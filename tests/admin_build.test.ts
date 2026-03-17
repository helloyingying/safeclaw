import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";

import { ensureAdminAssetsBuilt, shouldBuildAdminAssets } from "../src/admin/build.ts";

test("admin build helper rebuilds stale bundle and skips fresh output", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-admin-build-"));
  const sourceDir = path.join(tempDir, "admin/src");
  const publicDir = path.join(tempDir, "admin/public");
  const entryPoint = path.join(sourceDir, "app.jsx");
  const outfile = path.join(publicDir, "app.js");

  try {
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(entryPoint, 'console.log("securityclaw admin");\n', "utf8");

    assert.equal(shouldBuildAdminAssets({ paths: { sourceDir, entryPoint, outfile } }), true);

    const built = await ensureAdminAssetsBuilt({
      paths: { sourceDir, entryPoint, outfile }
    });
    assert.equal(built.state, "built");
    assert.equal(existsSync(outfile), true);

    const oldTime = new Date("2026-03-14T00:00:00.000Z");
    const newTime = new Date("2026-03-14T00:00:10.000Z");
    utimesSync(entryPoint, oldTime, oldTime);
    utimesSync(outfile, newTime, newTime);

    assert.equal(shouldBuildAdminAssets({ paths: { sourceDir, entryPoint, outfile } }), false);

    const skipped = await ensureAdminAssetsBuilt({
      paths: { sourceDir, entryPoint, outfile }
    });
    assert.equal(skipped.state, "skipped");

    utimesSync(entryPoint, newTime, newTime);
    utimesSync(outfile, oldTime, oldTime);
    assert.equal(shouldBuildAdminAssets({ paths: { sourceDir, entryPoint, outfile } }), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin build helper skips rebuild when packaged bundle exists without source tree", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-admin-build-packaged-"));
  const sourceDir = path.join(tempDir, "admin/src");
  const publicDir = path.join(tempDir, "admin/public");
  const entryPoint = path.join(sourceDir, "app.jsx");
  const outfile = path.join(publicDir, "app.js");

  try {
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(outfile, 'console.log("prebuilt");\n', "utf8");

    assert.equal(shouldBuildAdminAssets({ paths: { sourceDir, entryPoint, outfile } }), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
