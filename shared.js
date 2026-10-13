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

// Pull the element-hiding selectors (##selector) out of an EasyList-style list.
// Only generic rules are kept: 'example.com##.ad' would hide .ad on every site,
// which is exactly the site-breaking guess this extension should not make.
// shortcut: domain-scoped cosmetic rules are dropped, so sites that only break
// with their own selectors need the selector added to the list by hand.
function parseCosmetic(text) {
  const out = new Set();
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (line.indexOf("##") !== 0) continue; // scoped (#@# has no "##", plain lines neither)
    const sel = line.slice(2).trim();
    if (sel && !PROCEDURAL.test(sel)) out.add(sel);
  }
  return [...out];
}

// Host is the site itself or a subdomain of a whitelisted site.
function isWhitelisted(host, whitelist) {
  return whitelist.some(w => host === w || host.endsWith("." + w));
}

// Allow rules (whitelist) get their own id range so they can never collide with
// the block rule ids, which are handed out from 1 upwards.
const WHITELIST_ID_BASE = 1000000;

async function getState() {
  const { enabled = true, domains = [], whitelist = [], cosmetic = [] } =
    await chrome.storage.local.get(["enabled", "domains", "whitelist", "cosmetic"]);
  return { enabled, domains, whitelist, cosmetic };
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

// Naive eTLD+1 (last two labels). shortcut: wrong for co.uk-style suffixes, which
// only costs a missed detection, never a wrong block.
function baseDomain(host) {
  return host.split(".").slice(-2).join(".");
}
