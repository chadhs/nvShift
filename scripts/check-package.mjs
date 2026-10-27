import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { listPackage, extractFile } from '@electron/asar';

const [platform, argument] = process.argv.slice(2);
if (!['mac', 'linux', 'win'].includes(platform) || !argument) {
  throw new Error('Usage: node scripts/check-package.mjs mac|linux|win PATH_TO_APP');
}
const directory = path.resolve(argument);
const resources = platform === 'mac' ? path.join(directory, 'Contents', 'Resources') : path.join(directory, 'resources');
const archive = path.join(resources, 'app.asar');
const files = new Set(listPackage(archive).map((file) => file.replaceAll('\\', '/').replace(/^\//, '')));
for (const file of [
  'package.json', 'LICENSE', 'README.org', 'THIRD-PARTY-NOTICES.org',
  'dist/index.html', 'dist/document-analysis.cjs', 'dist/asset-references.cjs',
  'electron/main.cjs', 'electron/preload.cjs', 'electron/asset-cleanup.cjs', 'electron/asset-cleanup-worker.cjs',
]) assert.ok(files.has(file), `Packaged application is missing ${file}`);
const manifest = JSON.parse(extractFile(archive, 'package.json').toString());
assert.equal(manifest.name, 'nvshift');
assert.equal(manifest.main, 'electron/main.cjs');
assert.equal(manifest.license, 'BSD-3-Clause');
const license = extractFile(archive, 'LICENSE').toString();
assert.match(license, /^BSD 3-Clause License/);
assert.match(license, /Copyright \(c\) 2026, Chad Stovern/);
const notices = extractFile(archive, 'THIRD-PARTY-NOTICES.org').toString();
assert.match(notices, /nvShift's own code uses BSD-3-Clause/);
assert.doesNotMatch(notices, /^License: (?:undefined|null|UNLICENSED)\s*$/m);
assert.match(notices, /Selected license: Apache-2\.0/);
const has = async (filename) => access(filename).then(() => true, () => false);
for (const filename of ['Electron-LICENSE.txt', 'LICENSES.chromium.html']) {
  const nativeName = filename === 'Electron-LICENSE.txt' ? 'LICENSE.electron.txt' : filename;
  assert.ok(await has(path.join(resources, 'licenses', filename))
    || (platform !== 'mac' && await has(path.join(directory, nativeName))),
  `Electron distribution notice is missing: ${filename}`);
}
if (platform === 'mac') {
  const plist = path.join(directory, 'Contents', 'Info.plist');
  for (const [key, value] of [
    ['CFBundleIdentifier', 'com.chadhs.nvshift'], ['CFBundleName', 'nvShift'], ['CFBundleExecutable', 'nvShift'],
  ]) assert.equal(execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim(), value);
  await access(path.join(directory, 'Contents', 'MacOS', 'nvShift'));
} else {
  await access(path.join(directory, platform === 'win' ? 'nvShift.exe' : 'nvshift'));
  if (platform === 'linux') {
    const desktopNames = (await readdir(directory)).filter((name) => name.endsWith('.desktop'));
    if (desktopNames.length) {
      assert.ok(desktopNames.includes('com.chadhs.nvshift.desktop'), 'Linux launcher must use the portal app identity');
      const desktop = await readFile(path.join(directory, 'com.chadhs.nvshift.desktop'), 'utf8');
      assert.match(desktop, /^Name=nvShift$/m);
      assert.match(desktop, /^Terminal=false$/m);
      assert.match(desktop, /^Type=Application$/m);
      assert.match(desktop, /^Exec=AppRun(?: %U)?$/m);
      assert.doesNotMatch(desktop, /--no-sandbox|--disable.*sandbox/);
      await access(path.join(directory, '.DirIcon'));
    }
  }
}
console.log(`Verified nvShift ${platform} package identity, application payload, and license notices.`);
