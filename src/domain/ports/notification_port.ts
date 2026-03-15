export type ApprovalChannel = "telegram" | "discord" | "slack" | "signal" | "imessage" | "whatsapp" | "line";

export interface NotificationTarget {
  channel: ApprovalChannel;
  to: string;
  accountId?: string;
  threadId?: string | number;
}

export interface NotificationOptions {
  buttons?: Array<Array<{
    text: string;
    callback_data: string;
    style?: string;
  }>>;
}

export interface NotificationResult {
  channel: ApprovalChannel;
  to: string;
  accountId?: string;
  threadId?: number;
  messageId?: string;
  sentAt: string;
}

export interface NotificationPort {
  send(target: NotificationTarget, message: string, options?: NotificationOptions): Promise<NotificationResult>;
}
