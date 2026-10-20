// Writes icons/icon-{16,32,48,128}.png: a rounded blue tile with a white "blocked" ring.
// Hand-run like tools/build-cosmetic.js, not a build stage — the PNGs are committed, because
// the browser reads them as files and a store upload is rejected without a 128px one.
//   node tools/build-icons.js
const fs = require("fs");
const path = require("path");
const { encodePng } = require("./png");

const SIZES = [16, 32, 48, 128];
const OUT = path.join(__dirname, "..", "icons");
const BG = [37, 99, 235]; // #2563eb, the same blue the popup uses
const FG = [255, 255, 255];
const SS = 4; // 4x4 samples per pixel: 16px is the size that shows a jagged edge

// 0 = outside the tile, 1 = tile, 2 = the white mark inside it. Everything is a distance test
// in 0..1 shape space, so a pixel can be sampled at several offsets and averaged.
function shape(x, y) {
  const r = 0.22; // corner radius, as a fraction of the icon
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  if (Math.hypot(dx, dy) > r) return 0;
  const px = x - 0.5;
  const py = y - 0.5;
  const d = Math.hypot(px, py);
  const ring = d >= 0.30 && d <= 0.40;
  const bar = Math.abs(px - py) / Math.SQRT2 <= 0.055 && d <= 0.40; // the classic "no" slash
  return ring || bar ? 2 : 1;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0;
      let mark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const s = shape((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (s) tile++;
          if (s === 2) mark++;
        }
      }
      const i = (y * size + x) * 4;
      if (!tile) continue; // transparent outside the rounded corners
      const k = mark / tile; // the mark is drawn over the tile, so it can be blended flat
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(BG[c] + (FG[c] - BG[c]) * k);
      rgba[i + 3] = Math.round((tile / (SS * SS)) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  console.log(`${path.relative(process.cwd(), file)}  ${fs.statSync(file).size} bytes`);
}
