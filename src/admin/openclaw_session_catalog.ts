import os from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ApprovalSubjectResolver } from "../domain/services/approval_subject_resolver.ts";

type JsonRecord = Record<string, unknown>;

type RawSessionMetadata = {
  sessionId?: unknown;
  updatedAt?: unknown;
  chatType?: unknown;
  lastChannel?: unknown;
  deliveryContext?: {
    channel?: unknown;
    to?: unknown;
  };
  origin?: {
    provider?: unknown;
    surface?: unknown;
    chatType?: unknown;
    from?: unknown;
    to?: unknown;
  };
  sessionFile?: unknown;
};

export type OpenClawChatSession = {
  subject: string;
  label: string;
  session_key: string;
  session_id?: string;
  agent_id?: string;
  channel?: string;
  provider?: string;
  chat_type?: string;
  updated_at?: string;
  session_file?: string;
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

const DIRECT_CHAT_TYPES = new Set(["direct", "dm", "private"]);

function normalizeDirectSessionSubject(channel: string | undefined, value: string | undefined): string | undefined {
  const normalizedChannel = normalizeString(channel)?.toLowerCase();
  const trimmed = normalizeString(value);
  if (!normalizedChannel || !trimmed) {
    return undefined;
  }

  if (normalizedChannel === "telegram") {
    const identifier = trimmed.replace(/^telegram:/i, "").trim();
    return identifier ? `telegram:${identifier}` : undefined;
  }

  if (normalizedChannel === "discord") {
    const scoped = trimmed.replace(/^discord:/i, "").trim();
    if (!scoped || /^channel:/i.test(scoped)) {
      return undefined;
    }
    const identifier = scoped.replace(/^user:/i, "").trim();
    if (!identifier) {
      return undefined;
    }
    const mention = identifier.match(/^<@!?(\d+)>$/);
    return `discord:${mention?.[1] ?? identifier}`;
  }

  if (normalizedChannel === "slack") {
    const scoped = trimmed.replace(/^slack:/i, "").trim();
    if (!scoped || /^channel:/i.test(scoped)) {
      return undefined;
    }
    const identifier = scoped.replace(/^user:/i, "").trim();
    if (!identifier) {
      return undefined;
    }
    return /^[UW][A-Z0-9]+$/i.test(identifier)
      ? `slack:${identifier.toUpperCase()}`
      : `slack:${identifier}`;
  }

  if (normalizedChannel === "feishu" || normalizedChannel === "lark") {
    const identifier = trimmed
      .replace(/^(feishu|lark):/i, "")
      .replace(/^(user|open_id|dm):/i, "")
      .trim();
    return identifier ? `${normalizedChannel}:${identifier}` : undefined;
  }

  return undefined;
}

function deriveSessionLabel(agentId: string, sessionKey: string, subject: string): string {
  const trimmedSessionKey = sessionKey.trim();
  if (trimmedSessionKey === `agent:${agentId}:main` || trimmedSessionKey === `agent:${agentId}:${agentId}`) {
    return "main";
  }
  return subject;
}

function readSessionFile(filePath: string): JsonRecord {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as JsonRecord;
}

export function listOpenClawChatSessions(openClawHome = path.join(os.homedir(), ".openclaw")): OpenClawChatSession[] {
  const agentsDir = path.join(openClawHome, "agents");
  if (!existsSync(agentsDir)) {
    return [];
  }

  const deduped = new Map<string, OpenClawChatSession>();
  for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agentEntry.isDirectory()) {
      continue;
    }

    const agentId = agentEntry.name;
    const sessionsPath = path.join(agentsDir, agentId, "sessions", "sessions.json");
    if (!existsSync(sessionsPath)) {
      continue;
    }

    const rawSessions = readSessionFile(sessionsPath);
    for (const [sessionKey, rawMetadata] of Object.entries(rawSessions)) {
      if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
        continue;
      }

      const metadata = rawMetadata as RawSessionMetadata;
      const sessionId = normalizeString(metadata.sessionId);
      const channel =
        normalizeString(metadata.deliveryContext?.channel) ??
        normalizeString(metadata.lastChannel);
      const provider =
        normalizeString(metadata.origin?.provider) ??
        normalizeString(metadata.origin?.surface);
      const chatType =
        normalizeString(metadata.chatType) ??
        normalizeString(metadata.origin?.chatType);
      const updatedAt = normalizeTimestamp(metadata.updatedAt);
      const sessionFile = normalizeString(metadata.sessionFile);
      const fallbackSubject = ApprovalSubjectResolver.resolve({
        agentId,
        sessionKey,
        ...(sessionId ? { sessionId } : {}),
        ...(channel ? { channelId: channel } : {})
      });
      const subject = DIRECT_CHAT_TYPES.has(chatType?.toLowerCase() ?? "")
        ? normalizeDirectSessionSubject(channel ?? provider, normalizeString(metadata.origin?.from))
          ?? normalizeDirectSessionSubject(channel ?? provider, normalizeString(metadata.origin?.to))
          ?? normalizeDirectSessionSubject(channel ?? provider, normalizeString(metadata.deliveryContext?.to))
          ?? fallbackSubject
        : fallbackSubject;

      const entry: OpenClawChatSession = {
        subject,
        label: deriveSessionLabel(agentId, sessionKey, subject),
        session_key: sessionKey,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(channel ? { channel } : {}),
        ...(provider ? { provider } : {}),
        ...(chatType ? { chat_type: chatType } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        ...(sessionFile ? { session_file: sessionFile } : {}),
        agent_id: agentId
      };

      const previous = deduped.get(subject);
      const previousTs = previous?.updated_at ? Date.parse(previous.updated_at) : Number.NEGATIVE_INFINITY;
      const nextTs = entry.updated_at ? Date.parse(entry.updated_at) : Number.NEGATIVE_INFINITY;
      if (!previous || nextTs >= previousTs) {
        deduped.set(subject, entry);
      }
    }
  }

  return Array.from(deduped.values()).sort((left, right) => {
    const rightTs = right.updated_at ? Date.parse(right.updated_at) : Number.NEGATIVE_INFINITY;
    const leftTs = left.updated_at ? Date.parse(left.updated_at) : Number.NEGATIVE_INFINITY;
    if (rightTs !== leftTs) {
      return rightTs - leftTs;
    }
    return left.subject.localeCompare(right.subject);
  });
}
