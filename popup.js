const $ = id => document.getElementById(id);

let host = ""; // hostname of the tab the popup was opened on

async function render() {
  const { enabled, domains, whitelist } = await getState();
  $("enabled").checked = enabled;
  $("count").textContent = `${domains.length} domains blocked`;

  // chrome:// and the like have no hostname, so per-site controls make no sense there.
  $("site").hidden = !host;
  if (host) {
    const allowed = isWhitelisted(host, whitelist);
    $("site").textContent = allowed ? `Block ads on ${host}` : `Allow ads on ${host}`;
    $("site").className = allowed ? "btn" : "btn btn-outline";
  }
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).hostname; } catch {}
  await render();

  // What this page actually lost, so the extension is not a black box.
  try {
    const { matchedRules = [] } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
    const n = matchedRules.filter(r => r.ruleId < WHITELIST_ID_BASE).length;
    if (n) $("blocked").textContent = `${n} requests blocked on this page`;
  } catch {} // no feedback permission (Web Store build) -> leave the line empty
})();

$("enabled").onchange = e => chrome.storage.local.set({ enabled: e.target.checked });

$("site").onclick = async () => {
  const { whitelist } = await getState();
  const next = isWhitelisted(host, whitelist)
    ? whitelist.filter(w => !isWhitelisted(host, [w]))
    : [...whitelist, host].sort();
  await chrome.storage.local.set({ whitelist: next });
  render();
};

$("open").onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
