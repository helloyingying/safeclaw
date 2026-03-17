import test from "node:test";
import assert from "node:assert/strict";

import { buildInstallPlan, parseInstallArgs, resolveInstallTarget } from "../bin/install-lib.mjs";

test("resolveInstallTarget prefers explicit archive path", () => {
  assert.equal(
    resolveInstallTarget({
      packageName: "securityclaw",
      packageVersion: "0.1.0",
      archivePath: "/tmp/securityclaw-0.1.0.tgz",
    }),
    "/tmp/securityclaw-0.1.0.tgz",
  );
});

test("resolveInstallTarget pins package name and version for npm installs", () => {
  assert.equal(
    resolveInstallTarget({
      packageName: "securityclaw",
      packageVersion: "0.1.0",
    }),
    "securityclaw@0.1.0",
  );
});

test("buildInstallPlan includes restart and status by default", () => {
  assert.deepEqual(
    buildInstallPlan({
      packageName: "securityclaw",
      packageVersion: "0.1.0",
    }),
    [
      ["openclaw", "plugins", "install", "securityclaw@0.1.0"],
      ["openclaw", "gateway", "restart"],
      ["openclaw", "gateway", "status"],
    ],
  );
});

test("parseInstallArgs accepts archive and dry-run flags", () => {
  assert.deepEqual(
    parseInstallArgs(["--archive", "/tmp/securityclaw.tgz", "--dry-run", "--no-status"]),
    {
      archivePath: "/tmp/securityclaw.tgz",
      dryRun: true,
      restart: true,
      verify: false,
    },
  );
});
