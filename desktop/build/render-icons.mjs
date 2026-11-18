import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const CANVAS = 1024;
const MARK_SHARE = 0.66;
// macOS icon grid: an 824 pt tile with a 185.4 pt corner inside the 1024 pt canvas.
const DOCK = { tile: 824, radius: 185.4 };
const WEB = { tile: CANVAS, radius: 224 };
const WEB_MARK_PX = 256;
const ICONSET_PX = [16, 32, 64, 128, 256, 512];
const ICO_PX = [256, 128, 64, 48, 32, 16];

const at = (path) => new URL(path, import.meta.url);
const dataUri = (png) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
const render = (svg, px) => new Resvg(svg, { fitTo: { mode: "width", value: px } }).render();

function iconSvg({ tile, radius }, mark) {
  const origin = (CANVAS - tile) / 2;
  const size = tile * MARK_SHARE;
  const inset = origin + (tile - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" role="img" aria-label="Hezuo">
  <defs>
    <linearGradient id="tile" x1=".33" y1=".03" x2=".67" y2=".97">
      <stop offset="0" stop-color="#20262c"/>
      <stop offset="1" stop-color="#090b0d"/>
    </linearGradient>
    <radialGradient id="glow" cx=".5" cy=".46" r=".5">
      <stop offset="0" stop-color="#3fdcf2" stop-opacity=".16"/>
      <stop offset="1" stop-color="#3fdcf2" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="${origin}" y="${origin}" width="${tile}" height="${tile}" rx="${radius}" fill="url(#tile)"/>
  <rect x="${origin}" y="${origin}" width="${tile}" height="${tile}" rx="${radius}" fill="url(#glow)"/>
  <image x="${inset}" y="${inset}" width="${size}" height="${size}" href="${dataUri(mark)}"/>
</svg>
`;
}

function shrink(png, px) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image width="1" height="1" href="${dataUri(png)}"/></svg>`;
  return render(svg, px).asPng();
}

function bitmapEntry(px, premultiplied) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(px, 4);
  header.writeInt32LE(px * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(px * px * 4, 20);
  const pixels = Buffer.alloc(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const from = ((px - 1 - y) * px + x) * 4;
      const to = (y * px + x) * 4;
      const alpha = premultiplied[from + 3];
      const straight = (value) => (alpha ? Math.min(255, Math.round((value * 255) / alpha)) : 0);
      pixels[to] = straight(premultiplied[from + 2]);
      pixels[to + 1] = straight(premultiplied[from + 1]);
      pixels[to + 2] = straight(premultiplied[from]);
      pixels[to + 3] = alpha;
    }
  }
  const mask = Buffer.alloc(Math.ceil(px / 32) * 4 * px);
  return Buffer.concat([header, pixels, mask]);
}

function ico(svg) {
  const entries = ICO_PX.map((px) => ({ px, data: bitmapEntry(px, render(svg, px).pixels) }));
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);
  let offset = directory.length;
  entries.forEach(({ px, data }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = px % 256;
    directory[entry + 1] = px % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

const logo = readFileSync(at("logo.png"));
const dock = iconSvg(DOCK, logo);
const png = (px) => render(dock, px).asPng();

writeFileSync(at("icon.svg"), dock);
writeFileSync(at("icon-1024.png"), png(1024));
for (const px of ICONSET_PX) {
  writeFileSync(at(`icon.iconset/icon_${px}x${px}.png`), png(px));
  writeFileSync(at(`icon.iconset/icon_${px}x${px}@2x.png`), png(px * 2));
}
writeFileSync(at("icon.ico"), ico(dock));
writeFileSync(at("../electron/resources/app-icon.png"), png(1024));
writeFileSync(at("../public/app-icon.svg"), iconSvg(WEB, shrink(logo, WEB_MARK_PX)));
writeFileSync(at("../public/app-icon-192.png"), png(192));
writeFileSync(at("../public/app-icon-512.png"), png(512));
writeFileSync(at("../public/apple-touch-icon.png"), png(180));

if (process.platform === "darwin") {
  execFileSync("iconutil", ["--convert", "icns", "--output", fileURLToPath(at("icon.icns")), fileURLToPath(at("icon.iconset"))]);
} else {
  console.warn("icon.icns is only rebuilt on macOS (iconutil)");
}
