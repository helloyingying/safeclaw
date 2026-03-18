import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseInstallArgs } from "../bin/install-lib.mjs";
import { buildOpenClawDevPluginConfig } from "./openclaw-dev-link-lib.mjs";

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(ROOT, "openclaw.plugin.json"), "utf8"));
const parsed = parseInstallArgs(["--path", ROOT, "--link", ...process.argv.slice(2)]);
const openclawBin = typeof parsed.openclawBin === "string" && parsed.openclawBin.trim()
  ? parsed.openclawBin.trim()
  : "openclaw";

function extractConfigPath(output) {
  const candidates = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.endsWith(".json"));
  return candidates.at(-1) ?? "";
}

function expandHome(candidatePath) {
  if (!candidatePath.startsWith("~/")) {
    return candidatePath;
  }
  return path.join(os.homedir(), candidatePath.slice(2));
}

function resolveOpenClawConfigPath() {
  const envConfigPath = typeof process.env.OPENCLAW_CONFIG_PATH === "string"
    ? process.env.OPENCLAW_CONFIG_PATH.trim()
    : "";
  if (envConfigPath) {
    return envConfigPath;
  }

  const probe = spawnSync(openclawBin, ["config", "file"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  const probedPath = extractConfigPath(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`);
  if (probe.status === 0 && probedPath) {
    return expandHome(probedPath);
  }

  const envStateDir = typeof process.env.OPENCLAW_STATE_DIR === "string"
    ? process.env.OPENCLAW_STATE_DIR.trim()
    : "";
  return path.join(envStateDir || path.join(os.homedir(), ".openclaw"), "openclaw.json");
}

function runCommand(command, args, dryRun) {
  const display = [command, ...args].map((part) => JSON.stringify(part)).join(" ");
  console.log(display);
  if (dryRun) {
    return;
  }

  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const pluginId = typeof manifest.id === "string" && manifest.id.trim()
  ? manifest.id.trim()
  : String(pkg.name);
const configPath = resolveOpenClawConfigPath();
const config = JSON.parse(readFileSync(configPath, "utf8"));
const nextConfig = buildOpenClawDevPluginConfig(config, {
  pluginId,
  pluginPath: ROOT,
  version: String(pkg.version),
  installedAt: new Date().toISOString(),
});

console.log(`"securityclaw-dev-load-path" ${JSON.stringify(pluginId)} ${JSON.stringify(ROOT)} ${JSON.stringify(configPath)}`);

if (!parsed.dryRun) {
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

  const persisted = JSON.parse(readFileSync(configPath, "utf8"));
  const installRecord = persisted.plugins?.installs?.[pluginId];
  const loadPaths = persisted.plugins?.load?.paths ?? [];
  if (installRecord?.source !== "path" || installRecord.sourcePath !== ROOT || !loadPaths.includes(ROOT)) {
    throw new Error(`Failed to persist dev load path for ${pluginId} in ${configPath}`);
  }
}

if (parsed.restart !== false) {
  runCommand(openclawBin, ["gateway", "restart"], parsed.dryRun);
}

if (parsed.verify !== false) {
  runCommand(openclawBin, ["gateway", "status"], parsed.dryRun);
}
