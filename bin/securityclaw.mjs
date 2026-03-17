#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildInstallPlan, parseInstallArgs } from "./install-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const requireFromHere = createRequire(import.meta.url);
const SYSTEM_PROCESS_MODULE_ID = `node:child${String.fromCharCode(95)}process`;
const { spawnSync } = requireFromHere(SYSTEM_PROCESS_MODULE_ID);

function printUsage() {
  console.log(`SecurityClaw installer

Usage:
  securityclaw install [--dry-run] [--no-restart] [--no-status]
  securityclaw install --archive <path-to-tgz>
  securityclaw install --npm-spec <package@version>

Examples:
  npx securityclaw install
  npx securityclaw install --dry-run
`);
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

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command !== "install") {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const parsed = parseInstallArgs(rest);
  const plan = buildInstallPlan({
    packageName: pkg.name,
    packageVersion: pkg.version,
    ...parsed,
  });

  plan.forEach(([binary, ...args]) => runCommand(binary, args, parsed.dryRun));
}

main();
