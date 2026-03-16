import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeAccountPolicies } from "../src/domain/services/account_policy_engine.ts";

test("canonicalize account policies produces stable order and field layout", () => {
  const first = canonicalizeAccountPolicies([
    {
      label: "Chat 42",
      subject: "telegram:chat-42",
      is_admin: false,
      mode: "default_allow",
      updated_at: "2026-03-15T00:00:00.000Z",
      channel: "telegram"
    }
  ]);

  const second = canonicalizeAccountPolicies([
    {
      subject: "telegram:chat-42",
      mode: "default_allow",
      is_admin: false,
      channel: "telegram",
      label: "Chat 42",
      updated_at: "2026-03-15T00:00:00.000Z"
    }
  ]);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("canonicalize account policies keeps only one admin account", () => {
  const policies = canonicalizeAccountPolicies([
    {
      subject: "telegram:admin-a",
      mode: "apply_rules",
      is_admin: true,
    },
    {
      subject: "telegram:admin-b",
      mode: "apply_rules",
      is_admin: true,
    },
  ]);

  assert.equal(policies.filter((policy) => policy.is_admin).length, 1);
  assert.equal(policies.find((policy) => policy.is_admin)?.subject, "telegram:admin-b");
});
