import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";

import {
  announceAdminConsole,
  buildAdminConsoleBanner,
  resolveAdminConsoleMarkerPath,
  shouldAnnounceAdminConsoleForArgv,
} from "../src/admin/console_notice.ts";

test("admin console banner includes url and first-run auto-open hint", () => {
  const lines = buildAdminConsoleBanner({
    locale: "en",
    url: "http://127.0.0.1:4780",
    state: "started",
    openedAutomatically: true,
  });

  assert.equal(lines.length, 5);
  assert.match(lines[1] ?? "", /SafeClaw admin dashboard is ready/);
  assert.equal(lines[2], "URL: http://127.0.0.1:4780");
  assert.match(lines[3] ?? "", /Opened automatically/);
});

test("gateway service commands get an admin entry banner", () => {
  const lines = buildAdminConsoleBanner({
    locale: "en",
    url: "http://127.0.0.1:4780",
    state: "service-command",
    openedAutomatically: false,
  });

  assert.equal(lines.length, 5);
  assert.match(lines[1] ?? "", /SafeClaw admin dashboard entry/);
  assert.equal(lines[2], "URL: http://127.0.0.1:4780");
  assert.match(lines[3] ?? "", /background OpenClaw gateway service hosts this dashboard/i);
});

test("only gateway start-style commands announce admin entry in cli", () => {
  assert.equal(
    shouldAnnounceAdminConsoleForArgv(["node", "openclaw", "gateway", "restart"]),
    true,
  );
  assert.equal(
    shouldAnnounceAdminConsoleForArgv(["node", "openclaw", "gateway", "--port", "18789", "status"]),
    true,
  );
  assert.equal(
    shouldAnnounceAdminConsoleForArgv(["node", "openclaw", "gateway", "--help"]),
    false,
  );
  assert.equal(
    shouldAnnounceAdminConsoleForArgv(["node", "openclaw", "skills", "list"]),
    false,
  );
});

test("admin console announcement opens browser only once per state dir", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-admin-console-"));
  const infoLogs: string[] = [];
  const warnLogs: string[] = [];
  let openAttempts = 0;

  try {
    const first = announceAdminConsole({
      locale: "en",
      logger: {
        info(message: string) {
          infoLogs.push(message);
        },
        warn(message: string) {
          warnLogs.push(message);
        },
      },
      stateDir: tempDir,
      state: "started",
      url: "http://127.0.0.1:4780",
      opener() {
        openAttempts += 1;
        return { ok: true, command: "test-open" };
      },
    });

    assert.equal(first.firstRun, true);
    assert.equal(first.openedAutomatically, true);
    assert.equal(openAttempts, 1);
    assert.equal(warnLogs.length, 0);
    assert.ok(existsSync(resolveAdminConsoleMarkerPath(tempDir)));
    assert.ok(infoLogs.some((line) => line.includes("http://127.0.0.1:4780")));

    const second = announceAdminConsole({
      locale: "en",
      logger: {
        info() {},
        warn() {},
      },
      stateDir: tempDir,
      state: "already-running",
      url: "http://127.0.0.1:4780",
      opener() {
        openAttempts += 1;
        return { ok: true, command: "test-open" };
      },
    });

    assert.equal(second.firstRun, false);
    assert.equal(second.openedAutomatically, false);
    assert.equal(openAttempts, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin console announcement retries auto-open until it succeeds", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "safeclaw-admin-console-retry-"));
  let openAttempts = 0;

  try {
    const first = announceAdminConsole({
      locale: "en",
      logger: {
        info() {},
        warn() {},
      },
      stateDir: tempDir,
      state: "started",
      url: "http://127.0.0.1:4780",
      opener() {
        openAttempts += 1;
        return { ok: false, command: "test-open", error: "simulated failure" };
      },
    });

    assert.equal(first.firstRun, true);
    assert.equal(first.openedAutomatically, false);
    assert.equal(openAttempts, 1);
    assert.equal(existsSync(resolveAdminConsoleMarkerPath(tempDir)), false);

    const second = announceAdminConsole({
      locale: "en",
      logger: {
        info() {},
        warn() {},
      },
      stateDir: tempDir,
      state: "started",
      url: "http://127.0.0.1:4780",
      opener() {
        openAttempts += 1;
        return { ok: true, command: "test-open" };
      },
    });

    assert.equal(second.firstRun, true);
    assert.equal(second.openedAutomatically, true);
    assert.equal(openAttempts, 2);
    assert.ok(existsSync(resolveAdminConsoleMarkerPath(tempDir)));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
