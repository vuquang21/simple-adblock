// Packs the extension into dist/simple-adblock-<version>.zip: the file someone unzips and
// loads unpacked, or the file a store review uploads. No dependencies — the zip container is
// written by hand below, so this works on any machine with Node and nothing else.
//
//   node tools/package.js           -> dist/simple-adblock-1.4.0.zip
//   node tools/package.js --store   -> same, with the unpacked-only permission removed
//
// The file list is derived from manifest.json (and the HTML/worker imports it points at)
// rather than hand-kept, so a new content script cannot be missing from the package.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { crc32 } = require("./png");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const STORE = process.argv.includes("--store");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

// declarativeNetRequestFeedback is granted to unpacked copies only: a published build keeps
// the permission in its manifest and then never gets the matched-rule counts it promises.
// Both call sites already tolerate its absence, so the store build simply drops it.
if (STORE) {
  manifest.permissions = (manifest.permissions || []).filter(p => p !== "declarativeNetRequestFeedback");
}

// Every file the browser opens, walked from the manifest so nothing has to be remembered here.
function runtimeFiles() {
  const files = new Set(["manifest.json", "LICENSE"]);
  const add = f => { if (f && !/^https?:/.test(f)) files.add(f); };

  add(manifest.background && manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) {
    for (const f of [].concat(cs.js || [], cs.css || [])) add(f);
  }
  for (const res of manifest.web_accessible_resources || []) {
    for (const f of [].concat(res.resources || [])) if (!f.includes("*")) add(f);
  }
  add(manifest.options_page || (manifest.options_ui && manifest.options_ui.page));
  add(manifest.action && manifest.action.default_popup);
  for (const map of [manifest.icons, manifest.action && manifest.action.default_icon]) {
    if (typeof map === "string") add(map);
    else if (map) for (const f of Object.values(map)) add(f);
  }

  // Pages pull their scripts and stylesheets in, and the worker pulls its helpers in.
  const scan = (rel, re) => {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of text.matchAll(re)) add(m[1]);
  };
  const pages = [manifest.options_page, manifest.action && manifest.action.default_popup].filter(Boolean);
  for (const page of pages) {
    // files.has(), not `in files`: a Set has no such membership test and the miss is silent.
    if (files.has(page)) scan(page, /<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g);
  }
  if (manifest.background && files.has(manifest.background.service_worker)) {
    const text = fs.readFileSync(path.join(ROOT, manifest.background.service_worker), "utf8");
    for (const m of text.matchAll(/importScripts\(([^)]*)\)/g)) {
      for (const s of m[1].matchAll(/["']([^"']+)["']/g)) add(s[1]);
    }
  }
  return [...files].sort();
}

// Zip writer: deflate each file, one local header + central directory entry, then the trailer.
// shortcut: no zip64 and no encryption — an extension package is far under 4 GB and unsigned.
function zip(entries) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Storing an already-compressed file (a PNG) is smaller than deflating it again.
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0o644 << 16, 38); // external attributes: a plain file
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory starts right after the last local entry
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const names = runtimeFiles();
const missing = names.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  // A manifest that points at a file nobody wrote is exactly the mistake this check is for.
  console.error("Missing files: " + missing.join(", "));
  process.exit(1);
}

const entries = names.map(name => ({
  name,
  data: name === "manifest.json" ? Buffer.from(JSON.stringify(manifest, null, 2) + "\n") : fs.readFileSync(path.join(ROOT, name)),
}));
const zipBuf = zip(entries);
const suffix = STORE ? "-store" : "";
const out = path.join(DIST, `simple-adblock-${manifest.version}${suffix}.zip`);
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(out, zipBuf);

for (const { name, data } of entries) console.log(`  ${name}  (${data.length} bytes)`);
console.log(`\n${path.relative(process.cwd(), out)}  ${entries.length} files, ${zipBuf.length} bytes`);
if (STORE) console.log("Store build: declarativeNetRequestFeedback removed from permissions.");
