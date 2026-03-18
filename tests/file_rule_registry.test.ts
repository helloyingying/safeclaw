import assert from "node:assert/strict";
import test from "node:test";

import { defaultFileRuleReasonCode, matchFileRule, normalizeFileRules } from "../src/domain/services/file_rule_registry.ts";

test("normalizeFileRules keeps one rule per directory and rejects invalid entries", () => {
  const rules = normalizeFileRules([
    { id: "a", directory: "/tmp/Downloads", decision: "challenge" },
    { id: "b", directory: "/tmp/Downloads/", decision: "allow" },
    { id: "c", directory: "relative/path", decision: "block" },
    { id: "d", directory: "/tmp/Documents", decision: "not-a-decision" },
  ]);

  assert.deepEqual(rules.map((rule) => rule.id), ["b"]);
  assert.equal(rules[0]?.decision, "allow");
});

test("matchFileRule prefers the most specific directory", () => {
  const match = matchFileRule(
    ["/Users/liuzhuangm4/Documents/private/notes.txt"],
    normalizeFileRules([
      { id: "base", directory: "/Users/liuzhuangm4/Documents", decision: "challenge" },
      { id: "nested", directory: "/Users/liuzhuangm4/Documents/private", decision: "allow" },
    ]),
  );

  assert.equal(match?.id, "nested");
  assert.equal(match?.decision, "allow");
});

test("matchFileRule prefers operation-scoped overrides over generic directory overrides", () => {
  const rules = normalizeFileRules([
    { id: "generic", directory: "/Users/liuzhuangm4/Documents/private", decision: "challenge" },
    { id: "read-only", directory: "/Users/liuzhuangm4/Documents/private", decision: "allow", operations: ["read"] },
  ]);

  const readMatch = matchFileRule(
    ["/Users/liuzhuangm4/Documents/private/notes.txt"],
    rules,
    "read",
  );
  const writeMatch = matchFileRule(
    ["/Users/liuzhuangm4/Documents/private/notes.txt"],
    rules,
    "write",
  );

  assert.equal(readMatch?.id, "read-only");
  assert.deepEqual(readMatch?.operations, ["read"]);
  assert.equal(writeMatch?.id, "generic");
});

test("defaultFileRuleReasonCode maps decisions", () => {
  assert.equal(defaultFileRuleReasonCode("allow"), "USER_FILE_RULE_ALLOW");
  assert.equal(defaultFileRuleReasonCode("warn"), "USER_FILE_RULE_WARN");
  assert.equal(defaultFileRuleReasonCode("challenge"), "USER_FILE_RULE_CHALLENGE");
  assert.equal(defaultFileRuleReasonCode("block"), "USER_FILE_RULE_BLOCK");
});
