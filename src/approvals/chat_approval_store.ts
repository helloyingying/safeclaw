import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ApprovalStatus, ResourceScope } from "../types.ts";
import type { UserApprovalContext, UserApprovalContextRepository } from "../domain/services/user_approval_context_service.ts";

export type ApprovalChannel = string;

export type ChatApprovalTarget = {
  channel: ApprovalChannel;
  to: string;
  account_id?: string;
  thread_id?: string | number;
};

export type ChatApprovalApprover = {
  channel: ApprovalChannel;
  from: string;
  account_id?: string;
};

export type ChatApprovalConfig = {
  enabled?: boolean;
  targets?: ChatApprovalTarget[];
  approvers?: ChatApprovalApprover[];
};

export type StoredApprovalNotification = {
  channel: ApprovalChannel;
  to: string;
  account_id?: string;
  thread_id?: string | number;
  message_id?: string;
  sent_at?: string;
};

export type StoredApprovalRecord = {
  approval_id: string;
  request_key: string;
  session_scope: string;
  status: ApprovalStatus;
  requested_at: string;
  expires_at: string;
  policy_version: string;
  actor_id: string;
  scope: string;
  tool_name: string;
  resource_scope: ResourceScope;
  resource_paths: string[];
  reason_codes: string[];
  rule_ids: string[];
  args_summary: string;
  approver?: string;
  decided_at?: string;
  notifications: StoredApprovalNotification[];
};

export type CreateApprovalRecordInput = Omit<
  StoredApprovalRecord,
  "approval_id" | "status" | "requested_at" | "notifications"
> & {
  requested_at?: string;
  notifications?: StoredApprovalNotification[];
};

type ChatApprovalStoreOptions = {
  now?: () => number;
};

type ApprovalRow = {
  approval_id: string;
  request_key: string;
  session_scope: string;
  status: ApprovalStatus;
  requested_at: string;
  expires_at: string;
  policy_version: string;
  actor_id: string;
  scope: string;
  tool_name: string;
  resource_scope: string;
  resource_paths_json: string;
  reason_codes_json: string;
  rule_ids_json: string;
  args_summary: string;
  approver: string | null;
  decided_at: string | null;
  notifications_json: string | null;
};

const CHAT_APPROVAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_approval_requests (
  approval_id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL,
  session_scope TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  resource_scope TEXT NOT NULL,
  resource_paths_json TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  rule_ids_json TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  approver TEXT,
  decided_at TEXT,
  notifications_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_approval_session_request
  ON chat_approval_requests (session_scope, request_key, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_chat_approval_status
  ON chat_approval_requests (status, requested_at DESC);

CREATE TABLE IF NOT EXISTS user_approval_contexts (
  context_key TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT,
  sent_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_approval_context_expires
  ON user_approval_contexts (expires_at);
`;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function rowToRecord(row: ApprovalRow): StoredApprovalRecord {
  const approver = optionalString(row.approver);
  const decidedAt = optionalString(row.decided_at);
  return {
    approval_id: row.approval_id,
    request_key: row.request_key,
    session_scope: row.session_scope,
    status: row.status,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    policy_version: row.policy_version,
    actor_id: row.actor_id,
    scope: row.scope,
    tool_name: row.tool_name,
    resource_scope: row.resource_scope as ResourceScope,
    resource_paths: parseJsonArray<string>(row.resource_paths_json),
    reason_codes: parseJsonArray<string>(row.reason_codes_json),
    rule_ids: parseJsonArray<string>(row.rule_ids_json),
    args_summary: row.args_summary,
    ...(approver ? { approver } : {}),
    ...(decidedAt ? { decided_at: decidedAt } : {}),
    notifications: parseJsonArray<StoredApprovalNotification>(row.notifications_json),
  };
}

function normalizeForHash(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[MAX_DEPTH]";
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((output, key) => {
        const normalized = normalizeForHash(record[key], depth + 1);
        if (normalized !== undefined) {
          output[key] = normalized;
        }
        return output;
      }, {});
  }
  return String(value);
}

export function createApprovalRequestKey(input: {
  policy_version: string;
  scope: string;
  tool_name: string;
  resource_scope: ResourceScope;
  resource_paths: string[];
  params: unknown;
}): string {
  const payload = JSON.stringify(
    normalizeForHash({
      policy_version: input.policy_version,
      scope: input.scope,
      tool_name: input.tool_name,
      resource_scope: input.resource_scope,
      resource_paths: [...input.resource_paths].sort(),
      params: input.params,
    }),
  );

  return createHash("sha256").update(payload).digest("hex");
}

export class ChatApprovalStore implements UserApprovalContextRepository {
  #db: DatabaseSync;
  #now: () => number;

  constructor(dbPath: string, options: ChatApprovalStoreOptions = {}) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#db.exec("PRAGMA synchronous=NORMAL;");
    this.#db.exec(CHAT_APPROVAL_SCHEMA_SQL);
    this.#now = options.now ?? Date.now;
  }

  create(input: CreateApprovalRecordInput): StoredApprovalRecord {
    const requestedAt = input.requested_at ?? new Date(this.#now()).toISOString();
    const record: StoredApprovalRecord = {
      approval_id: randomUUID(),
      request_key: input.request_key,
      session_scope: input.session_scope,
      status: "pending",
      requested_at: requestedAt,
      expires_at: input.expires_at,
      policy_version: input.policy_version,
      actor_id: input.actor_id,
      scope: input.scope,
      tool_name: input.tool_name,
      resource_scope: input.resource_scope,
      resource_paths: [...input.resource_paths],
      reason_codes: [...input.reason_codes],
      rule_ids: [...input.rule_ids],
      args_summary: input.args_summary,
      notifications: [...(input.notifications ?? [])],
    };

    this.#write(record);
    return record;
  }

  getById(approvalId: string): StoredApprovalRecord | undefined {
    const row = this.#db
      .prepare(
        `
        SELECT *
        FROM chat_approval_requests
        WHERE approval_id = ?
      `,
      )
      .get(approvalId) as ApprovalRow | undefined;

    return row ? this.#expireIfNeeded(rowToRecord(row)) : undefined;
  }

  findPending(sessionScope: string, requestKey: string): StoredApprovalRecord | undefined {
    const row = this.#db
      .prepare(
        `
        SELECT *
        FROM chat_approval_requests
        WHERE session_scope = ?
          AND request_key = ?
          AND status = 'pending'
        ORDER BY requested_at DESC
        LIMIT 1
      `,
      )
      .get(sessionScope, requestKey) as ApprovalRow | undefined;

    const record = row ? this.#expireIfNeeded(rowToRecord(row)) : undefined;
    return record?.status === "pending" ? record : undefined;
  }

  findApproved(sessionScope: string, requestKey: string): StoredApprovalRecord | undefined {
    const row = this.#db
      .prepare(
        `
        SELECT *
        FROM chat_approval_requests
        WHERE session_scope = ?
          AND request_key = ?
          AND status = 'approved'
        ORDER BY decided_at DESC, requested_at DESC
        LIMIT 1
      `,
      )
      .get(sessionScope, requestKey) as ApprovalRow | undefined;

    const record = row ? this.#expireIfNeeded(rowToRecord(row)) : undefined;
    return record?.status === "approved" ? record : undefined;
  }

  resolve(
    approvalId: string,
    approver: string,
    decision: "approved" | "rejected",
    options: { expires_at?: string } = {},
  ): StoredApprovalRecord | undefined {
    const existing = this.getById(approvalId);
    if (!existing || existing.status !== "pending") {
      return existing;
    }

    const updated: StoredApprovalRecord = {
      ...existing,
      status: decision,
      ...(options.expires_at ? { expires_at: options.expires_at } : {}),
      approver,
      decided_at: new Date(this.#now()).toISOString(),
    };

    this.#write(updated);
    return updated;
  }

  listPending(limit = 10): StoredApprovalRecord[] {
    const rows = this.#db
      .prepare(
        `
        SELECT *
        FROM chat_approval_requests
        WHERE status = 'pending'
        ORDER BY requested_at DESC
        LIMIT ?
      `,
      )
      .all(limit) as ApprovalRow[];

    return rows
      .map((row) => this.#expireIfNeeded(rowToRecord(row)))
      .filter((record): record is StoredApprovalRecord => record?.status === "pending");
  }

  updateNotifications(approvalId: string, notifications: StoredApprovalNotification[]): StoredApprovalRecord | undefined {
    const existing = this.getById(approvalId);
    if (!existing) {
      return undefined;
    }
    const updated: StoredApprovalRecord = {
      ...existing,
      notifications: [...notifications],
    };
    this.#write(updated);
    return updated;
  }

  close(): void {
    this.#db.close();
  }

  // User Approval Context methods (implements UserApprovalContextRepository)
  setContext(context: UserApprovalContext): void {
    this.setUserContext(context);
  }

  getContext(channel: string, userId: string, accountId?: string): UserApprovalContext | undefined {
    return this.getUserContext(channel, userId, accountId);
  }

  clearContext(channel: string, userId: string, accountId?: string): void {
    this.clearUserContext(channel, userId, accountId);
  }

  // Internal implementation
  setUserContext(context: UserApprovalContext): void {
    const contextKey = this.#buildContextKey(context.channel, context.user_id, context.account_id);
    this.#db
      .prepare(
        `
        INSERT INTO user_approval_contexts (
          context_key,
          approval_id,
          channel,
          user_id,
          account_id,
          sent_at,
          expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(context_key) DO UPDATE SET
          approval_id = excluded.approval_id,
          channel = excluded.channel,
          user_id = excluded.user_id,
          account_id = excluded.account_id,
          sent_at = excluded.sent_at,
          expires_at = excluded.expires_at
      `,
      )
      .run(
        contextKey,
        context.approval_id,
        context.channel,
        context.user_id,
        context.account_id ?? null,
        context.sent_at,
        context.expires_at,
      );
  }

  getUserContext(channel: string, userId: string, accountId?: string): UserApprovalContext | undefined {
    const contextKey = this.#buildContextKey(channel, userId, accountId);
    const row = this.#db
      .prepare(
        `
        SELECT approval_id, channel, user_id, account_id, sent_at, expires_at
        FROM user_approval_contexts
        WHERE context_key = ?
      `,
      )
      .get(contextKey) as
      | {
          approval_id: string;
          channel: string;
          user_id: string;
          account_id: string | null;
          sent_at: string;
          expires_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      approval_id: row.approval_id,
      channel: row.channel,
      user_id: row.user_id,
      account_id: row.account_id ?? undefined,
      sent_at: row.sent_at,
      expires_at: row.expires_at,
    };
  }

  clearUserContext(channel: string, userId: string, accountId?: string): void {
    const contextKey = this.#buildContextKey(channel, userId, accountId);
    this.#db
      .prepare(
        `
        DELETE FROM user_approval_contexts
        WHERE context_key = ?
      `,
      )
      .run(contextKey);
  }

  cleanupExpiredUserContexts(): number {
    const now = new Date(this.#now()).toISOString();
    const result = this.#db
      .prepare(
        `
        DELETE FROM user_approval_contexts
        WHERE expires_at < ?
      `,
      )
      .run(now);
    return typeof result.changes === "number" ? result.changes : 0;
  }

  #buildContextKey(channel: string, userId: string, accountId?: string): string {
    // Normalize account_id: treat undefined, empty string, and "default" as equivalent (no suffix)
    const normalizedAccountId = accountId?.trim() && accountId.trim() !== "default" ? accountId.trim() : undefined;
    const normalized = `${channel.toLowerCase()}:${userId}${normalizedAccountId ? `:${normalizedAccountId}` : ""}`;
    return normalized;
  }

  #expireIfNeeded(record: StoredApprovalRecord): StoredApprovalRecord {
    if (record.status === "pending" || record.status === "approved") {
      if (this.#now() > new Date(record.expires_at).getTime()) {
        const expired: StoredApprovalRecord = {
          ...record,
          status: "expired",
        };
        this.#write(expired);
        return expired;
      }
    }
    return record;
  }

  #write(record: StoredApprovalRecord): void {
    this.#db
      .prepare(
        `
        INSERT INTO chat_approval_requests (
          approval_id,
          request_key,
          session_scope,
          status,
          requested_at,
          expires_at,
          policy_version,
          actor_id,
          scope,
          tool_name,
          resource_scope,
          resource_paths_json,
          reason_codes_json,
          rule_ids_json,
          args_summary,
          approver,
          decided_at,
          notifications_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(approval_id) DO UPDATE SET
          request_key = excluded.request_key,
          session_scope = excluded.session_scope,
          status = excluded.status,
          requested_at = excluded.requested_at,
          expires_at = excluded.expires_at,
          policy_version = excluded.policy_version,
          actor_id = excluded.actor_id,
          scope = excluded.scope,
          tool_name = excluded.tool_name,
          resource_scope = excluded.resource_scope,
          resource_paths_json = excluded.resource_paths_json,
          reason_codes_json = excluded.reason_codes_json,
          rule_ids_json = excluded.rule_ids_json,
          args_summary = excluded.args_summary,
          approver = excluded.approver,
          decided_at = excluded.decided_at,
          notifications_json = excluded.notifications_json
      `,
      )
      .run(
        record.approval_id,
        record.request_key,
        record.session_scope,
        record.status,
        record.requested_at,
        record.expires_at,
        record.policy_version,
        record.actor_id,
        record.scope,
        record.tool_name,
        record.resource_scope,
        JSON.stringify(record.resource_paths),
        JSON.stringify(record.reason_codes),
        JSON.stringify(record.rule_ids),
        record.args_summary,
        record.approver ?? null,
        record.decided_at ?? null,
        JSON.stringify(record.notifications),
      );
  }
}
