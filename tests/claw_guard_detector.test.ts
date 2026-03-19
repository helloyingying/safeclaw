import test from "node:test";
import assert from "node:assert/strict";

import { buildClawGuardFindings } from "../src/admin/claw_guard_detector.ts";
import type { ClawGuardConfigSnapshot } from "../src/admin/claw_guard_types.ts";

function createSnapshot(config: Record<string, unknown>): ClawGuardConfigSnapshot {
  return {
    config,
    source: "gateway-rpc",
    gatewayOnline: true,
    writeSupported: true,
    baseHash: "hash",
  };
}

test("claw guard detector reports risky gateway, channel, and sandbox settings", () => {
  const result = buildClawGuardFindings(
    createSnapshot({
      gateway: {
        bind: "loopback",
        auth: {
          mode: "token",
          token: "__OPENCLAW_REDACTED__",
        },
      },
      tools: {
        profile: "coding",
      },
      channels: {
        telegram: {
          enabled: true,
          dmPolicy: "open",
          groupPolicy: "open",
          groups: {
            "*": {
              requireMention: false,
            },
          },
        },
      },
    }),
    "en",
  );

  const findingIds = result.findings.map((item) => item.id);
  assert.ok(findingIds.includes("dm_policy_too_open::telegram"));
  assert.ok(findingIds.includes("group_policy_too_open::telegram"));
  assert.ok(findingIds.includes("group_missing_require_mention::telegram"));
  assert.ok(findingIds.includes("group_missing_allowlist::telegram"));
  assert.ok(findingIds.includes("sandbox_disabled_for_high_risk_profile"));

  const passedIds = result.passed.map((item) => item.id);
  assert.ok(passedIds.includes("gateway_public_bind"));
  assert.ok(passedIds.includes("gateway_missing_token_auth"));
});

test("claw guard detector treats allowlisted group configs as passed", () => {
  const result = buildClawGuardFindings(
    createSnapshot({
      gateway: {
        bind: "loopback",
        auth: {
          mode: "token",
          token: "__OPENCLAW_REDACTED__",
        },
      },
      channels: {
        telegram: {
          enabled: true,
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          groupAllowFrom: ["123456789"],
          groups: {
            "*": {
              requireMention: true,
            },
            "-100123": {
              allow: true,
            },
          },
        },
      },
    }),
    "en",
  );

  const findingIds = result.findings.map((item) => item.id);
  assert.equal(findingIds.includes("group_policy_too_open::telegram"), false);
  assert.equal(findingIds.includes("group_missing_require_mention::telegram"), false);
  assert.equal(findingIds.includes("group_missing_allowlist::telegram"), false);

  const passedIds = result.passed.map((item) => item.id);
  assert.ok(passedIds.includes("group_policy_too_open::telegram"));
  assert.ok(passedIds.includes("group_missing_require_mention::telegram"));
  assert.ok(passedIds.includes("group_missing_allowlist::telegram"));
});

test("claw guard detector only reports browser sandbox when browser config exists", () => {
  const withoutBrowser = buildClawGuardFindings(
    createSnapshot({
      gateway: {
        bind: "loopback",
        auth: {
          mode: "token",
          token: "__OPENCLAW_REDACTED__",
        },
      },
    }),
    "en",
  );
  assert.equal(withoutBrowser.findings.some((item) => item.id === "browser_sandbox_missing"), false);

  const withBrowser = buildClawGuardFindings(
    createSnapshot({
      gateway: {
        bind: "loopback",
        auth: {
          mode: "token",
          token: "__OPENCLAW_REDACTED__",
        },
      },
      browser: {
        enabled: true,
      },
    }),
    "en",
  );
  assert.equal(withBrowser.findings.some((item) => item.id === "browser_sandbox_missing"), true);
});

test("claw guard detector moves exempted findings into the exempted section and keeps related groups", () => {
  const result = buildClawGuardFindings(
    createSnapshot({
      gateway: {
        bind: "loopback",
        auth: {
          mode: "token",
          token: "__OPENCLAW_REDACTED__",
        },
      },
      channels: {
        telegram: {
          enabled: true,
          dmPolicy: "pairing",
          groupPolicy: "open",
          groups: {
            "*": {
              requireMention: false,
            },
          },
        },
      },
      plugins: {
        entries: {
          securityclaw: {
            config: {
              hardeningExemptions: [
                {
                  findingId: "group_policy_too_open::telegram",
                  createdAt: "2026-03-19T08:00:00.000Z",
                  updatedAt: "2026-03-19T08:00:00.000Z",
                  reason: "accepted risk",
                },
              ],
            },
          },
        },
      },
    }),
    "en",
  );

  assert.equal(result.findings.some((item) => item.id === "group_policy_too_open::telegram"), false);
  assert.equal(result.exempted.length, 1);
  assert.equal(result.exempted[0]?.id, "group_policy_too_open::telegram");
  assert.equal(result.exempted[0]?.exemption.findingId, "group_policy_too_open::telegram");
  assert.equal(result.exempted[0]?.exemption.reason, "accepted risk");

  const telegramGroup = result.groups.find((group) => group.id === "channel::telegram");
  assert.ok(telegramGroup);
  assert.deepEqual(telegramGroup?.childFindingIds.sort(), [
    "group_missing_allowlist::telegram",
    "group_missing_require_mention::telegram",
  ]);
});
