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
- `droppedPath(file)` -> a path for a user-dropped File using Electron webUtils.
- `image(id, revision, reference)` -> `{dataUrl}` or `{error}`.
- `diagram(id, revision, reference, theme)` -> `{svg}` or `{error}`.
- `openLink(id, revision, reference)` -> `{document, fragment}`; the document can be absent for an external URL or in-document anchor.
- `external(url)`, `reveal(id)`, `windowTheme(theme)`.
- `onState(callback)`, `onDocument(callback)`, `onLibrary(callback)`, `onCommand(callback)` -> unsubscribe. Commands include `focus-search`, `settings`, `find`, `save`, `cycle-view`.
- `rendererFlushed(requestId, error?)` acknowledges a `flush` command after staged edits reach the main process. Hide/Quit wait for this acknowledgement before flushing disk writes.

Settings are flat for the renderer: `{mode,light,dark,sansSerifHeadings,contentWidth,vimMode,viewMode,defaultExtension,txtSyntax,globalShortcut,sidebarWidth,splitRatio}`. Defaults: system/light/dark/false/reading/false/editor/md/plain/CommandOrControl+Shift+Space/300/0.5. Store library-specific `defaultExtension` and `txtSyntax` separately on disk.

Library state is `{root,count,indexing,errors}`; errors is an array of user-readable strings. Shortcut state is `{accelerator,registered,error}`.

A document is `{id,path,name,title,relativePath,extension,format,source,revision,clientVersion,diskFingerprint,status,modified,error?}`. `format` is `plain`, `markdown`, or `org`; extension excludes the dot. Status is `saved`, `saving`, `dirty`, `conflict`, or `error`. `revision` is a server buffer revision used for resource validation, independent of disk fingerprint and clientVersion. `source` uses LF internally; preserve original BOM/EOL on disk. A source change event from outside the editor must not replace newer local edits.

## Backend controller expected by main process

Export `createLibrary({userData,onDocument,onLibrary,onError,trashItem})` from `electron/library.cjs`. Return a controller with asynchronous `open(root, preferences?)`, `search(query)`, `create(title,extension)`, `activate(id)`, `updateBuffer(id,source,clientVersion)`, `save(id)`, `rename(id,title)`, `trash(id)`, `resolveConflict(id,action)`, `setPreferences({defaultExtension,txtSyntax})`, `flush()`, and `dispose()`. Provide synchronous `snapshot()`, `active()`, and `get(id)` returning document snapshots or null. `snapshot()` is library state, not whole application state. Root handles folder picker and settings persistence. If simple adjustments to this contract are needed, coordinate with root before changing it.

Resource modules accept immutable document snapshots containing `{id,path,name,source,format,revision}`. Preview analyzer and resource validation must see the same current source, including unsaved changes.
