// Hides ad containers that no network block can remove — the leftover white boxes.
// Loaded at document_start in the top frame only, so the boxes never get a chance to
// render. The whitelist turns it off per site, which is why this is a script and not a
// plain content_scripts.css entry.
// shortcut: top frame only, so an ad that renders its own page inside a third-party
// iframe has to be caught by its parent's selector or by a network rule.

// YouTube plays video ads from the same player and stream, so no DNR rule can drop them.
// youtube-main.js scrubs the ad fields out of the player data in the page's own world;
// here the stylesheet hides the leftover boxes, a tick seeks the <video> past an ad and
// presses Skip, and the enforcement overlay is dismissed. All of it is off on a
// whitelisted site, because this file is.
// shortcut: YouTube renames these classes every so often; refresh when ads reappear.
// shortcut: server-stitched (SSAI) and live-stream ads have no separate ad video to seek,
// so they cannot be removed client-side.
const YOUTUBE_SELECTORS = [
  "#player-ads",
  "#masthead-ad",
  ".video-ads",
  ".ytp-ad-module",
  ".ytp-ad-overlay-container",
  ".ytp-ad-overlay-slot",
  ".ytp-ad-player-overlay",
  ".ytp-ad-player-overlay-layout",
  ".ytp-ad-image-overlay",
  ".ytp-ad-text-overlay",
  ".ytp-ad-survey",
  "ytd-ad-slot-renderer",
  "ytd-display-ad-renderer",
  "ytd-in-feed-ad-layout-renderer",
  "ytd-promoted-sparkles-web-renderer",
  "ytd-promoted-video-renderer",
  "ytd-banner-promo-renderer",
  "ytd-statement-banner-renderer",
  "ytd-companion-slot-renderer",
  "ytd-action-companion-ad-renderer",
  "ytd-compact-promoted-video-renderer",
  "ytd-promoted-sparkles-text-search-renderer",
  "ytd-video-masthead-ad-v3-renderer",
  "ytm-promoted-sparkles-web-renderer",
  // The grid cell / promo section that wraps an ad: hiding only the inner node leaves an
  // empty rounded box where the ad used to be.
  "ytd-rich-item-renderer:has(ytd-ad-slot-renderer)",
  "ytd-rich-item-renderer:has(ytd-in-feed-ad-layout-renderer)",
  "ytd-rich-item-renderer:has(ytd-display-ad-renderer)",
  "ytd-rich-item-renderer:has(ytd-promoted-video-renderer)",
  "ytd-rich-item-renderer:has(ytd-promoted-sparkles-web-renderer)",
  "ytd-rich-section-renderer:has(ytd-ad-slot-renderer)",
  "ytd-rich-section-renderer:has(ytd-statement-banner-renderer)"
];
// Ad nodes the stylesheet only hides; removing them reclaims the empty slot they leave behind.
// The watch-page/sidebar containers are here too, so they disappear even if the big stylesheet
// rule is dropped for one bad selector anywhere in the list.
const YOUTUBE_REMOVE = [
  "ytd-ad-slot-renderer",
  "ytd-display-ad-renderer",
  "ytd-in-feed-ad-layout-renderer",
  "ytd-promoted-video-renderer",
  "ytd-promoted-sparkles-web-renderer",
  "ytd-action-companion-ad-renderer",
  "ytd-compact-promoted-video-renderer",
  "#player-ads",
  "#masthead-ad",
  "ytd-companion-slot-renderer",
  "ytd-banner-promo-renderer",
  "ytd-statement-banner-renderer",
  "ytd-promoted-sparkles-text-search-renderer",
  "ytd-video-masthead-ad-v3-renderer"
];
// A feed ad sits inside this grid cell, which keeps its empty box if only the ad is removed.
const YOUTUBE_AD_CELL = "ytd-rich-item-renderer";
// The two classes YouTube itself toggles while an ad is on screen. They are named as classes, not
// as the `#movie_player.ad-showing` selector they used to be, because the check is a classList
// read on one element: no selector engine, no document traversal, 3x/s for the life of the tab.
const YOUTUBE_AD_CLASSES = ["ad-showing", "ad-interrupting"];
// Ad controls can appear even when the player class does not (stitched/server-side ads).
const YOUTUBE_AD_UI = ".ytp-ad-player-overlay, .ytp-ad-simple-ad-badge, .ytp-ad-text, .ytp-ad-preview-container";
const YOUTUBE_SKIP = ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button, button[aria-label*='Skip' i]";
// Shown when YouTube decides the browser blocks ads: a stuck overlay, not an ad.
const YOUTUBE_ENFORCEMENT = "ytd-enforcement-message-view-model";

let adVideo = null; // the <video> sped up for the current ad, so it can be restored afterwards
let adVideoMuted = false;
let hiddenSheet = null; // the one hiding stylesheet, so a picked rule lands without a reload

function injectHiding(selectors) {
  hiddenSheet = document.createElement("style");
  // One rule per selector: a single invalid selector in a comma-joined list would make the
  // browser drop the whole rule, taking every other ad selector with it.
  hiddenSheet.textContent = selectors.map(s => s + "{display:none!important}").join("\n");
  (document.head || document.documentElement).append(hiddenSheet);
}

// Called by picker.js once it has saved a rule, so the picked banner disappears immediately
// instead of only on the next load. The sheet can be missing (blocking was off when the page
// loaded, or the page replaced <head>), so a pick re-creates it rather than hiding nothing.
function addHiddenRule(selector) {
  if (!hiddenSheet || !hiddenSheet.parentElement) injectHiding([]);
  hiddenSheet.textContent += "\n" + selector + "{display:none!important}";
}

function stopAdFastForward() {
  if (adVideo) {
    adVideo.playbackRate = 1;
    adVideo.muted = adVideoMuted;
    adVideo = null;
  }
}

// Two cadences, because the two jobs cost wildly different amounts. Killing the ad only needs the
// player subtree: read its classes, keep 16x pinned, press Skip. Sweeping the document for the 14
// ad containers cost 14 full traversals every 300ms -- the single biggest source of jank this
// extension added to YouTube -- and buys nothing at that speed, because the stylesheet already
// hides those containers the moment they appear; remove() only reclaims the empty slot.
const YOUTUBE_TICK = 300;
// shortcut: YOUTUBE_REMOVE is the part that can wait -- the stylesheet already hides those
// containers, so stopping at half a second only delays reclaiming the empty slot.
const YOUTUBE_SWEEP_TICK = 1500;

function youtubeAdTick() {
  const player = document.getElementById("movie_player");
  // No player: non-YouTube, or YouTube has not built one yet. Nothing to speed up.
  if (!player) return stopAdFastForward();
  const adPlaying = YOUTUBE_AD_CLASSES.some(c => player.classList.contains(c));
  const skipButton = player.querySelector(YOUTUBE_SKIP);
  // The same three signals as before, now anchored on the player element instead of a
  // `:has()` document query: an ad class, a Skip button, or ad controls inside the player.
  const onAd = adPlaying || !!skipButton || !!player.querySelector(YOUTUBE_AD_UI);
  const video = onAd ? player.querySelector("video") : null;
  // Read the duration once: it flips to NaN/Infinity while YouTube swaps media, and assigning a
  // non-finite currentTime throws. Only a real, positive duration is a seekable ad.
  const duration = video ? video.duration : NaN;
  // Only act on the player class YouTube itself toggles: the looser overlay check also matches
  // the real video for a tick after the ad ends, and seeking that to its end is the black screen.
  // Live streams report Infinity and an ad that already ended needs no second seek.
  if (!adPlaying || !video || video.ended || !isFinite(duration) || duration <= 0)
    stopAdFastForward();
  else {
    if (adVideo !== video) { stopAdFastForward(); adVideo = video; adVideoMuted = video.muted; }
    video.muted = true;
    video.playbackRate = 16; // YouTube resets it, so the 300ms tick keeps it pinned
    // Seek once to just before the end and let the ad finish by itself: jumping to exactly
    // duration re-seeks every frame, so 'ended' never settles and YouTube never swaps the real
    // video in, leaving a frozen black player at the ad's full length.
    if (video.currentTime < duration - 1) video.currentTime = duration - 0.5;
  }
  if (skipButton) skipButton.click();
}

// Ad nodes the stylesheet only hides; removing them reclaims the empty slot they leave behind.
// YouTube rebuilds the detection wall no matter what, so this also has to keep dismissing it.
function youtubeAdSweep() {
  for (const sel of YOUTUBE_REMOVE)
    for (const el of document.querySelectorAll(sel)) (el.closest(YOUTUBE_AD_CELL) || el).remove();
  const popup = document.querySelector(YOUTUBE_ENFORCEMENT);
  if (!popup) return;
  const dismiss = document.getElementById("dismiss-button");
  if (dismiss) dismiss.click();
  popup.remove();
}

chrome.storage.local.get(["enabled", "whitelist", "cosmetic", "siteRules"]).then(({ enabled = true, whitelist = [], cosmetic = [], siteRules = {} }) => {
  const off = !enabled || isWhitelisted(location.hostname, whitelist);
  // youtube-main.js runs in the page world on the next load and reads this to know blocking
  // is off here; it cannot read chrome.storage itself.
  try { localStorage.setItem("sab-ads-off", off ? "1" : "0"); } catch {}
  if (off) return;
  const youtube = /(^|\.)youtube\.com$/.test(location.hostname);
  // Rules picked by hand on this site come first in the list because they are the ones that
  // actually match its random container names.
  const selectors = siteRulesFor(location.hostname, siteRules)
    .concat(GENERIC_COSMETIC, cosmetic)
    .concat(youtube ? YOUTUBE_SELECTORS : []);
  injectHiding(selectors);
  if (youtube) {
    // The player is rebuilt on every SPA navigation, so both run from an interval rather than
    // from events on an element that gets thrown away.
    youtubeAdTick();
    setInterval(youtubeAdTick, YOUTUBE_TICK);
    // shortcut: the detection wall can now sit for up to YOUTUBE_SWEEP_TICK before it is clicked
    // away, where the old single tick cleared it within 300ms. A faster sweep means putting the 14
    // document queries back on the fast tick, which is what made the page stutter.
    youtubeAdSweep();
    setInterval(youtubeAdSweep, YOUTUBE_SWEEP_TICK);
  }
});
