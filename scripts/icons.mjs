import { Resvg } from '@resvg/resvg-js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

// Original SVG assets are the source of truth; no system fonts are required.
const svg = await readFile(new URL('../assets/icon.svg', import.meta.url));
const traySvg = await readFile(new URL('../assets/tray.svg', import.meta.url), 'utf8');
const output = new URL('../build/', import.meta.url);
await mkdir(new URL('icons/', output), { recursive: true });
const pngs = new Map();
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  pngs.set(size, png);
  await writeFile(new URL(`icons/${size}x${size}.png`, output), png);
}
const representations = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
const chunks = Object.entries(representations).map(([type, size]) => {
  const data = pngs.get(size);
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
});
const header = Buffer.alloc(8);
header.write('icns', 0, 'ascii');
header.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
await writeFile(new URL('icon.icns', output), Buffer.concat([header, ...chunks]));
const sizes = [16, 32, 48, 64, 128, 256];
const directory = Buffer.alloc(6 + 16 * sizes.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16, png = pngs.get(size);
  directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
await writeFile(new URL('icon.ico', output), Buffer.concat([directory, ...sizes.map((size) => pngs.get(size))]));
for (const [name, size, color] of [
  ['trayTemplate.png', 20, '#000'], ['trayTemplate@2x.png', 40, '#000'],
  ['tray.png', 24, '#1b201e'], ['tray-light.png', 24, '#f5f1e5'],
]) {
  const source = traySvg.replaceAll('#000', color);
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
  await writeFile(new URL(name, output), png);
}
console.log('Generated nvShift ICNS, ICO, PNG app icons, and monochrome tray icons.');
