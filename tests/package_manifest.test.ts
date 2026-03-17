import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};
const packageLock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as {
  name: string;
  version: string;
  packages?: Record<string, { name?: string; version?: string; dependencies?: Record<string, string> }>;
};

const BUILD_ONLY_DEPENDENCIES = ["esbuild", "react", "react-dom", "recharts"];

test("package manifest keeps admin build dependencies out of runtime dependencies", () => {
  const runtimeDependencies = pkg.dependencies ?? {};
  for (const dependencyName of BUILD_ONLY_DEPENDENCIES) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(runtimeDependencies, dependencyName),
      false,
      `expected ${dependencyName} to stay out of package.json runtime dependencies`,
    );
  }
});

test("package-lock root metadata matches the publish manifest", () => {
  const lockRoot = packageLock.packages?.[""] ?? {};

  assert.equal(packageLock.name, pkg.name);
  assert.equal(packageLock.version, pkg.version);
  assert.equal(lockRoot.name, pkg.name);
  assert.equal(lockRoot.version, pkg.version);

  const lockRuntimeDependencies = lockRoot.dependencies ?? {};
  for (const dependencyName of BUILD_ONLY_DEPENDENCIES) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(lockRuntimeDependencies, dependencyName),
      false,
      `expected ${dependencyName} to stay out of package-lock runtime dependencies`,
    );
  }
});
