// Runs background.js against a fake chrome API to verify rule sync behavior.
// Run: node test/background.test.js
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

function makeChrome() {
  const store = {};
  let rules = [];
  const changeListeners = [];
  const addedCalls = [];
  const removedCalls = [];
  const badges = {};

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const k in obj) changes[k] = { oldValue: store[k], newValue: obj[k] };
          Object.assign(store, obj);
          for (const fn of changeListeners) fn(changes, "local");
        }
      },
      onChanged: { addListener: fn => changeListeners.push(fn) }
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return rules.map(r => ({ ...r }));
      },
      // One block rule (id 1) and one whitelist allow rule (id WHITELIST_ID_BASE + 1).
      async getMatchedRules() {
        return { matchedRules: [{ ruleId: 1 }, { ruleId: 1000001 }] };
      },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        // Emulate Chrome: reject on duplicate IDs within addRules.
        const ids = addRules.map(r => r.id);
        assert.strictEqual(new Set(ids).size, ids.length, "duplicate rule ids in addRules");
        // Emulate Chrome semantics: remove listed ids first, then add.
        const remove = new Set(removeRuleIds);
        removedCalls.push([...remove]);
        rules = rules.filter(r => !remove.has(r.id)).concat(addRules);
        addedCalls.push(addRules.length);
      }
    },
    runtime: {
      onInstalled: { addListener: fn => { chrome.__onInstall = fn; } },
      onStartup: { addListener: fn => { chrome.__onStartup = fn; } }
    },
    action: {
      setBadgeBackgroundColor() {},
      setBadgeText({ tabId, text }) { badges[tabId] = text; }
    },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    webRequest: { onBeforeRequest: { addListener(fn) { chrome.__onRequest = fn; } } }
  };
  return { chrome, store, addedCalls, removedCalls, badges, getRules: () => rules };
}

// Loads background.js into a vm over the given fake chrome and returns the sandbox.
function boot(chrome) {
  const sandbox = { chrome, console, URL, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  sandbox.importScripts = (...files) =>
    files.forEach(f => vm.runInContext(fs.readFileSync(__dirname + "/../" + f, "utf8"), sandbox));
  vm.runInContext(fs.readFileSync(__dirname + "/../background.js", "utf8"), sandbox);
  return sandbox;
}

async function scenario() {
  const { chrome, addedCalls, removedCalls, badges, getRules } = makeChrome();
  const sandbox = { chrome, console, URL, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  sandbox.importScripts = (...files) =>
    files.forEach(f => vm.runInContext(fs.readFileSync(__dirname + "/../" + f, "utf8"), sandbox));
  vm.runInContext(fs.readFileSync(__dirname + "/../background.js", "utf8"), sandbox);

  // Simulate the user importing two domains from the dashboard.
  await chrome.storage.local.set({ enabled: true, domains: ["doubleclick.net", "ads.example.com"] });
  await new Promise(r => setTimeout(r, 0));

  let rules = getRules();
  assert.strictEqual(rules.length, 2, "expected 2 rules after first import");
  for (const r of rules) {
    assert.strictEqual(r.action.type, "block");
    assert.strictEqual(r.condition.urlFilter.startsWith("||"), true);
    assert.strictEqual(r.priority > 0, true);
  }
  const filters = rules.map(r => r.condition.urlFilter).sort();
  assert.deepStrictEqual(filters, ["||ads.example.com^", "||doubleclick.net^"]);

  // Simulate a second import: ads.example.com keeps its id, doubleclick.net is dropped.
  await chrome.storage.local.set({ domains: ["tracker.io", "ads.example.com"] });
  await new Promise(r => setTimeout(r, 0));
  rules = getRules();
  assert.strictEqual(rules.length, 2, "expected 2 rules after second import");
  assert.deepStrictEqual(rules.map(r => r.condition.urlFilter).sort(), ["||ads.example.com^", "||tracker.io^"]);

  // Detection now auto-blocks: an ad-like third-party request must land in the blocklist.
  chrome.__onRequest({ url: "https://ads.doubleclick.net/x.js", initiator: "https://news.example" });
  // A first-party request and a non-ad host must be ignored.
  chrome.__onRequest({ url: "https://cdn.example.com/app.js", initiator: "https://example.com" });
  chrome.__onRequest({ url: "https://tracker.io/t.gif", initiator: "https://news.example" }); // already blocked
  await new Promise(r => setTimeout(r, 2300)); // wait for the batched flush
  const { detected = {}, domains: afterDetect = [] } = await chrome.storage.local.get(["detected", "domains"]);
  assert.deepStrictEqual(Object.keys(detected), ["ads.doubleclick.net"], "only the ad-like third-party host should be logged");
  assert.ok(afterDetect.includes("ads.doubleclick.net"), "detected host should be auto-added to the blocklist");
  await new Promise(r => setTimeout(r, 0)); // let syncRules rebuild
  assert.ok(
    getRules().some(r => r.condition.urlFilter === "||ads.doubleclick.net^"),
    "auto-added host should have a blocking rule"
  );

  // Banners: an ad-shaped path served as an image is blocked even when the host has no
  // ad hint. An ordinary third-party image and a script with the same path are not.
  chrome.__onRequest({ url: "https://cdn.example.net/img/banner-300x250.jpg", initiator: "https://news.example", type: "image" });
  chrome.__onRequest({ url: "https://cdn.example.net/logo.png", initiator: "https://news.example", type: "image" });
  chrome.__onRequest({ url: "https://cdn.example.net/js/banner.js", initiator: "https://news.example", type: "script" });
  await new Promise(r => setTimeout(r, 2300));
  const { detected: bannerDetected = {}, domains: afterBanner = [] } = await chrome.storage.local.get(["detected", "domains"]);
  assert.ok(bannerDetected["cdn.example.net"], "banner image should be detected by type + path");
  assert.ok(afterBanner.includes("cdn.example.net"), "banner host should be auto-added to the blocklist");
  assert.strictEqual(bannerDetected["cdn.example.net"], 1, "only the banner image, not the logo or script, should count");

  // Whitelist: an allow rule that outranks the block rules, and no auto-detection there.
  const blocksBefore = getRules().filter(r => r.action.type === "block").length;
  await chrome.storage.local.set({ whitelist: ["news.example"] });
  await new Promise(r => setTimeout(r, 0));
  const allowRules = getRules().filter(r => r.action.type === "allow");
  assert.strictEqual(allowRules.length, 1, "expected 1 allow rule for the whitelist");
  assert.strictEqual(allowRules[0].condition.initiatorDomains.join(","), "news.example");
  assert.ok(allowRules[0].priority > 1, "the allow rule must outrank the block rules");
  assert.strictEqual(
    getRules().filter(r => r.action.type === "block").length,
    blocksBefore,
    "a whitelist change must not disturb the block rules"
  );

  chrome.__onRequest({ url: "https://ads.newtracker.net/x.js", initiator: "https://news.example" });
  await new Promise(r => setTimeout(r, 2300));
  const { domains: afterWl = [] } = await chrome.storage.local.get("domains");
  assert.ok(!afterWl.includes("ads.newtracker.net"), "a whitelisted site must not auto-block");

  // Badge: the matched allow rule must not inflate the count.
  chrome.__onRequest({ url: "https://example.com/app.js", initiator: "https://example.com", tabId: 7 });
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(badges[7], "1", "badge should count block rules only");

  // Toggling off should clear all rules.
  await chrome.storage.local.set({ enabled: false });
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(getRules().length, 0, "expected 0 rules when disabled");

  console.log("background sync: OK");
  console.log("  added calls:", JSON.stringify(addedCalls), "removed calls:", JSON.stringify(removedCalls));
}

// A fresh install seeds the default blocklist; an existing list is merged; a list the user
// emptied on purpose stays empty.
async function seedScenario() {
  const fresh = makeChrome();
  boot(fresh.chrome);
  await fresh.chrome.__onInstall();
  await new Promise(r => setTimeout(r, 0));
  assert.ok(Array.isArray(fresh.store.domains) && fresh.store.domains.length > 100, "install should seed the default blocklist");
  assert.ok(fresh.store.seedVersion > 0, "the seed version must be recorded");
  assert.strictEqual(
    fresh.getRules().filter(r => r.action.type === "block").length,
    fresh.store.domains.length,
    "every seeded domain should get a blocking rule"
  );

  // An install from the previous version already has a list: defaults are merged, not replaced.
  const merged = makeChrome();
  merged.store.domains = ["doubleclick.net"];
  boot(merged.chrome);
  await merged.chrome.__onInstall();
  await new Promise(r => setTimeout(r, 0));
  assert.ok(merged.store.domains.includes("doubleclick.net"), "an existing entry must survive the seed");
  assert.ok(merged.store.domains.includes("sentry.io"), "the new defaults must be merged in");
  assert.strictEqual(new Set(merged.store.domains).size, merged.store.domains.length, "no duplicates after merge");

  // Cleared from the dashboard, then reboot: the defaults must not come back.
  await fresh.chrome.storage.local.set({ domains: [] });
  await new Promise(r => setTimeout(r, 0));
  await fresh.chrome.__onStartup();
  await new Promise(r => setTimeout(r, 0));
  assert.deepStrictEqual(fresh.store.domains, [], "an explicitly empty list must stay empty");
  console.log("default seed: OK");
}

scenario().then(seedScenario).catch(e => { console.error("FAIL:", e.message); process.exit(1); });
