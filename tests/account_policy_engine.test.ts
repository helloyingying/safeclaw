import test from "node:test";
import assert from "node:assert/strict";

import {
  AccountPolicyEngine,
  canonicalizeAccountPolicies,
  sanitizeAccountPoliciesWithOptions,
} from "../src/domain/services/account_policy_engine.ts";

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

test("sanitize account policies defaults admin approval locale from the admin console locale", () => {
  const policies = sanitizeAccountPoliciesWithOptions(
    [
      {
        subject: "telegram:admin-a",
        mode: "apply_rules",
        is_admin: true,
      },
      {
        subject: "telegram:chat-42",
        mode: "default_allow",
        is_admin: false,
      },
    ],
    { defaultAdminApprovalLocale: "zh-CN" },
  );

  assert.equal(policies.find((policy) => policy.is_admin)?.approval_locale, "zh-CN");
  assert.equal(policies.find((policy) => !policy.is_admin)?.approval_locale, undefined);
});

test("account default allow stays inactive until an admin is configured", () => {
  const inactive = new AccountPolicyEngine([
    {
      subject: "telegram:chat-42",
      mode: "default_allow",
      is_admin: false,
    },
  ]);
  assert.equal(inactive.evaluate("telegram:chat-42"), undefined);

  const active = new AccountPolicyEngine([
    {
      subject: "telegram:chat-42",
      mode: "default_allow",
      is_admin: true,
    },
  ]);
  assert.equal(active.evaluate("telegram:chat-42")?.decision_source, "account");
});

test("group sessions are not treated as valid admin accounts", () => {
  const policies = canonicalizeAccountPolicies([
    {
      subject: "agent:main:feishu:group:oc_4626b6abb8e311841083a1d164274578",
      mode: "apply_rules",
      is_admin: true,
      chat_type: "group",
    },
    {
      subject: "telegram:chat-42",
      mode: "default_allow",
      is_admin: false,
    },
  ]);

  assert.equal(policies.length, 1);
  assert.equal(policies[0]?.subject, "telegram:chat-42");
  assert.equal(new AccountPolicyEngine(policies).evaluate("telegram:chat-42"), undefined);
});

test("unsupported direct channels are not treated as valid admin accounts", () => {
  const policies = canonicalizeAccountPolicies([
    {
      subject: "feishu:ops",
      mode: "apply_rules",
      is_admin: true,
      channel: "feishu",
      chat_type: "direct",
    },
    {
      subject: "telegram:chat-42",
      mode: "default_allow",
      is_admin: false,
    },
  ]);

  assert.equal(policies.length, 2);
  assert.equal(policies.find((policy) => policy.subject === "feishu:ops")?.is_admin, false);
  assert.equal(new AccountPolicyEngine(policies).evaluate("telegram:chat-42"), undefined);
});
