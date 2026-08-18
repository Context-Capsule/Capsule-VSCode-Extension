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

### Launching the Extension Development Host

For **F5**, VS Code itself must have `Capsule-VSCode-Extension` opened as the workspace folder. Merely changing the integrated terminal directory with `cd` does not change `${workspaceFolder}`. The checked-in `Run Extension` configuration passes:

```text
--extensionDevelopmentPath=${workspaceFolder}
```

so opening a parent folder and then pressing F5 can launch an Extension Development Host without loading Context Capsule from this repository.

The less ambiguous development path is:

```powershell
npm run dev:host
```

`dev:host` compiles first, resolves the extension root from `scripts/dev-host.mjs` itself, verifies that `dist/extension.js` exists, and launches VS Code with the absolute extension directory in `--extensionDevelopmentPath`. It does not depend on the parent VS Code window's workspace selection.

To verify the launch plan without opening another VS Code window:

```powershell
npm run dev:host:doctor
```

To open a particular project inside the Development Host:

```powershell
npm run dev:host -- --workspace "C:\path\to\project"
```

On Windows the launcher prefers the installed VS Code `bin\code.cmd` CLI, then falls back to `Code.exe` and finally the `code.cmd` on `PATH`. Set `CONTEXT_CAPSULE_VSCODE_BIN` to an explicit VS Code CLI/executable when needed.

When the development extension is loaded, the Command Palette must contain the `Context Capsule:` commands contributed by `package.json`. Activation then creates `%LOCALAPPDATA%\ContextCapsule\logs\vscode-host-<PID>.log` before host-identity probing. If neither the commands nor that log exist, diagnose development-extension loading before changing Context Capsule's capture/restore logic.

## CLI connection

Install/build Capsule CLI and ensure `capsule` is on PATH, or set the machine-scoped `contextCapsule.cliPath` setting to the full executable path.

Use `Context Capsule: Connection Diagnostics` to verify the CLI and show the runtime state path.

## Safety

- no file contents are persisted by this adapter
- no VS Code process-memory snapshotting
- restore does not close unrelated existing tabs
- restore is disabled in untrusted workspaces
- the CLI path setting is machine-scoped and restricted in untrusted workspaces
