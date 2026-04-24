import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const tauriDir = join(repoRoot, "src-tauri");
const serviceDir = join(repoRoot, "apps", "service");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      [stderr, stdout].filter(Boolean).join("\n") || `${command} ${args.join(" ")} failed`
    );
  }

  return result.stdout ?? "";
}

function resolveRustHostTarget() {
  const output = run("rustc", ["-vV"]);
  const hostLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("host: "));

  if (!hostLine) {
    throw new Error("Unable to determine rust host target triple.");
  }

  return hostLine.slice("host: ".length).trim();
}

const targetTriple = resolveRustHostTarget();
const isWindows = targetTriple.includes("windows");
const executableName = isWindows ? "shipflow-service.exe" : "shipflow-service";
const bundledName = isWindows
  ? `shipflow-service-${targetTriple}.exe`
  : `shipflow-service-${targetTriple}`;

run("cargo", [
  "build",
  "--manifest-path",
  "apps/service/Cargo.toml",
  "--release",
  "--bin",
  "shipflow-service",
]);

const sourcePath = join(serviceDir, "target", "release", executableName);
const targetDir = join(tauriDir, "binaries");
const targetPath = join(targetDir, bundledName);

await mkdir(targetDir, { recursive: true });
await copyFile(sourcePath, targetPath);

console.log(`Prepared service binary: ${targetPath}`);
