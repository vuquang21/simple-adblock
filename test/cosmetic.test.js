// Runs cosmetic.js against a fake DOM to verify YouTube ad handling.
// Run: node test/cosmetic.test.js
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

// Minimal DOM: records the injected stylesheet, gives youtubeAdTick a playing ad, a feed
// ad node to remove and the enforcement popup to dismiss. Selectors are matched by
// substring so the fake never has to know cosmetic.js's constants.
function makeDom(hostname, { adPlayer = true } = {}) {
  const injected = [];
  const counts = { skip: 0, dismiss: 0, removed: 0 };
  const video = { duration: 30, currentTime: 0, muted: false, playbackRate: 1, ended: false };
  const skip = { click: () => counts.skip++ };
  const player = {
    querySelector(sel) {
      if (sel === "video") return video;
      if (sel.includes("ytp-ad-skip-button") || sel.includes("ytp-skip-ad-button")) return skip;
      return null;
    }
  };
  const cell = { remove: () => counts.removed++ };
  const adNode = { closest: sel => (sel.includes("rich-item") ? cell : null) };
  const popup = { remove: () => counts.removed++ };
  const dismiss = { click: () => counts.dismiss++ };
  // parentElement is set like a real append: cosmetic.js checks it to know the sheet is still
  // in the page, which is how a pick after the page replaced <head> re-creates it.
  const head = { append: el => { el.parentElement = head; injected.push(el); } };
  const documentElement = { append: el => { el.parentElement = documentElement; injected.push(el); } };
  const document = {
    createElement: tag => ({ tag, textContent: "" }),
    head,
    documentElement,
    querySelector: sel => {
      if (adPlayer && sel.includes("#movie_player.ad-showing")) return player;
      if (sel.includes("enforcement")) return popup;
      return null;
    },
    querySelectorAll: sel => (sel.includes("ad-slot") ? [adNode] : []),
    getElementById: id => (id === "dismiss-button" ? dismiss : null)
  };
  return { document, location: { hostname }, injected, counts, video };
}

function load(dom, state) {
  const sandbox = {
    chrome: { storage: { local: { get: async () => state } } },
    document: dom.document,
    location: dom.location,
    setInterval: () => 0,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    isFinite
  };
  vm.createContext(sandbox);
  for (const f of ["shared.js", "cosmetic-rules.js", "cosmetic.js"]) {
    vm.runInContext(fs.readFileSync(__dirname + "/../" + f, "utf8"), sandbox);
  }
  return sandbox;
}

const flush = () => new Promise(r => setTimeout(r, 0));

(async () => {
  // On YouTube: scoped selectors are injected and the tick kills the ad.
  const dom = makeDom("www.youtube.com");
  const sandbox = load(dom, { enabled: true, whitelist: [], cosmetic: [] });
  await flush();
  assert.strictEqual(dom.injected.length, 1, "one stylesheet on YouTube");
  assert.ok(dom.injected[0].textContent.includes(".ytp-ad-module"), "YouTube ad selectors must be injected");
  assert.ok(dom.injected[0].textContent.includes("ytd-ad-slot-renderer"), "feed ad selectors must be injected");
  assert.ok(dom.injected[0].textContent.includes("ytd-rich-item-renderer:has"), "the ad's grid cell must be hidden too");
  assert.ok(dom.injected[0].textContent.includes(".a-ad"), "generic selectors must still apply");
  dom.counts.skip = 0; // the init tick already ran; count only the tick under test
  dom.counts.removed = 0;
  dom.counts.dismiss = 0;
  sandbox.youtubeAdTick();
  assert.strictEqual(dom.video.currentTime, 29.5, "the tick seeks to just before the ad's end");
  assert.strictEqual(dom.video.playbackRate, 16, "the ad plays at 16x");
  assert.strictEqual(dom.video.muted, true, "the ad is muted");
  assert.strictEqual(dom.counts.skip, 1, "the tick should press Skip");
  assert.strictEqual(dom.counts.removed, 2, "the tick should remove the ad's grid cell and the popup");
  assert.strictEqual(dom.counts.dismiss, 1, "the tick should dismiss the enforcement popup");

  // The ad reached its end: it must be handed back untouched, or YouTube never resumes.
  dom.video.currentTime = 30;
  dom.video.ended = true;
  sandbox.youtubeAdTick();
  assert.strictEqual(dom.video.currentTime, 30, "an ad that already ended is not seeked again");
  assert.strictEqual(dom.video.playbackRate, 1, "the playback rate is restored after the ad");
  assert.strictEqual(dom.video.muted, false, "the mute state is restored after the ad");

  // Off YouTube: no scoped selectors, and no player so the tick is a no-op.
  const off = makeDom("news.example", { adPlayer: false });
  const offSandbox = load(off, { enabled: true, whitelist: [], cosmetic: [] });
  await flush();
  assert.ok(!off.injected[0].textContent.includes(".ytp-ad-module"), "no YouTube selectors off YouTube");
  offSandbox.youtubeAdTick();
  assert.strictEqual(off.video.currentTime, 0, "no player means no seek");

  // A rule stored for one site applies there (and on its subdomains), nowhere else.
  const scoped = makeDom("www.phim.example", { adPlayer: false });
  const scopedSandbox = load(scoped, {
    enabled: true, whitelist: [], cosmetic: [], siteRules: { "phim.example": [".banner-quang-cao"] }
  });
  await flush();
  assert.ok(scoped.injected[0].textContent.includes(".banner-quang-cao"),
    "a rule set on the apex must cover the subdomain");
  // A picked rule has to hide right away, not on the next load.
  scopedSandbox.addHiddenRule("#ads-top");
  assert.ok(scoped.injected[0].textContent.includes("#ads-top{display:none!important}"),
    "a picked rule joins the live stylesheet");
  assert.strictEqual(scoped.injected.length, 1, "a picked rule must not add a second stylesheet");
  // A page that replaces <head> detaches the sheet; a pick has to bring it back, otherwise the
  // rule is saved and the toast says "hidden" while the banner stays on screen.
  scoped.injected[0].parentElement = null;
  scopedSandbox.addHiddenRule("#late-banner");
  assert.strictEqual(scoped.injected.length, 2, "a pick after <head> was replaced re-injects the sheet");
  assert.ok(scoped.injected[1].textContent.includes("#late-banner{display:none!important}"),
    "the re-created sheet still carries the picked rule");

  const other = makeDom("other.example", { adPlayer: false });
  load(other, { enabled: true, whitelist: [], cosmetic: [], siteRules: { "phim.example": [".banner-quang-cao"] } });
  await flush();
  assert.ok(!other.injected[0].textContent.includes(".banner-quang-cao"),
    "a site rule must never leak to another site");

  // Whitelisted YouTube: nothing is injected at all.
  const wl = makeDom("www.youtube.com");
  load(wl, { enabled: true, whitelist: ["youtube.com"], cosmetic: [] });
  await flush();
  assert.strictEqual(wl.injected.length, 0, "a whitelisted site gets no stylesheet");

  // Master off: nothing either.
  const offState = makeDom("www.youtube.com");
  load(offState, { enabled: false, whitelist: [], cosmetic: [] });
  await flush();
  assert.strictEqual(offState.injected.length, 0, "disabled means no stylesheet");

  // Live video (infinite duration) must not be seeked.
  const live = makeDom("www.youtube.com");
  const liveSandbox = load(live, { enabled: true, whitelist: [], cosmetic: [] });
  await flush();
  live.video.currentTime = 0; // the init tick already seeked; test this tick alone
  live.video.duration = Infinity;
  liveSandbox.youtubeAdTick();
  assert.strictEqual(live.video.currentTime, 0, "a live stream must not be seeked");
  // A duration that flips to NaN mid-swap must not throw the non-finite currentTime TypeError.
  live.video.duration = NaN;
  liveSandbox.youtubeAdTick();
  assert.strictEqual(live.video.currentTime, 0, "an unknown duration must not be seeked");

  console.log("cosmetic/YouTube: OK");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
