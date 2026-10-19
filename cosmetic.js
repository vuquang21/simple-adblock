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
const YOUTUBE_AD_PLAYING = "#movie_player.ad-showing, #movie_player.ad-interrupting";
// Ad controls can appear even when the player class does not (stitched/server-side ads).
const YOUTUBE_AD_UI = ".ytp-ad-player-overlay, .ytp-ad-simple-ad-badge, .ytp-ad-text, .ytp-ad-preview-container";
const YOUTUBE_SKIP = ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button, button[aria-label*='Skip' i]";
// Shown when YouTube decides the browser blocks ads: a stuck overlay, not an ad.
const YOUTUBE_ENFORCEMENT = "ytd-enforcement-message-view-model";

let adVideo = null; // the <video> sped up for the current ad, so it can be restored afterwards
let adVideoMuted = false;

function stopAdFastForward() {
  if (adVideo) {
    adVideo.playbackRate = 1;
    adVideo.muted = adVideoMuted;
    adVideo = null;
  }
}

function youtubeAdTick() {
  const skipButton = document.querySelector(YOUTUBE_SKIP);
  const adPlaying = document.querySelector(YOUTUBE_AD_PLAYING);
  const player =
    adPlaying ||
    document.querySelector("#movie_player:has(" + YOUTUBE_AD_UI + ")") ||
    (skipButton && skipButton.closest("#movie_player"));
  const video = player && player.querySelector("video");
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
  if (player) {
    const skip = player.querySelector(YOUTUBE_SKIP);
    if (skip) skip.click();
  }
  for (const sel of YOUTUBE_REMOVE)
    for (const el of document.querySelectorAll(sel)) (el.closest(YOUTUBE_AD_CELL) || el).remove();
  const popup = document.querySelector(YOUTUBE_ENFORCEMENT);
  if (popup) {
    const dismiss = document.getElementById("dismiss-button");
    if (dismiss) dismiss.click();
    popup.remove();
  }
}

chrome.storage.local.get(["enabled", "whitelist", "cosmetic"]).then(({ enabled = true, whitelist = [], cosmetic = [] }) => {
  const off = !enabled || isWhitelisted(location.hostname, whitelist);
  // youtube-main.js runs in the page world on the next load and reads this to know blocking
  // is off here; it cannot read chrome.storage itself.
  try { localStorage.setItem("sab-ads-off", off ? "1" : "0"); } catch {}
  if (off) return;
  const youtube = /(^|\.)youtube\.com$/.test(location.hostname);
  const selectors = youtube ? GENERIC_COSMETIC.concat(cosmetic, YOUTUBE_SELECTORS) : GENERIC_COSMETIC.concat(cosmetic);
  const style = document.createElement("style");
  // One rule per selector: a single invalid selector in a comma-joined list would make the
  // browser drop the whole rule, taking every other ad selector with it.
  style.textContent = selectors.map(s => s + "{display:none!important}").join("\n");
  (document.head || document.documentElement).append(style);
  if (youtube) {
    youtubeAdTick();
    setInterval(youtubeAdTick, 300);// the player is rebuilt on every SPA navigation
  }
});
