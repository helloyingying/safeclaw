import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { ChatApprovalStore, createApprovalRequestKey } from "../src/approvals/chat_approval_store.ts";

test("chat approval store persists approvals and expires approved grants", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "securityclaw-chat-approval-store-"));
  const dbPath = path.join(tempDir, "securityclaw.db");
  let now = Date.parse("2026-03-15T08:00:00.000Z");
  let store: ChatApprovalStore | undefined;

  try {
    store = new ChatApprovalStore(dbPath, { now: () => now });
    const requestKey = createApprovalRequestKey({
      policy_version: "2026-03-15",
      scope: "default",
      tool_name: "filesystem.list",
      resource_scope: "workspace_inside",
      resource_paths: ["/tmp/workspace"],
      params: { path: "." },
    });

    const created = store.create({
      request_key: requestKey,
      session_scope: "session:test",
      expires_at: "2026-03-15T08:10:00.000Z",
      policy_version: "2026-03-15",
      actor_id: "main",
      scope: "default",
      tool_name: "filesystem.list",
      resource_scope: "workspace_inside",
      resource_paths: ["/tmp/workspace"],
      reason_codes: ["FILE_ENUMERATION_REQUIRES_APPROVAL"],
      rule_ids: ["filesystem-list-challenge"],
      args_summary: "{\"path\":\".\"}",
    });

    assert.equal(store.findPending("session:test", requestKey)?.approval_id, created.approval_id);

    store.resolve(created.approval_id, "telegram:admin", "approved", {
      expires_at: "2026-03-15T08:30:00.000Z",
    });
    assert.equal(store.findApproved("session:test", requestKey)?.approver, "telegram:admin");

    store.close();
    store = new ChatApprovalStore(dbPath, { now: () => now });
    assert.equal(store.findApproved("session:test", requestKey)?.approval_id, created.approval_id);

    now = Date.parse("2026-03-15T08:11:00.000Z");
    assert.equal(store.findApproved("session:test", requestKey)?.approval_id, created.approval_id);

    now = Date.parse("2026-03-15T08:31:00.000Z");
    assert.equal(store.findApproved("session:test", requestKey), undefined);
    assert.equal(store.getById(created.approval_id)?.status, "expired");
  } finally {
    store?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
