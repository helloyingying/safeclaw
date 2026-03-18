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

test("resolveInstallTarget prefers explicit local path over npm metadata", () => {
  assert.equal(
    resolveInstallTarget({
      packageName: "securityclaw",
      packageVersion: "0.1.0",
      localPath: "/tmp/securityclaw",
    }),
    "/tmp/securityclaw",
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

test("buildInstallPlan supports linked local path installs", () => {
  assert.deepEqual(
    buildInstallPlan({
      localPath: "/tmp/securityclaw",
      link: true,
      verify: false,
    }),
    [
      ["openclaw", "plugins", "install", "--link", "/tmp/securityclaw"],
      ["openclaw", "gateway", "restart"],
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

test("parseInstallArgs accepts linked local path installs", () => {
  assert.deepEqual(
    parseInstallArgs(["--path", "/tmp/securityclaw", "--link", "--no-restart"]),
    {
      dryRun: false,
      link: true,
      localPath: "/tmp/securityclaw",
      restart: false,
      verify: true,
    },
  );
});

test("parseInstallArgs rejects conflicting explicit targets", () => {
  assert.throws(
    () => parseInstallArgs(["--path", "/tmp/securityclaw", "--archive", "/tmp/securityclaw.tgz"]),
    /Choose only one of --archive, --path, or --npm-spec/,
  );
});

test("parseInstallArgs rejects --link without --path", () => {
  assert.throws(() => parseInstallArgs(["--link"]), /--link requires --path/);
});
