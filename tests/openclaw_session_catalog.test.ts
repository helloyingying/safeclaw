import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { listOpenClawChatSessions } from "../src/admin/openclaw_session_catalog.ts";

test("session catalog reads openclaw sessions and resolves stable subjects", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-session-catalog-"));
  const sessionsDir = path.join(tempDir, "agents", "main", "sessions");

  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "session-main",
            updatedAt: Date.parse("2026-03-15T12:00:00.000Z"),
            chatType: "direct",
            deliveryContext: {
              channel: "webchat"
            },
            origin: {
              provider: "webchat"
            }
          },
          "telegram:direct:chat-42": {
            sessionId: "session-1",
            updatedAt: Date.parse("2026-03-15T10:00:00.000Z"),
            chatType: "direct",
            deliveryContext: {
              channel: "telegram"
            },
            origin: {
              provider: "telegram"
            }
          },
          "agent:main:telegram:direct:chat-99": {
            sessionId: "session-2",
            updatedAt: Date.parse("2026-03-15T11:00:00.000Z"),
            chatType: "direct",
            deliveryContext: {
              channel: "telegram"
            }
          },
          "agent:main:slack:direct:u0amkf3qb0x": {
            sessionId: "session-slack",
            updatedAt: Date.parse("2026-03-15T13:00:00.000Z"),
            chatType: "direct",
            deliveryContext: {
              channel: "slack",
              to: "user:U0AMKF3QB0X"
            },
            origin: {
              provider: "slack",
              from: "slack:U0AMKF3QB0X",
              to: "user:U0AMKF3QB0X",
            }
          }
        },
        null,
        2,
      ),
      "utf8",
    );

    const sessions = listOpenClawChatSessions(tempDir);
    assert.equal(sessions.length, 4);
    assert.equal(sessions[0]?.subject, "slack:U0AMKF3QB0X");
    assert.equal(sessions[0]?.channel, "slack");
    assert.equal(sessions[1]?.subject, "agent:main:main");
    assert.equal(sessions[1]?.label, "main");
    assert.equal(sessions[1]?.channel, "webchat");
    assert.equal(sessions[2]?.subject, "telegram:chat-99");
    assert.equal(sessions[2]?.agent_id, "main");
    assert.equal(sessions[2]?.channel, "telegram");
    assert.equal(sessions[3]?.subject, "telegram:chat-42");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
