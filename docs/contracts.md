# nvShift integration contracts

This internal contract coordinates the MVP implementation. All note operations use opaque IDs issued by the main process, never renderer-selected write paths.

## Renderer preload API

`window.nvShift` exposes:

- `platform`: OS string.
- `initial()` -> `{settings, library, document, shortcut}`.
- `chooseLibrary()` -> same state after a native folder picker, or `null` on cancel.
- `search(query)` -> `{results, total, query}`. Each result is `{id,name,title,relativePath,snippet,modified,format,extension}`. Creation is a separate renderer result.
- `create(title, extension)` -> document.
- `open(id)` -> document, flushing the previously active note first.
- `updateBuffer(id, source, clientVersion, baseRevision)` -> document. Versions increase per note; returned snapshots echo `clientVersion`. `baseRevision` detects outside reloads racing local edits.
- `save(id)` -> document.
- `rename(id, title)` -> document.
- `trash(id)` -> state.
- `resolveConflict(id, action)` -> document; action is `keep-both` or `use-disk`.
- `updateSettings(patch)` -> settings. Library fields are applied to the active library.
- `insertImage(id, bytes, name)` -> `{text}`; bytes are a Uint8Array or number array.
- `insertImagePaths(id, paths)` -> `{text}` for native dropped image paths.
- `startAssetCleanup()` -> `{scanId}`; progress/results arrive through `onAssetCleanup(callback)`.
- `cancelAssetCleanup(scanId)` cancels that scan without removing files.
- `assetCleanupThumbnail(scanId, assetId)` -> `{dataUrl}` for an opaque candidate from the current review.
- `trashUnusedAssets(scanId, assetIds)` -> `{removed,failed}` after revalidation and OS Trash operations.
- `protectAssetHistory(id, previousSource)` retains the note's previous editor source for session Undo protection.
- `droppedPath(file)` -> a path for a user-dropped File using Electron webUtils.
- `image(id, revision, reference)` -> `{dataUrl}` or `{error}`.
- `diagram(id, revision, reference, theme)` -> `{svg}` or `{error}`.
- `openLink(id, revision, reference)` -> `{document, fragment}`; the document can be absent for an external URL or in-document anchor.
- `external(url)`, `reveal(id)`, `windowTheme(theme)`.
- `onState(callback)`, `onDocument(callback)`, `onLibrary(callback)`, `onCommand(callback)` -> unsubscribe. Commands include `focus-search`, `settings`, `find`, `save`, `cycle-view`.
- `rendererFlushed(requestId, error?)` acknowledges a `flush` command after staged edits reach the main process. Hide/Quit wait for this acknowledgement before flushing disk writes.

Settings are flat for the renderer: `{mode,light,dark,sansSerifHeadings,contentWidth,filenameHeadings,vimMode,viewMode,defaultExtension,txtSyntax,globalShortcut,sidebarWidth,splitRatio}`. Defaults: system/light/dark/false/reading/false/false/editor/md/plain/CommandOrControl+Shift+Space/300/0.5. Store library-specific `defaultExtension` and `txtSyntax` separately on disk. `filenameHeadings` is a global presentation preference and must be a boolean.

Library state is `{root,count,indexing,errors}`; errors is an array of user-readable strings. Shortcut state is `{accelerator,registered,error}`.

Search Up/Down displays the highlighted existing note through `open(id)` while
retaining focus in the search input and retaining the current view. Enter and
result clicks use the normal edit-and-focus behavior. Arrow requests coalesce
and share the navigation/save queue; a superseded in-flight open restores the
displayed note's main-process selection before newer navigation runs. Query
changes, focus changes, and explicit navigation invalidate pending browse work.
Highlighting Create never invokes `create()`.

A document is `{id,path,name,title,relativePath,extension,format,source,revision,clientVersion,diskFingerprint,status,modified,error?}`. `format` is `plain`, `markdown`, or `org`; extension excludes the dot. Status is `saved`, `saving`, `dirty`, `conflict`, or `error`. `revision` is a server buffer revision used for resource validation, independent of disk fingerprint and clientVersion. `source` uses LF internally; preserve original BOM/EOL on disk. A source change event from outside the editor must not replace newer local edits.

## Backend controller expected by main process

Export `createLibrary({userData,onDocument,onLibrary,onError,trashItem})` from `electron/library.cjs`. Return a controller with asynchronous `open(root, preferences?)`, `search(query)`, `create(title,extension)`, `activate(id)`, `updateBuffer(id,source,clientVersion)`, `save(id)`, `rename(id,title)`, `trash(id)`, `resolveConflict(id,action)`, `setPreferences({defaultExtension,txtSyntax})`, `flush()`, and `dispose()`. Provide synchronous `snapshot()`, `active()`, and `get(id)` returning document snapshots or null. `snapshot()` is library state, not whole application state. Root handles folder picker and settings persistence. If simple adjustments to this contract are needed, coordinate with root before changing it.

Resource modules accept immutable document snapshots containing `{id,path,name,source,format,revision}`. Preview analyzer and resource validation must see the same current source, including unsaved changes.

## Content headings and editor commands

Main-owned document `title` and search-result labels remain filename-based.
Presentation resolves explicit metadata title, first document-level H1, then
filename. The browser worker uses the same AST-based resolver for lightweight
title-only requests and full previews. Internal `renderer.render(document,
{titleOnly,filenameHeadings})` options default to false; no preload methods change.
Editor-view titles use the current unsaved buffer with debounce and generation,
note, syntax, filename, and source checks before applying asynchronous results.
Full preview requests also include the heading preference in their cache key.

The Org language compartment supplies Enter list continuation. Vim's newline
command invokes the same Org command in Insert mode and falls back to its original
handler elsewhere. These commands change the CodeMirror document through normal
transactions, preserving undo and the existing buffer/recovery pipeline.

## Linked-directory locations

Directory discovery is a canonical graph. Public document `path` is the real
physical file; `relativePath` is the preferred route through the chosen library.
The internal logical path and directory identity are pinned separately. Linked
aliases share one note ID. `resolveIndexedPath(path)` asynchronously resolves a
canonical or aliased link to an indexed, reachable note. `assertWritable(id)`
revalidates the pinned location before image insertion; neither is exposed to
the renderer as a general filesystem API. New notes remain at the library root.

Recovery journals use version 2 with the original physical path, logical route,
and directory identity. Version 1 journals remain readable. Link removal or
retargeting never rebinds a pending buffer to a different target. A bounded
retired-record cache retains location history so renderer updates arriving just
after a clean note disappears can still be preserved as conflict drafts.

## Asset cleanup

Cleanup scans regular image files directly inside the selected library's own
assets directory. A separate bounded Node worker collects references without
preview image-count limits. Fresh disk text, main-owned buffers, active recovery
drafts, and per-session Undo/import pins protect candidates; archive-only
references classify a candidate as `backup`, otherwise it is `unused`.

`onAssetCleanup` receives `{scanId,status,done,total,candidates,protectedCount,errors}`.
Status is `scanning`, `complete`, `cancelled`, or `error`; candidates expose only
`{id,name,size,category}`. All filesystem paths and scan capabilities remain
main-owned. Incomplete scans never authorize removal. Trash rechecks the library,
references, recovery data, and file identities and reports per-item failures.

The editor sends every pre-change source to history protection before its
coalesced buffer update. History writes are drained before scanning or switching
libraries; protection survives folder switches until the process restarts.
Imports register their destination before the exclusive write so the image is
protected before its inserted link reaches the buffer. Cleanup thumbnails are
bounded in size/concurrency and unloaded outside the review viewport.
