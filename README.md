# Context Capsule — VS Code Adapter

Captures restorable VS Code workspace/editor context for Context Capsule without snapshotting the VS Code process or file contents.

## Captured state

- workspace file and workspace folders
- local/remote VS Code host context
- Extension Development Host identity/path when it can be determined safely
- editor groups and text tabs
- tab order, active/dirty/pinned/preview metadata
- visible text-editor selections/cursors
- active text editor
- integrated terminal launch context (name, shell/profile data exposed by VS Code, working directory, and which terminal was active)

Non-text/custom tabs are recorded as context but marked non-restorable until a safe adapter exists for that tab type. Extension-provided pseudoterminals are likewise recorded but not recreated as arbitrary processes.

The extension continuously writes an atomic live snapshot to the Context Capsule runtime directory. `capsule save` reads that recent snapshot into SQLite. CLI-driven restoration is delivered to the matching live VS Code extension host through the local restore bus; a closed Extension Development Host can be relaunched by the CLI before that semantic request is consumed.

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

On Windows the launcher prefers the installed `Code.exe` directly for extension-development arguments, then falls back to the installation's `bin\code.cmd` and finally `code.cmd` on `PATH`. Set `CONTEXT_CAPSULE_VSCODE_BIN` to an explicit VS Code executable/CLI when needed.

When the development extension is loaded, the Command Palette must contain the `Context Capsule:` commands contributed by `package.json`. Activation creates `%LOCALAPPDATA%\ContextCapsule\logs\vscode-host-<PID>.log` before host-identity probing. If neither the commands nor that log exist, diagnose development-extension loading before changing Context Capsule's capture/restore logic.

## Persistent diagnostics

Each VS Code extension host owns its own log:

```text
%LOCALAPPDATA%\ContextCapsule\logs\vscode-host-<PID>.log
%LOCALAPPDATA%\ContextCapsule\logs\vscode-host-<PID>.log.1
```

The log records host identity probes, state synchronization, restore targeting/acceptance, changed/skipped resources, and failures. Logs rotate before the next write would exceed 1 MiB and retain one previous file. Individual messages are capped at 4096 characters and control characters are normalized so one event cannot forge additional physical log records.

The runtime semantic state remains separate under `%LOCALAPPDATA%\ContextCapsule\runtime\`.

## CLI connection

Install/build Capsule CLI and ensure `capsule` is on PATH, or set the machine-scoped `contextCapsule.cliPath` setting to the full executable path.

Use `Context Capsule: Connection Diagnostics` to verify the CLI and show the canonical/per-host runtime state and log paths. The CLI-wide `capsule doctor --verbose` command also checks whether recent VS Code semantic state is available.

## Safety

- no file contents are persisted by this adapter
- no VS Code process-memory snapshotting
- shell history is not replayed as commands
- extension pseudoterminals are not guessed/recreated as normal process terminals
- restore does not close unrelated existing tabs
- restore is disabled in untrusted workspaces
- the CLI path setting is machine-scoped and restricted in untrusted workspaces
