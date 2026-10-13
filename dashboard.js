const $ = id => document.getElementById(id);

let domains = [];
let whitelist = [];
let cosmetic = [];

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

async function render() {
  const state = await getState();
  domains = state.domains;
  whitelist = state.whitelist;
  cosmetic = state.cosmetic;
  $("enabled").checked = state.enabled;
  $("count").textContent = `· ${domains.length} domains blocked`;
  $("total").textContent = domains.length;
  $("whitelistTotal").textContent = whitelist.length;
  $("cosmeticTotal").textContent = cosmetic.length;

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
  await setDomains([...domains, ...found]);
  if (newCosmetic.length) await chrome.storage.local.set({ cosmetic: [...cosmetic, ...newCosmetic] });
  await render();
  return { domains: found.length, cosmetic: newCosmetic.length };
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
  const n = await addMany($("pasteList").value);
  $("pasteList").value = "";
  flash(`Imported ${plural(n.domains)} and ${n.cosmetic} element-hiding rules.`);
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
    flash(`Imported ${plural(n.domains)} and ${n.cosmetic} element-hiding rules.`);
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

render();
