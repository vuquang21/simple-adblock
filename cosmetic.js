// Hides ad containers that no network block can remove — the leftover white boxes.
// Loaded at document_start in the top frame only, so the boxes never get a chance to
// render. The whitelist turns it off per site, which is why this is a script and not a
// plain content_scripts.css entry.
// shortcut: top frame only, so an ad that renders its own page inside a third-party
// iframe has to be caught by its parent's selector or by a network rule.

// YouTube plays video ads from the same player and stream, so no DNR rule can drop them.
// On YouTube the stylesheet also gets the scoped ad selectors, and a tick seeks the <video>
// past the ad and presses Skip. Both are off on a whitelisted site, because this file is.
// shortcut: YouTube renames these classes every so often; refresh when ads reappear.
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
  "ytm-promoted-sparkles-web-renderer"
];
const YOUTUBE_AD_PLAYING = "#movie_player.ad-showing, #movie_player.ad-interrupting";
const YOUTUBE_SKIP = ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button";

function youtubeAdTick() {
  const player = document.querySelector(YOUTUBE_AD_PLAYING);
  if (!player) return;
  const video = player.querySelector("video");
  // Live streams report Infinity; seeking there would break playback.
  if (video && isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
  const skip = player.querySelector(YOUTUBE_SKIP);
  if (skip) skip.click();
}

chrome.storage.local.get(["enabled", "whitelist", "cosmetic"]).then(({ enabled = true, whitelist = [], cosmetic = [] }) => {
  if (!enabled || isWhitelisted(location.hostname, whitelist)) return;
  const youtube = /(^|\.)youtube\.com$/.test(location.hostname);
  const selectors = youtube ? GENERIC_COSMETIC.concat(cosmetic, YOUTUBE_SELECTORS) : GENERIC_COSMETIC.concat(cosmetic);
  const style = document.createElement("style");
  style.textContent = selectors.join(",") + "{display:none!important}";
  (document.head || document.documentElement).append(style);
  if (youtube) {
    youtubeAdTick();
    setInterval(youtubeAdTick, 300); // the player is rebuilt on every SPA navigation
  }
});
