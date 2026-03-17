import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const installScript = readFileSync(path.join(ROOT, "install.sh"), "utf8");

const failures = [];
const packageName = typeof pkg.name === "string" ? pkg.name.trim() : "";

if (!packageName) {
  failures.push("package.json is missing a package name.");
}

if (packageName.startsWith("@")) {
  failures.push("package.json name must be unscoped.");
}

const installPackageMatch = installScript.match(/SECURITYCLAW_NPM_PACKAGE:-([^}]+)}/);
const installPackage = installPackageMatch?.[1]?.trim() ?? "";
if (installPackage !== packageName) {
  failures.push(`install.sh default package '${installPackage}' does not match package.json name '${packageName}'.`);
}

const requiredRepository = "git+https://github.com/znary/securityclaw.git";
if (pkg.repository?.url !== requiredRepository) {
  failures.push(`package.json repository.url must be '${requiredRepository}' for trusted publishing provenance.`);
}

if (failures.length > 0) {
  failures.forEach((failure) => console.error(`release:check: ${failure}`));
  process.exit(1);
}

console.log(`release:check: package ${packageName}@${pkg.version} is configured for publish.`);
console.log("release:check: next steps:");
console.log("  1. npm run release:dry-run");
console.log("  2. Configure npm trusted publishing for .github/workflows/publish-npm.yml");
console.log("  3. Push a v<version> tag to trigger publish");
