import test from "node:test";
import assert from "node:assert/strict";

import {
  canAssignAdminForAccount,
  supportsInteractiveApprovalForAccount,
} from "../src/domain/services/approval_channel.ts";

test("supportsInteractiveApprovalForAccount recognizes button-capable channels", () => {
  assert.equal(supportsInteractiveApprovalForAccount({ channel: "telegram" }), true);
  assert.equal(supportsInteractiveApprovalForAccount({ channel: "slack" }), true);
  assert.equal(supportsInteractiveApprovalForAccount({ channel: "discord" }), true);
  assert.equal(supportsInteractiveApprovalForAccount({ channel: "feishu" }), false);
});

test("canAssignAdminForAccount requires both a supported channel and a direct chat", () => {
  assert.equal(
    canAssignAdminForAccount({
      channel: "telegram",
      chat_type: "direct",
      subject: "telegram:chat-42",
      session_key: "telegram:direct:chat-42",
    }),
    true,
  );

  assert.equal(
    canAssignAdminForAccount({
      channel: "telegram",
      chat_type: "group",
      subject: "agent:main:telegram:group:ops-room",
      session_key: "agent:main:telegram:group:ops-room",
    }),
    false,
  );

  assert.equal(
    canAssignAdminForAccount({
      channel: "feishu",
      chat_type: "direct",
      subject: "feishu:ou_123",
      session_key: "agent:main:feishu:direct:ou_123",
    }),
    false,
  );
});
