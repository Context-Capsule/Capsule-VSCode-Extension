import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDirectory, "..");
const manifestPath = join(extensionRoot, "package.json");
const extensionEntry = join(extensionRoot, "dist", "extension.js");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (manifest.name !== "context-capsule" || manifest.publisher !== "context-capsule") {
  throw new Error(
    `Refusing to launch: ${manifestPath} is not the Context Capsule VS Code extension manifest.`,
  );
}

if (!existsSync(extensionEntry)) {
  throw new Error(
    `The compiled extension entry does not exist at ${extensionEntry}. Run npm run compile first.`,
  );
}

function parseArguments(argv) {
  let dryRun = false;
  let workspace;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--workspace") {
      const value = argv[index + 1];
      if (!value) throw new Error("--workspace requires a path");
      workspace = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown dev-host argument: ${argument}`);
  }

  return { dryRun, workspace };
}

function needsShell(command) {
  if (process.platform !== "win32") return false;
  const extension = extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function resolveVsCodeCommand() {
  const explicit = process.env.CONTEXT_CAPSULE_VSCODE_BIN?.trim();
  if (explicit) {
    const resolved = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    if (!existsSync(resolved)) {
      throw new Error(`CONTEXT_CAPSULE_VSCODE_BIN does not exist: ${resolved}`);
    }
    return {
      command: resolved,
      shell: needsShell(resolved),
      source: "CONTEXT_CAPSULE_VSCODE_BIN",
    };
  }

  if (process.platform === "win32") {
    const candidates = [
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe")
        : undefined,
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe")
        : undefined,
      process.env["ProgramFiles(x86)"]
        ? join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe")
        : undefined,
    ].filter(Boolean);

    const installed = candidates.find(candidate => existsSync(candidate));
    if (installed) return { command: installed, shell: false, source: "detected Code.exe" };

    return { command: "code.cmd", shell: true, source: "PATH" };
  }

  return { command: "code", shell: false, source: "PATH" };
}

async function launchDetached(command, args, shell) {
  await new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(command, args, {
      cwd: extensionRoot,
      detached: true,
      stdio: "ignore",
      shell,
    });

    child.once("error", rejectLaunch);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}

const { dryRun, workspace } = parseArguments(process.argv.slice(2));
const vscode = resolveVsCodeCommand();
const launchArguments = [
  "--new-window",
  `--extensionDevelopmentPath=${extensionRoot}`,
];
if (workspace) launchArguments.push(workspace);

const plan = {
  vscode: vscode.command,
  vscode_source: vscode.source,
  extension_root: extensionRoot,
  extension_entry: extensionEntry,
  workspace: workspace ?? null,
  launch_arguments: launchArguments,
};

console.log("Context Capsule VS Code Development Host launch plan:");
console.log(JSON.stringify(plan, null, 2));

if (!dryRun) {
  await launchDetached(vscode.command, launchArguments, vscode.shell);
  console.log("VS Code Development Host launch requested successfully.");
}
