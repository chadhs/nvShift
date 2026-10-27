// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function parseVersion(value) {
  const match = typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match || match[0] !== value || match.slice(1).some((part) => !Number.isSafeInteger(Number(part)))) throw new Error(`Invalid stable version: ${value}`);
  return match.slice(1).map(Number);
}
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}
export function releaseSource(commit, message, parents) {
  const marker = /^nvShift-Source: ([a-f0-9]{40})$/m.exec(message)?.[1];
  return marker && parents.length === 1 && parents[0] === marker ? marker : commit;
}
export function planRelease(initial, tags, source) {
  parseVersion(initial);
  if (typeof source !== 'string' || source.length !== 40 || !/^[a-f0-9]{40}$/.test(source)) throw new Error('A full source commit SHA is required.');
  const stable = tags.filter(({ tag }) => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag));
  stable.sort((a, b) => compareVersions(a.tag.slice(1), b.tag.slice(1)));
  const matching = stable.filter((item) => item.source === source);
  if (matching.length > 1) throw new Error('More than one release tag maps to this source commit.');
  let version = matching[0]?.tag.slice(1);
  if (!version) {
    const latest = stable.at(-1);
    if (!latest) version = initial;
    else {
      const [major, minor] = parseVersion(latest.tag.slice(1));
      version = `${major}.${minor + 1}.0`;
      parseVersion(version);
    }
  }
  const previous = stable.filter((item) => compareVersions(item.tag.slice(1), version) < 0).at(-1)?.tag;
  return { version, tag: `v${version}`, source, previous, existing: matching.length === 1 };
}
export async function stampVersion(directory, version) {
  parseVersion(version);
  const packagePath = path.join(directory, 'package.json');
  const lockPath = path.join(directory, 'package-lock.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (!lock.packages?.[''] || lock.name !== pkg.name) throw new Error('Package and lockfile roots must agree.');
  pkg.version = lock.version = lock.packages[''].version = version;
  await writeFile(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
export function assetNames(version) {
  parseVersion(version);
  return [
    `nvshift-${version}-arm64.dmg`, `nvshift-${version}-arm64.zip`,
    `nvshift-${version}.AppImage`, `nvshift-${version}.tar.gz`,
    `nvshift-${version}-win-x64-setup.exe`,
    'SHA256SUMS-darwin-arm64.txt', 'SHA256SUMS-linux-x64.txt', 'SHA256SUMS-win32-x64.txt',
  ];
}
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function verifyAssets(directory, version) {
  const names = assetNames(version);
  const checksumGroups = new Map([
    [names[5], names.slice(0, 2)], [names[6], names.slice(2, 4)], [names[7], names.slice(4, 5)],
  ]);
  const expected = [...names].sort();
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Release must contain exactly the macOS, Linux, and Windows packages and their checksum files.');
  const checksummed = new Set();
  for (const name of expected.filter((name) => name.startsWith('SHA256SUMS-'))) {
    const lines = (await readFile(path.join(directory, name), 'utf8')).trim().split('\n');
    if (lines.length !== checksumGroups.get(name).length) throw new Error('Each platform checksum file must cover exactly its packages.');
    for (const line of lines) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      if (!match || path.basename(match[2]) !== match[2] || !expected.includes(match[2]) || match[2].startsWith('SHA256SUMS-')) throw new Error('Invalid checksum entry.');
      if (!checksumGroups.get(name).includes(match[2])) throw new Error('A platform checksum file contains another platform’s package.');
      if (checksummed.has(match[2])) throw new Error('Duplicate checksum entry.');
      if (await sha256(path.join(directory, match[2])) !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
      checksummed.add(match[2]);
    }
  }
  if (checksummed.size !== expected.filter((name) => !name.startsWith('SHA256SUMS-')).length) throw new Error('All packages need checksums.');
  return Promise.all(expected.map(async (name) => {
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Empty or invalid release asset: ${name}`);
    return { name, file, size: info.size, digest: `sha256:${await sha256(file)}` };
  }));
}
export function assertMainRelease(env) {
  const regular = ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME);
  const merged = env.GITHUB_EVENT_NAME === 'pull_request_target' && env.RELEASE_PR_MERGED === 'true' && env.RELEASE_PR_BASE === 'main';
  if (env.RELEASES_ENABLED !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || (!regular && !merged)) throw new Error('Releasing is allowed only for trusted main events in GitHub Actions with RELEASES_ENABLED=true.');
}
export function releaseNotes({ version, repository, source, changes = '', runId = '' }) {
  parseVersion(version);
  const guide = `https://github.com/${repository}/blob/v${version}/README.org#install`;
  return [
    'nvShift: Notational Velocity for everyone. Search, create, and edit ordinary plain-text, Markdown, and Org notes in one local folder, including linked directories. Downloaded releases need no Node.js, npm, or Emacs.',
    '',
    'Includes keyboard browsing and note creation, CodeMirror editing with optional Vim mode, content-based headings, Editor/Split/Preview views, themes, local and HTTP/HTTPS images, image paste/drop, offline Mermaid diagrams, safe autosave and recovery, and manual unused-asset cleanup. Notes remain ordinary files. BSD-3-Clause; third-party and Electron notices are included.',
    '',
    '### macOS: Apple Silicon',
    '',
    `1. Download \`nvshift-${version}-arm64.dmg\` and \`SHA256SUMS-darwin-arm64.txt\` from Assets below. The ZIP is an alternative; GitHub Source code archives are not installers.`,
    '2. Quit older copies using nvShift → Quit. Closing the window only hides it. Open the DMG, drag nvShift.app into Applications, and eject the disk image.',
    '3. Open the Applications copy. macOS builds are ad-hoc signed for bundle integrity, but are not Developer-ID-signed or notarized. If macOS cannot verify the developer and you trust the download, attempt to open it, then use System Settings → Privacy & Security → Open Anyway to approve this app specifically.',
    '4. Choose your notes folder on first launch. Use ⌘L to search and browse results with arrow keys; Enter focuses editing. New notes are created at the notes-folder root.',
    '',
    '### Linux: x86_64',
    '',
    `Download \`nvshift-${version}.tar.gz\` or \`nvshift-${version}.AppImage\` with \`SHA256SUMS-linux-x64.txt\`. Extract the tarball and run its \`nvshift\` executable as your normal user with sandboxing enabled.`,
    '',
    'The AppImage can run with --appimage-extract-and-run if FUSE 2 is unavailable. The reverse-DNS desktop launcher is com.chadhs.nvshift.desktop. Linux Wayland shortcut support depends on the desktop portal; interactive Wayland and physical shortcut checks remain separate from Xvfb CI.',
    '',
    '### Windows: Intel/AMD x64',
    '',
    `Download \`nvshift-${version}-win-x64-setup.exe\` with \`SHA256SUMS-win32-x64.txt\`. Verify its hash with PowerShell \`Get-FileHash .\\nvshift-${version}-win-x64-setup.exe -Algorithm SHA256\`, then run the per-user installer and open nvShift from Start.`,
    '',
    'The Windows installer is unsigned and may display SmartScreen or unknown-publisher prompts. Install only a verified download you trust. Reinstalling and uninstalling preserve preferences and notes. Native ARM64 builds are not supplied.',
    '',
    '### Using and updating nvShift',
    '',
    'Choose one notes folder; search discovers .txt, .md, .markdown, and .org files recursively. Directory links are followed, while hidden directories, node_modules, assets, and individual linked files are excluded. Editing, renaming, and trashing linked notes affect their real files.',
    '',
    'The default global shortcut is Cmd/Ctrl+Shift+Space. Closing the window keeps nvShift running in the tray/menu bar; Quit flushes pending edits and exits. Remote images contact their hosts without cookies, authentication, or document referrers. Local notes are not uploaded.',
    '',
    'Use File → Find unused assets to review images in the selected library’s assets folder. Removal is manual and uses OS Trash. Current notes, drafts, and session Undo references are protected; images used only by older backups are listed separately. References in unrelated outside notes cannot be established.',
    '',
    `See the [installation and update guide](${guide}). Compare downloads with their SHA-256 files using \`shasum -a 256\` on macOS or \`sha256sum\` on Linux. To update, quit nvShift and replace the installed app or run the newer Windows installer. There is no in-app updater.`,
    '',
    '### Validation and limits',
    '',
    'Publication requires native macOS, Linux, and Windows tests, package inspection, and packaged-app smoke checks. Windows CI also verifies install, reinstall, and uninstall with preferences preserved. Interactive Wayland, physical shortcuts, native folder-picker interaction, and native Trash behavior require manual checks.',
    '',
    'UTF-8 notes are limited to 16 MiB each. Preview limits include 100 image references, 8 MiB per image, a 32 MiB image budget per note, and 20 Mermaid diagrams. Cleanup scans are independent of the preview reference limit. Invalid content remains available for editing. Network-share/device paths, full Emacs Org functionality, TextBundle, custom sync, Neovim plugins, auto-updates, notarization, and Windows code signing remain outside scope. Intel Mac builds are not supplied.',
    '',
    `[Release information](https://github.com/${repository}/blob/v${version}/RELEASE-NOTES.org) · [Source commit](https://github.com/${repository}/commit/${source})`,
    '',
    ...(/^\d+$/.test(runId) ? [`[Native build and package checks](https://github.com/${repository}/actions/runs/${runId})`, ''] : []),
    changes,
  ].join('\n');
}
// The tag endpoint can omit drafts, even for authenticated callers. List
// releases as a fallback so an interrupted upload resumes the existing draft.
export async function findRelease(github, tag) {
  const published = await github.request('GET', `/releases/tags/${tag}`, undefined, true);
  if (published) return published;
  for (let page = 1; ; page++) {
    const releases = await github.request('GET', `/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Unexpected release-list response.');
    const found = releases.find((release) => release.tag_name === tag);
    if (found) return found;
    if (releases.length < 100) return null;
  }
}
// A failed upload leaves a draft. Published releases and their assets are never replaced.
export async function uploadAndPublish(github, plan, assets, body) {
  let release = await findRelease(github, plan.tag);
  if (release && !release.draft) return release;
  if (!release) release = await github.request('POST', '/releases', { tag_name: plan.tag, name: `nvShift ${plan.tag}`, body, draft: true, prerelease: false });
  else {
    await github.request('PATCH', `/releases/${release.id}`, { name: `nvShift ${plan.tag}`, body });
    for (const asset of release.assets) await github.request('DELETE', `/releases/assets/${asset.id}`);
  }
  for (const asset of assets) {
    const uploaded = await github.upload(release.upload_url, asset);
    if (uploaded.name !== asset.name || uploaded.state !== 'uploaded' || uploaded.size !== asset.size || (uploaded.digest && uploaded.digest !== asset.digest)) throw new Error(`Upload verification failed: ${asset.name}`);
  }
  const latest = await github.request('GET', '/releases/latest', undefined, true);
  const makeLatest = !latest || !/^v\d+\.\d+\.\d+$/.test(latest.tag_name) || compareVersions(plan.version, latest.tag_name.slice(1)) >= 0;
  return github.request('PATCH', `/releases/${release.id}`, { draft: false, make_latest: String(makeLatest) });
}
