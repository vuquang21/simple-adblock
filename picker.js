// Element picker: point at a banner once and keep it hidden on this site.
// This is the answer to leftover banners no network rule can drop — a same-origin <img>
// wrapped in an <a>, inside a container whose class is generated. The generic list cannot
// name such a class, and a generic guess with the wrong class is exactly the site-breaking
// mistake this extension refuses to make, so the rule is stored per host in `siteRules`.
// Loaded after cosmetic.js in the same isolated world, so it can call addHiddenRule() to
// hide the pick immediately and `isWhitelisted` from shared.js.
// shortcut: top frame only, so a banner drawn inside a third-party iframe has to be caught
// by a network rule instead of by a pick.

// Classes the site's build tool mints: 'css-1q2w3e', 'sc-bdVaJa', 'svelte-1x2y3z'. A rule
// naming one of those stops working at the next deploy, so the picker never uses them.
const PICK_JUNK = /^(css|sc|jsx|jss|emotion|svelte|styled|ng|v|radix)[-_]|[-_]{2}|^(?=.*\d)[a-z0-9]{6,}$/i;

let picking = null; // { overlay, box, handlers } while the picker is armed

function pickClasses(el) {
  const raw = typeof el.className === "string" ? el.className : "";
  return raw.split(/\s+/).filter(c => c && c.length <= 40 && !PICK_JUNK.test(c));
}

function pickNthOfType(node) {
  let i = 1;
  for (let p = node.previousElementSibling; p; p = p.previousElementSibling)
    if (p.tagName === node.tagName) i++;
  return i;
}

// A selector that survives the page's next re-render: the id when it looks hand-written,
// else the tag with its readable classes, else the position in the tree from <body> down.
// Every candidate is checked against the page first: a rule that matches nothing is a waste,
// but a rule that matches several nodes hides unrelated content, so it is not saved at all.
function pickSelector(el) {
  const tag = (el.tagName || "").toLowerCase();
  if (!tag) return "";
  const id = el.id || "";
  if (id && id.length <= 40 && !PICK_JUNK.test(id)) {
    const sel = "#" + CSS.escape(id);
    if (document.querySelectorAll(sel).length === 1) return sel;
  }
  const classes = pickClasses(el).slice(0, 2);
  if (classes.length) {
    const sel = tag + classes.map(c => "." + CSS.escape(c)).join("");
    if (document.querySelectorAll(sel).length === 1) return sel;
  }
  // Anchored at <body>, so the chain cannot match the same shape somewhere else in the page.
  const parts = [];
  for (let node = el; node && node.tagName && node !== document.body && parts.length < 12; node = node.parentElement)
    parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + pickNthOfType(node) + ")");
  const sel = parts.length ? "body > " + parts.join(" > ") : "";
  return sel && document.querySelectorAll(sel).length === 1 ? sel : "";
}

// The creative sits inside a wrapper: <img> in an <a> in the banner box. Hiding only the <img>
// leaves the wrapper's padding behind, so walk up to the *nearest* ad-shaped node — and refuse
// one that covers most of the viewport, because that is the page's own <main class="has-ads">
// and hiding it would take the article with the banner.
function pickContainer(el) {
  for (let node = el, i = 0; node && node.tagName && i < 5 && node !== document.body; i++, node = node.parentElement) {
    const cls = typeof node.className === "string" ? node.className : "";
    if (!AD_LOOK.test(node.id || "") && !AD_LOOK.test(cls)) continue;
    const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    if (r && r.width * r.height > window.innerWidth * window.innerHeight * 0.6) break;
    return node;
  }
  return el;
}

async function pickSave(selector) {
  const { siteRules = {} } = await chrome.storage.local.get("siteRules");
  // Stored on the apex, like an imported site rule, so a banner caught on www.example.com is
  // also hidden on example.com — siteRulesFor() walks the other way (apex to subdomains).
  const host = location.hostname.replace(/^www\./, "");
  const list = siteRules[host] || [];
  if (list.includes(selector)) return;
  await chrome.storage.local.set({ siteRules: { ...siteRules, [host]: [...list, selector] } });
}

// A banner is usually a third-party <iframe>, and hiding the box only fixes this site. The
// frame's host is what actually serves the ad, so it goes into the network blocklist too —
// one pick then kills the same banner on every site that shows it. A picked grid of banners
// yields one host per frame, so the whole row dies in a single click.
function pickFrameHosts(el) {
  const frames = el.tagName === "IFRAME" ? [el]
    : el.querySelectorAll ? [...el.querySelectorAll("iframe")] : [];
  const hosts = new Set();
  for (const frame of frames) {
    try {
      const src = frame.src || (frame.getAttribute && frame.getAttribute("src")) || "";
      const host = new URL(src, location.href).hostname;
      if (host && host !== location.hostname) hosts.add(host);
    } catch {
      // about:blank, blob:, srcdoc: nothing to block at the network level
    }
  }
  return [...hosts];
}

// Returns how many hosts were new, so the toast can stay honest about what a pick changed.
async function pickBlockHosts(hosts) {
  const { domains = [] } = await chrome.storage.local.get("domains");
  const added = hosts.filter(h => !domains.includes(h));
  if (!added.length) return 0;
  await chrome.storage.local.set({ domains: [...domains, ...added].sort() });
  return added.length;
}

function pickToast(text) {
  const el = document.createElement("div");
  el.setAttribute("style", "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
    "padding:8px 14px;border-radius:6px;background:#18181b;color:#fafafa;font:13px system-ui,sans-serif;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
  el.textContent = text;
  (document.body || document.documentElement).append(el);
  setTimeout(() => el.remove(), 2500);
}

function pickStop() {
  if (!picking) return;
  const { overlay, box, onKey } = picking;
  picking = null;
  window.removeEventListener("keydown", onKey, true);
  overlay.remove();
  box.remove();
}

function pickStart() {
  // A page that rewrites its <body> takes the overlay with it; re-arm instead of staying
  // "armed" on a picker that is no longer on screen.
  if (picking && picking.overlay.parentElement) return;
  if (picking) pickStop();
  if (!document.body) return;
  const box = document.createElement("div");
  box.setAttribute("style", "position:fixed;z-index:2147483646;pointer-events:none;left:0;top:0;width:0;height:0;" +
    "border:2px solid #2f6fed;background:rgba(47,111,237,.18);border-radius:2px;");
  // The overlay takes the clicks: an ad's own capture handler would otherwise see the click
  // first and could navigate away mid-pick.
  const overlay = document.createElement("div");
  overlay.setAttribute("style", "position:fixed;z-index:2147483647;left:0;top:0;right:0;bottom:0;" +
    "cursor:crosshair;background:rgba(0,0,0,.04);");
  document.body.append(box, overlay);

  // elementFromPoint would return the overlay itself, so it steps aside for the read.
  const under = (x, y) => {
    overlay.style.display = "none";
    const el = document.elementFromPoint(x, y);
    overlay.style.display = "";
    return el;
  };
  const target = e => {
    const el = under(e.clientX, e.clientY);
    return el && el !== overlay && el !== box ? pickContainer(el) : null;
  };
  const onMove = e => {
    const el = target(e);
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px"
    });
  };
  const onClick = async e => {
    e.preventDefault();
    e.stopPropagation();
    const el = target(e);
    const selector = el ? pickSelector(el) : "";
    const frameHosts = el ? pickFrameHosts(el) : [];
    pickStop();
    // No rule beats a rule that hides the wrong thing, so an unusable pick says so.
    if (!selector) return pickToast("Could not build a safe rule for this element.");
    let blocked = 0;
    try {
      await pickSave(selector);
      if (frameHosts.length) blocked = await pickBlockHosts(frameHosts);
    } catch {
      return pickToast("Could not save the rule — the list is full.");
    }
    // cosmetic.js may be an older copy when this file was injected on demand, and a pick is
    // not worth a ReferenceError after the rule is already saved.
    if (typeof addHiddenRule === "function") addHiddenRule(selector);
    pickToast(!blocked ? "Hidden on this site: " + selector
      : "Hidden here, and blocked " + frameHosts[0] + (blocked > 1 ? " +" + (blocked - 1) : "") + " everywhere");
  };
  const onKey = e => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    pickStop();
  };
  overlay.addEventListener("mousemove", onMove);
  overlay.addEventListener("click", onClick);
  window.addEventListener("keydown", onKey, true);
  picking = { overlay, box, onKey };
}

// The popup arms the picker, so a page that cannot be picked (chrome://, the Web Store)
// answers with ok:false and the popup says why instead of failing silently.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "sab-pick") return;
  chrome.storage.local.get(["enabled", "whitelist"]).then(({ enabled = true, whitelist = [] }) => {
    if (!enabled || isWhitelisted(location.hostname, whitelist)) {
      reply({ ok: false, reason: "Blocking is off for this site." });
      return;
    }
    if (document.body) {
      pickStart();
      reply({ ok: true });
      return;
    }
    // document_start: the popup can ask before <body> exists. Arm on the first paint instead
    // of refusing, so the click still lands on the real page.
    document.addEventListener("DOMContentLoaded", pickStart, { once: true });
    reply({ ok: true });
  });
  return true; // the reply is async
});
