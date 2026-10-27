import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { documentArgument, documentArguments } from '../electron/arguments.cjs';

test('development and packaged command lines keep Unicode and unsupported paths', () => {
  for (const file of ['notes café 日本語.org', 'notes café 日本語.md', 'notes.MARKDOWN', 'unsupported.txt', 'large.org']) {
    assert.equal(documentArgument(['electron', '.', '--ozone-platform=wayland', file], false), file);
    assert.equal(documentArgument(['markup-preview', '--ozone-platform=x11', file], true), file);
  }
  assert.equal(documentArgument(['electron', '.', '--ozone-platform=wayland'], false), undefined);
  assert.equal(documentArgument(['markup-preview', '--', '-notes.org'], true), '-notes.org');
});


test('desktop file URLs resolve locally without treating remote URLs as files', () => {
  const file = path.join(tmpdir(), 'notes café 日本語.org');
  const url = pathToFileURL(file).href;
  assert.equal(documentArgument(['markup-preview', url], true), file);
  assert.equal(documentArgument(['electron', '.', url], false), file);
  for (const unsupported of ['https://example.com/notes.org', 'file://remote-host/notes.org', 'file:///tmp/bad%2Fpath.org']) {
    assert.equal(documentArgument(['markup-preview', unsupported], true), unsupported);
  }
});


test('second-instance Chromium flag reordering does not turn the app path into a document', () => {
  const file = path.join(tmpdir(), 'notes café.org');
  const flags = [`--user-data-dir=${path.join(tmpdir(), 'profile')}`,  '--allow-file-access-from-files', '--enable-avfoundation'];
  assert.equal(documentArgument(['electron', ...flags, '.', pathToFileURL(file).href], false), file);
  assert.equal(documentArgument(['electron', ...flags, '/source/markup-preview', 'notes.org'], false), 'notes.org');
  assert.equal(documentArgument(['markup-preview', ...flags, 'notes.org'], true), 'notes.org');
});

test('multi-file invocations preserve order, Unicode URLs and explicit dash-prefixed paths', () => {
  const file = path.join(tmpdir(), 'b c.org');
  assert.deepEqual(documentArguments(['electron', `--user-data-dir=${path.join(tmpdir(), 'profile')}`, '.', 'a.org', pathToFileURL(file).href, '--ozone-platform=x11'], false), ['a.org', file]);
  assert.deepEqual(documentArguments(['markup-preview', '--', '-a.org', 'b.org'], true), ['-a.org', 'b.org']);
});
