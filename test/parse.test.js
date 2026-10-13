// Self-check for parseDomains. Run: node test/parse.test.js
const fs = require("fs");
const assert = require("assert");

// Load shared.js and expose its helpers.
const src = fs.readFileSync(__dirname + "/../shared.js", "utf8");
const { parseDomains, parseCosmetic, isWhitelisted, AD_HINT, baseDomain } =
  new Function(src + "; return { parseDomains, parseCosmetic, isWhitelisted, AD_HINT, baseDomain };")();

const input = `
# comment line
0.0.0.0 ads.example.com
127.0.0.1 tracker.example.net  # inline comment
plain.example.org
localhost
1.2.3.4
not a domain
UPPER.example.COM

! EasyList comment
[Adblock Plus 2.0]
||banner.example.com^
||beacon.example.com^$third-party
||pixel.example.com/path^
example.com##.ad-banner
@@||allowed.example.com^
/^https:\/\/regex\\.example\\.com/
https://cdn.example.com/script.js
*.wild.example.com
`;
const got = parseDomains(input);
assert.deepStrictEqual(got.sort(), [
  "ads.example.com",
  "banner.example.com",
  "beacon.example.com",
  "cdn.example.com",
  "pixel.example.com",
  "plain.example.org",
  "tracker.example.net",
  "upper.example.com",
  "wild.example.com"
]);
// Exception (@@) and cosmetic (##) rules must not be blocked.
assert.ok(!got.includes("allowed.example.com"), "@@ exception must be skipped");
assert.deepStrictEqual(parseDomains(""), []);
console.log("parseDomains: OK");

// Element-hiding rules: only generic ones a plain stylesheet can express.
assert.deepStrictEqual(
  parseCosmetic(
    [
      "##.ad-banner",
      "##.sponsor, .promo-box",
      "example.com##.side-ad", // scoped: would hide .side-ad on every site
      "##.ad:has-text(Sponsored)", // procedural, needs uBO's engine
      "##.ad > div{color:red}", // not a selector
      "#@#.ad-banner", // exception
      "! a comment",
      ""
    ].join("\n")
  ).sort(),
  [".ad-banner", ".sponsor, .promo-box"]
);
console.log("parseCosmetic: OK");

// A whitelisted site covers its subdomains, never a lookalike suffix.
assert.ok(isWhitelisted("example.com", ["example.com"]));
assert.ok(isWhitelisted("ads.example.com", ["example.com"]));
assert.ok(!isWhitelisted("notexample.com", ["example.com"]));
assert.ok(!isWhitelisted("example.com", []));
console.log("isWhitelisted: OK");

// Ad-detection hint: matches real ad hosts, ignores ordinary ones and substrings.
for (const h of ["ads.example.com", "doubleclick.net", "google-analytics.com", "tracker.io", "cdn.adserver.net"]) {
  assert.ok(AD_HINT.test(h), `expected AD_HINT to match ${h}`);
}
for (const h of ["example.com", "cdn.jsdelivr.net", "soundtrack.fm", "myads.example.com"]) {
  assert.ok(!AD_HINT.test(h), `expected AD_HINT to ignore ${h}`);
}
// The brand tokens added for the weak test categories must catch real ad/tracker hosts
// without tripping on ordinary domains.
for (const h of ["adcolony.com", "sub.applovin.com", "ads.pubmatic.com", "kochava.com", "static.hotjar.com", "cdn.adsterra.com", "mgid.com", "ssp.adsrvr.org", "optimizely.com", "cdn.sentry.io", "onetrust.com", "embed.tawk.to", "ezoic.net", "awin1.com", "static.cquotient.com"]) {
  assert.ok(AD_HINT.test(h), `expected AD_HINT to match ${h}`);
}
for (const h of ["adjustment.example.com", "branch.example.com", "segment.example.com", "mgidnews.com"]) {
  assert.ok(!AD_HINT.test(h), `expected AD_HINT to ignore ${h}`);
}
assert.strictEqual(baseDomain("ads.doubleclick.net"), "doubleclick.net");
assert.strictEqual(baseDomain("doubleclick.net"), "doubleclick.net");
console.log("AD_HINT/baseDomain: OK");

// The shipped default list must be clean and parse back to itself, or the seed would
// write domains the importer itself would reject.
const defaultsSrc = fs.readFileSync(__dirname + "/../default-domains.js", "utf8");
const { DEFAULT_DOMAINS } = new Function(defaultsSrc + "; return { DEFAULT_DOMAINS };")();
assert.ok(DEFAULT_DOMAINS.length > 100, "expected a real starter list");
assert.strictEqual(new Set(DEFAULT_DOMAINS).size, DEFAULT_DOMAINS.length, "no duplicate defaults");
for (const d of DEFAULT_DOMAINS) assert.deepStrictEqual(parseDomains(d), [d], `default ${d} must parse cleanly`);
// The sample hosts used for the AD_HINT negative test below must not be in the list either,
// or "detected as ad" and "already blocked" would contradict each other.
for (const d of ["adjustment.example.com", "mgidnews.com"]) assert.ok(!DEFAULT_DOMAINS.includes(d));
console.log("DEFAULT_DOMAINS: OK");
