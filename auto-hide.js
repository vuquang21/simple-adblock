// The picker is the precise tool: one banner, one click. This is the automatic one, for the
// banners a site builds at runtime that no imported list knows — their only ad signal is the
// host they link to or frame, because the brand is the point of the advertisement.
// A heuristic is judged by its two failure modes: a false positive eats the article, a false
// negative leaves one banner. So every signal here also has to survive autoShaped(), and the
// whole pass is off on a whitelisted site and behind its own switch.

const AUTO_MARK = "data-sab-auto";
const AUTO_TAGS = new Set(["IFRAME", "OBJECT", "EMBED", "INS", "IMG", "A", "DIV", "SECTION", "ASIDE"]);
// Never the page, its chrome, or the thing the visitor came for.
const AUTO_NEVER = new Set(["HTML", "BODY", "MAIN", "ARTICLE", "NAV", "HEADER", "FOOTER", "VIDEO", "FORM"]);
const AUTO_MAX_LINKS = 12;  // a menu is a list of links; a banner is one
const AUTO_MIN_AREA = 8000; // ~125x64: smaller than that is a text link
const AUTO_MAX_SHARE = 0.5; // never most of the viewport
const AUTO_MAX_HIDES = 40;  // a page that "needs" more than this is a false-positive storm

const autoSeen = new WeakSet(); // judged nodes, so a mutation elsewhere does not re-query them
const autoPending = [];         // added nodes waiting for the debounced pass
let autoBlocked = null;         // hosts this install already blocks, read once from storage
let autoSheet = null;
let autoTimer = 0;
let autoHides = 0;

function autoHostOf(url) {
  try { return new URL(url, location.href).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// A host is a signal when a list already blocks it or its name says what it does. The site's
// own host never counts: that is its content, however it is named.
function autoAdHost(host) {
  return !!host && host !== location.hostname.replace(/^www\./, "") &&
    (autoBlocked.has(host) || AD_HINT.test(host));
}

function autoUrlOf(node) {
  const attr = node.getAttribute &&
    (node.getAttribute("src") || node.getAttribute("data-src") ||
      node.getAttribute("data") || node.getAttribute("href"));
  return attr || node.src || node.href || "";
}

// A third-party frame on an ad host is unambiguous: the box is nothing but the ad.
function autoFramedAd(node) {
  const tag = node.tagName;
  if (tag !== "IFRAME" && tag !== "OBJECT" && tag !== "EMBED") return false;
  return autoAdHost(autoHostOf(autoUrlOf(node)));
}

// A link counts only when it is the box itself — an article that merely links to a brand must
// not be eaten, which is why a link found deeper is only supporting evidence in autoIsAd().
function autoLinkedAd(node) {
  return node.tagName === "A" && autoAdHost(autoHostOf(autoUrlOf(node)));
}

// Every reason not to hide the node. Without this the attribute word "banner" alone would
// take navigation bars and page wrappers with it.
function autoShaped(node) {
  if (!node.getBoundingClientRect) return false;
  const r = node.getBoundingClientRect() || {};
  const area = (r.width || 0) * (r.height || 0);
  const view = (window.innerWidth || 0) * (window.innerHeight || 0);
  if (area && area < AUTO_MIN_AREA) return false;                  // a text link, not a banner
  if (area && view && area > view * AUTO_MAX_SHARE) return false;   // the page itself
  if (node.querySelector && node.querySelector("video, article, h1, form")) return false;
  const links = node.tagName === "A" ? 1 : node.querySelectorAll ? node.querySelectorAll("a[href]").length : 0;
  return links <= AUTO_MAX_LINKS;
}

function autoIsAd(node) {
  if (!node || !node.tagName || autoSeen.has(node)) return false;
  autoSeen.add(node);
  if (!AUTO_TAGS.has(node.tagName)) return false;
  const cls = typeof node.className === "string" ? node.className : "";
  // What the picker walks up with, reused so "ad-looking" means one thing in this extension.
  const named = AD_LOOK.test(node.id || "") || AD_LOOK.test(cls);
  const strong = autoFramedAd(node) || autoLinkedAd(node);
  // A name alone proves nothing: the box also has to hold something ad-shaped.
  const creative = node.tagName === "IMG" ||
    (node.querySelector && !!node.querySelector("img, iframe, picture, canvas"));
  if (!strong && !(named && creative)) return false;
  return autoShaped(node);
}

function autoHide(node) {
  if (autoHides >= AUTO_MAX_HIDES) return false;
  autoHides++;
  node.setAttribute(AUTO_MARK, "1");
  if (!autoSheet || !autoSheet.parentElement) {
    autoSheet = document.createElement("style");
    // One attribute rule, so the site's own class churn cannot outlive it.
    autoSheet.textContent = "[" + AUTO_MARK + "]{display:none!important}";
    (document.head || document.documentElement).append(autoSheet);
  }
  return true;
}

function autoScan(root) {
  if (!root || !root.querySelectorAll) return;
  const nodes = [root, ...root.querySelectorAll("iframe, ins, img, a, div, section, aside, object, embed")];
  for (const node of nodes) if (autoIsAd(node)) autoHide(node);
}

function autoFlush() {
  autoTimer = 0;
  for (const node of autoPending.splice(0)) autoScan(node);
}

function autoStart() {
  if (!document.body) return;
  autoScan(document.body);
  new MutationObserver(records => {
    for (const rec of records) {
      for (const node of rec.addedNodes) if (node && node.nodeType === 1) autoPending.push(node);
    }
    if (autoPending.length && !autoTimer) autoTimer = setTimeout(autoFlush, 400);
  }).observe(document.documentElement, { childList: true, subtree: true });
}

// The same gate as cosmetic.js: nothing runs when blocking is off or the site is whitelisted.
// autoHide is separate because a heuristic will eventually hurt one page, and whitelisting the
// whole site is too blunt a way to say "not this one".
// shortcut: `domains` is read in full on every page load, which is a large array once a list has
// been imported; it buys the strongest signal there is ("this box links to a host we block"), so
// it is worth the read until someone measures it hurting a page.
chrome.storage.local.get(["enabled", "whitelist", "domains", "autoHide"])
  .then(({ enabled = true, whitelist = [], domains = [], autoHide = true }) => {
    if (!enabled || !autoHide) return;
    if (isWhitelisted(location.hostname, whitelist)) return;
    autoBlocked = new Set(domains.map(h => h.replace(/^www\./, "")));
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", autoStart, { once: true });
    } else {
      autoStart();
    }
  });
