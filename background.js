// Rebuilds the browser's dynamic block rules from the domain list in storage, and
// auto-blocks ad-like third-party requests as they are seen.
// Source of truth: chrome.storage.local
// { enabled, domains: string[], whitelist: string[], detected: {host: count} }
// `detected` is a log of what was auto-blocked, for display only.

importScripts("default-domains.js", "shared.js");

const DNR = chrome.declarativeNetRequest;

let blocked = new Set(); // domains currently blocked (in memory for fast per-request checks)
let whitelist = []; // sites where blocking is off
let blockingOn = true;
const pending = {}; // host -> sightings since the last flush
let flushTimer = null;

// Load state early so tracking works even after the worker was restarted.
chrome.storage.local.get(["domains", "enabled", "whitelist"]).then(({ domains = [], enabled = true, whitelist: wl = [] }) => {
  blocked = new Set(domains);
  whitelist = wl;
  blockingOn = enabled;
});

chrome.action.setBadgeBackgroundColor({ color: "#2f6fed" });

// Each domain gets a stable rule id for the install, so adding one domain is a small
// diff instead of a remove-all + add-all rebuild of every rule.
async function syncRules() {
  try {
    const { enabled = true, domains = [], whitelist: wl = [], ruleIds: saved = {} } =
      await chrome.storage.local.get(["enabled", "domains", "whitelist", "ruleIds"]);
    blocked = new Set(domains);
    whitelist = wl;
    blockingOn = enabled;

    // Rules are keyed "d:<host>" / "w:<host>" so a whitelisted host and a blocked
    // host can be the same string without sharing a rule id.
    const idToKey = {}; // id -> key
    let next = domains.reduce((m, d) => Math.max(m, saved["d:" + d] || 0), 0) + 1;
    for (const d of new Set(domains)) idToKey[saved["d:" + d] || next++] = "d:" + d;
    let nextW = wl.reduce((m, w) => Math.max(m, saved["w:" + w] || 0), WHITELIST_ID_BASE) + 1;
    for (const w of new Set(wl)) idToKey[saved["w:" + w] || nextW++] = "w:" + w;
    const ruleIds = {};
    for (const [id, key] of Object.entries(idToKey)) ruleIds[key] = +id;

    const existing = await DNR.getDynamicRules();
    const existingIds = new Set(existing.map(r => r.id));
    // Disabled removes everything; ruleIds are still saved so re-enabling reuses them.
    const removeRuleIds = [...existingIds].filter(id => !enabled || !idToKey[id]);
    // shortcut: Chrome allows 30,000 'safe' dynamic rules (block/allow count as safe)
    // since Chrome 121, which is what minimum_chrome_version pins. Beyond that the
    // add rejects and lastError is shown in the dashboard.
    const addRules = enabled
      ? Object.entries(idToKey)
          .filter(([id]) => !existingIds.has(+id))
          .map(([id, key]) =>
            key[0] === "d"
              ? {
                  id: +id,
                  priority: 1,
                  action: { type: "block" },
                  condition: { urlFilter: `||${key.slice(2)}^`, isUrlFilterCaseSensitive: false }
                }
              : {
                  // Allow outranks block, so a whitelisted site loads even blocked domains.
                  // shortcut: keyed on the request initiator, so a whitelisted page still
                  // blocks ads inside third-party iframes it embeds.
                  id: +id,
                  priority: 2,
                  action: { type: "allow" },
                  condition: { initiatorDomains: [key.slice(2)], urlFilter: "*" }
                }
          )
      : [];

    // Remove, then add, in separate calls so reused rule IDs never collide in one update.
    if (removeRuleIds.length) await DNR.updateDynamicRules({ removeRuleIds });
    if (addRules.length) await DNR.updateDynamicRules({ addRules });
    await chrome.storage.local.set({ ruleIds, lastError: null });
    if (!enabled) await chrome.action.setBadgeText({ text: "" });
  } catch (e) {
    // Surface the failure in the dashboard instead of swallowing it.
    await chrome.storage.local.set({ lastError: (e && e.message) || String(e) });
  }
}

// Banner ads load as images/iframes, and the ad hint often sits in the path
// (…/banner-300x250.jpg) rather than the host, so the resource type is what tells us
// an ad-shaped URL is a banner and not just a stray script.
const BANNER_TYPES = new Set(["image", "sub_frame"]);
const PATH_HINT = /(^|[/_.-])(ads?|advert\w*|banner\w*|sponsor\w*|promo\w*)([/_.-]|$)/i;

// Badge = rules that actually matched on that tab, so it counts blocks and nothing else.
// Throttled per tab; any request on the page is a good enough clock.
const badgeAt = {};
function refreshBadge(tabId) {
  if (!(tabId >= 0) || !DNR.getMatchedRules) return;
  const now = Date.now();
  if (badgeAt[tabId] && now - badgeAt[tabId] < 1000) return;
  badgeAt[tabId] = now;
  // shortcut: getMatchedRules needs the declarativeNetRequestFeedback permission, which
  // Chrome ignores for Web Store installs, so the badge stays empty there. Read the
  // count in the popup instead if this ever ships to the store.
  DNR.getMatchedRules({ tabId })
    .then(({ matchedRules = [] }) =>
      chrome.action.setBadgeText({
        tabId,
        // Allow rules are the whitelist; only block rules are worth showing.
        text: String(matchedRules.filter(r => r.ruleId < WHITELIST_ID_BASE).length) || ""
      }))
    .catch(() => {});
}

// Queue ad-like third-party requests for auto-blocking.
function track(details) {
  refreshBadge(details.tabId);
  if (!blockingOn) return;
  let host;
  try { host = new URL(details.url).hostname; } catch { return; }
  if (!details.initiator || blocked.has(host)) return;
  let initHost;
  try { initHost = new URL(details.initiator).hostname; } catch { return; }
  // A whitelisted site is left alone entirely, including the auto-blocking.
  if (isWhitelisted(initHost, whitelist)) return;
  // Only third-party hosts: never suggest blocking the site's own domain.
  if (baseDomain(initHost) === baseDomain(host)) return;
  // Ad hint in the host, or an ad-shaped path served as a banner image/iframe.
  if (!AD_HINT.test(host) && !(BANNER_TYPES.has(details.type) && PATH_HINT.test(details.url))) return;
  pending[host] = (pending[host] || 0) + 1;
  scheduleFlush();
}

// Batched: writing on every request would be far too hot.
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const hosts = Object.keys(pending);
    if (!hosts.length) return;
    const counts = { ...pending };
    for (const h in pending) delete pending[h];

    // Read-modify-write; the window is a few ms, so a concurrent dashboard import could in theory be lost.
    // shortcut: no storage transaction in the extension APIs, so keep the window tiny rather than adding a lock.
    const { domains = [], detected = {} } = await chrome.storage.local.get(["domains", "detected"]);
    const known = new Set(domains);
    for (const h of hosts) {
      detected[h] = (detected[h] || 0) + counts[h];
      if (!known.has(h)) { known.add(h); domains.push(h); } // auto-add to the blocklist
    }
    const top = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 500));
    await chrome.storage.local.set({ detected: top(detected), domains: domains.sort() });
  }, 2000);
}

// The starter list is versioned so a new batch of defaults also reaches installs that already
// have a list, instead of only ever helping a fresh profile.
const SEED_VERSION = 3;

// A new install starts with the common ad/tracker networks already blocked, so ads are gone
// before auto-detection has watched anything. An existing list is merged, never replaced, and a
// list the user emptied on purpose is left alone because its seedVersion is already current.
// shortcut: bumping SEED_VERSION brings back defaults the user had deleted; keep bumps rare.
async function seedDefaultDomains() {
  const { domains, seedVersion = 0 } = await chrome.storage.local.get(["domains", "seedVersion"]);
  if (domains !== undefined && seedVersion >= SEED_VERSION) return;
  const merged = [...new Set([...(domains || []), ...DEFAULT_DOMAINS])].sort();
  await chrome.storage.local.set({ domains: merged, seedVersion: SEED_VERSION });
}

chrome.runtime.onInstalled.addListener(() => seedDefaultDomains().then(syncRules));
chrome.runtime.onStartup.addListener(() => seedDefaultDomains().then(syncRules));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.domains || changes.enabled || changes.whitelist)) syncRules();
});
// A count from the previous page would be a lie, so clear it on navigation.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "loading") return;
  delete badgeAt[tabId];
  // A tab closed mid-load is already gone, and the badge API rejects with
  // "No tab with id: …" — swallow it instead of leaving an unhandled rejection
  // in the extension's error list.
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => delete badgeAt[tabId]);
chrome.webRequest.onBeforeRequest.addListener(track, { urls: ["<all_urls>"] });
