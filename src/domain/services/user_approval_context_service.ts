/**
 * User Approval Context Service
 * 
 * Manages per-user approval context for numeric shortcut responses.
 * When an approval notification is sent, we track the user's context
 * so they can respond with simple numbers (1, 2, 3) instead of full commands.
 */

export type UserApprovalContext = {
  approval_id: string;
  channel: string;
  user_id: string;
  account_id?: string | undefined;
  sent_at: string;
  expires_at: string;
};

export type NumericAction = "approve_temporary" | "approve_longterm" | "reject";

export interface UserApprovalContextRepository {
  setContext(context: UserApprovalContext): void;
  getContext(channel: string, userId: string, accountId?: string): UserApprovalContext | undefined;
  clearContext(channel: string, userId: string, accountId?: string): void;
}

export class UserApprovalContextService {
  private repository: UserApprovalContextRepository;
  private now: () => number;

  constructor(
    repository: UserApprovalContextRepository,
    now: () => number = Date.now,
  ) {
    this.repository = repository;
    this.now = now;
  }

  /**
   * Record that an approval notification was sent to a user.
   * This enables numeric shortcut responses within the time window.
   */
  recordApprovalSent(
    approvalId: string,
    channel: string,
    userId: string,
    expiresAt: string,
    accountId?: string,
  ): void {
    const context: UserApprovalContext = {
      approval_id: approvalId,
      channel,
      user_id: userId,
      account_id: accountId,
      sent_at: new Date(this.now()).toISOString(),
      expires_at: expiresAt,
    };
    this.repository.setContext(context);
  }

  /**
   * Try to resolve a numeric input (1, 2, 3) to an approval action.
   * Returns undefined if no valid context exists or input is invalid.
   */
  resolveNumericInput(
    input: string,
    channel: string,
    userId: string,
    accountId?: string,
  ): { approvalId: string; action: NumericAction } | undefined {
    const context = this.repository.getContext(channel, userId, accountId);
    if (!context) {
      return undefined;
    }

    // Check if context has expired
    const expiresAtMs = new Date(context.expires_at).getTime();
    if (this.now() > expiresAtMs) {
      this.repository.clearContext(channel, userId, accountId);
      return undefined;
    }

    // Map numeric input to action
    const action = this.parseNumericAction(input.trim());
    if (!action) {
      return undefined;
    }

    return {
      approvalId: context.approval_id,
      action,
    };
  }

  /**
   * Clear user context after successful approval action.
   */
  clearUserContext(channel: string, userId: string, accountId?: string): void {
    this.repository.clearContext(channel, userId, accountId);
  }

  /**
   * Parse numeric input to action.
   * 1 -> approve_temporary
   * 2 -> approve_longterm
   * 3 -> reject
   */
  private parseNumericAction(input: string): NumericAction | undefined {
    switch (input) {
      case "1":
        return "approve_temporary";
      case "2":
        return "approve_longterm";
      case "3":
        return "reject";
      default:
        return undefined;
    }
  }
}
