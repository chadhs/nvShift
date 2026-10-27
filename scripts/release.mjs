// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import { execFileSync } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { planRelease, releaseSource, stampVersion, verifyAssets, assertMainRelease, releaseNotes, uploadAndPublish, findRelease } from './lib/releases.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const command = process.argv[2];
if (command === 'stamp') {
  await stampVersion(process.cwd(), process.argv[3] || process.env.RELEASE_VERSION);
} else {
  assertMainRelease(process.env);
  const source = process.env.RELEASE_SOURCE || process.env.GITHUB_SHA;
  if (typeof source !== 'string' || source.length !== 40 || !/^[a-f0-9]{40}$/.test(source)) throw new Error('Missing full source commit SHA.');
  if (git('rev-parse', 'HEAD') !== source) throw new Error('Checkout must match the triggering source commit.');
  // A merged-event fallback may arrive after main has advanced. Only release
  // the exact merged snapshot, and require it to be part of main's history.
  git('merge-base', '--is-ancestor', source, 'origin/main');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid GitHub repository.');
  if (!process.env.GH_TOKEN) throw new Error('A GitHub Actions token is required.');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
  const github = {
    async request(method, endpoint, body, allowMissing = false) {
      const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
        method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (allowMissing && response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub ${method} ${endpoint}: HTTP ${response.status}`);
      return response.status === 204 ? null : response.json();
    },
    async upload(template, asset) {
      const url = new URL(template.replace(/\{.*\}$/, ''));
      if (url.origin !== 'https://uploads.github.com') throw new Error('Unexpected release upload host.');
      url.searchParams.set('name', asset.name);
      const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size) }, body: createReadStream(asset.file), duplex: 'half' });
      if (!response.ok) throw new Error(`GitHub asset upload ${asset.name}: HTTP ${response.status}`);
      return response.json();
    },
  };
  const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean).map((tag) => {
    const commit = git('rev-parse', `${tag}^{commit}`);
    const parents = git('rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
    return { tag, source: releaseSource(commit, git('show', '-s', '--format=%B', commit), parents) };
  });
  const initial = JSON.parse(await readFile('package.json', 'utf8')).version;
  const plan = planRelease(initial, tags, source);
  if (command === 'plan') {
    const existing = plan.existing ? await findRelease(github, plan.tag) : null;
    const output = { version: plan.version, source, published: String(Boolean(existing && !existing.draft)) };
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify(output));
  } else if (command === 'publish') {
    assertMainRelease(process.env);
    if (plan.version !== process.env.RELEASE_VERSION) throw new Error('Release version changed since planning; rerun the workflow.');
    const assets = await verifyAssets(path.resolve('release'), plan.version);
    let commit;
    if (plan.existing) {
      commit = git('rev-parse', `${plan.tag}^{commit}`);
      const manifest = JSON.parse(git('show', `${plan.tag}:package.json`));
      if (manifest.version !== plan.version) throw new Error('Existing tag has a conflicting package version.');
    } else {
      git('diff', '--exit-code');
      git('diff', '--cached', '--exit-code');
      await stampVersion(process.cwd(), plan.version);
      git('add', 'package.json', 'package-lock.json');
      git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '--allow-empty', '-m', `Release ${plan.tag}`, '-m', `nvShift-Source: ${source}`);
      commit = git('rev-parse', 'HEAD');
      git('push', 'origin', `${commit}:refs/tags/${plan.tag}`);
    }
    const existing = await findRelease(github, plan.tag);
    if (existing && !existing.draft) console.log(`Already published: ${existing.html_url}`);
    else {
      const generated = plan.previous ? await github.request('POST', '/releases/generate-notes', { tag_name: plan.tag, target_commitish: commit, previous_tag_name: plan.previous }) : { body: '### Changes\n\nFirst public release of nvShift.' };
      const release = await uploadAndPublish(github, plan, assets, releaseNotes({ version: plan.version, repository, source, changes: generated.body, runId: process.env.GITHUB_RUN_ID }));
      console.log(release.html_url);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `Published [${plan.tag}](${release.html_url}) from ${source}.\n`);
    }
  } else throw new Error('Use plan, stamp VERSION, or publish.');
}
