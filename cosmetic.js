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

// The <video> is shared between the ad and the real video, so any speed change must be
// undone the moment the ad ends or the real video would keep playing at 16x. Remember the
// element we sped up and watch the player's class so the reset is instant, not up to a
// full 300ms tick late (at 16x that would skip several seconds of the actual video).
let youtubeAdVideo = null;
let youtubeObserver = null;

function youtubeAdTick() {
  const player = document.querySelector(YOUTUBE_AD_PLAYING);
  if (!player) {
    if (youtubeAdVideo && youtubeAdVideo.playbackRate !== 1) youtubeAdVideo.playbackRate = 1;
    youtubeAdVideo = null;
    // Attach once the player exists. It appears after document_start, so this is lazy.
    const root = document.querySelector("#movie_player");
    if (root && !youtubeObserver && typeof MutationObserver === "function") {
      youtubeObserver = new MutationObserver(youtubeAdTick);
      youtubeObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
    }
    return;
  }
  const video = player.querySelector("video");
  if (video) {
    youtubeAdVideo = video;
    try {
      // Seeking to the end skips a normal ad outright. Some ad formats report no finite
      // duration, so also play it at 16x — a fast-forward YouTube does not reject the way
      // it sometimes does a seek mid-ad.
      if (isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
      if (video.playbackRate !== 16) video.playbackRate = 16;
    } catch {} // the player can reject a seek while the ad is still loading
  }
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
