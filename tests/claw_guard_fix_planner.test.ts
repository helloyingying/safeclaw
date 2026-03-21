import test from "node:test";
import assert from "node:assert/strict";

import { buildClawGuardFixPlan, toClawGuardPreviewPayload } from "../src/admin/claw_guard_fix_planner.ts";
import type { ClawGuardConfigSnapshot } from "../src/admin/claw_guard_types.ts";

function createSnapshot(
  config: Record<string, unknown>,
  extra: Partial<ClawGuardConfigSnapshot> = {},
): ClawGuardConfigSnapshot {
  return {
    config,
    source: "gateway-rpc",
    gatewayOnline: true,
    writeSupported: true,
    baseHash: "hash",
    ...extra,
  };
}

function createReadOnlySnapshot(config: Record<string, unknown>, writeReason = "Gateway RPC is unavailable"): ClawGuardConfigSnapshot {
  return {
    config,
    source: "local-file",
    gatewayOnline: false,
    writeSupported: false,
    writeReason,
  };
}

test("gateway token fix preview masks generated token", () => {
  const plan = buildClawGuardFixPlan({
    snapshot: createSnapshot({
      gateway: {
        auth: {
          mode: "password",
        },
      },
    }),
    findingId: "gateway_missing_token_auth",
    locale: "en",
    environment: {
      sandboxImageReady: true,
      browserSandboxImageReady: true,
    },
  });

  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.previewPatch, {
    gateway: {
      auth: {
        mode: "token",
        token: "********",
      },
    },
  });
  assert.equal(typeof plan.patch?.gateway, "object");
});

test("group allowlist wizard falls back to disabling groups when no allowlist exists", () => {
  const snapshot = createSnapshot({
    channels: {
      telegram: {
        enabled: true,
        groupPolicy: "open",
      },
    },
  });

  const disablePlan = buildClawGuardFixPlan({
    snapshot,
    findingId: "group_missing_allowlist::telegram",
    locale: "en",
    options: {
      choice: "disable_groups",
    },
    environment: {
      sandboxImageReady: true,
      browserSandboxImageReady: true,
    },
  });
  assert.equal(disablePlan.canApply, true);
  assert.deepEqual(disablePlan.patch, {
    channels: {
      telegram: {
        groupPolicy: "disabled",
      },
    },
  });

  const allowlistPlan = buildClawGuardFixPlan({
    snapshot,
    findingId: "group_missing_allowlist::telegram",
    locale: "en",
    options: {
      choice: "use_allowlist",
    },
    environment: {
      sandboxImageReady: true,
      browserSandboxImageReady: true,
    },
  });
  assert.equal(allowlistPlan.canApply, false);
  assert.match(String(allowlistPlan.applyDisabledReason), /allowlist/i);
});

test("discord guild requireMention fix patches guild and channel paths", () => {
  const plan = buildClawGuardFixPlan({
    snapshot: createSnapshot({
      channels: {
        discord: {
          enabled: true,
          groupPolicy: "allowlist",
          guilds: {
            "1484822413131911189": {
              channels: {
                "1484822413735624748": {
                  allow: true,
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    }),
    findingId: "group_missing_require_mention::discord",
    locale: "en",
    environment: {
      sandboxImageReady: true,
      browserSandboxImageReady: true,
    },
  });

  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.configPaths, [
    "channels.discord.guilds.1484822413131911189.channels.1484822413735624748.requireMention",
  ]);
  assert.deepEqual(plan.patch, {
    channels: {
      discord: {
        guilds: {
          "1484822413131911189": {
            channels: {
              "1484822413735624748": {
                allow: true,
                requireMention: true,
              },
            },
            requireMention: true,
          },
        },
      },
    },
  });
});

test("discord guild allowlist wizard points at guild config paths", () => {
  const plan = buildClawGuardFixPlan({
    snapshot: createSnapshot({
      channels: {
        discord: {
          enabled: true,
          groupPolicy: "allowlist",
        },
      },
    }),
    findingId: "group_missing_allowlist::discord",
    locale: "en",
    options: {
      choice: "disable_groups",
    },
    environment: {
      sandboxImageReady: true,
      browserSandboxImageReady: true,
    },
  });

  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.configPaths, [
    "channels.discord.groupPolicy",
    "channels.discord.guilds",
  ]);
  assert.deepEqual(plan.patch, {
    channels: {
      discord: {
        groupPolicy: "disabled",
      },
    },
  });
});

test("sandbox fix stays blocked when sandbox image is not ready", () => {
  const plan = buildClawGuardFixPlan({
    snapshot: createSnapshot({
      tools: {
        profile: "coding",
      },
      agents: {
        defaults: {
          sandbox: {
            mode: "off",
          },
        },
      },
    }),
    findingId: "sandbox_disabled_for_high_risk_profile",
    locale: "en",
    environment: {
      sandboxImageReady: false,
      browserSandboxImageReady: false,
    },
  });

  assert.equal(plan.canApply, false);
  assert.match(String(plan.applyDisabledReason), /sandbox image/i);
});

test("read-only preview keeps manual repair details", () => {
  const plan = buildClawGuardFixPlan({
    snapshot: createReadOnlySnapshot({
      gateway: {
        bind: "0.0.0.0",
      },
    }),
    findingId: "gateway_public_bind",
    locale: "en",
  });

  assert.equal(plan.title, "Limit gateway bind to loopback");
  assert.equal(plan.currentValue, "0.0.0.0");
  assert.equal(plan.recommendedValue, "loopback");
  assert.deepEqual(plan.previewPatch, {
    gateway: {
      bind: "loopback",
    },
  });
  assert.equal(plan.canApply, false);
  assert.match(String(plan.applyDisabledReason), /Gateway RPC is unavailable/i);
});

test("dm allowlist fallback switches back to pairing", () => {
  const plan = buildClawGuardFixPlan({
    snapshot: createSnapshot({
      channels: {
        telegram: {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: [],
        },
      },
    }),
    findingId: "dm_allowlist_missing::telegram",
    locale: "en",
    environment: {
      sandboxImageReady: true,
      browserSandboxImageReady: true,
    },
  });

  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.patch, {
    channels: {
      telegram: {
        dmPolicy: "pairing",
      },
    },
  });
});

test("sandbox isolation fix tightens workspace access and scope", () => {
  const plan = buildClawGuardFixPlan({
    snapshot: createSnapshot({
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",
            workspaceAccess: "rw",
            scope: "agent",
          },
        },
      },
    }),
    findingId: "sandbox_isolation_defaults_missing",
    locale: "en",
    environment: {
      sandboxImageReady: true,
      browserSandboxImageReady: true,
    },
  });

  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.patch, {
    agents: {
      defaults: {
        sandbox: {
          workspaceAccess: "none",
          scope: "session",
        },
      },
    },
  });
});

test("workspace bootstrap guidance stays manual in writable mode", () => {
  const plan = buildClawGuardFixPlan({
    snapshot: createSnapshot(
      {},
      {
        workspace: {
          dir: "/tmp/openclaw-workspace",
          soul: {
            path: "/tmp/openclaw-workspace/SOUL.md",
            exists: false,
          },
        },
      },
    ),
    findingId: "workspace_bootstrap_guardrails_missing",
    locale: "en",
    environment: {
      sandboxImageReady: true,
      browserSandboxImageReady: true,
    },
  });

  assert.equal(plan.canApply, false);
  assert.equal(plan.patch, null);
  assert.match(plan.currentValue, /SOUL\.md/);
  assert.doesNotMatch(plan.currentValue, /HEARTBEAT\.md/);
  assert.match(plan.currentValue, /baseline guardrails incomplete/i);
  assert.match(plan.recommendedValue, /suggested SOUL\.md template/i);
  assert.equal(plan.referenceTemplates?.[0]?.label, "SOUL.md");
  assert.match(String(plan.referenceTemplates?.[0]?.content), /# SOUL\.md - Who You Are/);
  assert.deepEqual(plan.configPaths, ["/tmp/openclaw-workspace/SOUL.md"]);
  const preview = toClawGuardPreviewPayload(plan);
  assert.equal(preview.reference_templates?.[0]?.label, "SOUL.md");
  assert.match(String(plan.applyDisabledReason), /manual review/i);
});
