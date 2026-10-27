// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import manifest from '../package.json' with { type: 'json' };

if (process.platform !== 'darwin') throw new Error('Run macOS package checks on macOS.');
const { version } = manifest;
const directory = await mkdtemp(path.join(tmpdir(), 'nvshift-packaged-'));
const mount = path.join(directory, 'dmg');
const app = path.join(directory, 'nvShift.app');
const archive = path.resolve(`release/nvshift-${version}-${process.arch}.zip`);
const image = path.resolve(`release/nvshift-${version}-${process.arch}.dmg`);
let mounted = false;
const run = (file, args, extra = {}) => execFileSync(file, args, { stdio: 'inherit', timeout: 180000, ...extra });
try {
  run('ditto', ['-xk', archive, directory]);
  run(process.execPath, ['scripts/check-package.mjs', 'mac', app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  run(process.execPath, ['scripts/smoke.mjs'], { env: { ...process.env, NVSHIFT_EXECUTABLE: path.join(app, 'Contents/MacOS/nvShift') } });
  await mkdir(mount);
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image]);
  mounted = true;
  run('codesign', ['--verify', '--deep', '--strict', path.join(mount, 'nvShift.app')]);
  run(process.execPath, ['scripts/check-package.mjs', 'mac', path.join(mount, 'nvShift.app')]);
  console.log('ZIP runtime smoke and DMG signature/identity checks passed.');
} finally {
  if (mounted) run('hdiutil', ['detach', mount]);
  // The cleanup target is the unique directory created by this invocation.
  if (path.dirname(directory) !== tmpdir() || !path.basename(directory).startsWith('nvshift-packaged-')) throw new Error('Refusing unexpected cleanup path.');
  await rm(directory, { recursive: true, force: true });
}
