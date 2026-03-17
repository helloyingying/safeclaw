import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(ROOT, "dist");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const archiveName = `${String(pkg.name).replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}.tgz`;
const archivePath = path.join(DIST_DIR, archiveName);
const forwardArgs = process.argv.slice(2);
const dryRun = forwardArgs.includes("--dry-run");

mkdirSync(DIST_DIR, { recursive: true });

if (dryRun) {
  console.log(`"npm" "run" "pack:plugin"`);
} else {
  const packResult = spawnSync("npm", ["run", "pack:plugin"], {
    cwd: ROOT,
    stdio: "inherit",
  });

  if (packResult.status !== 0) {
    process.exit(packResult.status ?? 1);
  }
}

const result = spawnSync(
  process.execPath,
  [path.join(ROOT, "bin/securityclaw.mjs"), "install", "--archive", archivePath, ...forwardArgs],
  {
    cwd: ROOT,
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
