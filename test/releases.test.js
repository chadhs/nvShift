import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { planRelease, releaseSource, parseVersion, stampVersion, assetNames, verifyAssets, sha256, assertMainRelease, uploadAndPublish, releaseNotes } from '../scripts/lib/releases.mjs';
const source = 'a'.repeat(40);

test('first release uses the initial version, then increments minors numerically', () => {
  assert.equal(planRelease('0.1.0', [], source).version, '0.1.0');
  const tags = ['v0.9.9', 'v0.10.2', 'v1.0.0-beta.1', 'irrelevant'].map((tag) => ({ tag, source: 'b'.repeat(40) }));
  const result = planRelease('0.1.0', tags, source);
  assert.equal(result.version, '0.11.0');
  assert.equal(result.previous, 'v0.10.2');
  assert.equal(planRelease('0.1.0', [{ tag: 'v2.4.7' }], source).version, '2.5.0');
});

test('reruns reuse their source tag, even if a later release exists', () => {
  const result = planRelease('0.1.0', [{ tag: 'v0.1.0', source }, { tag: 'v0.2.0', source: 'b'.repeat(40) }], source);
  assert.equal(result.tag, 'v0.1.0');
  assert.equal(result.existing, true);
  assert.equal(result.previous, undefined);
  assert.throws(() => planRelease('0.1.0', [{ tag: 'v0.1.0', source }, { tag: 'v0.2.0', source }], source), /More than one/);
});

test('version and publication guards reject malformed or non-main inputs', () => {
  for (const version of ['0.01.0', 'v0.1.0', '0.1.0-beta', '1.2', '0.1.0\nfoo', '0.1.0\n', null, 1, '0.9007199254740992.0']) assert.throws(() => parseVersion(version));
  const valid = { GITHUB_ACTIONS: 'true', RELEASES_ENABLED: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
  assert.doesNotThrow(() => assertMainRelease(valid));
  for (const changed of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_ACTIONS: 'false' }, { RELEASES_ENABLED: 'false' }, { RELEASES_ENABLED: undefined }]) assert.throws(() => assertMainRelease({ ...valid, ...changed }), /trusted main/);
});

test('stamping changes both version manifests and preserves dependency data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nvshift-version-'));
  try {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'nvshift', version: '0.1.0', dependencies: { orga: '^4.7.1' } }));
    await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'nvshift', version: '0.1.0', packages: { '': { version: '0.1.0', dependencies: { orga: '^4.7.1' } }, 'node_modules/orga': { version: '4.7.1' } } }));
    await stampVersion(dir, '0.12.0');
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json')));
    const lock = JSON.parse(await readFile(path.join(dir, 'package-lock.json')));
    assert.equal(pkg.version, '0.12.0');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(lock.packages['node_modules/orga'].version, '4.7.1');
    assert.deepEqual(pkg.dependencies, { orga: '^4.7.1' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('all eight assets and matching checksums are required before publication', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nvshift-assets-'));
  const names = assetNames('0.2.0');
  try {
    for (const name of names.slice(0, 5)) await writeFile(path.join(dir, name), `Test package ${name}`);
    const line = async (name) => `${await sha256(path.join(dir, name))}  ${name}\n`;
    await writeFile(path.join(dir, names[5]), await line(names[0]) + await line(names[1]));
    await writeFile(path.join(dir, names[6]), await line(names[2]) + await line(names[3]));
    await writeFile(path.join(dir, names[7]), await line(names[4]));
    assert.equal((await verifyAssets(dir, '0.2.0')).length, 8);
    await writeFile(path.join(dir, 'nvshift-0.2.0-arm64.dmg.blockmap'), 'Extra builder output');
    await assert.rejects(verifyAssets(dir, '0.2.0'), /exactly the macOS, Linux, and Windows/);
    await rm(path.join(dir, 'nvshift-0.2.0-arm64.dmg.blockmap'));
    await writeFile(path.join(dir, names[5]), await line(names[2]) + await line(names[1]));
    await assert.rejects(verifyAssets(dir, '0.2.0'), /another platform/);
    await writeFile(path.join(dir, names[5]), await line(names[0]) + await line(names[0]));
    await assert.rejects(verifyAssets(dir, '0.2.0'), /Duplicate checksum/);
    await writeFile(path.join(dir, names[5]), await line(names[0]) + await line(names[1]));
    await rm(path.join(dir, names[4]));
    await assert.rejects(verifyAssets(dir, '0.2.0'), /exactly the macOS, Linux, and Windows/);
    await writeFile(path.join(dir, names[4]), 'Tampered Windows installer');
    await assert.rejects(verifyAssets(dir, '0.2.0'), /Checksum mismatch/);
    await writeFile(path.join(dir, names[4]), `Test package ${names[4]}`);
    await writeFile(path.join(dir, names[7]), '');
    await assert.rejects(verifyAssets(dir, '0.2.0'), /Invalid checksum|exactly its packages/);
    await writeFile(path.join(dir, names[7]), await line(names[4]));
    await writeFile(path.join(dir, names[0]), 'Tampered');
    await assert.rejects(verifyAssets(dir, '0.2.0'), /Checksum mismatch/);
    await rm(path.join(dir, names[3]));
    await assert.rejects(verifyAssets(dir, '0.2.0'), /exactly the macOS, Linux, and Windows/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('release assets must be regular files rather than links outside staging', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvshift-release-links-'));
  const dir = path.join(root, 'release');
  const names = assetNames('0.1.0');
  try {
    await mkdir(dir);
    for (const name of names.slice(0, 5)) await writeFile(path.join(dir, name), `Package ${name}`);
    const line = async (name) => `${await sha256(path.join(dir, name))}  ${name}\n`;
    await writeFile(path.join(dir, names[5]), await line(names[0]) + await line(names[1]));
    await writeFile(path.join(dir, names[6]), await line(names[2]) + await line(names[3]));
    await writeFile(path.join(dir, names[7]), await line(names[4]));
    const target = path.join(root, 'outside.exe');
    await writeFile(target, `Package ${names[4]}`);
    await rm(path.join(dir, names[4]));
    await symlink(target, path.join(dir, names[4]));
    await assert.rejects(verifyAssets(dir, '0.1.0'), /Empty or invalid release asset/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workflow bootstrap keeps PR builds read-only and enables only trusted main publication', async () => {
  const workflow = async (name) => parseYaml(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const [build, ci, release] = await Promise.all(['build', 'ci', 'release'].map(workflow));
  for (const item of [build, ci, release]) assert.equal(item.permissions.contents, 'read');
  assert.deepEqual(build.jobs.desktop.strategy.matrix.os, ['macos-latest', 'ubuntu-22.04', 'windows-2025']);
  assert.ok(Object.hasOwn(build.on, 'workflow_call'));
  assert.ok(Object.hasOwn(ci.on, 'pull_request'));
  assert.ok(Object.hasOwn(ci.on, 'workflow_dispatch'));
  assert.match(ci.jobs.desktop.if, /github\.event_name != 'push' \|\| vars\.RELEASES_ENABLED != 'true'/);
  assert.deepEqual(release.on.pull_request_target, { types: ['closed'], branches: ['main'] });
  for (const job of ['plan', 'publish']) {
    assert.match(release.jobs[job].if, /vars\.RELEASES_ENABLED == 'true'/);
    assert.match(release.jobs[job].if, /github\.ref == 'refs\/heads\/main'/);
    assert.match(release.jobs[job].if, /github\.event\.pull_request\.merged == true/);
  }
  assert.equal(release.jobs.publish.permissions.contents, 'write');
  assert.deepEqual(release.jobs.publish.needs, ['plan', 'build']);
  assert.equal(release.concurrency['cancel-in-progress'], false);
  assert.equal(release.concurrency.queue, 'max');
  const checkout = build.jobs.desktop.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  const upload = build.jobs.desktop.steps.find((step) => step.with?.name?.startsWith('nvshift-'));
  assert.doesNotMatch(upload.with.path, /blockmap|test-results|mac-arm64|linux-unpacked/);
  const calls = release.jobs.publish.steps.find((step) => step.run === 'node scripts/release.mjs publish');
  assert.equal(calls.env.RELEASES_ENABLED, '${{ vars.RELEASES_ENABLED }}');
  assert.ok(!build.jobs.desktop.steps.some((step) => /secrets\./.test(JSON.stringify(step))));
});

function fakeGitHub({ existing = null, failUpload = false, latest = null, draftOnly = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, endpoint, body) {
      calls.push({ method, endpoint, body });
      if (endpoint.includes('/releases/tags/')) return draftOnly ? null : existing;
      if (endpoint.startsWith('/releases?')) return existing ? [existing] : [];
      if (endpoint === '/releases/latest') return latest;
      return { id: 1, draft: true, upload_url: 'https://uploads.github.com/test', assets: [], ...body };
    },
    async upload(_url, asset) {
      calls.push({ method: 'UPLOAD', asset: asset.name });
      if (failUpload) throw new Error('Network interrupted');
      return { name: asset.name, state: 'uploaded', size: asset.size, digest: asset.digest };
    },
  };
}
const assets = [{ name: 'test.dmg', size: 10, digest: 'sha256:test' }];
const plan = { tag: 'v0.1.0', version: '0.1.0' };

test('publication happens only after complete verified uploads', async () => {
  const api = fakeGitHub();
  await uploadAndPublish(api, plan, assets, 'Notes');
  assert.equal(api.calls.find((call) => call.method === 'POST').body.draft, true);
  assert.equal(api.calls.at(-1).body.draft, false);
  assert.ok(api.calls.findIndex((call) => call.method === 'UPLOAD') < api.calls.length - 1);
  const interrupted = fakeGitHub({ failUpload: true });
  await assert.rejects(uploadAndPublish(interrupted, plan, assets, 'Notes'), /Network interrupted/);
  assert.ok(!interrupted.calls.some((call) => call.body?.draft === false));
});

test('published releases are untouched, draft retries replace partial assets, older retries do not replace latest', async () => {
  const published = fakeGitHub({ existing: { id: 1, draft: false } });
  await uploadAndPublish(published, plan, assets, 'Notes');
  assert.deepEqual(published.calls.map((call) => call.method), ['GET']);
  const draft = fakeGitHub({ existing: { id: 1, draft: true, upload_url: 'https://uploads.github.com/test', assets: [{ id: 7 }] }, latest: { tag_name: 'v0.2.0' } });
  await uploadAndPublish(draft, plan, assets, 'Notes');
  assert.ok(draft.calls.some((call) => call.method === 'DELETE' && call.endpoint === '/releases/assets/7'));
  assert.equal(draft.calls.at(-1).body.make_latest, 'false');
});

test('release notes use the actual version and source, without stale publication instructions', () => {
  const notes = releaseNotes({ version: '0.12.0', repository: 'chadhs/nvShift', source, changes: 'Merged feature A.' });
  assert.match(notes, /nvshift-0\.12\.0-arm64\.dmg/);
  assert.match(notes, /nvshift-0\.12\.0\.tar\.gz/);
  assert.match(notes, /nvshift-0\.12\.0-win-x64-setup\.exe/);
  assert.match(notes, /SHA256SUMS-win32-x64\.txt/);
  assert.match(notes, /unsigned/);
  assert.match(notes, /File → Find unused assets/);
  assert.match(notes, /BSD-3-Clause/);
  assert.match(notes, /Closing the window only hides it/);
  assert.doesNotMatch(notes, /document tabs|fresh application identity|Up to 20 UTF-8 documents|Open file/);
  assert.ok(notes.includes('/blob/v0.12.0/README.org#install'));
  assert.ok(notes.includes(source));
  assert.match(notes, /Merged feature A/);
  const verified = releaseNotes({ version: '0.1.0', repository: 'chadhs/nvShift', source, runId: '12345' });
  assert.match(verified, /Native build and package checks\]\(https:\/\/github.com\/chadhs\/nvShift\/actions\/runs\/12345\)/);
  assert.doesNotMatch(notes, /MVP-v0\.1|after the PR is merged/);
});


test('manual recovery and merged-PR fallback only allow trusted main events', () => {
  const main = { GITHUB_ACTIONS: 'true', RELEASES_ENABLED: 'true', GITHUB_REF: 'refs/heads/main' };
  assert.doesNotThrow(() => assertMainRelease({ ...main, GITHUB_EVENT_NAME: 'workflow_dispatch' }));
  const merged = { ...main, GITHUB_EVENT_NAME: 'pull_request_target', RELEASE_PR_MERGED: 'true', RELEASE_PR_BASE: 'main' };
  assert.doesNotThrow(() => assertMainRelease(merged));
  for (const change of [{ RELEASE_PR_MERGED: 'false' }, { RELEASE_PR_BASE: 'feature' }, { GITHUB_REF: 'refs/pull/2/merge' }, { GITHUB_EVENT_NAME: 'pull_request' }]) {
    assert.throws(() => assertMainRelease({ ...merged, ...change }), /trusted main/);
  }
  assert.throws(() => assertMainRelease({ ...main, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature' }), /trusted main/);
});


test('draft retries work when GitHub omits the draft from the tag endpoint', async () => {
  const api = fakeGitHub({ existing: { id: 1, tag_name: 'v0.1.0', draft: true, upload_url: 'https://uploads.github.com/test', assets: [] }, draftOnly: true });
  await uploadAndPublish(api, plan, assets, 'Notes');
  assert.ok(api.calls.some((call) => call.endpoint.startsWith('/releases?')));
  assert.ok(!api.calls.some((call) => call.method === 'POST'));
  assert.equal(api.calls.at(-1).body.draft, false);
});

test('renamed uploads are rejected before publication', async () => {
  const api = fakeGitHub();
  api.upload = async (_url, asset) => ({ name: 'unexpected-name.dmg', state: 'uploaded', size: asset.size, digest: asset.digest });
  await assert.rejects(uploadAndPublish(api, plan, assets, 'Notes'), /Upload verification failed/);
  assert.ok(!api.calls.some((call) => call.body?.draft === false));
});

test('nvShift source markers preserve retry identity without accepting another product marker', () => {
  const commit = 'c'.repeat(40);
  const message = `Release v0.1.0\n\nnvShift-Source: ${source}`;
  assert.equal(releaseSource(commit, message, [source]), source);
  for (const parents of [[], [source, commit], [commit]]) assert.equal(releaseSource(commit, message, parents), commit);
  assert.equal(releaseSource(commit, message.replace('nvShift-Source:', 'Markup-Preview-Source:'), [source]), commit);
  assert.equal(planRelease('0.1.0', [{ tag: 'v0.1.0', source: 'b'.repeat(40) }], source).version, '0.2.0');
  for (const bad of [source + '\n', 'a'.repeat(39), 'z'.repeat(40)]) assert.throws(() => planRelease('0.1.0', [], bad), /full source/);
});
