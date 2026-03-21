import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UserApprovalContextService } from "../src/domain/services/user_approval_context_service.ts";
import type { UserApprovalContext, UserApprovalContextRepository } from "../src/domain/services/user_approval_context_service.ts";

class InMemoryUserApprovalContextRepository implements UserApprovalContextRepository {
  private contexts = new Map<string, UserApprovalContext>();

  setContext(context: UserApprovalContext): void {
    const key = this.buildKey(context.channel, context.user_id, context.account_id);
    this.contexts.set(key, context);
  }

  getContext(channel: string, userId: string, accountId?: string): UserApprovalContext | undefined {
    const key = this.buildKey(channel, userId, accountId);
    return this.contexts.get(key);
  }

  clearContext(channel: string, userId: string, accountId?: string): void {
    const key = this.buildKey(channel, userId, accountId);
    this.contexts.delete(key);
  }

  private buildKey(channel: string, userId: string, accountId?: string): string {
    return `${channel}:${userId}${accountId ? `:${accountId}` : ""}`;
  }
}

it("user context service records approval and resolves numeric input within time window", () => {
  const now = Date.now();
  const repository = new InMemoryUserApprovalContextRepository();
  const service = new UserApprovalContextService(repository, () => now);

  const approvalId = "test-approval-123";
  const channel = "telegram";
  const userId = "user123";
  const expiresAt = new Date(now + 15 * 60 * 1000).toISOString();

  service.recordApprovalSent(approvalId, channel, userId, expiresAt);

  const result1 = service.resolveNumericInput("1", channel, userId);
  assert.ok(result1);
  assert.equal(result1.approvalId, approvalId);
  assert.equal(result1.action, "approve_temporary");

  const result2 = service.resolveNumericInput("2", channel, userId);
  assert.ok(result2);
  assert.equal(result2.action, "approve_longterm");

  const result3 = service.resolveNumericInput("3", channel, userId);
  assert.ok(result3);
  assert.equal(result3.action, "reject");
});

it("user context service returns undefined for invalid numeric input", () => {
  const repository = new InMemoryUserApprovalContextRepository();
  const service = new UserApprovalContextService(repository);

  service.recordApprovalSent("test-approval", "telegram", "user123", new Date(Date.now() + 60000).toISOString());

  const result = service.resolveNumericInput("4", "telegram", "user123");
  assert.equal(result, undefined);
});

it("user context service returns undefined when context has expired", () => {
  let now = Date.now();
  const repository = new InMemoryUserApprovalContextRepository();
  const service = new UserApprovalContextService(repository, () => now);

  const expiresAt = new Date(now + 1000).toISOString();
  service.recordApprovalSent("test-approval", "telegram", "user123", expiresAt);

  // Move time forward past expiration
  now += 2000;

  const result = service.resolveNumericInput("1", "telegram", "user123");
  assert.equal(result, undefined);
});

it("user context service returns undefined when no context exists for user", () => {
  const repository = new InMemoryUserApprovalContextRepository();
  const service = new UserApprovalContextService(repository);

  const result = service.resolveNumericInput("1", "telegram", "unknown-user");
  assert.equal(result, undefined);
});

it("user context service clears user context after action", () => {
  const repository = new InMemoryUserApprovalContextRepository();
  const service = new UserApprovalContextService(repository);

  service.recordApprovalSent("test-approval", "telegram", "user123", new Date(Date.now() + 60000).toISOString());

  const result1 = service.resolveNumericInput("1", "telegram", "user123");
  assert.ok(result1);

  service.clearUserContext("telegram", "user123");

  const result2 = service.resolveNumericInput("1", "telegram", "user123");
  assert.equal(result2, undefined);
});

it("user context service supports account-scoped contexts", () => {
  const repository = new InMemoryUserApprovalContextRepository();
  const service = new UserApprovalContextService(repository);

  service.recordApprovalSent("approval-1", "telegram", "user123", new Date(Date.now() + 60000).toISOString(), "account-a");
  service.recordApprovalSent("approval-2", "telegram", "user123", new Date(Date.now() + 60000).toISOString(), "account-b");

  const result1 = service.resolveNumericInput("1", "telegram", "user123", "account-a");
  assert.ok(result1);
  assert.equal(result1.approvalId, "approval-1");

  const result2 = service.resolveNumericInput("1", "telegram", "user123", "account-b");
  assert.ok(result2);
  assert.equal(result2.approvalId, "approval-2");
});
