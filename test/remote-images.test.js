import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createImageReader, MAX_IMAGE_BYTES, MAX_DOCUMENT_IMAGE_BYTES } from '../electron/images.cjs';
import { renderMarkdown } from '../src/markdown.js';
import { renderOrg } from '../src/org.js';
import { createImageFixture, fixturePng } from '../scripts/lib/image-fixture.mjs';

function setup(targets, options, format = 'markdown') {
  const source = targets.map((target) => format === 'org' ? `[[${target}]]` : `![Alt text](${target})`).join('\n\n');
  const doc = { path: `/notes/test.${format === 'org' ? 'org' : 'md'}`, source };
  return { doc, images: (format === 'org' ? renderOrg(source) : renderMarkdown(source)).images, read: createImageReader(doc, options) };
}
const pngResult = { dataUrl: `data:image/png;base64,${fixturePng.toString('base64')}` };

test('HTTP image downloads support Org query strings, Markdown extensionless URLs, redirects and caching', async (t) => {
  const fixture = await createImageFixture();
  t.after(() => fixture.close());
  for (const format of ['org', 'markdown']) {
    const url = `${fixture.origin}/image.png?size=2#view`;
    const { read, images } = setup([url, url, `${fixture.origin}/redirect.png`], undefined, format);
    assert.deepEqual(await read(images[0]), pngResult);
    assert.deepEqual(await read(images[1]), pngResult);
    assert.deepEqual(await read(images[2]), pngResult);
  }
  assert.deepEqual(fixture.requests.map(({ url }) => url), ['/image.png?size=2', '/redirect.png', '/image', '/image.png?size=2', '/redirect.png', '/image']);
  for (const { headers } of fixture.requests) {
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.referer, undefined);
  }
});

test('remote formats are detected from bytes, independent of extension and content type', async () => {
  const formats = [
    [fixturePng, 'png'],
    [Buffer.from([255, 216, 255, 224]), 'jpeg'],
    [Buffer.from('GIF89a'), 'gif'],
    [Buffer.from('RIFF0000WEBP'), 'webp'],
    [Buffer.from('<?xml version="1.0"?>\n<!-- image -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg+xml'],
  ];
  for (const [bytes, mime] of formats) {
    const { read, images } = setup(['https://example.invalid/api/image'], { fetch: async (url, options) => {
      assert.equal(url, 'https://example.invalid/api/image');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(options.headers, undefined);
      return new Response(bytes, { headers: { 'Content-Type': 'text/plain' } });
    } });
    assert.deepEqual(await read(images[0]), { dataUrl: `data:image/${mime};base64,${bytes.toString('base64')}` });
  }
  for (const body of ['<script>bad()</script>', '<html><svg></svg></html>', 'Not an image', '']) {
    const { read, images } = setup(['https://example.invalid/photo.png'], { fetch: async () => new Response(body, { headers: { 'Content-Type': 'image/png' } }) });
    assert.match((await read(images[0])).error, /invalid image/);
  }
});

test('remote images report HTTP failures and invalid content without breaking later images', async (t) => {
  const fixture = await createImageFixture();
  t.after(() => fixture.close());
  const { read, images } = setup(['/missing.png', '/invalid.png', '/image'].map((target) => fixture.origin + target));
  assert.match((await read(images[0])).error, /HTTP 404/);
  assert.match((await read(images[1])).error, /invalid image/);
  assert.deepEqual(await read(images[2]), pngResult);
});

test('only verified image nodes initiate fetches, and renderer-supplied targets are ignored', async () => {
  const source = '![Real](https://example.invalid/image)\n\n```md\n![Fake](https://example.invalid/fake.png)\n```\n\n<img src="https://example.invalid/html.png">';
  const doc = { path: '/notes/test.md', source }, calls = [];
  const read = createImageReader(doc, { fetch: async (url) => { calls.push(url); return new Response(fixturePng); } });
  const reference = '![Fake](https://example.invalid/fake.png)', start = source.indexOf(reference);
  assert.match((await read({ start, end: start + reference.length, reference })).error, /Invalid/);
  const real = renderMarkdown(source).images[0];
  assert.match((await read({ ...real, reference: reference })).error, /changed/);
  assert.deepEqual(await read({ ...real, target: 'https://example.invalid/forged' }), pngResult);
  assert.deepEqual(calls, ['https://example.invalid/image']);
});

test('URLs containing credentials and redirects to credentials or unsupported protocols are rejected', async () => {
  let calls = 0;
  const direct = setup(['https://user:secret@example.invalid/image'], { fetch: async () => { calls++; return new Response(fixturePng); } });
  assert.match((await direct.read(direct.images[0])).error, /credentials/);
  assert.equal(calls, 0);
  for (const location of ['file:///secret.png', 'data:image/png;base64,AAA', 'ftp://example.invalid/image', 'https://user:secret@example.invalid/image']) {
    const { read, images } = setup(['https://example.invalid/image'], { fetch: async () => {
      calls++; return new Response(null, { status: 302, headers: { Location: location } });
    } });
    const previous = calls;
    assert.match((await read(images[0])).error, /HTTP or HTTPS|credentials/);
    assert.equal(calls, previous + 1);
  }
});

test('redirects allow HTTP and HTTPS, stop after five hops, and reject missing destinations', async () => {
  for (const hops of [5, 6]) {
    const calls = [];
    const { read, images } = setup(['http://example.invalid/0'], { fetch: async (url) => {
      calls.push(url);
      const hop = Number(new URL(url).pathname.slice(1));
      return hop < hops ? new Response(null, { status: 302, headers: { Location: `https://example.invalid/${hop + 1}` } }) : new Response(fixturePng);
    } });
    const result = await read(images[0]);
    if (hops === 5) assert.deepEqual(result, pngResult);
    else assert.match(result.error, /five redirects/);
    assert.equal(calls.length, 6);
  }
  const { read, images } = setup(['http://example.invalid/image'], { fetch: async () => new Response(null, { status: 302 }) });
  assert.match((await read(images[0])).error, /no destination/);
});

test('streamed byte limits apply without content lengths and with misleading lengths', async () => {
  for (const length of [undefined, '1', 'not-a-number', String(MAX_IMAGE_BYTES + 1)]) {
    let cancelled = false;
    const { read, images } = setup(['https://example.invalid/image'], { fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.alloc(MAX_IMAGE_BYTES)); controller.enqueue(Buffer.alloc(1)); },
      cancel() { cancelled = true; },
    }), { headers: length === undefined ? {} : { 'Content-Length': length } }) });
    assert.match((await read(images[0])).error, /8 MiB/);
    assert.equal(cancelled, true);
  }
});

test('local and remote images share byte budgets, cache duplicates and refresh on a new reader', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'markup-preview-remote-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
  fixturePng.copy(bytes);
  const local = path.join(directory, 'local.png');
  await writeFile(local, bytes);
  let calls = 0;
  const options = { fetch: async () => { calls++; return new Response(bytes); } };
  const targets = [local, 'https://example.invalid/1', 'https://example.invalid/1', 'https://example.invalid/2', 'https://example.invalid/3', 'https://example.invalid/4'];
  const { read, images, doc } = setup(targets, options);
  assert.equal(MAX_DOCUMENT_IMAGE_BYTES, MAX_IMAGE_BYTES * 4);
  for (const image of images.slice(0, 5)) assert.ok((await read(image)).dataUrl);
  assert.match((await read(images[5])).error, /Image limit reached/);
  assert.equal(calls, 4);
  assert.ok((await read(images[1])).dataUrl);
  assert.equal(calls, 4);
  assert.ok((await createImageReader(doc, options)(images[5])).dataUrl);
});

test('timeouts cover response headers, bodies and a complete redirect chain', async (t) => {
  const fixture = await createImageFixture((request, response) => {
    if (request.url === '/headers') return;
    if (request.url === '/body') { response.writeHead(200); response.write(fixturePng.subarray(0, 8)); return; }
    const hop = Number(request.url.slice(1));
    const timer = setTimeout(() => { response.writeHead(302, { Location: `/${hop + 1}` }); response.end(); }, 60);
    response.on('close', () => clearTimeout(timer));
  });
  t.after(() => fixture.close());
  for (const target of ['/headers', '/body', '/0']) {
    const { read, images } = setup([fixture.origin + target], { timeoutMs: 150 });
    assert.match((await read(images[0])).error, /timed out/);
  }
  const redirects = fixture.requests.filter(({ url }) => /^\/\d+$/.test(url));
  assert.ok(redirects.length >= 2 && redirects.length < 6);
});

test('cancelling a reader aborts active downloads and discards queued requests', async (t) => {
  let started;
  const downloading = new Promise((resolve) => { started = resolve; });
  const fixture = await createImageFixture((_request, response) => { response.write(fixturePng.subarray(0, 8)); started(); });
  t.after(() => fixture.close());
  const { read, images } = setup([`${fixture.origin}/slow`, `${fixture.origin}/queued`]);
  const first = read(images[0]), second = read(images[1]);
  await downloading;
  read.cancel();
  assert.match((await first).error, /document changed/);
  assert.match((await second).error, /document changed/);
  assert.match((await read(images[0])).error, /document changed/);
  assert.deepEqual(fixture.requests.map(({ url }) => url), ['/slow']);
});

test('failed downloads are cached for a revision and retried by a new reader', async () => {
  let calls = 0;
  const options = { fetch: async () => { calls++; return calls === 1 ? new Response(null, { status: 503 }) : new Response(fixturePng); } };
  const { read, images, doc } = setup(['https://example.invalid/image'], options);
  assert.match((await read(images[0])).error, /HTTP 503/);
  assert.match((await read(images[0])).error, /HTTP 503/);
  assert.equal(calls, 1);
  assert.deepEqual(await createImageReader(doc, options)(images[0]), pngResult);
});

test('a stalled remote image does not delay local reads and cancellation frees in-flight bytes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'markup-preview-image-queues-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'local.png');
  await writeFile(file, fixturePng);
  let started;
  const downloading = new Promise((resolve) => { started = resolve; });
  const { read, images } = setup(['https://example.invalid/slow', file], { fetch: async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(fixturePng);
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      started();
    },
  })) });
  t.after(() => read.cancel());
  const remote = read(images[0]);
  await downloading;
  let timer;
  try {
    const local = await Promise.race([read(images[1]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local image blocked by remote')), 1000); })]);
    assert.deepEqual(local, pngResult);
  } finally { clearTimeout(timer); read.cancel(); }
  assert.match((await remote).error, /document changed/);
});

test('concurrent local and remote reads cannot exceed their shared byte budget', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'markup-preview-concurrent-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES); fixturePng.copy(bytes);
  const local = path.join(directory, 'large.png'); await writeFile(local, bytes);
  const { read, images } = setup([local, ...Array.from({ length: 5 }, (_, index) => `https://example.invalid/${index}`)], { fetch: async () => new Response(bytes) });
  const results = await Promise.all(images.map(read));
  assert.equal(results.filter((result) => result.dataUrl).length, 4);
  assert.equal(results.filter((result) => /Image limit reached/.test(result.error)).length, 2);
});

test('invalid downloaded bytes release budget for later valid images', async () => {
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES); fixturePng.copy(bytes);
  const targets = Array.from({ length: 8 }, (_, index) => `https://example.invalid/${index}`);
  const { read, images } = setup(targets, { fetch: async (url) => new Response(Number(new URL(url).pathname.slice(1)) < 4 ? Buffer.alloc(MAX_IMAGE_BYTES) : bytes) });
  for (const reference of images.slice(0, 4)) assert.match((await read(reference)).error, /invalid image/);
  for (const reference of images.slice(4)) assert.ok((await read(reference)).dataUrl);
});
