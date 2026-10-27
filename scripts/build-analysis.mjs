import { build } from 'vite';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
await build({
  configFile: false,
  resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
  build: {
    target: 'node22', outDir: 'dist', emptyOutDir: false, minify: false,
    rolldownOptions: { external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)] },
    lib: { entry: 'src/document-analysis.js', formats: ['cjs'], fileName: () => 'document-analysis.cjs' },
  },
});
// Cleanup uses its own uncapped reference collector in a bounded Node worker.
await build({
  configFile: false,
  resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
  build: {
    target: 'node24', outDir: 'dist', emptyOutDir: false, minify: false,
    rolldownOptions: { external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)] },
    lib: { entry: 'src/asset-references.js', formats: ['cjs'], fileName: () => 'asset-references.cjs' },
  },
});
// Exercise the shipped file outside the repository, without DOM globals or dependencies.
const directory = await mkdtemp(path.join(tmpdir(), 'markup-preview-analysis-'));
try {
  const bundle = path.join(directory, 'analysis.cjs');
  await copyFile('dist/document-analysis.cjs', bundle);
  execFileSync(process.execPath, ['-e', String.raw`
    const assert = require('node:assert/strict');
    const { analyzeDocument } = require(process.argv[1]);
    for (const [format, source] of [['org', '[[file:chart.png]]'], ['markdown', '![Chart](chart.png)']]) {
      assert.equal(analyzeDocument({ source, format }).images[0].target.replace(/^file:/, ''), 'chart.png');
    }
    for (const [format, source, target] of [
      ['org', '[[https://example.invalid/chart.svg?size=2#view]]', 'https://example.invalid/chart.svg?size=2#view'],
      ['markdown', '![Chart][image]\n\n[image]: http://localhost:8080/image', 'http://localhost:8080/image'],
    ]) {
      assert.equal(analyzeDocument({ source, format }).images[0].target, target);
    }
    for (const [format, source] of [['org', '#+draft: true'], ['markdown', '---\ndraft: true\n---'], ['markdown', '+++\ndraft = true\n+++']]) {
      assert.equal(analyzeDocument({ source, format }).metadata.draft, true);
    }
  `, bundle], { stdio: 'inherit' });
  const references = path.join(directory, 'asset-references.cjs');
  await copyFile('dist/asset-references.cjs', references);
  execFileSync(process.execPath, ['-e', String.raw`
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const { collectAssetReferences } = require(process.argv[1]);
    const assets = Array.from({ length: 130 }, (_, index) => ({
      id: String(index), name: 'asset-' + index + '.png',
      path: path.resolve('assets', 'asset-' + index + '.png'),
    }));
    const source = assets.map((asset) => '![Image](assets/' + asset.name + ')').join('\n\n');
    collectAssetReferences({ path: path.resolve('Note.md'), format: 'markdown', source }, assets)
      .then((ids) => assert.equal(ids.length, 130)).catch((error) => { console.error(error); process.exitCode = 1; });
  `, references], { stdio: 'inherit', cwd: directory });
} finally { await rm(directory, { recursive: true, force: true }); }
