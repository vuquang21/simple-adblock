// Runs auto-hide.js against a fake DOM: the point of this file is that it decides *not* to hide
// far more often than it decides to hide, so the guards get as many cases as the detections do.
// Run: node test/auto-hide.test.js
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

function node(tag, { id = "", cls = "", rect, src = "", href = "" } = {}, ...kids) {
  const n = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    className: cls,
    src,
    href,
    children: [],
    parentElement: null,
    attrs: {},
    textContent: "",
    rect,
    setAttribute(k, v) { n.attrs[k] = v; },
    getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; },
    append(...list) { for (const k of list) { k.parentElement = n; n.children.push(k); } },
    remove() {
      const p = n.parentElement;
      if (p) p.children = p.children.filter(c => c !== n);
      n.parentElement = null;
    },
    getBoundingClientRect: () => n.rect || { left: 0, top: 0, width: 300, height: 100 },
    // Understands the shapes auto-hide.js asks for: "a, b[href]", "img, iframe, picture".
    querySelectorAll(sel) {
      const want = sel.split(",").map(s => s.trim().split(/[[ :]/)[0].toLowerCase());
      const hits = [];
      const walk = k => {
        for (const c of k.children) {
          if (c.tagName && want.includes(c.tagName.toLowerCase())) hits.push(c);
          walk(c);
        }
      };
      walk(n);
      return hits;
    },
    querySelector(sel) { return n.querySelectorAll(sel)[0] || null; }
  };
  n.append(...kids);
  return n;
}

function load(page, store) {
  const observers = [];
  const docListeners = {};
  const head = { children: [], append: el => { el.parentElement = head; head.children.push(el); } };
  const document = {
    body: page.body,
    head,
    documentElement: head,
    readyState: "complete",
    createElement: tag => node(tag),
    addEventListener: (type, fn) => ((docListeners[type] || (docListeners[type] = [])).push(fn))
  };
  const sandbox = {
    chrome: {
      storage: { local: {
        get: async keys => {
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in store) out[k] = store[k];
          return out;
        },
        set: async obj => Object.assign(store, obj)
      } }
    },
    document,
    location: { hostname: page.host, href: "https://" + page.host + "/tap-1" },
    window: { innerWidth: 1200, innerHeight: 800 },
    MutationObserver: function (cb) {
      observers.push(cb);
      this.observe = () => {};
      this.disconnect = () => {};
    },
    URL,
    setTimeout,
    WeakSet,
    Set
  };
  vm.createContext(sandbox);
  for (const f of ["shared.js", "auto-hide.js"]) {
    vm.runInContext(fs.readFileSync(__dirname + "/../" + f, "utf8"), sandbox);
  }
  return { sandbox, observers, docListeners, head };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hidden = n => n.attrs["data-sab-auto"] === "1";

// One page holding every case at once: each node is named after what it must prove.
function makePage(host = "animevs.example") {
  const banner = { width: 728, height: 90 };
  const whole = { width: 1200, height: 800 };
  const cases = {
    // Must be hidden.
    adFrame: node("iframe", { src: "https://ads.taboola.com/serve?slot=1", rect: banner }),
    blockedLink: node("div", { cls: "banner-quang-cao", rect: banner },
      node("a", { href: "https://hitclub.com/dang-ky" }, node("img", { rect: banner }))),
    namedBox: node("div", { cls: "ad-box", rect: { width: 300, height: 250 } }, node("img", {})),
    // Must be left alone.
    menu: node("div", { cls: "ads-menu", rect: { width: 300, height: 250 } },
      node("img", {}), ...Array.from({ length: 15 }, (_, i) => node("a", { href: "/m/" + i }))),
    noCreative: node("div", { cls: "ad-slot", rect: { width: 300, height: 250 } }),
    ownPlayer: node("iframe", { src: "https://animevs.example/player/1", rect: banner }),
    article: node("article", { cls: "ad-story", rect: { width: 300, height: 250 } }, node("img", {})),
    pageWrapper: node("div", { cls: "ad-page", rect: whole }, node("img", { rect: whole })),
    withVideo: node("div", { cls: "ad-player", rect: { width: 300, height: 250 } }, node("video", {})),
    tinyLink: node("a", { href: "https://789win.com/", rect: { width: 90, height: 20 } }, node("span", {}))
  };
  const main = node("div", { id: "main" }, ...Object.values(cases));
  const body = node("body", {}, main);
  return { host, body, cases };
}

(async () => {
  const page = makePage();
  const store = { enabled: true, whitelist: [], domains: ["hitclub.com", "sun88.club"] };
  const { sandbox, observers, head } = load(page, store);
  await flush();

  const { cases } = page;
  assert.strictEqual(hidden(cases.adFrame), true, "a third-party frame on an ad host is hidden");
  assert.strictEqual(hidden(cases.blockedLink), true,
    "a box whose link points at an already-blocked host is hidden");
  assert.strictEqual(hidden(cases.namedBox), true, "an ad-named box holding a creative is hidden");
  assert.strictEqual(head.children.length, 1, "one stylesheet, not one per hidden node");
  assert.ok(head.children[0].textContent.includes("[data-sab-auto]{display:none!important}"),
    "hiding is one attribute rule, so the site's class churn cannot outlive it");

  assert.strictEqual(hidden(cases.menu), false, "a block of links with an image is a menu, not a banner");
  assert.strictEqual(hidden(cases.noCreative), false, "an ad-named box with nothing inside is left alone");
  assert.strictEqual(hidden(cases.ownPlayer), false, "the site's own player is never hidden");
  assert.strictEqual(hidden(cases.article), false, "an <article> is never hidden, whatever its classes say");
  assert.strictEqual(hidden(cases.pageWrapper), false, "a box covering the viewport is the page, not the ad");
  assert.strictEqual(hidden(cases.withVideo), false, "a box holding a <video> is the player, not the ad");
  assert.strictEqual(hidden(cases.tinyLink), false,
    "a 90x20 link is a text link: hiding it buys nothing and breaks the page");

  // A banner built after load is caught by the observer, once, after the debounce.
  const late = node("div", { cls: "banner-chot", rect: { width: 728, height: 90 } }, node("img", {}));
  page.body.append(late);
  assert.strictEqual(hidden(late), false, "nothing is hidden before the debounced pass runs");
  observers[0]([{ addedNodes: [late] }]);
  await sleep(450);
  assert.strictEqual(hidden(late), true, "a banner inserted after load is hidden too");

  // The switch and the whitelist both mean "do nothing at all".
  for (const [label, settings] of [
    ["the auto-hide switch is off", { enabled: true, autoHide: false, whitelist: [], domains: [] }],
    ["the site is whitelisted", { enabled: true, whitelist: ["animevs.example"], domains: [] }],
    ["blocking is off", { enabled: false, whitelist: [], domains: [] }]
  ]) {
    const off = makePage();
    const loaded = load(off, settings);
    await flush();
    assert.strictEqual(loaded.head.children.length, 0, `no stylesheet is injected when ${label}`);
    assert.strictEqual(hidden(off.cases.adFrame), false, `nothing is hidden when ${label}`);
    assert.strictEqual(loaded.observers.length, 0, `no observer is installed when ${label}`);
  }

  // A cap keeps one bad regex from emptying a page: past AUTO_MAX_HIDES the pass stops.
  const flood = makePage();
  flood.body.append(...Array.from({ length: 60 }, () =>
    node("div", { cls: "ad-x", rect: { width: 300, height: 250 } }, node("img", {}))));
  const flooded = load(flood, { enabled: true, whitelist: [], domains: [] });
  await flush();
  const hiddenCount = flood.body.querySelectorAll("div, iframe").filter(hidden).length;
  assert.strictEqual(hiddenCount, 40, "at most 40 boxes are hidden per page");

  console.log("auto-hide: OK");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
