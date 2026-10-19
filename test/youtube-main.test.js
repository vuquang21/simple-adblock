// Runs youtube-main.js in a vm to verify ad fields are scrubbed before YouTube reads them.
// Run: node test/youtube-main.test.js
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const code = fs.readFileSync(__dirname + "/../youtube-main.js", "utf8");

// Minimal XMLHttpRequest with accessor responses on the prototype, like the real one, so the
// script's getter override has a native descriptor to wrap.
function makeXHR() {
  class FakeXHR {
    open() {}
    send() {}
  }
  Object.defineProperty(FakeXHR.prototype, "responseText", {
    configurable: true,
    get() { return this.__text; },
    set(v) { this.__text = v; }
  });
  Object.defineProperty(FakeXHR.prototype, "response", {
    configurable: true,
    get() { return this.__text; }
  });
  return FakeXHR;
}

// window is the sandbox's global object, so a MAIN-world defineProperty behaves as it does
// on a real page. fetchImpl stands in for the page's fetch and must exist before load.
function load(fetchImpl, XHR, localStorage) {
  const sandbox = { Response, console };
  sandbox.window = sandbox;
  if (fetchImpl) sandbox.fetch = fetchImpl;
  if (XHR) sandbox.XMLHttpRequest = XHR;
  if (localStorage) sandbox.localStorage = localStorage;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

const playerBody = () => ({
  adPlacements: [{ adPlacementRenderer: {} }],
  playerAds: [{}],
  adSlots: [{}],
  adSlotLoggingData: {},
  streamingData: { formats: [1] }
});

(async () => {
  // ytInitialPlayerResponse is scrubbed the moment it is assigned.
  const s = load(async () => {});
  assert.strictEqual(s.__simpleAdblockMain, "on", "the diagnostic marker should report the hook is active");
  s.ytInitialPlayerResponse = playerBody();
  assert.ok(!("adPlacements" in s.ytInitialPlayerResponse), "adPlacements must be removed");
  assert.ok(!("playerAds" in s.ytInitialPlayerResponse), "playerAds must be removed");
  assert.ok(!("adSlots" in s.ytInitialPlayerResponse), "adSlots must be removed");
  assert.ok(!("adSlotLoggingData" in s.ytInitialPlayerResponse), "adSlotLoggingData must be removed");
  assert.deepStrictEqual(s.ytInitialPlayerResponse.streamingData, { formats: [1] }, "video data must survive");

  // fetch: /youtubei/v1/player responses are scrubbed in flight.
  const s2 = load(async () =>
    new Response(JSON.stringify(playerBody()), { headers: { "content-type": "application/json" } }));
  const player = await (await s2.fetch("https://www.youtube.com/youtubei/v1/player?key=abc")).json();
  assert.ok(!("adPlacements" in player), "adPlacements must be stripped from the player response");
  assert.deepStrictEqual(player.streamingData, { formats: [1] }, "streamingData must survive the scrub");

  // A non-player endpoint is passed through untouched.
  const other = await s2.fetch("https://www.youtube.com/youtubei/v1/next");
  assert.strictEqual("adPlacements" in (await other.json()), true, "other endpoints must not be modified");

  // A non-JSON player response must fall back to the original, not throw.
  const s3 = load(async () => new Response("not json"));
  const raw = await s3.fetch("https://www.youtube.com/youtubei/v1/player");
  assert.strictEqual(await raw.text(), "not json", "a non-JSON response must pass through");

  // XHR: a player request is scrubbed at read time, whatever handler runs first.
  const XHR = makeXHR();
  const s4 = load(async () => {}, XHR);
  const x = new s4.XMLHttpRequest();
  x.open("GET", "https://www.youtube.com/youtubei/v1/player?key=abc");
  x.__text = JSON.stringify(playerBody()); // the browser filling the response
  const xbody = JSON.parse(x.responseText);
  assert.ok(!("adPlacements" in xbody), "XHR player data must be scrubbed");
  assert.deepStrictEqual(xbody.streamingData, { formats: [1] }, "XHR video data must survive");

  const y = new s4.XMLHttpRequest();
  y.open("GET", "https://www.youtube.com/youtubei/v1/next");
  y.__text = JSON.stringify(playerBody());
  assert.strictEqual("adPlacements" in JSON.parse(y.responseText), true, "a non-player XHR must pass through");

  // Gate: cosmetic.js writes "1" here when blocking is off for this origin, and the script
  // must not hook anything. "0" (or no value) keeps it on.
  const gated = load(async () => {}, undefined, { getItem: () => "1" });
  assert.strictEqual(gated.__simpleAdblockMain, "off", "the marker should report the gate is off");
  gated.ytInitialPlayerResponse = playerBody();
  assert.ok("adPlacements" in gated.ytInitialPlayerResponse, "the gate must skip hooking when blocking is off here");

  const on = load(async () => {}, undefined, { getItem: () => "0" });
  on.ytInitialPlayerResponse = playerBody();
  assert.ok(!("adPlacements" in on.ytInitialPlayerResponse), "a gate value of 0 must keep hooking");

  console.log("youtube-main: OK");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
