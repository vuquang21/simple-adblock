// Runs picker.js against a fake DOM to verify the whole pick: arm, hover, click, save, hide.
// The fake only understands the selector shapes the picker generates (#id, tag.class,
// tag:nth-of-type(n) > …), which is exactly what needs checking.
// Run: node test/picker.test.js
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

function node(tag, { id = "", cls = "", rect } = {}, ...kids) {
  const n = {
    tagName: tag.toUpperCase(),
    id,
    className: cls,
    children: [],
    parentElement: null,
    style: {},
    textContent: "",
    listeners: {},
    setAttribute() {},
    append(...list) {
      for (const k of list) { k.parentElement = n; n.children.push(k); }
    },
    remove() {
      const p = n.parentElement;
      if (p) p.children = p.children.filter(c => c !== n);
      n.parentElement = null;
    },
    addEventListener(type, fn) { (n.listeners[type] || (n.listeners[type] = [])).push(fn); },
    getBoundingClientRect: () => n.rect || { left: 10, top: 20, width: 300, height: 100 },
    querySelectorAll(sel) {
      const want = sel.toLowerCase();
      const hits = [];
      const walk = k => {
        for (const c of k.children) {
          if (c.tagName && c.tagName.toLowerCase() === want) hits.push(c);
          walk(c);
        }
      };
      walk(n);
      return hits;
    },
    querySelector(sel) {
      return n.querySelectorAll(sel)[0] || null;
    },
    get previousElementSibling() {
      const p = n.parentElement;
      if (!p) return null;
      const i = p.children.indexOf(n);
      return i > 0 ? p.children[i - 1] : null;
    }
  };
  n.append(...kids);
  return n;
}

function nthOfType(n) {
  let i = 1;
  for (let p = n.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === n.tagName) i++;
  return i;
}

function parsePart(part) {
  const nth = /:nth-of-type\((\d+)\)$/.exec(part);
  const rest = nth ? part.slice(0, nth.index) : part;
  const out = { tag: null, id: null, classes: [], nth: nth ? +nth[1] : null };
  for (const t of rest.match(/^[a-z0-9*]+|[.#][^.#]+/gi) || []) {
    if (t[0] === ".") out.classes.push(t.slice(1));
    else if (t[0] === "#") out.id = t.slice(1);
    else out.tag = t.toLowerCase();
  }
  return out;
}

function matchPart(n, p) {
  if (!n || !n.tagName) return false;
  if (p.tag && p.tag !== "*" && n.tagName.toLowerCase() !== p.tag) return false;
  if (p.id && n.id !== p.id) return false;
  const cls = (n.className || "").split(/\s+/);
  for (const c of p.classes) if (!cls.includes(c)) return false;
  return !p.nth || nthOfType(n) === p.nth;
}

function queryAll(root, selector) {
  const parts = selector.split(" > ").map(parsePart);
  const hits = [];
  const walk = n => {
    for (const child of n.children) {
      let cur = child, ok = true;
      for (let i = parts.length - 1; i >= 0 && ok; i--) {
        ok = matchPart(cur, parts[i]);
        cur = cur.parentElement;
      }
      if (ok) hits.push(child);
      walk(child);
    }
  };
  walk(root);
  return hits;
}

// body > #main > (div.ad-wrapper.banner-quang-cao > a > img, div.content > p),
// and body > div.css-1q2w3e > span.sc-bdVaJa for the generated-class case.
function makePage(hostname) {
  const img = node("img", { cls: "some-img" });
  const link = node("a", { cls: "link" }, img);
  const banner = node("div", { cls: "ad-wrapper banner-quang-cao" }, link);
  const content = node("div", { cls: "content" }, node("p", { cls: "paragraph" }));
  const main = node("div", { id: "main" }, banner, content);
  const body = node("body", {}, main);
  const junk = node("div", { cls: "css-1q2w3e" }, node("span", { cls: "sc-bdVaJa" }));
  body.append(junk);

  const injected = [];
  const head = { append: el => { el.parentElement = head; injected.push(el); } };
  const document = {
    body,
    head,
    documentElement: head,
    createElement: tag => node(tag),
    querySelectorAll: sel => queryAll(body, sel),
    elementFromPoint: () => img,
    getElementById: () => null
  };
  return { document, location: { hostname, href: "https://" + hostname + "/xem-phim/1" }, banner, img, body, main, junk, injected };
}

function load(page, store) {
  const msgListeners = [];
  const winListeners = {};
  const sandbox = {
    chrome: {
      storage: { local: {
        get: async keys => {
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in store) out[k] = store[k];
          return out;
        },
        set: async obj => Object.assign(store, obj)
      } },
      runtime: { onMessage: { addListener: fn => msgListeners.push(fn) } }
    },
    document: page.document,
    location: page.location,
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener: (type, fn) => (winListeners[type] || (winListeners[type] = [])).push(fn),
      removeEventListener: (type, fn) => {
        winListeners[type] = (winListeners[type] || []).filter(f => f !== fn);
      }
    },
    localStorage: { setItem() {} },
    URL,
    CSS: { escape: s => s },
    setInterval: () => 0,
    setTimeout,
    isFinite
  };
  vm.createContext(sandbox);
  for (const f of ["shared.js", "cosmetic-rules.js", "cosmetic.js", "picker.js"]) {
    vm.runInContext(fs.readFileSync(__dirname + "/../" + f, "utf8"), sandbox);
  }
  return { sandbox, msgListeners, winListeners };
}

const flush = () => new Promise(r => setTimeout(r, 0));
// Everything the picker adds to the page, minus the confirmation toast (which lives 2.5s).
const extras = page => page.body.children
  .filter(c => c !== page.main && c !== page.junk)
  .filter(c => !String(c.textContent).startsWith("Hidden "));
// Objects created inside the vm belong to another realm, so deepStrictEqual would compare
// prototypes and always fail; the round-trip brings them back to this one.
const plain = v => JSON.parse(JSON.stringify(v));
const evt = { clientX: 50, clientY: 60, preventDefault() {}, stopPropagation() {} };
// The picker's own overlays are the only children body gains; the toast self-removes.
const overlays = body => body.children.filter(c => c.listeners.click || c.listeners.mousemove);

(async () => {
  const page = makePage("phim.example");
  const store = { enabled: true, whitelist: [] };
  const { sandbox, msgListeners, winListeners } = load(page, store);
  await flush();
  assert.strictEqual(msgListeners.length, 1, "the picker must listen for the popup's message");

  // Arming from the popup puts a highlight box and a click-catching overlay on the page.
  let reply = null;
  msgListeners[0]({ type: "sab-pick" }, {}, r => (reply = r));
  await flush();
  assert.strictEqual(reply.ok, true, "an eligible page arms the picker");
  assert.strictEqual(extras(page).length, 2, "the highlight box and the overlay are added");

  const overlay = extras(page)[1];
  overlay.listeners.mousemove[0](evt);
  assert.strictEqual(extras(page)[0].style.width, "300px", "the box follows the hovered banner");

  // One click saves the wrapper — not the inner <img> — and hides it right away.
  overlay.listeners.click[0](evt);
  await flush();
  await flush();
  assert.deepStrictEqual(plain(store.siteRules), { "phim.example": ["div.ad-wrapper.banner-quang-cao"] },
    "the ad wrapper is stored as a site rule");
  assert.strictEqual(extras(page).length, 0, "the picker cleans up after itself");
  assert.ok(page.body.children.some(c => String(c.textContent).startsWith("Hidden on this site")),
    "the pick confirms itself by naming the saved rule");
  assert.ok(page.injected[0].textContent.includes("div.ad-wrapper.banner-quang-cao{display:none!important}"),
    "the picked rule joins the live stylesheet, so no reload is needed");

  // Escape cancels and saves nothing.
  msgListeners[0]({ type: "sab-pick" }, {}, r => (reply = r));
  await flush();
  assert.strictEqual(extras(page).length, 2, "the picker can be armed again");
  winListeners.keydown[0]({ key: "Escape", preventDefault() {} });
  assert.strictEqual(extras(page).length, 0, "Escape removes the overlay and the box");
  assert.deepStrictEqual(plain(store.siteRules), { "phim.example": ["div.ad-wrapper.banner-quang-cao"] },
    "a cancelled pick must not write a rule");

  // A whitelisted or switched-off site refuses instead of arming.
  const allowed = makePage("allowed.example");
  const refused = load(allowed, { enabled: true, whitelist: ["allowed.example"] });
  await flush();
  let answer = null;
  refused.msgListeners[0]({ type: "sab-pick" }, {}, r => (answer = r));
  await flush();
  assert.strictEqual(answer.ok, false, "a whitelisted site must refuse a pick");
  assert.strictEqual(extras(allowed).length, 0, "nothing is added to a whitelisted page");

  // Selector generation: a build-generated class never ends up in a rule, and the positional
  // fallback still targets exactly the picked node.
  const junkSel = sandbox.pickSelector(page.junk);
  assert.ok(!/css-1q2w3e|sc-bdVaJa/.test(junkSel), `a generated class leaked into ${junkSel}`);
  assert.ok(junkSel.startsWith("body > "), `the positional fallback must be anchored at body: ${junkSel}`);
  assert.deepStrictEqual(queryAll(page.body, junkSel), [page.junk], "the fallback must match the picked node alone");
  const spanSel = sandbox.pickSelector(page.junk.children[0]);
  assert.ok(!/css-1q2w3e|sc-bdVaJa/.test(spanSel), `a generated class leaked into ${spanSel}`);
  assert.deepStrictEqual(queryAll(page.body, spanSel), [page.junk.children[0]], "the fallback must be unique");

  // A page-level wrapper that merely mentions ads ('<main class="has-ads">') is not the ad:
  // hiding it would take the article with the banner, so the pick stops at the banner itself.
  const full = { left: 0, top: 0, width: 1200, height: 800 };
  const inner = node("div", { cls: "ad-slot", rect: { left: 0, top: 0, width: 300, height: 250 } },
    node("a", { cls: "link" }, node("img", { cls: "creative" })));
  const whole = node("main", { cls: "has-ads", rect: full }, inner);
  const wideBody = node("body", {}, whole);
  assert.strictEqual(sandbox.pickContainer(inner.children[0].children[0]), inner,
    "the nearest ad-shaped wrapper wins over the page wrapper");
  assert.strictEqual(sandbox.pickContainer(whole.children[0]), inner,
    "a wrapper covering most of the viewport is never the pick target");

  // The rule lands on the apex, so a banner caught on www.example also hides on example.com.
  const wwwPage = makePage("www.phim.example");
  const wwwStore = { enabled: true, whitelist: [] };
  const www = load(wwwPage, wwwStore);
  await flush();
  www.msgListeners[0]({ type: "sab-pick" }, {}, () => {});
  await flush();
  extras(wwwPage)[1].listeners.click[0](evt);
  await flush();
  await flush();
  assert.deepStrictEqual(Object.keys(plain(wwwStore.siteRules)), ["phim.example"],
    "a pick on www.* is stored on the apex");

  // A picked <iframe> banner is a third-party ad server: hiding the box only fixes this page,
  // so the frame's host joins the network blocklist too and the toast names what was blocked.
  const framePage = makePage("phim.example");
  const frameStore = { enabled: true, whitelist: [] };
  const advFrame = node("iframe", { cls: "ad-frame" });
  advFrame.src = "https://ads.hitclub-quangcao.example/serve?slot=1";
  const otherFrame = node("iframe", { cls: "ad-frame" });
  otherFrame.src = "https://banner.789win-quangcao.example/serve?slot=2";
  const sitePlayer = node("iframe", { cls: "player" });
  sitePlayer.src = "https://phim.example/player/1";
  const grid = node("div", { cls: "ad-slot" }, advFrame, otherFrame, sitePlayer);
  framePage.body.append(grid);
  // Clicking anywhere in the grid picks the whole row, so every ad frame in it is collected.
  framePage.document.elementFromPoint = () => grid;
  const fp = load(framePage, frameStore);
  await flush();
  fp.msgListeners[0]({ type: "sab-pick" }, {}, () => {});
  await flush();
  extras(framePage).find(c => c.listeners.click).listeners.click[0](evt);
  await flush();
  await flush();
  // Whatever the frame or its wrapper is called, both halves of the pick are stored.
  assert.deepStrictEqual(Object.keys(plain(frameStore.siteRules)), ["phim.example"],
    "the cosmetic half still lands on the site rule");
  assert.deepStrictEqual(plain(frameStore.domains),
    ["ads.hitclub-quangcao.example", "banner.789win-quangcao.example"],
    "every third-party frame in the picked box is blocked, the site's own player is not");
  assert.ok(framePage.body.children.some(c => /blocked ads\.hitclub[^]*\+1 everywhere/.test(String(c.textContent))),
    "the toast says which hosts were blocked everywhere");

  // Frames with no third-party host are cosmetic-only: nothing is added to the blocklist.
  const sameOrigin = node("iframe", {});
  sameOrigin.src = "https://phim.example/player/1";
  assert.deepStrictEqual(plain(sandbox.pickFrameHosts(sameOrigin)), [], "a same-origin frame has no host to block");
  const blankFrame = node("iframe", {});
  blankFrame.src = "about:blank";
  assert.deepStrictEqual(plain(sandbox.pickFrameHosts(blankFrame)), [], "about:blank has nothing to block");
  assert.deepStrictEqual(plain(sandbox.pickFrameHosts(node("div", { cls: "ad-slot" }))), [],
    "a wrapper without a frame blocks nothing");
  const twice = node("div", { cls: "ad-slot" }, node("iframe", {}), node("iframe", {}));
  for (const f of twice.children) f.src = "https://one-ad-server.example/a";
  assert.deepStrictEqual(plain(sandbox.pickFrameHosts(twice)), ["one-ad-server.example"],
    "the same host in two frames is blocked once");

  // Picking something already blocked adds nothing and does not claim it did.
  const again = load(makePage("phim.example"), { enabled: true, whitelist: [], domains: ["a.example"] });
  await flush();
  assert.strictEqual(await again.sandbox.pickBlockHosts(["a.example"]), 0, "a known host is not re-added");
  assert.strictEqual(await again.sandbox.pickBlockHosts(["b.example", "c.example"]), 2,
    "new hosts are counted so the toast can report them");

  console.log("picker: OK");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
