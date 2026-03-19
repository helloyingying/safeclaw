import test from "node:test";
import assert from "node:assert/strict";

import {
  ensureDefaultAdminAccount,
  pruneAccountPolicyOverrides,
  mergeAccountPoliciesWithSessions,
} from "../src/admin/account_catalog.ts";

test("mergeAccountPoliciesWithSessions shows scanned sessions and overlays saved policy fields", () => {
  const sessions = [
    {
      subject: "telegram:chat-42",
      label: "telegram:chat-42",
      session_key: "telegram:direct:chat-42",
      session_id: "session-42",
      agent_id: "main",
      channel: "telegram",
      chat_type: "direct",
      updated_at: "2026-03-18T07:00:00.000Z",
    },
    {
      subject: "agent:main:main",
      label: "main",
      session_key: "agent:main:main",
      session_id: "session-main",
      agent_id: "main",
      channel: "webchat",
      chat_type: "direct",
      updated_at: "2026-03-18T08:00:00.000Z",
    },
  ];

  const merged = mergeAccountPoliciesWithSessions(
    [
      {
        subject: "telegram:chat-42",
        mode: "default_allow",
        is_admin: true,
        label: "Ops Telegram",
      },
    ],
    sessions,
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.subject, "telegram:chat-42");
  assert.equal(merged[0]?.label, "Ops Telegram");
  assert.equal(merged[0]?.mode, "default_allow");
  assert.equal(merged[0]?.is_admin, true);
  assert.equal(merged[0]?.session_id, "session-42");
  assert.equal(merged[1]?.subject, "agent:main:main");
  assert.equal(merged[1]?.label, "main");
});

test("ensureDefaultAdminAccount no longer invents a default admin", () => {
  const sessions = [
    {
      subject: "agent:main:main",
      label: "main",
      session_key: "agent:main:main",
      session_id: "session-main",
      agent_id: "main",
      channel: "webchat",
      chat_type: "direct",
      updated_at: "2026-03-18T08:00:00.000Z",
    },
  ];

  const next = ensureDefaultAdminAccount([], sessions, "2026-03-18T09:00:00.000Z");
  assert.deepEqual(next, []);
});

test("pruneAccountPolicyOverrides drops default apply_rules records", () => {
  const next = pruneAccountPolicyOverrides([
    {
      subject: "agent:main:main",
      mode: "apply_rules",
      is_admin: false,
    },
    {
      subject: "telegram:chat-42",
      mode: "default_allow",
      is_admin: false,
    },
    {
      subject: "telegram:ops",
      mode: "apply_rules",
      is_admin: true,
    },
  ]);

  assert.deepEqual(next, [
    {
      subject: "telegram:chat-42",
      mode: "default_allow",
      is_admin: false,
    },
    {
      subject: "telegram:ops",
      mode: "apply_rules",
      is_admin: true,
    },
  ]);
});
