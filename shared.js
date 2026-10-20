// Shared helpers for dashboard and popup.

// Parse a blocklist into clean domains. Handles hosts-file lines, plain domains,
// EasyList lines (||domain^, ||domain^$third-party, domain/path), and full URLs.
// Skips comments, cosmetic filters (##), exceptions (@@) and regex rules.
function parseDomains(text) {
  const out = new Set();
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === "!" || line[0] === "[") continue; // EasyList comment/header
    if (line.includes("##") || line.includes("#@#") || line.includes("#?#")) continue; // cosmetic
    if (line.startsWith("@@")) continue; // exception rule
    line = line.replace(/#.*$/, "").trim(); // hosts comment
    if (!line) continue;
    for (let token of line.split(/\s+/)) {
      token = token.split("$")[0]; // drop adblock options
      token = token.replace(/^\|\|?/, "").replace(/[\^|]+$/, "");
      if (token.includes("://")) {
        try { token = new URL(token).hostname; } catch { continue; }
      } else if (token.includes("/")) {
        token = token.split("/")[0]; // drop path
      }
      const d = token.toLowerCase().replace(/^\*\./, "");
      if (d === "localhost" || /^[0-9.:]+$/.test(d)) continue;
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) out.add(d);
    }
  }
  return [...out];
}

// Cosmetic rules a plain stylesheet cannot express (uBO/ABP procedural filters),
// plus block syntax that would be invalid CSS.
const PROCEDURAL = /[{}]|:has-text|:matches-|:xpath|:style|:upward|:remove|:min-text-length|:-abp-|:contains|:watch-attr/;

// Every selector ends up inside one generated stylesheet, so a single unbalanced quote or
// comment start would swallow the rules after it — and a site rule is written first, which
// would take the whole generic list down with it. Keep only selectors that are inert there.
function safeSelector(selector) {
  if (!selector || selector.length > 500) return false;
  if (/[\\{}]/.test(selector) || selector.includes("/*") || selector.includes("*/")) return false;
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '"' || ch === "'") {
      const end = selector.indexOf(ch, i + 1);
      if (end < 0) return false; // unterminated string: the brace after it would not count
      i = end;
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return false;
      depth--;
    }
  }
  return depth === 0;
}

// Pull the element-hiding selectors (##selector) out of an EasyList-style list.
// Only generic rules are kept: 'example.com##.ad' would hide .ad on every site,
// which is exactly the site-breaking guess this extension should not make.
function parseCosmetic(text) {
  const out = new Set();
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (line.indexOf("##") !== 0) continue; // scoped (#@# has no "##", plain lines neither)
    const sel = line.slice(2).trim();
    if (sel && !PROCEDURAL.test(sel) && safeSelector(sel)) out.add(sel);
  }
  return [...out];
}

// Site-scoped element-hiding rules ('example.com##.banner') hide a class on that site only.
// They are what catches ad containers with build-generated names: the generic list cannot
// name them, and applying the same guess everywhere would hide real content elsewhere.
// shortcut: entity (example.*) and wildcard (*##.ad) rules are dropped; those need ABP's
// domain matcher, and dropping them only costs a missed hide.
const SCOPED_HOST = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

function parseScopedCosmetic(text) {
  const out = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === "!") continue;
    const at = line.indexOf("##");
    // at < 1 is a generic rule (parseCosmetic's job) or #@# / #?# / #$#, which are not CSS.
    if (at < 1) continue;
    const sel = line.slice(at + 2).trim();
    if (!sel || sel[0] === "^" || PROCEDURAL.test(sel) || !safeSelector(sel)) continue; // ^ = HTML filtering
    const hosts = line.slice(0, at).split(",").map(h => h.trim().toLowerCase());
    const excused = hosts.filter(h => h[0] === "~").map(h => h.slice(1).replace(/^www\./, ""));
    for (let host of hosts) {
      if (host[0] === "~") continue; // exception domain: it gets no rule of its own
      host = host.replace(/^\*\./, "").replace(/^www\./, "");
      if (!SCOPED_HOST.test(host)) continue; // example.*, $entity and oddities stay out
      // '~example.com' cancels the rule for example.com and everything under it.
      // shortcut: 'example.com,~shop.example.com' still reaches shop.example.com, because a
      // rule is stored per host and siteRulesFor() spreads it down the subdomains.
      if (excused.some(e => host === e || host.endsWith("." + e))) continue;
      (out[host] || (out[host] = new Set())).add(sel);
    }
  }
  const res = {};
  for (const h of Object.keys(out)) res[h] = [...out[h]];
  return res;
}

// Rules stored for this host: its own, plus any set on a parent domain, so a rule added on
// example.com also hides on www.example.com. Both sides are stored on the apex (`www.`
// stripped), so the reverse direction cannot silently miss.
function siteRulesFor(host, siteRules) {
  const out = [];
  const name = host.replace(/^www\./, "");
  const names = name === host ? [host] : [host, name]; // a key saved before the apex rule exists
  for (const [h, sels] of Object.entries(siteRules || {})) {
    if (!Array.isArray(sels) || !sels.length) continue;
    if (names.some(n => n === h || n.endsWith("." + h))) out.push(...sels);
  }
  return out;
}

// Importing a full EasyList yields tens of thousands of scoped rules, and storage.local is
// quota-limited, so a merge stops at a selector count *and* a byte budget: selectors from
// real lists run 10-500 bytes each, so a count alone does not bound the stored size.
const MAX_SITE_RULES = 20000;
const MAX_SITE_BYTES = 2000000;

function mergeSiteRules(prev, found, max = MAX_SITE_RULES) {
  const out = {};
  let total = 0;
  let bytes = 2; // the empty object
  for (const [h, sels] of Object.entries(prev || {})) {
    if (!Array.isArray(sels) || !sels.length) continue;
    out[h] = [...new Set(sels)];
    total += out[h].length;
    bytes += h.length + out[h].reduce((n, s) => n + s.length + 3, 6);
  }
  let added = 0;
  for (const [h, sels] of Object.entries(found || {})) {
    const list = out[h] || (out[h] = []);
    for (const s of sels) {
      if (total >= max || bytes + s.length > MAX_SITE_BYTES) return { siteRules: out, added };
      if (list.includes(s)) continue;
      list.push(s);
      total++;
      added++;
      bytes += s.length + 3;
    }
  }
  return { siteRules: out, added };
}

// Host is the site itself or a subdomain of a whitelisted site.
function isWhitelisted(host, whitelist) {
  return whitelist.some(w => host === w || host.endsWith("." + w));
}

// Allow rules (whitelist) get their own id range so they can never collide with
// the block rule ids, which are handed out from 1 upwards.
const WHITELIST_ID_BASE = 1000000;

async function getState() {
  const { enabled = true, domains = [], whitelist = [], cosmetic = [], siteRules = {}, autoHide = true } =
    await chrome.storage.local.get(["enabled", "domains", "whitelist", "cosmetic", "siteRules", "autoHide"]);
  return { enabled, domains, whitelist, cosmetic, siteRules, autoHide };
}

async function setDomains(domains) {
  await chrome.storage.local.set({ domains: [...new Set(domains)].sort() });
}

// Hostname hint for a likely ad/tracker request. The leading [.-] boundary keeps words
// like "soundtrack" or "myads" from matching, so only whole host labels count.
const AD_WORDS = ["ads?", "adserv\\w*", "advert\\w*", "banner\\w*", "track\\w*", "analytics", "pixel", "beacon", "sponsor\\w*", "popunder"];
// Distinctive network names from the families the default list covers. Plain words a normal
// site could also use ("adjust", "branch", "convert", "crisp") deliberately stay out.
const AD_BRANDS = [
  // ad networks, exchanges, ad servers
  "doubleclick", "taboola", "outbrain", "criteo", "pubmatic", "rubicon", "appnexus", "openx", "adsystem", "adnxs",
  "adform", "adroll", "adservice", "adition", "yieldlab", "casalemedia", "33across", "sharethrough", "sonobi", "spotx",
  "sovrn", "lijit", "tremorhub", "bidswitch", "stackadapt", "triplelift", "yieldmo", "gumgum", "smaato", "seedtag",
  "loopme", "teads", "smartadserver", "adsrvr", "adsterra", "propellerads", "popads", "adcash", "exoclick", "juicyads",
  "mgid", "revcontent", "dable", "zemanta", "moatads", "doubleverify", "adsafeprotected", "ezoic", "mediavine", "monumetric",
  "freestar", "playwire", "adyoulike", "adbutler", "bidvertiser", "infolinks", "kontera", "zedo", "buysellads", "carbonads",
  "adpushup", "setupad", "snigelweb",
  // mobile SDKs
  "adcolony", "applovin", "inmobi", "vungle", "chartboost", "mopub", "startapp", "ironsrc", "unityads", "tapsense",
  "mintegral", "appnext", "fyber", "supersonicads", "airpush", "revmob", "kochava", "appsflyer",
  // video ad servers
  "adswizz", "freewheel", "fwmrm", "aniview", "connatix", "primis", "vidazoo", "adsbynimbus", "tritondigital", "targetspot",
  "springserve", "stickyadstv", "unruly", "beachfront", "innovid", "imrworldwide", "anyclip", "vidora", "sekindo",
  // analytics, telemetry, fingerprinting, identity
  "quantserve", "scorecardresearch", "scorecard", "demdex", "omtrdc", "krxd", "rlcdn", "agkn", "mathtag", "tapad",
  "exelator", "mparticle", "lotame", "bluekai", "hotjar", "fullstory", "mixpanel", "amplitude", "flurry", "posthog",
  "matomo", "plausible", "statcounter", "getclicky", "histats", "fingerprintjs", "fpjs", "deviceatlas", "threatmetrix", "siftscience",
  "forter", "kount", "signifyd", "blueconic", "cquotient", "tealium", "ensighten",
  // A/B testing and experimentation
  "optimizely", "vwo", "abtasty", "kameleoon", "googleoptimize", "crazyegg", "monetate", "evolv", "conductrics", "qubit", "richrelevance",
  // error trackers / RUM
  "sentry", "bugsnag", "rollbar", "logrocket", "raygun", "airbrake", "trackjs", "atatus", "honeybadger", "datadoghq",
  "newrelic", "dynatrace", "appdynamics",
  // affiliate networks and link redirectors
  "awin\\w*", "impactradius", "shareasale", "clickbank", "linksynergy", "tradedoubler", "webgains", "tradetracker", "flexoffers", "skimresources",
  "viglink", "partnerize", "pepperjam", "hasoffers",
  // email tracking, live chat, support widgets
  "mailchimp", "mandrill", "hubspot", "sendgrid", "livechatinc", "tawk", "zendesk", "intercom", "driftt", "olark",
  "tidio", "freshchat", "helpscout", "liveperson", "userlike", "sendbird", "zdassets", "zopim",
  // consent managers
  "onetrust", "cookiebot", "usercentrics", "trustarc", "didomi", "osano", "iubenda", "cookieyes", "cookiefirst", "sourcepoint",
  "crownpeak", "evidon", "quantcast", "consentmanager",
  // OEM / device ad telemetry
  "samsungads", "samsungacr", "lgads",
  // social trackers
  "addthis", "sharethis"
];
const AD_HINT = new RegExp("(^|[.-])(" + AD_WORDS.concat(AD_BRANDS).join("|") + ")([.-]|$)");

// A container whose id/class reads like an ad slot. Banner farms randomize the inner class but
// keep a readable wrapper ('banner-quang-cao', 'ads-top', 'mgid-wrap'), so this is what the
// picker walks up with and what auto-hide.js judges a box by.
const AD_LOOK = /(^|[-_ ])(ad|ads|adv|advert\w*|banner\w*|sponsor\w*|promo\w*|quang-?cao|qc)([-_ ]|$)/i;

// Naive eTLD+1 (last two labels). shortcut: wrong for co.uk-style suffixes, which
// only costs a missed detection, never a wrong block.
function baseDomain(host) {
  return host.split(".").slice(-2).join(".");
}
