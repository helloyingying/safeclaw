export interface StoredApprovalNotification {
  channel: string;
  to: string;
  account_id?: string;
  thread_id?: number;
  message_id?: string;
  sent_at?: string;
}

export interface StoredApprovalRecord {
  approval_id: string;
  request_key: string;
  session_scope: string;
  status: "pending" | "approved" | "rejected" | "expired";
  requested_at: string;
  expires_at: string;
  policy_version: string;
  actor_id: string;
  scope: string;
  tool_name: string;
  resource_scope: string;
  resource_paths: string[];
  reason_codes: string[];
  rule_ids: string[];
  args_summary?: string;
  approver?: string;
  decided_at?: string;
  notifications: StoredApprovalNotification[];
}

export interface ApprovalRepository {
  create(record: Omit<StoredApprovalRecord, "notifications">): StoredApprovalRecord;
  getById(approvalId: string): StoredApprovalRecord | undefined;
  findApproved(sessionScope: string, requestKey: string): StoredApprovalRecord | undefined;
  findPending(sessionScope: string, requestKey: string): StoredApprovalRecord | undefined;
  resolve(approvalId: string, approver: string, decision: "approved" | "rejected", metadata?: { expires_at?: string }): StoredApprovalRecord | undefined;
  updateNotifications(approvalId: string, notifications: StoredApprovalNotification[]): StoredApprovalRecord | undefined;
  listPending(limit: number): StoredApprovalRecord[];
  close(): void;
}
