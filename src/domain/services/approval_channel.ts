export const INTERACTIVE_APPROVAL_CHANNELS = ["telegram", "slack", "discord"] as const;

export type InteractiveApprovalChannel = (typeof INTERACTIVE_APPROVAL_CHANNELS)[number];

type ApprovalChannelRecordLike = {
  channel?: string;
  subject?: string;
  session_key?: string;
  chat_type?: string;
};

const INTERACTIVE_APPROVAL_CHANNEL_SET = new Set<string>(INTERACTIVE_APPROVAL_CHANNELS);
const DIRECT_CHAT_TYPES = new Set(["direct", "dm", "private"]);

function normalizeChatType(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function normalizeChannel(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function normalizeInteractiveApprovalChannel(value: string | undefined): InteractiveApprovalChannel | undefined {
  const normalized = normalizeChannel(value);
  return normalized && INTERACTIVE_APPROVAL_CHANNEL_SET.has(normalized)
    ? (normalized as InteractiveApprovalChannel)
    : undefined;
}

function findInteractiveApprovalChannel(value: string | undefined): InteractiveApprovalChannel | undefined {
  const direct = normalizeInteractiveApprovalChannel(value);
  if (direct) {
    return direct;
  }
  if (!value?.trim()) {
    return undefined;
  }
  return value
    .split(":")
    .map((part) => normalizeInteractiveApprovalChannel(part))
    .find((part): part is InteractiveApprovalChannel => part !== undefined);
}

export function supportsInteractiveApprovalChannel(value: string | undefined): value is InteractiveApprovalChannel {
  return normalizeInteractiveApprovalChannel(value) !== undefined;
}

export function resolveInteractiveApprovalChannel(
  value: string | ApprovalChannelRecordLike | undefined,
): InteractiveApprovalChannel | undefined {
  if (typeof value === "string") {
    return findInteractiveApprovalChannel(value);
  }
  if (!value) {
    return undefined;
  }
  return findInteractiveApprovalChannel(value.channel)
    ?? findInteractiveApprovalChannel(value.subject)
    ?? findInteractiveApprovalChannel(value.session_key);
}

export function supportsInteractiveApprovalForAccount(record: ApprovalChannelRecordLike | undefined): boolean {
  return resolveInteractiveApprovalChannel(record) !== undefined;
}

export function canAssignAdminForAccount(record: ApprovalChannelRecordLike | undefined): boolean {
  if (!record || !supportsInteractiveApprovalForAccount(record)) {
    return false;
  }

  const chatType = normalizeChatType(record.chat_type);
  if (chatType) {
    return DIRECT_CHAT_TYPES.has(chatType);
  }

  const sessionKey = record.session_key?.trim().toLowerCase();
  if (sessionKey) {
    return sessionKey.includes(":direct:");
  }

  const subject = record.subject?.trim().toLowerCase();
  if (!subject) {
    return false;
  }
  return !subject.includes(":group:")
    && !subject.includes(":channel:")
    && !subject.includes(":thread:")
    && !subject.includes(":topic:")
    && !subject.startsWith("agent:");
}
