import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/notices.mjs', import.meta.url));
const mit = `The MIT License (MIT)\n\nCopyright (c) 2026 Example Author\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n`;
async function fixture(t, runtime) {
  const root = await mkdtemp(path.join(tmpdir(), 'nvshift-notices-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
  for (const [name, manifest, text] of [
    ['fixture', { name: 'fixture', version: '1.0.0', ...runtime }, mit],
    ['electron', { name: 'electron', version: '1.0.0', license: 'MIT' }, mit],
  ]) {
    const directory = path.join(root, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'LICENSE'), text);
  }
  return root;
}
function run(root, ...args) {
  return execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
}

test('license inventory infers a complete MIT license, retains notices, and checks reproducibility', async (t) => {
  const root = await fixture(t, {});
  await writeFile(path.join(root, 'node_modules/fixture/NOTICE'), 'Keep this package attribution.');
  assert.match(run(root), /2 installed runtime packages/);
  const output = await readFile(path.join(root, 'THIRD-PARTY-NOTICES.org'), 'utf8');
  assert.match(output, /License: MIT/);
  assert.match(output, /Keep this package attribution/);
  assert.doesNotMatch(output, /License: undefined/);
  assert.match(run(root, '--check'), /Verified license notices/);
  await writeFile(path.join(root, 'THIRD-PARTY-NOTICES.org'), 'stale');
  assert.throws(() => run(root, '--check'), /Command failed/);
});

for (const license of ['GPL-3.0-only', 'AGPL-3.0-or-later', 'LGPL-3.0-only']) {
  test(`license inventory rejects a ${license} requirement before writing notices`, async (t) => {
    const root = await fixture(t, { license });
    let failure;
    try { run(root); } catch (error) { failure = error; }
    assert.ok(failure, 'A copyleft requirement must fail the inventory');
    assert.match(failure.stderr, /Copyleft license requires review before shipping/);
    await assert.rejects(access(path.join(root, 'THIRD-PARTY-NOTICES.org')), { code: 'ENOENT' });
  });
}

test('license inventory rejects an unidentified license instead of printing its value', async (t) => {
  const root = await fixture(t, { license: 'Unknown-custom-license' });
  let failure;
  try { run(root); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.match(failure.stderr, /Unidentified or unreviewed license/);
});
