const $ = id => document.getElementById(id);

let tab = null; // the tab the popup was opened on: per-site controls and the picker need it
let host = ""; // hostname of that tab

async function render() {
  const { enabled, domains, whitelist, siteRules, autoHide } = await getState();
  $("enabled").checked = enabled;
  $("autoHide").checked = autoHide;
  $("count").textContent = `${domains.length} domains blocked`;

  // chrome:// and the like have no hostname, so per-site controls make no sense there.
  $("site").hidden = !host;
  $("pick").hidden = !host;
  if (host) {
    const allowed = isWhitelisted(host, whitelist);
    $("site").textContent = allowed ? `Block ads on ${host}` : `Allow ads on ${host}`;
    $("site").className = allowed ? "btn" : "btn btn-outline";
    $("pick").disabled = allowed || !enabled;
    // Parent rules count too: cosmetic.js applies what was set on the apex to its subdomains.
    const mine = siteRulesFor(host, siteRules);
    $("picked").textContent = mine.length ? `${mine.length} element rule${mine.length === 1 ? "" : "s"} on this site` : "";
  }
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).hostname; } catch {}
  await render();

  // What this page actually lost, so the extension is not a black box.
  try {
    const { matchedRules = [] } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
    const n = matchedRules.filter(r => r.ruleId < WHITELIST_ID_BASE).length;
    if (n) $("blocked").textContent = `${n} requests blocked on this page`;
  } catch {} // no feedback permission (Web Store build) -> leave the line empty
})();

// Re-render so the pick button's disabled state follows the toggle instead of going stale.
$("enabled").onchange = async e => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  render();
};

// Takes effect on the next page load, since auto-hide.js has already read this once.
$("autoHide").onchange = e => chrome.storage.local.set({ autoHide: e.target.checked });

$("site").onclick = async () => {
  const { whitelist } = await getState();
  const next = isWhitelisted(host, whitelist)
    ? whitelist.filter(w => !isWhitelisted(host, [w]))
    : [...whitelist, host].sort();
  await chrome.storage.local.set({ whitelist: next });
  render();
};

$("open").onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

// The content script is missing on every tab that was already open when the extension was
// installed, reloaded or updated, and that is the usual reason a pick "does nothing". Inject
// the files instead of giving up; each one is separate so a re-declaration of the ones that
// are already there (a SyntaxError, harmless) does not stop picker.js from loading.
async function armPicker() {
  const msg = { type: "sab-pick" };
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    for (const f of ["shared.js", "cosmetic-rules.js", "cosmetic.js", "picker.js", "auto-hide.js"]) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [f] }); } catch {}
    }
    return await chrome.tabs.sendMessage(tab.id, msg);
  }
}

// Hand the picker to the page's content script; it answers ok:false when it cannot pick there.
$("pick").onclick = async () => {
  try {
    const reply = await armPicker();
    if (reply && reply.ok) window.close();
    else $("picked").textContent = (reply && reply.reason) || "Cannot pick on this page.";
  } catch {
    $("picked").textContent = "Cannot pick on this page (chrome:// and the Web Store are off-limits).";
  }
};
