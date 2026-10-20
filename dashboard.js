const $ = id => document.getElementById(id);

let domains = [];
let whitelist = [];
let cosmetic = [];
let siteRules = {}; // host -> selectors picked by hand (or imported scoped ##rules)

// Small × button that removes a value from a storage list and re-renders.
function removeButton(value, list, key) {
  const btn = document.createElement("button");
  btn.className = "icon-btn remove";
  btn.textContent = "×";
  btn.title = "Remove";
  btn.onclick = async () => {
    const next = list.filter(x => x !== value);
    await chrome.storage.local.set({ [key]: next });
    render();
  };
  return btn;
}

// × on a site's whole set of element rules: the host is the key, so it is dropped as a key.
function removeHostButton(host) {
  const btn = document.createElement("button");
  btn.className = "icon-btn remove";
  btn.textContent = "×";
  btn.title = "Remove every rule for this site";
  btn.onclick = async () => {
    const { siteRules = {} } = await chrome.storage.local.get("siteRules");
    delete siteRules[host];
    await chrome.storage.local.set({ siteRules });
    render();
  };
  return btn;
}

async function render() {
  const state = await getState();
  domains = state.domains;
  whitelist = state.whitelist;
  cosmetic = state.cosmetic;
  siteRules = state.siteRules;
  $("enabled").checked = state.enabled;
  $("count").textContent = `· ${domains.length} domains blocked`;
  $("total").textContent = domains.length;
  $("whitelistTotal").textContent = whitelist.length;
  $("cosmeticTotal").textContent = cosmetic.length;
  const siteHosts = Object.keys(siteRules);
  $("siteTotal").textContent = siteHosts.reduce((n, h) => n + (siteRules[h] || []).length, 0);

  // Show whether the browser actually accepted the rules, so failures aren't silent.
  const { lastError = null } = await chrome.storage.local.get("lastError");
  const rules = lastError ? [] : await chrome.declarativeNetRequest.getDynamicRules();
  const blocking = rules.filter(r => r.action.type === "block").length;
  $("diag").classList.toggle("error", !!lastError);
  $("diag").textContent = lastError
    ? `⚠ ${lastError}`
    : `${domains.length} domains stored · ${blocking} blocking rules · ${whitelist.length} sites allowed`;

  const list = $("list");
  list.innerHTML = "";
  if (!domains.length) list.append(emptyRow("No domains blocked yet."));
  for (const d of domains) list.append(hostRow(d, removeButton(d, domains, "domains")));

  const wlist = $("whitelistList");
  wlist.innerHTML = "";
  if (!whitelist.length) wlist.append(emptyRow("No sites allowed yet."));
  for (const w of whitelist) wlist.append(hostRow(w, removeButton(w, whitelist, "whitelist")));

  // Cosmetic rules are imported in bulk, so show a preview rather than 13k rows.
  const clist = $("cosmeticList");
  clist.innerHTML = "";
  if (!cosmetic.length) clist.append(emptyRow("No element-hiding rules yet."));
  else clist.append(emptyRow(cosmetic.slice(0, 20).join(", ") + (cosmetic.length > 20 ? `, … +${cosmetic.length - 20} more` : "")));

  // Per-site rules are the ones picked by hand, so they are worth naming host by host — but
  // an imported list brings thousands of hosts, so only the first 20 are spelled out.
  const slist = $("siteList");
  slist.innerHTML = "";
  if (!siteHosts.length) slist.append(emptyRow("No site rules yet — use “Block an element on this page” in the popup."));
  for (const host of siteHosts.sort().slice(0, 20)) {
    const sels = siteRules[host] || [];
    const preview = sels.slice(0, 3).join(", ") + (sels.length > 3 ? `, … +${sels.length - 3}` : "");
    slist.append(hostRow(`${host} · ${sels.length} rule${sels.length === 1 ? "" : "s"}: ${preview}`, removeHostButton(host)));
  }
  if (siteHosts.length > 20) slist.append(emptyRow(`… +${siteHosts.length - 20} more sites`));

  // Log of hosts auto-blocked by detection, most-seen first.
  const { detected = {} } = await chrome.storage.local.get("detected");
  const entries = Object.entries(detected).sort((a, b) => b[1] - a[1]);
  $("detectedTotal").textContent = entries.length;
  const dlist = $("detectedList");
  dlist.innerHTML = "";
  if (!entries.length) dlist.append(emptyRow("Nothing detected yet — browse a few sites."));
  for (const [host, count] of entries) {
    const seen = document.createElement("span");
    seen.className = "seen";
    seen.textContent = `${count}×`;
    dlist.append(hostRow(host, seen));
  }
}

function hostRow(host, ...controls) {
  const li = document.createElement("li");
  const name = document.createElement("span");
  name.className = "host";
  name.textContent = host;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.append(...controls);
  li.append(name, meta);
  return li;
}

function emptyRow(text) {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = text;
  return li;
}

async function addMany(text) {
  const found = parseDomains(text);
  const newCosmetic = parseCosmetic(text).filter(s => !cosmetic.includes(s));
  // Scoped rules ('site.com##.ad') are what catch random class names, so an imported list's
  // site rules are kept too — bounded by MAX_SITE_RULES because they arrive in thousands.
  const { siteRules: merged, added } = mergeSiteRules(siteRules, parseScopedCosmetic(text));
  await setDomains([...domains, ...found]);
  if (newCosmetic.length) await chrome.storage.local.set({ cosmetic: [...cosmetic, ...newCosmetic] });
  if (added) await chrome.storage.local.set({ siteRules: merged });
  await render();
  return { domains: found.length, cosmetic: newCosmetic.length, scoped: added };
}

const plural = n => `${n} domain${n === 1 ? "" : "s"}`;

function flash(msg) {
  $("status").textContent = msg;
  setTimeout(() => ($("status").textContent = ""), 3000);
}

$("enabled").onchange = e => chrome.storage.local.set({ enabled: e.target.checked });

$("addDomain").onclick = async () => {
  const v = $("customDomain").value.trim();
  if (!v) return;
  $("customDomain").value = "";
  const n = await addMany(v);
  flash(n.domains ? "Added." : "Not a valid domain.");
};

$("allowSite").onclick = async () => {
  const v = $("allowHost").value.trim();
  if (!v) return;
  $("allowHost").value = "";
  const host = parseDomains(v)[0];
  if (!host) return flash("Not a valid domain.");
  await chrome.storage.local.set({ whitelist: [...new Set([...whitelist, host])].sort() });
  flash(`${host} will not be blocked.`);
};

$("importPaste").onclick = async () => {
  try {
    const n = await addMany($("pasteList").value);
    $("pasteList").value = "";
    flash(`Imported ${plural(n.domains)}, ${n.cosmetic} element-hiding rules and ${n.scoped} per-site rules.`);
  } catch (e) {
    // A quota rejection used to surface only in the console: keep the text so it can be retried.
    flash(`Import failed: ${e.message}`);
  }
};

$("importUrl").onclick = async () => {
  const url = $("listUrl").value.trim();
  if (!url) return;
  flash("Downloading…");
  try {
    // Fetch in the page context; the extension has <all_urls> host permission.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const n = await addMany(await res.text());
    flash(`Imported ${plural(n.domains)}, ${n.cosmetic} element-hiding rules and ${n.scoped} per-site rules.`);
  } catch (e) {
    flash(`Import failed: ${e.message}`);
  }
};

$("clearAll").onclick = async () => {
  if (confirm("Remove all blocked domains?")) {
    await setDomains([]);
    render();
  }
};

$("clearCosmetic").onclick = async () => {
  if (confirm("Remove all element-hiding rules?")) {
    await chrome.storage.local.set({ cosmetic: [] });
    render();
  }
};

$("clearDetected").onclick = async () => {
  await chrome.storage.local.set({ detected: {} });
  render();
};

$("clearSiteRules").onclick = async () => {
  if (confirm("Remove every per-site element rule?")) {
    await chrome.storage.local.set({ siteRules: {} });
    render();
  }
};

render();
