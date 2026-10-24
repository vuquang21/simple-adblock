// Runs cosmetic.js against a fake DOM to verify YouTube ad handling.
// Run: node test/cosmetic.test.js
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

// Minimal DOM: records the injected stylesheet, gives youtubeAdTick a playing ad, a feed
// ad node to remove and the enforcement popup to dismiss. Selectors are matched by
// substring so the fake never has to know cosmetic.js's constants.
// `docQueries` / `docScans` count document-level lookups: the point of the two cadences is that
// the 300ms tick must not touch the document at all, and counting is how a test can prove it.
function makeDom(hostname, { adPlayer = true } = {}) {
  const injected = [];
  const counts = { skip: 0, dismiss: 0, removed: 0, docQueries: 0, docScans: 0 };
  const timers = [];
  // Flipping this models YouTube adding or dropping the ad class on the player mid-session.
  const flags = { adPlaying: adPlayer };
  const video = { duration: 30, currentTime: 0, muted: false, playbackRate: 1, ended: false };
  const skip = { click: () => counts.skip++ };
  const player = {
    classList: {
      contains: c => flags.adPlaying && (c === "ad-showing" || c === "ad-interrupting")
    },
    querySelector(sel) {
      if (sel === "video") return video;
      // A Skip button only exists while an ad is on screen, so the fake must not offer one after.
      if (sel.includes("ytp-ad-skip-button") || sel.includes("ytp-skip-ad-button"))
        return flags.adPlaying ? skip : null;
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
      counts.docQueries++;
      return sel.includes("enforcement") ? popup : null;
    },
    querySelectorAll: sel => {
      counts.docScans++;
      return sel.includes("ad-slot") ? [adNode] : [];
    },
    getElementById: id => {
      // Only YouTube builds #movie_player; off YouTube the tick has to stay a no-op.
      if (id === "movie_player") return /(^|\.)youtube\.com$/.test(hostname) ? player : null;
      return id === "dismiss-button" ? dismiss : null;
    }
  };
  return { document, location: { hostname }, injected, counts, flags, timers, video };
}

function load(dom, state) {
  const sandbox = {
    chrome: { storage: { local: { get: async () => state } } },
    document: dom.document,
    location: dom.location,
    // cosmetic.js starts both cadences itself; the test drives the callbacks by hand.
    setInterval: (fn, ms) => { dom.timers.push({ fn, ms }); return dom.timers.length; },
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
  dom.counts.docQueries = 0;
  dom.counts.docScans = 0;
  sandbox.youtubeAdTick();
  assert.strictEqual(dom.video.currentTime, 29.5, "the tick seeks to just before the ad's end");
  assert.strictEqual(dom.video.playbackRate, 16, "the ad plays at 16x");
  assert.strictEqual(dom.video.muted, true, "the ad is muted");
  assert.strictEqual(dom.counts.skip, 1, "the tick should press Skip");
  // The 300ms tick runs for the life of the tab, so it has to stay inside the player subtree.
  // Fourteen document scans at that rate is what made YouTube stutter while it rendered.
  assert.strictEqual(dom.counts.docScans, 0, "the fast tick must not scan the document");
  assert.strictEqual(dom.counts.docQueries, 0, "the fast tick must not query the document");
  // The cleanup that does need the document runs on its own, slower cadence.
  sandbox.youtubeAdSweep();
  assert.strictEqual(dom.counts.removed, 2, "the sweep should remove the ad's grid cell and the popup");
  assert.strictEqual(dom.counts.dismiss, 1, "the sweep should dismiss the enforcement popup");

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
  assert.strictEqual(wl.timers.length, 0, "a whitelisted site must not start the tick");

  // Master off: nothing either.
  const offState = makeDom("www.youtube.com");
  load(offState, { enabled: false, whitelist: [], cosmetic: [] });
  await flush();
  assert.strictEqual(offState.injected.length, 0, "disabled means no stylesheet");
  assert.strictEqual(offState.timers.length, 0, "disabled means no tick");

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

  // A page with no ad: 1.5 seconds of fast ticks must cost nothing. Before the split this was 14
  // document traversals plus a `:has()` query every 300ms, on every page, ad or not.
  const idle = makeDom("www.youtube.com", { adPlayer: false });
  const idleSandbox = load(idle, { enabled: true, whitelist: [], cosmetic: [] });
  await flush();
  idle.counts.docQueries = 0;
  idle.counts.docScans = 0;
  idle.counts.skip = 0;
  for (let i = 0; i < 5; i++) idleSandbox.youtubeAdTick();
  assert.strictEqual(idle.counts.docScans, 0, "five ticks with no ad must not scan the document");
  assert.strictEqual(idle.counts.docQueries, 0, "five ticks with no ad must not query the document");
  assert.strictEqual(idle.counts.skip, 0, "no ad means no Skip press");
  assert.strictEqual(idle.video.currentTime, 0, "no ad means no seek");

  // The cadences are 300ms for the ad and 1500ms for the cleanup: the sweep is the only callback
  // allowed to touch the whole document, and it pays exactly one scan per ad selector.
  assert.deepStrictEqual(idle.timers.map(t => t.ms), [300, 1500],
    "one fast tick and one slow sweep, in that order");
  idle.counts.docQueries = 0;
  idle.counts.docScans = 0;
  idle.timers[1].fn();
  assert.strictEqual(idle.counts.docScans, 14, "the sweep scans once per ad selector, not once per tick");
  assert.strictEqual(idle.counts.docQueries, 1, "the sweep also looks for the detection wall");

  // An ad that starts long after the page settled still has to die on the next fast tick.
  idle.flags.adPlaying = true;
  idleSandbox.youtubeAdTick();
  assert.strictEqual(idle.video.currentTime, 29.5, "an ad that appears later is still seeked");
  assert.strictEqual(idle.video.playbackRate, 16, "an ad that appears later is still sped up");
  assert.strictEqual(idle.counts.skip, 1, "an ad that appears later still gets Skip pressed");
  // And the class leaving hands the video back at its own speed and mute state.
  idle.flags.adPlaying = false;
  idle.video.currentTime = 5;
  idleSandbox.youtubeAdTick();
  assert.strictEqual(idle.video.playbackRate, 1, "the ad class leaving restores the playback rate");
  assert.strictEqual(idle.video.muted, false, "the ad class leaving restores the mute state");
  assert.strictEqual(idle.video.currentTime, 5, "the real video is never seeked");

  console.log("cosmetic/YouTube: OK");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
