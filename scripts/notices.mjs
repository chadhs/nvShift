import { readFile, writeFile, readdir, access, realpath } from 'node:fs/promises';
import path from 'node:path';

const seen = new Set();
const notices = [];
const root = process.cwd();
const recognizedPermissiveLicenses = new Set([
  'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  'Unlicense', 'CC0-1.0', 'CC-BY-4.0', 'BlueOak-1.0.0', 'Zlib', 'Python-2.0', 'BSL-1.0',
]);
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

async function packageDirectory(name, from, optional = false) {
  let parent = path.resolve(from);
  while (true) {
    const directory = path.join(parent, 'node_modules', name);
    try {
      await access(path.join(directory, 'package.json'));
      return await realpath(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (path.dirname(parent) === parent) {
        if (optional) return null;
        throw new Error(`Missing installed runtime dependency: ${name}`);
      }
      parent = path.dirname(parent);
    }
  }
}

function declaredLicense(pkg, text) {
  const license = typeof pkg.license === 'string' ? pkg.license
    : pkg.license?.type || pkg.licenses?.map((item) => typeof item === 'string' ? item : item.type).join(' OR ');
  if (license && license !== 'UNLICENSED' && !/^SEE LICENSE IN /i.test(license)) return license;
  // khroma 2.1.0 omits package metadata, but ships the complete MIT license.
  // Inferring only this unambiguous permission text avoids silently classifying
  // an arbitrary or missing license as permissive.
  if (/The MIT License|\bMIT License\b/i.test(text)
    && /Permission is hereby granted, free of charge/i.test(text)
    && /THE SOFTWARE IS PROVIDED ["“]AS IS/i.test(text)) return 'MIT';
  throw new Error(`Unidentified license for ${pkg.name}@${pkg.version}`);
}

async function visit(name, from = root, optional = false, traverse = true) {
  const directory = await packageDirectory(name, from, optional);
  if (!directory || seen.has(directory)) return;
  seen.add(directory);
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const files = await readdir(directory);
  const licenseFile = files.find((file) => /^license(?:\.(?:md|org|txt))?$/i.test(file));
  let licenseText;
  if (licenseFile) licenseText = await readFile(path.join(directory, licenseFile), 'utf8');
  else {
    const readme = files.find((file) => /^readme\.md$/i.test(file));
    const text = readme ? await readFile(path.join(directory, readme), 'utf8') : '';
    licenseText = text.match(/^(?:## License|License\r?\n=+)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim();
    if (!licenseText || !/Copyright/i.test(licenseText)) throw new Error(`Missing license text for ${name}`);
  }
  if (name === 'format' && pkg.version === '0.2.2') {
    licenseText += '\n\n' + await readFile(new URL('licenses/MIT-permission.txt', import.meta.url), 'utf8');
  }
  const license = declaredLicense(pkg, licenseText);
  const selectedLicense = name === 'dompurify' ? 'Apache-2.0' : license;
  if (/(?:^|[^A-Z])(?:A|L)?GPL(?:-|\b)/i.test(selectedLicense)) {
    throw new Error(`Copyleft license requires review before shipping: ${pkg.name}@${pkg.version}: ${selectedLicense}`);
  }
  const tokens = selectedLicense.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) || [];
  if (!tokens.length || tokens.some((token) => !['AND', 'OR'].includes(token) && !recognizedPermissiveLicenses.has(token))) {
    throw new Error(`Unidentified or unreviewed license for ${pkg.name}@${pkg.version}: ${selectedLicense}`);
  }
  const noticeFile = files.find((file) => /^notice(?:\.(?:md|org|txt))?$/i.test(file));
  notices.push({
    name: pkg.name || name, version: pkg.version, license, selectedLicense,
    licenseText: licenseText.trim(),
    noticeText: noticeFile ? (await readFile(path.join(directory, noticeFile), 'utf8')).trim() : '',
  });
  if (!traverse) return;
  const optionalNames = new Set(Object.keys(pkg.optionalDependencies || {}));
  for (const dependency of Object.keys(pkg.dependencies || {})) {
    await visit(dependency, directory, optionalNames.has(dependency));
  }
  for (const dependency of optionalNames) await visit(dependency, directory, true);
  for (const dependency of Object.keys(pkg.peerDependencies || {})) {
    await visit(dependency, directory, pkg.peerDependenciesMeta?.[dependency]?.optional === true);
  }
}

for (const dependency of Object.keys(manifest.dependencies || {}).sort()) await visit(dependency);
// The development package supplies Electron's distributed runtime. Its Node
// installer dependencies do not run in, or ship as part of, nvShift itself.
await visit('electron', root, false, false);
notices.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
let output = `#+title: Third-party notices\n\nnvShift's own code uses BSD-3-Clause. Dependencies retain their licenses.\nDOMPurify is used under its Apache-2.0 option. The Electron runtime retains its\nLICENSE and LICENSES.chromium.html notices for bundled components in each package.\n\nThis inventory includes installed production dependencies, their dependencies,\nand Electron itself. Platform-specific optional dependencies are listed when\ninstalled. Regenerate with =npm run notices= after dependency updates.\n`;
for (const item of notices) {
  output += `\n* ${item.name} ${item.version}\nLicense: ${item.license}\n`;
  if (item.selectedLicense !== item.license) output += `Selected license: ${item.selectedLicense}\n`;
  output += `\n#+begin_example\n${item.licenseText}\n#+end_example\n`;
  if (item.noticeText) output += `\n#+begin_example\n${item.noticeText}\n#+end_example\n`;
}
const filename = path.join(root, 'THIRD-PARTY-NOTICES.org');
if (process.argv.includes('--check')) {
  const existing = await readFile(filename, 'utf8');
  if (existing !== output) throw new Error('Third-party notices are stale. Run npm run notices.');
  console.log(`Verified license notices for ${notices.length} installed runtime packages.`);
} else {
  await writeFile(filename, output);
  console.log(`Wrote license notices for ${notices.length} installed runtime packages.`);
}
