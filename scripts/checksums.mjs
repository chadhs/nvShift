import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve('release');
const names = (await readdir(directory)).filter((name) => /\.(dmg|zip|AppImage|tar\.gz|exe)$/.test(name)).sort();
if (!names.length) throw new Error('Build the release packages first.');
const lines = [];
for (const name of names) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${name}`);
}
const output = path.join(directory, `SHA256SUMS-${process.platform}-${process.arch}.txt`);
await writeFile(output, lines.join('\n') + '\n');
console.log(output);
