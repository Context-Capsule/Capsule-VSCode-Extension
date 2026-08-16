# Context Capsule — VS Code Adapter

Captures restorable VS Code workspace/editor context for Context Capsule without snapshotting the VS Code process or file contents.

## Captured state

- workspace file and workspace folders
- local/remote VS Code host context
- editor groups and text tabs
- tab order, active/dirty/pinned/preview metadata
- visible text-editor selections/cursors
- active text editor

Non-text/custom tabs are recorded as context but marked non-restorable until a safe adapter exists for that tab type.

The extension continuously writes an atomic live snapshot to the Context Capsule runtime directory. `capsule save` reads that recent snapshot into SQLite. Restoring a saved VS Code snapshot is initiated by `Context Capsule: Restore VS Code Context from Capsule`, which calls the local CLI only to retrieve the saved semantic snapshot.

## Development

```powershell
npm ci
npm run compile
npm test
```

Press **F5** to launch an Extension Development Host. The generated `$esbuild-watch` dependency has been removed; watch tasks work without installing a separate problem-matcher extension.

## CLI connection

Install/build Capsule CLI and ensure `capsule` is on PATH, or set the machine-scoped `contextCapsule.cliPath` setting to the full executable path.

Use `Context Capsule: Connection Diagnostics` to verify the CLI and show the runtime state path.

## Safety

- no file contents are persisted by this adapter
- no VS Code process-memory snapshotting
- restore does not close unrelated existing tabs
- restore is disabled in untrusted workspaces
- the CLI path setting is machine-scoped and restricted in untrusted workspaces
