// Runs in YouTube's own JavaScript world, at document_start. YouTube reads its player data
// here, so this is the only place the ad fields can be removed before the player schedules
// an ad. It cannot read chrome.storage, which is why background.js registers it only while
// blocking is on and youtube.com is not whitelisted.
(() => {
  // This static MAIN-world script cannot read chrome.storage. cosmetic.js (isolated world)
  // mirrors the enabled/whitelist state into this origin's localStorage; absent means
  // blocking was never turned off here, so hooking is the safe default.
  let off = false;
  try { off = localStorage.getItem("sab-ads-off") === "1"; } catch {}
  // Diagnostic: the DevTools console on a video shows "on"/"off"; undefined means the script
  // never ran, which points at the extension side rather than at YouTube.
  try { window.__simpleAdblockMain = off ? "off" : "on"; } catch {}
  if (off) return;

  const AD_KEYS = ["adPlacements", "playerAds", "adSlots", "adSlotLoggingData"];
  const scrub = data => {
    if (data && typeof data === "object") for (const k of AD_KEYS) delete data[k];
    return data;
  };
  const isPlayer = url => typeof url === "string" && url.includes("/youtubei/v1/player");
  const scrubText = text => {
    try { return JSON.stringify(scrub(JSON.parse(text))); } catch { return text; }
  };

  // YouTube assigns ytInitialPlayerResponse from an inline script; the setter scrubs it
  // before the player ever reads it. `var x = ...` on an existing accessor calls the setter.
  let playerResponse;
  Object.defineProperty(window, "ytInitialPlayerResponse", {
    configurable: true,
    get: () => playerResponse,
    set: v => { playerResponse = scrub(v); }
  });

  // Later videos (SPA navigation) fetch the player data instead, over fetch or XHR.
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = (typeof args[0] === "string" ? args[0] : args[0] && args[0].url) || "";
    const res = await origFetch.apply(this, args);
    if (!isPlayer(url)) return res;
    try {
      const data = await res.clone().json();
      return new Response(JSON.stringify(scrub(data)), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
    } catch {
      return res;
    }
  };

  // Override the prototype getters so every read is scrubbed, whichever handler ordered first.
  const XHR = window.XMLHttpRequest;
  const textDesc = XHR && Object.getOwnPropertyDescriptor(XHR.prototype, "responseText");
  const respDesc = XHR && Object.getOwnPropertyDescriptor(XHR.prototype, "response");
  if (textDesc && respDesc) {
    const open = XHR.prototype.open;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__sabPlayer = isPlayer(url);
      return open.call(this, method, url, ...rest);
    };
    Object.defineProperty(XHR.prototype, "responseText", {
      configurable: true,
      get() {
        const text = textDesc.get.call(this);
        return this.__sabPlayer && text ? scrubText(text) : text;
      }
    });
    Object.defineProperty(XHR.prototype, "response", {
      configurable: true,
      get() {
        const value = respDesc.get.call(this);
        if (!this.__sabPlayer) return value;
        if (typeof value === "string") return scrubText(value);
        return typeof value === "object" && value ? scrub(value) : value;
      }
    });
  }
})();
