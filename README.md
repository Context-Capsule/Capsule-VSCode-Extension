# Context Capsule — VS Code Adapter

VS Code semantic-state adapter for Context Capsule. It captures restorable editor/workspace context without snapshotting the VS Code process or persisting file contents.

This repository owns **VS Code-specific semantics**. It does not own capsule persistence or generic workspace restoration: the Rust CLI/Local Agent remains the core engine, while this extension continuously publishes editor state and consumes semantic restore requests.

## Context Capsule ecosystem

Context Capsule is split across four cooperating repositories:

```text
                         user-facing clients

  +----------------------+                 +----------------------+
  | Capsule Desktop App  |                 | Capsule CLI          |
  | Tauri + Svelte       |                 | Rust CLI client      |
  +----------+-----------+                 +----------+-----------+
             | bundled/allow-listed CLI               |
             +--------------------------->             |
                                                       | authenticated
                                                       | loopback IPC
                                                       v
                                             +--------------------+
                                             | Local Agent        |
                                             | worker + engines   |
                                             | SQLite persistence |
                                             +----+-----------+---+
                                                  |           |
                       runtime files/restore bus   |           | native messaging
                                                  |           |
                      +---------------------------+           +------------------+
                      |                                                          |
                      v                                                          v
          +---------------------------+                              +---------------------------+
          | Capsule VS Code Extension |                              | Capsule Browser Extension |
          | this repository           |                              | Firefox/Zen + Chrome      |
          +---------------------------+                              +---------------------------+
```

### Repository responsibilities

| Repository | Primary responsibility |
| --- | --- |
| [Capsule-CLI](https://github.com/Context-Capsule/Capsule-CLI) | Core domain engine, Local Agent/worker, SQLite/revisions, generic terminals, Docker, Windows desktop state, browser native hosts, VS Code snapshot persistence/routing |
| [Capsule-Desktop-App](https://github.com/Context-Capsule/Capsule-Desktop-App) | Tauri/Svelte desktop UX and safe GUI-to-CLI bridge |
| [Capsule-Browser-Extension](https://github.com/Context-Capsule/Capsule-Browser-Extension) | Firefox/Zen and Chrome tab/window/group semantic capture/restore |
| **Capsule-VSCode-Extension** | VS Code workspace/editor/integrated-terminal semantic capture/restore and extension-host targeting |

## Where should a feature be implemented?

| Change | Repository / layer |
| --- | --- |
| Capture another VS Code concept exposed by the VS Code API | This repo, primarily `src/adapter/capture.ts` + state/types |
| Change how saved VS Code tabs/workspaces are restored | This repo, `src/adapter/restore.ts` and specialized restore helpers |
| Change integrated-terminal restore semantics | This repo, `src/adapter/terminal-restore.ts` / `service-restart.ts` |
| Change how the extension identifies the correct VS Code/Extension Development Host | This repo, `src/adapter/host-identity.ts` and `src/bridge/host-target.ts` |
| Change local restore-bus delivery/acknowledgement | This repo, `src/bridge/restore-bus.ts`, plus CLI if the wire/runtime contract changes |
| Add a capsule database field, revision behavior, generic restore rule, or CLI command | `Capsule-CLI` first |
| Add desktop GUI for VS Code-related engine data | `Capsule-Desktop-App` after the CLI exposes the data |
| Browser tabs/windows/groups | `Capsule-Browser-Extension`, not this repo |
| Generic PowerShell/cmd/Windows Terminal sessions outside VS Code | `Capsule-CLI`, not this repo |

A useful rule: **if the behavior depends on the VS Code Extension API, it belongs here; if it must work independently of VS Code, it usually belongs in the CLI engine.**

## What is captured

The adapter records semantic, reconstructable context such as:

- workspace file and workspace folders;
- local/remote VS Code host context;
- Extension Development Host identity/path when it can be determined safely;
- editor groups and text tabs;
- tab order and active/dirty/pinned/preview metadata;
- visible text-editor selections/cursors;
- the active text editor;
- integrated-terminal launch context exposed by VS Code, including name, shell/profile data, working directory, and active terminal.

Non-text/custom tabs are retained as context but marked non-restorable until a safe adapter exists for the tab type. Extension-provided pseudoterminals are also recorded as context but are not recreated by guessing an arbitrary process command.

## Runtime data flow

### Capture

```text
VS Code events
    |
    v
src/extension.ts
    |
    v
src/adapter/capture.ts
    |
    +--> host identity / terminal metadata / typed state
    |
    v
atomic live snapshot under %LOCALAPPDATA%\ContextCapsule\runtime\
    |
    v
Capsule CLI save/update reads recent semantic state
    |
    v
SQLite capsule revision
```

The extension does **not** need the CLI process to remain running in order to maintain live semantic state.

### Restore

```text
capsule restore <name>
    |
    v
CLI / Local Agent selects saved VS Code semantic state
    |
    +--> may relaunch a closed matching Extension Development Host
    |
    v
local restore bus
    |
    v
src/bridge/restore-bus.ts
    |
    v
src/adapter/restore.ts
    |
    +--> editor groups/tabs/selections
    +--> integrated terminals
    +--> active-resource reconciliation
```

Restore is semantic and conservative: unrelated tabs are not blindly closed, shell history is not replayed as commands, and unsupported tab types are not reconstructed by guessing.

## Repository architecture

```text
Capsule-VSCode-Extension/
├─ src/
│  ├─ extension.ts                 activation, commands, event wiring, orchestration
│  ├─ adapter/
│  │  ├─ capture.ts               build VS Code semantic snapshot
│  │  ├─ state.ts                 live-state persistence/update helpers
│  │  ├─ types.ts                 adapter data model
│  │  ├─ restore.ts               editor/workspace semantic restore
│  │  ├─ terminal-restore.ts      integrated-terminal restore behavior
│  │  ├─ service-restart.ts       restartable service handling
│  │  └─ host-identity.ts         identify local/remote/dev extension host
│  ├─ bridge/
│  │  ├─ cli.ts                   CLI invocation/diagnostic bridge
│  │  ├─ restore-bus.ts           local restore request transport
│  │  └─ host-target.ts           restore targeting helpers
│  └─ test/                       VS Code extension tests
├─ scripts/
│  └─ dev-host.mjs                reliable Extension Development Host launcher
├─ esbuild.js                     extension bundling
├─ package.json                   commands, settings, activation, build scripts
├─ .vscode-test.mjs               VS Code test runner config
└─ dist/extension.js              generated extension bundle
```

### `src/extension.ts` is orchestration, not the domain model

Keep activation, command registration and VS Code event subscription in `extension.ts`. Reusable capture/restore behavior belongs under `adapter/`; transport/integration mechanics belong under `bridge/`.

This makes feature placement predictable:

- **new state field** -> `adapter/types.ts`, capture/state, restore if applicable;
- **new VS Code command** -> `package.json` contribution + `extension.ts` handler;
- **new restore semantic** -> `adapter/restore.ts` or a focused helper;
- **new CLI/runtime transport behavior** -> `bridge/`, coordinated with `Capsule-CLI`.

## CLI connection

Install/build Capsule CLI and ensure `capsule` is on `PATH`, or set the machine-scoped VS Code setting:

```text
contextCapsule.cliPath
```

Use **Context Capsule: Connection Diagnostics** to verify the CLI and show canonical/per-host runtime state and log paths. The CLI-wide command also checks whether recent VS Code semantic state is available:

```powershell
capsule doctor --verbose
```

The configured CLI executable is restricted in untrusted workspaces. Capture can remain available, while restore and configured executable use stay disabled until the workspace is trusted.

## Development

### Requirements

- Node.js compatible with the checked-in dependencies
- npm
- VS Code compatible with the extension engine declared in `package.json`
- Capsule CLI for end-to-end capture/restore testing

### Install dependencies

```powershell
npm ci
```

### Compile

```powershell
npm run compile
```

`compile` performs type checking, linting, and esbuild bundling.

### Run tests

```powershell
npm test
```

The test command compiles tests and the extension, then runs the VS Code test harness.

### Production bundle

```powershell
npm run package
```

This runs type checks/linting and emits a production `dist/extension.js` bundle. Distribution packaging/signing is a separate release concern; this script is the repository's production bundle step.

### Watch mode

```powershell
npm run watch
```

This runs the esbuild and TypeScript watchers in parallel.

## Launching the Extension Development Host

The most reliable development path is:

```powershell
npm run dev:host
```

`dev:host` compiles first, resolves the extension root from `scripts/dev-host.mjs`, verifies `dist/extension.js`, and launches VS Code with the absolute extension directory in `--extensionDevelopmentPath`.

To inspect the launch plan without opening a new VS Code window:

```powershell
npm run dev:host:doctor
```

To open a particular project in the Development Host:

```powershell
npm run dev:host -- --workspace "C:\path\to\project"
```

On Windows, the launcher prefers the installed `Code.exe`, then the installation's `bin\code.cmd`, then `code.cmd` on `PATH`. Override discovery with:

```powershell
$env:CONTEXT_CAPSULE_VSCODE_BIN = "C:\path\to\Code.exe"
```

You can also use the checked-in **Run Extension** F5 configuration, but the extension repository must actually be the VS Code workspace folder. Merely changing an integrated terminal's current directory does not change `${workspaceFolder}`.

## Verifying a development host

When the extension loads successfully:

- the Command Palette contains the `Context Capsule:` commands contributed by `package.json`;
- activation creates a per-host diagnostic log;
- semantic state is written under the Context Capsule runtime directory.

If neither commands nor logs appear, diagnose extension loading before changing capture/restore code.

## Persistent diagnostics

Each VS Code extension host owns its own rotating log:

```text
%LOCALAPPDATA%\ContextCapsule\logs\vscode-host-<PID>.log
%LOCALAPPDATA%\ContextCapsule\logs\vscode-host-<PID>.log.1
```

Logs include host identity probes, state synchronization, restore targeting/acceptance, changed/skipped resources, and failures. Runtime semantic state remains separate under:

```text
%LOCALAPPDATA%\ContextCapsule\runtime\
```

Logs rotate before the next write would exceed the configured bound; messages are length-limited and control characters are normalized.

## Developing a cross-repo VS Code feature

Use this order when the feature requires persisted or engine-visible data:

1. Define the VS Code semantic state in this repo.
2. Capture it in `src/adapter/capture.ts` and update adapter types/state.
3. If the persisted capsule schema or CLI routing changes, update `Capsule-CLI` and its tests.
4. Implement restore semantics in this repo.
5. If the desktop app needs to expose the new information, add a thin CLI desktop API field first, then update `Capsule-Desktop-App`.
6. Validate a real `save -> close/change state -> restore` cycle with the development extension loaded.

Protocol/schema changes should be treated as cross-repo contracts, not silently changed on one side.

## Safety invariants

- File contents are not persisted by this adapter.
- VS Code process memory is not snapshotted.
- Shell history is not replayed as commands.
- Extension pseudoterminals are not guessed/recreated as arbitrary processes.
- Restore does not indiscriminately close unrelated existing tabs.
- Restore is disabled in untrusted workspaces.
- The CLI path setting is machine-scoped and restricted in untrusted workspaces.

Preserve these invariants when adding features.