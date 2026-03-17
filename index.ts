import os from "node:os";
import { isIP } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type {
  OpenClawPluginApi
} from "openclaw/plugin-sdk";
import * as OpenClawCompat from "openclaw/plugin-sdk/compat";

import { LiveConfigResolver, type LiveConfigSnapshot } from "./src/config/live_config.ts";
import {
  ChatApprovalStore,
  type ApprovalChannel,
  type ChatApprovalApprover,
  type ChatApprovalTarget,
  type StoredApprovalNotification,
  type StoredApprovalRecord,
  createApprovalRequestKey,
} from "./src/approvals/chat_approval_store.ts";
import { DecisionEngine } from "./src/engine/decision_engine.ts";
import { DlpEngine } from "./src/engine/dlp_engine.ts";
import { RuleEngine } from "./src/engine/rule_engine.ts";
import { EventEmitter, HttpEventSink } from "./src/events/emitter.ts";
import { RuntimeStatusStore } from "./src/monitoring/status_store.ts";
import { startAdminServer } from "./admin/server.ts";
import { ensureAdminAssetsBuilt } from "./src/admin/build.ts";
import { announceAdminConsole, shouldAnnounceAdminConsoleForArgv } from "./src/admin/console_notice.ts";
import { shouldAutoStartAdminServer } from "./src/admin/runtime_guard.ts";
import { AccountPolicyEngine } from "./src/domain/services/account_policy_engine.ts";
import { ApprovalSubjectResolver } from "./src/domain/services/approval_subject_resolver.ts";
import {
  extractEmbeddedPathCandidates,
  hasEmbeddedPathHint,
  isPathLikeCandidate,
  resolvePathCandidate,
} from "./src/domain/services/path_candidate_inference.ts";
import { defaultFileRuleReasonCode, matchFileRule } from "./src/domain/services/file_rule_registry.ts";
import { hydrateSensitivePathConfig } from "./src/domain/services/sensitive_path_registry.ts";
import { inferShellFilesystemSemantic } from "./src/domain/services/shell_filesystem_inference.ts";
import { inferSensitivityLabels } from "./src/domain/services/sensitivity_label_inference.ts";
import type { SecurityClawLocale } from "./src/i18n/locale.ts";
import { localeForIntl, pickLocalized, resolveSecurityClawLocale } from "./src/i18n/locale.ts";
import type {
  AccountPolicyRecord,
  DecisionContext,
  DecisionSource,
  DlpFinding,
  ResourceScope,
  RuleMatch,
  SecurityClawConfig,
  SecurityDecisionEvent
} from "./src/types.ts";

type SecurityClawPluginConfig = {
  configPath?: string;
  overridePath?: string;
  dbPath?: string;
  webhookUrl?: string;
  policyVersion?: string;
  environment?: string;
  approvalTtlSeconds?: number;
  persistMode?: "strict" | "compat";
  decisionLogMaxLength?: number;
  statusPath?: string;
  adminAutoStart?: boolean;
  adminPort?: number;
};

type ResolvedPluginRuntime = {
  configPath: string;
  dbPath: string;
  legacyOverridePath: string;
};

type RuntimeDependencies = {
  config: SecurityClawConfig;
  ruleEngine: RuleEngine;
  decisionEngine: DecisionEngine;
  accountPolicyEngine: AccountPolicyEngine;
  dlpEngine: DlpEngine;
  emitter: EventEmitter;
  overrideLoaded: boolean;
};

type SecurityClawHookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  channelId?: string;
};

type SecurityClawApprovalCommandContext = {
  channel?: string;
  senderId?: string;
  from?: string;
  to?: string;
  accountId?: string;
  args?: string;
  isAuthorizedSender: boolean;
};

type ApprovalNotificationResult = {
  sent: boolean;
  notifications: StoredApprovalNotification[];
};

type ApprovalGrantMode = "temporary" | "longterm";

type ResolvedApprovalBridge = {
  enabled: boolean;
  targets: ChatApprovalTarget[];
  approvers: ChatApprovalApprover[];
};

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = os.homedir();
const APPROVAL_APPROVE_COMMAND = "securityclaw-approve";
const APPROVAL_REJECT_COMMAND = "securityclaw-reject";
const APPROVAL_PENDING_COMMAND = "securityclaw-pending";
const APPROVAL_LONG_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const APPROVAL_DISPLAY_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const APPROVAL_NOTIFICATION_MAX_ATTEMPTS = 3;
const APPROVAL_NOTIFICATION_RETRY_DELAYS_MS = [250, 750];
const APPROVAL_NOTIFICATION_RESEND_COOLDOWN_MS = 60_000;
const APPROVAL_NOTIFICATION_HISTORY_LIMIT = 12;
const PATH_KEY_PATTERN = /(path|paths|file|files|dir|cwd|target|output|input|source|destination|dest|root)/i;
const COMMAND_KEY_PATTERN = /(command|cmd|script|query|sql)/i;
const URL_KEY_PATTERN = /(url|uri|endpoint|host|domain|upload|webhook|callback|proxy|origin|destination|dest)/i;
const SYSTEM_PATH_PREFIXES = ["/etc", "/usr", "/bin", "/sbin", "/var", "/private/etc", "/System", "/Library"];
const DEFAULT_MESSAGES_DB_PATH = path.join(HOME_DIR, "Library/Messages/chat.db");
const MESSAGE_DB_PATH_PATTERN = /(?:~\/Library\/Messages\/chat\.db|\/Users\/[^/\s"'`;]+\/Library\/Messages\/chat\.db)/i;
const PERSONAL_STORAGE_DOMAINS = [
  "dropbox.com",
  "drive.google.com",
  "docs.google.com",
  "onedrive.live.com",
  "1drv.ms",
  "notion.so",
  "notion.site",
];
const PASTE_SERVICE_DOMAINS = [
  "pastebin.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "hastebin.com",
  "transfer.sh",
];
const CHANNEL_METHOD_SUFFIX_OVERRIDES: Record<string, string> = {
  imessage: "IMessage",
  whatsapp: "WhatsApp",
  lark: "Feishu",
};
const FEISHU_DEFAULT_API_BASE = "https://open.feishu.cn";
const LARK_DEFAULT_API_BASE = "https://open.larksuite.com";
const FEISHU_HTTP_TIMEOUT_MS = 10_000;
const CHANNEL_LOOKUP_ALIASES: Record<string, string[]> = {
  feishu: ["lark"],
  lark: ["feishu"],
};
const getChannelPluginCompat = (OpenClawCompat as Record<string, unknown>).getChannelPlugin as
  | ((id: string) => unknown)
  | undefined;

function resolveRuntimeLocale(): SecurityClawLocale {
  const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  return resolveSecurityClawLocale(systemLocale, "en");
}

let runtimeLocale: SecurityClawLocale = resolveRuntimeLocale();

function text(zhText: string, enText: string): string {
  return pickLocalized(runtimeLocale, zhText, enText);
}

function resolvePluginStateDir(api: OpenClawPluginApi): string {
  try {
    return api.runtime.state.resolveStateDir();
  } catch {
    return path.join(HOME_DIR, ".openclaw");
  }
}

function resolveAdminConsoleUrl(pluginConfig: SecurityClawPluginConfig): string {
  const port = pluginConfig.adminPort ?? Number(process.env.SECURITYCLAW_ADMIN_PORT ?? 4780);
  return `http://127.0.0.1:${port}`;
}

function plural(value: number, unit: "day" | "hour" | "minute"): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function resolveScope(ctx: { workspaceDir?: string | undefined; channelId?: string | undefined }): string {
  if (ctx.workspaceDir) {
    return path.basename(ctx.workspaceDir);
  }
  return ctx.channelId ?? "default";
}

function isPathLike(value: string, keyHint: string): boolean {
  if (PATH_KEY_PATTERN.test(keyHint)) {
    return true;
  }
  return isPathLikeCandidate(value);
}

function collectPathCandidates(value: unknown, keyHint = "", depth = 0, output: string[] = []): string[] {
  if (depth > 4 || output.length >= 24) {
    return output;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && isPathLike(trimmed, keyHint)) {
      output.push(trimmed);
    } else if (trimmed && (COMMAND_KEY_PATTERN.test(keyHint) || hasEmbeddedPathHint(trimmed))) {
      for (const candidate of extractEmbeddedPathCandidates(trimmed)) {
        output.push(candidate);
        if (output.length >= 24) {
          break;
        }
      }
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathCandidates(item, keyHint, depth + 1, output);
      if (output.length >= 24) {
        break;
      }
    }
    return output;
  }

  if (!value || typeof value !== "object") {
    return output;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    collectPathCandidates(item, key, depth + 1, output);
    if (output.length >= 24) {
      break;
    }
  }
  return output;
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSystemPath(candidate: string): boolean {
  return SYSTEM_PATH_PREFIXES.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
}

function classifyResolvedResourcePaths(
  resolved: string[],
  workspaceDir?: string,
): { resourceScope: ResourceScope; resourcePaths: string[] } {
  if (resolved.length === 0) {
    return { resourceScope: "none", resourcePaths: [] };
  }

  let hasInside = false;
  let hasOutside = false;
  let hasSystem = false;
  const normalizedWorkspace = workspaceDir ? path.normalize(workspaceDir) : undefined;

  for (const candidate of resolved) {
    if (isSystemPath(candidate)) {
      hasSystem = true;
    }
    if (normalizedWorkspace && isPathInside(normalizedWorkspace, candidate)) {
      hasInside = true;
    } else {
      hasOutside = true;
    }
  }

  if (hasSystem) {
    return { resourceScope: "system", resourcePaths: resolved };
  }
  if (hasOutside) {
    return { resourceScope: "workspace_outside", resourcePaths: resolved };
  }
  if (hasInside) {
    return { resourceScope: "workspace_inside", resourcePaths: resolved };
  }
  return { resourceScope: "none", resourcePaths: resolved };
}

function extractResourceContext(args: unknown, workspaceDir?: string): { resourceScope: ResourceScope; resourcePaths: string[] } {
  const candidates = collectPathCandidates(args);
  const resolved = Array.from(
    new Set(
      candidates
        .map((candidate) => resolvePathCandidate(candidate, workspaceDir))
        .filter((value): value is string => Boolean(value)),
    ),
  ).slice(0, 12);
  return classifyResolvedResourcePaths(resolved, workspaceDir);
}

function isUrlLike(value: string, keyHint: string): boolean {
  return URL_KEY_PATTERN.test(keyHint) || value.startsWith("http://") || value.startsWith("https://");
}

function collectUrlCandidates(value: unknown, keyHint = "", depth = 0, output: string[] = []): string[] {
  if (depth > 4 || output.length >= 12) {
    return output;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && isUrlLike(trimmed, keyHint)) {
      output.push(trimmed);
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlCandidates(item, keyHint, depth + 1, output);
      if (output.length >= 12) {
        break;
      }
    }
    return output;
  }

  if (!value || typeof value !== "object") {
    return output;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    collectUrlCandidates(item, key, depth + 1, output);
    if (output.length >= 12) {
      break;
    }
  }
  return output;
}

function isPrivateIp(host: string): boolean {
  if (isIP(host) !== 4) {
    return false;
  }
  const octets = host.split(".").map((value) => Number(value));
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isLoopbackIp(host: string): boolean {
  if (isIP(host) === 4) {
    return host.startsWith("127.");
  }
  return host === "::1";
}

function classifyDestination(urls: string[]): Pick<
  DecisionContext,
  "destination_type" | "dest_domain" | "dest_ip_class"
> {
  for (const candidate of urls) {
    try {
      const parsed = new URL(candidate);
      const host = parsed.hostname.toLowerCase();
      const ipVersion = isIP(host);
      const isInternalHost =
        host === "localhost" ||
        host.endsWith(".internal") ||
        host.endsWith(".corp") ||
        host.endsWith(".local") ||
        host.endsWith(".lan") ||
        isPrivateIp(host);

      const destinationType =
        PERSONAL_STORAGE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
          ? "personal_storage"
          : PASTE_SERVICE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
            ? "paste_service"
            : isInternalHost
              ? "internal"
              : "public";

      const destIpClass =
        ipVersion === 0
          ? destinationType === "internal"
            ? "private"
            : "unknown"
          : isLoopbackIp(host)
            ? "loopback"
            : isPrivateIp(host)
              ? "private"
              : "public";

      return {
        destination_type: destinationType,
        dest_domain: host,
        dest_ip_class: destIpClass,
      };
    } catch {
      continue;
    }
  }

  return {};
}

function inferToolGroup(toolName: string): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.startsWith("shell.")) {
    return "execution";
  }
  if (normalized.startsWith("filesystem.")) {
    return "filesystem";
  }
  if (normalized.startsWith("network.") || normalized.startsWith("http.")) {
    return "network";
  }
  if (normalized.startsWith("email.") || normalized.startsWith("mail.")) {
    return "email";
  }
  if (
    normalized.startsWith("sms.") ||
    normalized.startsWith("message.") ||
    normalized.startsWith("messages.")
  ) {
    return "sms";
  }
  if (normalized.startsWith("album.") || normalized.startsWith("photo.") || normalized.startsWith("media.")) {
    return "album";
  }
  if (normalized.startsWith("browser.")) {
    return "browser";
  }
  if (
    normalized.startsWith("archive.") ||
    normalized.startsWith("compress.") ||
    normalized.includes(".archive") ||
    normalized.includes(".compress") ||
    normalized.includes(".zip")
  ) {
    return "archive";
  }
  if (
    normalized.startsWith("crm.") ||
    normalized.startsWith("erp.") ||
    normalized.startsWith("hr.") ||
    normalized.startsWith("finance.") ||
    normalized.startsWith("jira.") ||
    normalized.startsWith("servicenow.") ||
    normalized.startsWith("zendesk.")
  ) {
    return "business";
  }
  return undefined;
}

function inferOperation(toolName: string): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.startsWith("network.") || normalized.startsWith("http.")) {
    return "request";
  }
  if (/(exec|run|spawn)$/.test(normalized) || normalized.endsWith(".exec")) {
    return "execute";
  }
  if (/(delete|remove|unlink|destroy)$/.test(normalized) || normalized.endsWith(".rm")) {
    return "delete";
  }
  if (/(write|save|create|update|append|put)$/.test(normalized)) {
    return "write";
  }
  if (/(list|ls|enumerate)$/.test(normalized)) {
    return "list";
  }
  if (/(search|query|find)$/.test(normalized)) {
    return "search";
  }
  if (/(read|get|open|cat|fetch|download)$/.test(normalized)) {
    return "read";
  }
  if (/(upload|send|post|reply)$/.test(normalized)) {
    return "upload";
  }
  if (/(export|dump)$/.test(normalized)) {
    return "export";
  }
  if (/(archive|compress|zip|tar|bundle)$/.test(normalized)) {
    return "archive";
  }
  if (/(deploy|apply|terraform|kubectl)$/.test(normalized)) {
    return "modify";
  }
  return undefined;
}

function inferFileType(resourcePaths: string[]): string | undefined {
  for (const candidate of resourcePaths) {
    const basename = path.basename(candidate);
    if (basename === "Dockerfile") {
      return "dockerfile";
    }
    const extension = path.extname(basename).toLowerCase().replace(/^\./, "");
    if (extension) {
      return extension;
    }
  }
  return undefined;
}

function extractShellCommandText(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isMessagesDbPath(candidate: string): boolean {
  return /\/Library\/Messages\/chat\.db$/i.test(candidate);
}

function isMessagesShellAccess(commandText: string | undefined, resourcePaths: string[]): boolean {
  if (resourcePaths.some((candidate) => isMessagesDbPath(candidate))) {
    return true;
  }
  const corpus = [commandText ?? "", ...resourcePaths].join(" ");
  return /\bimsg\b/i.test(corpus) || (/\bsqlite3\b/i.test(corpus) && MESSAGE_DB_PATH_PATTERN.test(corpus));
}

function inferMessagesOperation(commandText: string | undefined): string {
  const normalized = (commandText ?? "").toLowerCase();
  if (/\b(export|dump)\b/.test(normalized)) {
    return "export";
  }
  if (/\b(search|find|query)\b/.test(normalized)) {
    return "search";
  }
  return "read";
}

function deriveToolContext(
  normalizedToolName: string | undefined,
  args: unknown,
  resourceScope: ResourceScope,
  resourcePaths: string[],
  workspaceDir?: string,
): {
  inferredToolName?: string;
  toolGroup?: string;
  operation?: string;
  resourceScope: ResourceScope;
  resourcePaths: string[];
  tags: string[];
} {
  let nextResourcePaths = [...resourcePaths];
  let nextResourceScope = resourceScope;
  let toolGroup = normalizedToolName ? inferToolGroup(normalizedToolName) : undefined;
  let operation = normalizedToolName ? inferOperation(normalizedToolName) : undefined;
  let inferredToolName: string | undefined;
  const tags: string[] = [];

  if (normalizedToolName === "shell.exec") {
    const commandText = extractShellCommandText(args);
    if (isMessagesShellAccess(commandText, nextResourcePaths)) {
      toolGroup = "sms";
      operation = inferMessagesOperation(commandText);
      if (!nextResourcePaths.some((candidate) => isMessagesDbPath(candidate))) {
        nextResourcePaths = [...nextResourcePaths, DEFAULT_MESSAGES_DB_PATH];
      }
      const classified = classifyResolvedResourcePaths(nextResourcePaths, workspaceDir);
      nextResourcePaths = classified.resourcePaths;
      nextResourceScope = classified.resourceScope;
      tags.push("messages_shell_access");
    } else {
      const shellSemantic = inferShellFilesystemSemantic(commandText, nextResourcePaths);
      if (shellSemantic) {
        inferredToolName = shellSemantic.toolName;
        toolGroup = "filesystem";
        operation = shellSemantic.operation;
        tags.push("shell_filesystem_access", `shell_filesystem_operation:${shellSemantic.operation}`);
      }
    }
  }

  return {
    ...(inferredToolName !== undefined ? { inferredToolName } : {}),
    ...(toolGroup !== undefined ? { toolGroup } : {}),
    ...(operation !== undefined ? { operation } : {}),
    resourceScope: nextResourceScope,
    resourcePaths: nextResourcePaths,
    tags,
  };
}

function inferLabels(
  config: SecurityClawConfig,
  toolGroup: string | undefined,
  resourcePaths: string[],
  toolArgsSummary: string | undefined,
): Pick<DecisionContext, "asset_labels" | "data_labels"> {
  const inferred = inferSensitivityLabels(
    toolGroup,
    resourcePaths,
    toolArgsSummary,
    config.sensitivity.path_rules,
  );
  return {
    asset_labels: inferred.assetLabels,
    data_labels: inferred.dataLabels,
  };
}

function inferVolume(args: unknown, resourcePaths: string[]): DecisionContext["volume"] {
  const metrics: DecisionContext["volume"] = {};
  if (resourcePaths.length > 0) {
    metrics.file_count = resourcePaths.length;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return metrics;
  }

  const record = args as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (Array.isArray(value)) {
      if (/(files|paths|attachments|items|results|records|messages)/.test(lower)) {
        if ((metrics.file_count ?? 0) < value.length) {
          metrics.file_count = value.length;
        }
        if (/(results|records|messages)/.test(lower) && (metrics.record_count ?? 0) < value.length) {
          metrics.record_count = value.length;
        }
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    if (/(bytes|size|length)/.test(lower)) {
      metrics.bytes = value;
    }
    if (/(count|limit|total|records)/.test(lower)) {
      metrics.record_count = value;
    }
  }

  return metrics;
}

function trimText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeApprovalChannel(value: string | undefined): ApprovalChannel | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? (normalized as ApprovalChannel) : undefined;
}

function normalizeThreadId(threadId: string | number | undefined): number | undefined {
  if (typeof threadId === "number" && Number.isInteger(threadId)) {
    return threadId;
  }
  if (typeof threadId === "string" && /^\d+$/.test(threadId.trim())) {
    return Number(threadId.trim());
  }
  return undefined;
}

function resolveApprovalSubject(ctx: SecurityClawHookContext): string {
  return ApprovalSubjectResolver.resolve(ctx);
}

function splitApprovalSubject(value: string | undefined): { channel?: ApprovalChannel; identifier?: string } {
  const subject = value?.trim();
  if (!subject) {
    return {};
  }
  const separator = subject.indexOf(":");
  if (separator <= 0) {
    return {};
  }
  const channel = normalizeApprovalChannel(subject.slice(0, separator));
  if (!channel) {
    return {};
  }
  const identifier = subject.slice(separator + 1).trim();
  if (!identifier) {
    return {};
  }
  return { channel, identifier };
}

function normalizeApprovalIdentity(value: string | undefined, channel: ApprovalChannel): string | undefined {
  const candidate = value?.trim();
  if (!candidate) {
    return undefined;
  }
  const channelPrefix = `${channel}:`;
  if (candidate.toLowerCase().startsWith(channelPrefix)) {
    const unscoped = candidate.slice(channelPrefix.length).trim();
    return unscoped || undefined;
  }
  return candidate;
}

function collectAdminApprovalIdentities(policy: AccountPolicyRecord, channel: ApprovalChannel): string[] {
  const candidates = new Set<string>();
  const subject = splitApprovalSubject(policy.subject);
  const subjectIdentity = normalizeApprovalIdentity(subject.identifier, channel);
  if (subjectIdentity) {
    candidates.add(subjectIdentity);
  } else {
    const sessionIdentity = normalizeApprovalIdentity(policy.session_id, channel);
    if (sessionIdentity) {
      candidates.add(sessionIdentity);
    }
  }
  return Array.from(candidates);
}

function deriveApprovalBridgeFromAdminPolicies(
  accountPolicyEngine: AccountPolicyEngine,
): Pick<ResolvedApprovalBridge, "targets" | "approvers"> {
  const targets: ChatApprovalTarget[] = [];
  const approvers: ChatApprovalApprover[] = [];
  for (const policy of accountPolicyEngine.listPolicies()) {
    if (!policy.is_admin) {
      continue;
    }
    const subject = splitApprovalSubject(policy.subject);
    const channel = normalizeApprovalChannel(policy.channel) ?? subject.channel;
    if (!channel) {
      continue;
    }
    const identities = collectAdminApprovalIdentities(policy, channel);
    for (const identity of identities) {
      targets.push({
        channel,
        to: identity,
      });
      approvers.push({
        channel,
        from: identity,
      });
    }
  }
  return { targets, approvers };
}

function dedupeApprovalTargets(targets: ChatApprovalTarget[]): ChatApprovalTarget[] {
  const deduped: ChatApprovalTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const key = [
      target.channel,
      target.to,
      target.account_id ?? "",
      target.thread_id !== undefined ? String(target.thread_id) : "",
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

function dedupeApprovalApprovers(approvers: ChatApprovalApprover[]): ChatApprovalApprover[] {
  const deduped: ChatApprovalApprover[] = [];
  const seen = new Set<string>();
  for (const approver of approvers) {
    const key = [approver.channel, approver.from, approver.account_id ?? ""].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(approver);
  }
  return deduped;
}

function mergeApprovalBridgeConfig(
  derived: Pick<ResolvedApprovalBridge, "targets" | "approvers">,
): ResolvedApprovalBridge {
  const targets = dedupeApprovalTargets(derived.targets);
  const approvers = dedupeApprovalApprovers(derived.approvers);
  return {
    enabled: approvers.length > 0,
    targets,
    approvers,
  };
}

function matchesApprover(approvers: ChatApprovalApprover[], ctx: SecurityClawApprovalCommandContext): boolean {
  const channel = normalizeApprovalChannel(ctx.channel);
  if (!channel) {
    return false;
  }
  const senderIds = new Set<string>();
  const collectSenderId = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    senderIds.add(trimmed);
    const lower = trimmed.toLowerCase();
    const channelPrefix = `${channel}:`;
    if (lower.startsWith(channelPrefix)) {
      const unscoped = trimmed.slice(channelPrefix.length).trim();
      if (unscoped) {
        senderIds.add(unscoped);
      }
      return;
    }
    senderIds.add(`${channel}:${trimmed}`);
  };

  collectSenderId(ctx.from);
  collectSenderId(ctx.senderId);
  if (senderIds.size === 0) {
    return false;
  }

  return approvers.some((approver) => {
    if (approver.channel !== channel || !senderIds.has(approver.from)) {
      return false;
    }
    if (approver.account_id && approver.account_id !== ctx.accountId) {
      return false;
    }
    return true;
  });
}

function formatResourceScopeLabel(scope: ResourceScope): string {
  if (scope === "workspace_inside") {
    return text("工作区内", "Inside workspace");
  }
  if (scope === "workspace_outside") {
    return text("工作区外", "Outside workspace");
  }
  if (scope === "system") {
    return text("系统目录", "System directory");
  }
  return text("无路径", "No path");
}

function formatResourceScopeDetail(scope: ResourceScope): string {
  return `${formatResourceScopeLabel(scope)} (${scope})`;
}

function formatApprovalPrompt(record: StoredApprovalRecord): string {
  const paths = record.resource_paths.length > 0
    ? trimText(record.resource_paths.slice(0, 3).join(" | "), 160)
    : undefined;
  const rules = record.rule_ids.length > 0 ? record.rule_ids.join(", ") : undefined;
  const reasons = record.reason_codes.length > 0 ? record.reason_codes.join(", ") : text("策略要求复核", "Policy review required");
  const summary = record.args_summary ? trimText(record.args_summary, 180) : undefined;

  return [
    text("SecurityClaw 审批请求", "SecurityClaw Approval"),
    `${text("对象", "Subject")}: ${record.actor_id}`,
    `${text("工具", "Tool")}: ${record.tool_name}`,
    `${text("范围", "Scope")}: ${record.scope}`,
    `${text("资源", "Resource")}: ${formatResourceScopeDetail(record.resource_scope)}`,
    `${text("原因", "Reason")}: ${reasons}`,
    `${text("请求截止", "Request expires")}: ${formatTimestampForApproval(record.expires_at)}`,
    `${text("审批单", "Request ID")}: ${record.approval_id}`,
    ...(paths ? [`${text("路径", "Paths")}: ${paths}`] : []),
    ...(summary ? [`${text("参数", "Args")}: ${summary}`] : []),
    ...(rules ? [`${text("规则", "Policy")}: ${rules}`] : []),
    "",
    text("操作", "Actions"),
    `- ${text("批准", "Approve")} ${formatApprovalGrantDuration(record, "temporary")}: /${APPROVAL_APPROVE_COMMAND} ${record.approval_id}`,
    `- ${text("批准", "Approve")} ${formatApprovalGrantDuration(record, "longterm")}: /${APPROVAL_APPROVE_COMMAND} ${record.approval_id} long`,
    `- ${text("拒绝", "Reject")}: /${APPROVAL_REJECT_COMMAND} ${record.approval_id}`,
  ].join("\n");
}

function formatPendingApprovals(records: StoredApprovalRecord[]): string {
  if (records.length === 0) {
    return text("当前没有待审批请求。", "No pending approval requests.");
  }
  return [
    text(`待审批请求 ${records.length} 条:`, `Pending approval requests (${records.length}):`),
    ...records.map((record) =>
      `- ${record.approval_id} | ${record.actor_id} | ${record.scope} | ${record.tool_name} | ${formatTimestampForApproval(record.requested_at)}`,
    ),
  ].join("\n");
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDurationMs(durationMs: number): string {
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const totalHours = totalMinutes / 60;
  const totalDays = totalHours / 24;
  if (Number.isInteger(totalDays) && totalDays >= 1) {
    return text(`${totalDays}天`, plural(totalDays, "day"));
  }
  if (Number.isInteger(totalHours) && totalHours >= 1) {
    return text(`${totalHours}小时`, plural(totalHours, "hour"));
  }
  return text(`${totalMinutes}分钟`, plural(totalMinutes, "minute"));
}

function formatTimestampForApproval(value: string | undefined, timeZone = APPROVAL_DISPLAY_TIMEZONE): string {
  const timestamp = parseTimestampMs(value);
  if (timestamp === undefined) {
    return value ?? text("未知", "Unknown");
  }

  try {
    const parts = new Intl.DateTimeFormat(localeForIntl(runtimeLocale), {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(timestamp));
    const values = parts.reduce<Record<string, string>>((output, part) => {
      if (part.type !== "literal") {
        output[part.type] = part.value;
      }
      return output;
    }, {});
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute} (${timeZone})`;
  } catch {
    return `${new Date(timestamp).toISOString()} (${timeZone})`;
  }
}

function resolveTemporaryGrantDurationMs(record: StoredApprovalRecord): number {
  const requestedAt = parseTimestampMs(record.requested_at) ?? Date.now();
  const expiresAt = parseTimestampMs(record.expires_at) ?? (requestedAt + (15 * 60 * 1000));
  return Math.max(60_000, expiresAt - requestedAt);
}

function formatApprovalGrantDuration(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
  return mode === "longterm"
    ? formatDurationMs(APPROVAL_LONG_GRANT_TTL_MS)
    : formatDurationMs(resolveTemporaryGrantDurationMs(record));
}

function formatCompactApprovalGrantDuration(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
  const durationMs = mode === "longterm"
    ? APPROVAL_LONG_GRANT_TTL_MS
    : resolveTemporaryGrantDurationMs(record);
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const totalHours = totalMinutes / 60;
  const totalDays = totalHours / 24;
  if (Number.isInteger(totalDays) && totalDays >= 1) {
    return text(`${totalDays}天`, `${totalDays}d`);
  }
  if (Number.isInteger(totalHours) && totalHours >= 1) {
    return text(`${totalHours}小时`, `${totalHours}h`);
  }
  return text(`${totalMinutes}分钟`, `${totalMinutes}m`);
}

function formatApprovalButtonLabel(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
  return `${text("批准", "Approve")} ${formatCompactApprovalGrantDuration(record, mode)}`;
}

function shouldResendPendingApproval(record: StoredApprovalRecord, nowMs = Date.now()): boolean {
  if (record.notifications.length === 0) {
    return true;
  }
  const latestSentAt = record.notifications
    .map((notification) => parseTimestampMs(notification.sent_at))
    .reduce<number | undefined>((latest, current) => {
      if (current === undefined) {
        return latest;
      }
      if (latest === undefined || current > latest) {
        return current;
      }
      return latest;
    }, undefined);
  const baseline = latestSentAt ?? parseTimestampMs(record.requested_at);
  if (baseline === undefined) {
    return true;
  }
  return nowMs - baseline >= APPROVAL_NOTIFICATION_RESEND_COOLDOWN_MS;
}

function mergeApprovalNotifications(
  existing: StoredApprovalNotification[],
  incoming: StoredApprovalNotification[],
): StoredApprovalNotification[] {
  if (incoming.length === 0) {
    return existing;
  }
  return [...existing, ...incoming].slice(-APPROVAL_NOTIFICATION_HISTORY_LIMIT);
}

function nowIsoString(): string {
  return new Date(Date.now()).toISOString();
}

function parseApprovalGrantMode(args: string | undefined): ApprovalGrantMode {
  const value = args?.trim();
  const mode = value ? value.split(/\s+/)[1]?.toLowerCase() : undefined;
  if (mode === "long" || mode === "longterm" || mode === "permanent" || mode === "长期") {
    return "longterm";
  }
  return "temporary";
}

function formatGrantModeLabel(mode: ApprovalGrantMode): string {
  return text(mode === "longterm" ? "长期授权" : "临时授权", mode === "longterm" ? "Long-lived grant" : "Temporary grant");
}

function resolveApprovalGrantExpiry(record: StoredApprovalRecord, mode: ApprovalGrantMode): string {
  if (mode === "longterm") {
    return new Date(Date.now() + APPROVAL_LONG_GRANT_TTL_MS).toISOString();
  }
  return new Date(Date.now() + resolveTemporaryGrantDurationMs(record)).toISOString();
}

type ChannelSendMessageFn = (
  to: string,
  text: string,
  opts?: Record<string, unknown>,
) => Promise<{ messageId?: string }>;

function resolveChannelLookupCandidates(channel: string): string[] {
  const normalized = channel.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const candidates = new Set<string>([normalized]);
  for (const alias of CHANNEL_LOOKUP_ALIASES[normalized] ?? []) {
    candidates.add(alias);
  }
  return Array.from(candidates);
}

function resolveChannelMethodSuffix(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  const override = CHANNEL_METHOD_SUFFIX_OVERRIDES[normalized];
  if (override) {
    return override;
  }
  return normalized
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function buildChannelMethodCandidates(channel: string): string[] {
  const suffix = resolveChannelMethodSuffix(channel);
  return [
    `sendMessage${suffix}`,
    `pushMessage${suffix}`,
    `postMessage${suffix}`,
    `send${suffix}`,
    `push${suffix}`,
    "sendMessage",
    "pushMessage",
  ];
}

function resolveDynamicChannelSender(
  api: OpenClawPluginApi,
  channel: string,
): ChannelSendMessageFn | undefined {
  const runtimeChannels = api.runtime.channel as unknown as Record<string, unknown>;
  for (const channelCandidate of resolveChannelLookupCandidates(channel)) {
    const channelClient = runtimeChannels[channelCandidate];
    if (!channelClient || typeof channelClient !== "object") {
      continue;
    }
    const methodNames = Array.from(new Set<string>([
      ...buildChannelMethodCandidates(channel),
      ...buildChannelMethodCandidates(channelCandidate),
    ]));
    for (const methodName of methodNames) {
      const candidate = (channelClient as Record<string, unknown>)[methodName];
      if (typeof candidate === "function") {
        return (to: string, text: string, opts?: Record<string, unknown>) =>
          (candidate as (to: string, text: string, opts?: Record<string, unknown>) => Promise<{ messageId?: string }>)
            .call(channelClient, to, text, opts);
      }
    }
  }
  return undefined;
}

type ChannelPluginSendTextFn = (ctx: {
  cfg: unknown;
  to: string;
  text: string;
  accountId?: string | null;
  threadId?: string | number | null;
}) => Promise<Record<string, unknown>>;

function resolveChannelPluginSendText(channel: string): ChannelPluginSendTextFn | undefined {
  if (typeof getChannelPluginCompat !== "function") {
    return undefined;
  }
  for (const channelCandidate of resolveChannelLookupCandidates(channel)) {
    const plugin = getChannelPluginCompat(channelCandidate) as {
      outbound?: {
        sendText?: ChannelPluginSendTextFn;
      };
    } | undefined;
    const sendText = plugin?.outbound?.sendText;
    if (typeof sendText === "function") {
      return sendText;
    }
  }
  return undefined;
}

type FeishuReceiveIdType = "chat_id" | "open_id" | "user_id";

type FeishuRuntimeConfig = {
  appId: string;
  appSecret: string;
  apiBase: string;
};

function feishuAsRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function feishuTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveFeishuSecretValue(value: unknown): string | undefined {
  const direct = feishuTrimmedString(value);
  if (direct) {
    return direct;
  }
  const record = feishuAsRecord(value);
  if (!record) {
    return undefined;
  }
  const source = feishuTrimmedString(record.source)?.toLowerCase();
  const id = feishuTrimmedString(record.id);
  if (source === "env" && id) {
    const envValue = feishuTrimmedString(process.env[id]);
    if (envValue) {
      return envValue;
    }
  }
  for (const key of ["value", "secret", "token", "text"]) {
    const candidate = feishuTrimmedString(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function resolveFeishuApiBase(domain: unknown): string {
  const domainValue = feishuTrimmedString(domain)?.replace(/\/+$/, "");
  if (!domainValue || domainValue.toLowerCase() === "feishu") {
    return FEISHU_DEFAULT_API_BASE;
  }
  if (domainValue.toLowerCase() === "lark") {
    return LARK_DEFAULT_API_BASE;
  }
  if (/^https?:\/\//i.test(domainValue)) {
    return domainValue;
  }
  return `https://${domainValue}`;
}

function resolveFeishuRuntimeConfig(
  api: OpenClawPluginApi,
  target: ChatApprovalTarget,
): FeishuRuntimeConfig | undefined {
  const configRoot = feishuAsRecord(api.config);
  const channels = feishuAsRecord(configRoot?.channels);
  const feishu = feishuAsRecord(channels?.feishu) ?? feishuAsRecord(channels?.lark);
  if (!feishu) {
    return undefined;
  }
  const accounts = feishuAsRecord(feishu.accounts);
  const pickAccount = (accountId: string | undefined): Record<string, unknown> | undefined => {
    if (!accounts || !accountId) {
      return undefined;
    }
    return feishuAsRecord(accounts[accountId]);
  };
  const explicitAccount = pickAccount(feishuTrimmedString(target.account_id));
  const defaultAccount = pickAccount(feishuTrimmedString(feishu.defaultAccount));
  const firstAccount = accounts
    ? feishuAsRecord(accounts[Object.keys(accounts).sort((left, right) => left.localeCompare(right))[0]])
    : undefined;
  const merged = {
    ...feishu,
    ...(explicitAccount ?? defaultAccount ?? firstAccount ?? {}),
  };

  const appId = resolveFeishuSecretValue(merged.appId);
  const appSecret = resolveFeishuSecretValue(merged.appSecret);
  if (!appId || !appSecret) {
    return undefined;
  }
  return {
    appId,
    appSecret,
    apiBase: resolveFeishuApiBase(merged.domain),
  };
}

function resolveFeishuReceiveTarget(rawTarget: string): { receiveId: string; receiveIdType: FeishuReceiveIdType } | undefined {
  const scoped = rawTarget.trim().replace(/^(feishu|lark):/i, "").trim();
  if (!scoped) {
    return undefined;
  }
  const lowered = scoped.toLowerCase();
  const stripPrefix = (prefix: string): string => scoped.slice(prefix.length).trim();
  if (lowered.startsWith("chat:")) {
    const receiveId = stripPrefix("chat:");
    return receiveId ? { receiveId, receiveIdType: "chat_id" } : undefined;
  }
  if (lowered.startsWith("group:")) {
    const receiveId = stripPrefix("group:");
    return receiveId ? { receiveId, receiveIdType: "chat_id" } : undefined;
  }
  if (lowered.startsWith("channel:")) {
    const receiveId = stripPrefix("channel:");
    return receiveId ? { receiveId, receiveIdType: "chat_id" } : undefined;
  }
  if (lowered.startsWith("open_id:")) {
    const receiveId = stripPrefix("open_id:");
    return receiveId ? { receiveId, receiveIdType: "open_id" } : undefined;
  }
  if (lowered.startsWith("user:")) {
    const receiveId = stripPrefix("user:");
    if (!receiveId) {
      return undefined;
    }
    return {
      receiveId,
      receiveIdType: receiveId.startsWith("ou_") ? "open_id" : "user_id",
    };
  }
  if (lowered.startsWith("dm:")) {
    const receiveId = stripPrefix("dm:");
    if (!receiveId) {
      return undefined;
    }
    return {
      receiveId,
      receiveIdType: receiveId.startsWith("ou_") ? "open_id" : "user_id",
    };
  }
  if (scoped.startsWith("oc_")) {
    return {
      receiveId: scoped,
      receiveIdType: "chat_id",
    };
  }
  if (scoped.startsWith("ou_")) {
    return {
      receiveId: scoped,
      receiveIdType: "open_id",
    };
  }
  return {
    receiveId: scoped,
    receiveIdType: "user_id",
  };
}

type FeishuApiResponse = {
  code?: number;
  msg?: string;
  message?: string;
  tenant_access_token?: string;
  data?: Record<string, unknown>;
};

async function parseFeishuJsonResponse(response: Response): Promise<FeishuApiResponse> {
  const payload = await response.json() as unknown;
  const record = feishuAsRecord(payload);
  if (!record) {
    throw new Error("feishu api returned non-object response");
  }
  return record as FeishuApiResponse;
}

function buildFeishuApiError(prefix: string, payload: FeishuApiResponse): Error {
  const code = payload.code ?? "unknown";
  const message = payload.msg ?? payload.message ?? "unknown";
  return new Error(`${prefix}: code=${code} msg=${message}`);
}

async function sendFeishuApprovalNotificationDirect(
  api: OpenClawPluginApi,
  target: ChatApprovalTarget,
  message: string,
): Promise<{ messageId?: string }> {
  const feishuConfig = resolveFeishuRuntimeConfig(api, target);
  if (!feishuConfig) {
    throw new Error("feishu credentials not configured for approval notification");
  }
  const receiveTarget = resolveFeishuReceiveTarget(target.to);
  if (!receiveTarget) {
    throw new Error(`invalid feishu approval target: ${target.to}`);
  }

  const authResponse = await fetch(`${feishuConfig.apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      app_id: feishuConfig.appId,
      app_secret: feishuConfig.appSecret,
    }),
    signal: AbortSignal.timeout(FEISHU_HTTP_TIMEOUT_MS),
  });
  const authPayload = await parseFeishuJsonResponse(authResponse);
  if (!authResponse.ok) {
    throw buildFeishuApiError(`feishu auth http_${authResponse.status}`, authPayload);
  }
  if (authPayload.code !== 0) {
    throw buildFeishuApiError("feishu auth failed", authPayload);
  }
  const token = feishuTrimmedString(authPayload.tenant_access_token);
  if (!token) {
    throw new Error("feishu auth failed: missing tenant_access_token");
  }

  const sendResponse = await fetch(
    `${feishuConfig.apiBase}/open-apis/im/v1/messages?receive_id_type=${receiveTarget.receiveIdType}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveTarget.receiveId,
        msg_type: "text",
        content: JSON.stringify({ text: message }),
      }),
      signal: AbortSignal.timeout(FEISHU_HTTP_TIMEOUT_MS),
    },
  );
  const sendPayload = await parseFeishuJsonResponse(sendResponse);
  if (!sendResponse.ok) {
    throw buildFeishuApiError(`feishu send http_${sendResponse.status}`, sendPayload);
  }
  if (sendPayload.code !== 0) {
    throw buildFeishuApiError("feishu send failed", sendPayload);
  }
  const messageId = feishuTrimmedString(sendPayload.data?.message_id);
  return messageId ? { messageId } : {};
}

async function sendApprovalNotification(
  api: OpenClawPluginApi,
  target: ChatApprovalTarget,
  message: string,
  record: StoredApprovalRecord,
): Promise<StoredApprovalNotification> {
  const notification: StoredApprovalNotification = {
    channel: target.channel,
    to: target.to,
    ...(target.account_id ? { account_id: target.account_id } : {}),
    ...(target.thread_id !== undefined ? { thread_id: target.thread_id } : {}),
  };

  if (target.channel === "telegram") {
    const sendTelegram = api.runtime.channel.telegram.sendMessageTelegram as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;

    const result = await sendTelegram(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
      ...(normalizeThreadId(target.thread_id) !== undefined ? { messageThreadId: normalizeThreadId(target.thread_id) } : {}),
      buttons: [
        [
          {
            text: formatApprovalButtonLabel(record, "temporary"),
            callback_data: `/${APPROVAL_APPROVE_COMMAND} ${record.approval_id}`,
            style: "success",
          },
          {
            text: formatApprovalButtonLabel(record, "longterm"),
            callback_data: `/${APPROVAL_APPROVE_COMMAND} ${record.approval_id} long`,
            style: "primary",
          },
        ],
        [
          {
            text: text("拒绝", "Reject"),
            callback_data: `/${APPROVAL_REJECT_COMMAND} ${record.approval_id}`,
            style: "danger",
          },
        ],
      ],
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "discord") {
    const sendDiscord = api.runtime.channel.discord.sendMessageDiscord as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendDiscord(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "slack") {
    const sendSlack = api.runtime.channel.slack.sendMessageSlack as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendSlack(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "signal") {
    const sendSignal = api.runtime.channel.signal.sendMessageSignal as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendSignal(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "imessage") {
    const sendIMessage = api.runtime.channel.imessage.sendMessageIMessage as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendIMessage(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "whatsapp") {
    const sendWhatsApp = api.runtime.channel.whatsapp.sendMessageWhatsApp as unknown as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await sendWhatsApp(target.to, message, {
      cfg: api.config,
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "line") {
    const pushLine = api.runtime.channel.line.pushMessageLine as (
      to: string,
      text: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ messageId?: string }>;
    const result = await pushLine(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  const sendDynamic = resolveDynamicChannelSender(api, target.channel);
  if (sendDynamic) {
    const threadId = normalizeThreadId(target.thread_id);
    const result = await sendDynamic(target.to, message, {
      cfg: api.config,
      ...(target.account_id ? { accountId: target.account_id } : {}),
      ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
    });
    if (result?.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  const sendPluginText = resolveChannelPluginSendText(target.channel);
  if (sendPluginText) {
    const result = await sendPluginText({
      cfg: api.config,
      to: target.to,
      text: message,
      ...(target.account_id ? { accountId: target.account_id } : {}),
      ...(target.thread_id !== undefined ? { threadId: target.thread_id } : {}),
    });
    const messageId = typeof result.messageId === "string" ? result.messageId : undefined;
    if (messageId) {
      notification.message_id = messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  if (target.channel === "feishu" || target.channel === "lark") {
    const result = await sendFeishuApprovalNotificationDirect(api, target, message);
    if (result.messageId) {
      notification.message_id = result.messageId;
    }
    notification.sent_at = nowIsoString();
    return notification;
  }

  const runtimeChannels = Object.keys((api.runtime.channel as unknown as Record<string, unknown>) ?? {});
  throw new Error(
    `unsupported approval notification channel: ${target.channel} (runtime channels: ${
      runtimeChannels.length > 0 ? runtimeChannels.join(", ") : "none"
    })`,
  );
}

async function notifyApprovalTargets(
  api: OpenClawPluginApi,
  targets: ChatApprovalTarget[],
  record: StoredApprovalRecord,
): Promise<ApprovalNotificationResult> {
  if (targets.length === 0) {
    return {
      sent: false,
      notifications: [],
    };
  }

  const notifications: StoredApprovalNotification[] = [];
  let sent = false;
  const prompt = formatApprovalPrompt(record);
  for (const target of targets) {
    let delivered = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= APPROVAL_NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
      try {
        const notification = await sendApprovalNotification(api, target, prompt, record);
        notifications.push(notification);
        sent = true;
        delivered = true;
        api.logger.info?.(
          `securityclaw: sent approval prompt approval_id=${record.approval_id} channel=${target.channel} to=${target.to} attempt=${attempt}${notification.message_id ? ` message_id=${notification.message_id}` : ""}`,
        );
        break;
      } catch (error) {
        lastError = error;
        if (attempt < APPROVAL_NOTIFICATION_MAX_ATTEMPTS) {
          api.logger.warn?.(
            `securityclaw: retrying approval prompt approval_id=${record.approval_id} channel=${target.channel} to=${target.to} attempt=${attempt} (${String(error)})`,
          );
          await sleep(APPROVAL_NOTIFICATION_RETRY_DELAYS_MS[attempt - 1] ?? APPROVAL_NOTIFICATION_RETRY_DELAYS_MS.at(-1) ?? 250);
        }
      }
    }
    if (!delivered) {
      api.logger.warn?.(
        `securityclaw: failed to send approval prompt approval_id=${record.approval_id} channel=${target.channel} to=${target.to} (${String(lastError)})`,
      );
    }
  }

  return { sent, notifications };
}

function formatApprovalBlockReason(params: {
  toolName: string;
  scope: string;
  traceId: string;
  resourceScope: ResourceScope;
  reasonCodes: string[];
  rules: string;
  approvalId: string;
  notificationSent: boolean;
}): string {
  const reasons = params.reasonCodes.join(", ");
  const notifyHint = params.notificationSent
    ? text(
      "已通知管理员，批准后可重试。",
      "Sent to admin. Retry after approval.",
    )
    : text(
      "通知失败，请将审批单交给管理员处理。",
      "Admin notification failed. Share the request ID with an approver.",
    );
  const lines = [
    text("SecurityClaw 需要审批", "SecurityClaw Approval Required"),
    `${text("工具", "Tool")}: ${params.toolName}`,
    `${text("范围", "Scope")}: ${params.scope}`,
    `${text("资源", "Resource")}: ${formatResourceScopeDetail(params.resourceScope)}`,
    `${text("原因", "Reason")}: ${reasons || text("策略要求复核", "Policy review required")}`,
    ...(params.rules && params.rules !== "-" ? [`${text("规则", "Policy")}: ${params.rules}`] : []),
    `${text("审批单", "Request ID")}: ${params.approvalId}`,
    `${text("状态", "Status")}: ${notifyHint}`,
    `${text("追踪", "Trace")}: ${params.traceId}`,
  ];
  return lines.join("\n");
}

function parseApprovalId(args: string | undefined): string | undefined {
  const value = args?.trim();
  return value ? value.split(/\s+/)[0] : undefined;
}

function resolvePluginRuntime(api: OpenClawPluginApi): ResolvedPluginRuntime {
  const pluginConfig = (api.pluginConfig ?? {}) as SecurityClawPluginConfig;
  const configPath = pluginConfig.configPath
    ? path.isAbsolute(pluginConfig.configPath)
      ? pluginConfig.configPath
      : path.resolve(PLUGIN_ROOT, pluginConfig.configPath)
    : path.resolve(PLUGIN_ROOT, "./config/policy.default.yaml");
  const dbPath = pluginConfig.dbPath
    ? path.isAbsolute(pluginConfig.dbPath)
      ? pluginConfig.dbPath
      : path.resolve(PLUGIN_ROOT, pluginConfig.dbPath)
    : path.resolve(PLUGIN_ROOT, "./runtime/securityclaw.db");
  const legacyOverridePath = pluginConfig.overridePath
    ? path.isAbsolute(pluginConfig.overridePath)
      ? pluginConfig.overridePath
      : path.resolve(PLUGIN_ROOT, pluginConfig.overridePath)
    : path.resolve(PLUGIN_ROOT, "./config/policy.overrides.json");
  return {
    configPath,
    dbPath,
    legacyOverridePath
  };
}

function createEventEmitter(config: SecurityClawConfig): EventEmitter {
  const sink = config.event_sink.webhook_url
    ? new HttpEventSink(config.event_sink.webhook_url, config.event_sink.timeout_ms)
    : undefined;
  return new EventEmitter(sink, config.event_sink.max_buffer, config.event_sink.retry_limit);
}

function applyPluginConfigOverrides(config: SecurityClawConfig, pluginConfig: SecurityClawPluginConfig): SecurityClawConfig {
  const webhookUrl = pluginConfig.webhookUrl ?? config.event_sink.webhook_url;
  return {
    ...config,
    policy_version: pluginConfig.policyVersion ?? config.policy_version,
    environment: pluginConfig.environment ?? config.environment,
    defaults: {
      ...config.defaults,
      approval_ttl_seconds: pluginConfig.approvalTtlSeconds ?? config.defaults.approval_ttl_seconds,
      persist_mode: pluginConfig.persistMode ?? config.defaults.persist_mode
    },
    event_sink: {
      ...config.event_sink,
      ...(webhookUrl !== undefined ? { webhook_url: webhookUrl } : {})
    },
    sensitivity: hydrateSensitivePathConfig(config.sensitivity)
  };
}

function buildRuntime(snapshot: LiveConfigSnapshot): RuntimeDependencies {
  return {
    config: snapshot.config,
    ruleEngine: new RuleEngine(snapshot.config.policies),
    decisionEngine: new DecisionEngine(snapshot.config),
    accountPolicyEngine: new AccountPolicyEngine(snapshot.override?.account_policies),
    dlpEngine: new DlpEngine(snapshot.config.dlp),
    emitter: createEventEmitter(snapshot.config),
    overrideLoaded: snapshot.overrideLoaded
  };
}

function toStatusConfig(config: SecurityClawConfig, overrideLoaded: boolean, resolved: ResolvedPluginRuntime) {
  return {
    environment: config.environment,
    policy_version: config.policy_version,
    policy_count: config.policies.length,
    config_path: resolved.configPath,
    strategy_db_path: resolved.dbPath,
    strategy_loaded: overrideLoaded,
    legacy_override_path: resolved.legacyOverridePath
  };
}

function buildDecisionContext(
  config: SecurityClawConfig,
  ctx: SecurityClawHookContext,
  toolName?: string,
  tags: string[] = [],
  resourceScope: ResourceScope = "none",
  resourcePaths: string[] = [],
  args?: unknown,
  toolArgsSummary?: string,
): DecisionContext {
  const workspace = "workspaceDir" in ctx ? ctx.workspaceDir : undefined;
  const runtimeScope = resolveScope({ workspaceDir: workspace, channelId: "channelId" in ctx ? ctx.channelId : undefined });
  const scope = config.environment || runtimeScope;
  const normalizedToolName = toolName ? normalizeToolName(toolName) : undefined;
  const derivedToolContext = deriveToolContext(normalizedToolName, args, resourceScope, resourcePaths, workspace);
  const effectiveToolName = derivedToolContext.inferredToolName ?? normalizedToolName;
  const mergedTags = [...new Set([...tags, ...derivedToolContext.tags, `resource_scope:${derivedToolContext.resourceScope}`])];
  const toolGroup = derivedToolContext.toolGroup;
  const operation = derivedToolContext.operation;
  const urlCandidates = args !== undefined ? collectUrlCandidates(args) : [];
  const destination = classifyDestination(urlCandidates);
  const fileType = inferFileType(derivedToolContext.resourcePaths);
  const summary = toolArgsSummary ?? (args !== undefined ? summarizeForLog(args, 240) : undefined);
  const labels = inferLabels(config, toolGroup, derivedToolContext.resourcePaths, summary);
  const volume = inferVolume(args, derivedToolContext.resourcePaths);

  return {
    actor_id: ctx.agentId ?? "unknown-agent",
    scope,
    ...(effectiveToolName !== undefined ? { tool_name: effectiveToolName } : {}),
    ...(toolGroup !== undefined ? { tool_group: toolGroup } : {}),
    ...(operation !== undefined ? { operation } : {}),
    tags: mergedTags,
    resource_scope: derivedToolContext.resourceScope,
    resource_paths: derivedToolContext.resourcePaths,
    ...(fileType !== undefined ? { file_type: fileType } : {}),
    asset_labels: labels.asset_labels,
    data_labels: labels.data_labels,
    trust_level: mergedTags.includes("untrusted") ? "untrusted" : "unknown",
    ...(destination.destination_type !== undefined ? { destination_type: destination.destination_type } : {}),
    ...(destination.dest_domain !== undefined ? { dest_domain: destination.dest_domain } : {}),
    ...(destination.dest_ip_class !== undefined ? { dest_ip_class: destination.dest_ip_class } : {}),
    ...(summary !== undefined ? { tool_args_summary: summary } : {}),
    volume,
    security_context: {
      trace_id: ctx.runId ?? ctx.sessionId ?? ctx.sessionKey ?? `trace-${Date.now()}`,
      actor_id: ctx.agentId ?? "unknown-agent",
      workspace: workspace ?? "unknown-workspace",
      policy_version: config.policy_version,
      untrusted: false,
      tags: mergedTags,
      created_at: new Date().toISOString()
    }
  };
}

function findingsToText(findings: DlpFinding[]): string {
  return findings.map((finding) => `${finding.pattern_name}@${finding.path}`).join(", ");
}

function emitEvent(
  emitter: EventEmitter,
  event: SecurityDecisionEvent,
  logger: OpenClawPluginApi["logger"],
): void {
  void emitter.emitSecurityEvent(event).catch((error) => {
    logger.warn?.(`securityclaw: failed to emit event (${String(error)})`);
  });
}

function createEvent(
  traceId: string,
  hook:
    | "before_prompt_build"
    | "before_tool_call"
    | "after_tool_call"
    | "tool_result_persist"
    | "message_sending",
  decision: "allow" | "warn" | "challenge" | "block",
  reasonCodes: string[],
  decisionSource?: DecisionSource,
  resourceScope?: ResourceScope,
): SecurityDecisionEvent {
  return {
    schema_version: "1.0",
    event_type: "SecurityDecisionEvent",
    trace_id: traceId,
    hook,
    decision,
    reason_codes: reasonCodes,
    latency_ms: 0,
    ts: new Date().toISOString(),
    ...(decisionSource !== undefined ? { decision_source: decisionSource } : {}),
    ...(resourceScope !== undefined ? { resource_scope: resourceScope } : {})
  };
}

function sanitizeUnknown<T>(dlpEngine: DlpEngine, value: T): { value: T; findings: DlpFinding[] } {
  const findings = dlpEngine.scan(value);
  if (findings.length === 0) {
    return { value, findings };
  }
  return {
    value: dlpEngine.sanitize(value, findings, "sanitize"),
    findings
  };
}

function summarizeForLog(value: unknown, maxLength: number): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) {
      return String(value);
    }
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}...(truncated)`;
  } catch {
    return "[unserializable]";
  }
}

function matchedRuleIds(matches: RuleMatch[]): string {
  if (matches.length === 0) {
    return "-";
  }
  return matches.map((match) => match.rule.rule_id).join(",");
}

function normalizeToolName(rawToolName: string): string {
  const tool = rawToolName.trim().toLowerCase();
  if (tool === "exec" || tool === "shell" || tool === "shell_exec") {
    return "shell.exec";
  }
  if (tool === "fs.list" || tool === "file.list") {
    return "filesystem.list";
  }
  return rawToolName;
}

function formatToolBlockReason(
  toolName: string,
  scope: string,
  traceId: string,
  decision: "challenge" | "block",
  decisionSource: DecisionSource,
  resourceScope: ResourceScope,
  reasonCodes: string[],
  rules: string,
): string {
  const reasons = reasonCodes.join(", ");
  const lines = [
    text(
      decision === "challenge" ? "SecurityClaw 需要审批" : "SecurityClaw 已阻止此操作",
      decision === "challenge" ? "SecurityClaw Approval Required" : "SecurityClaw Blocked",
    ),
    `${text("工具", "Tool")}: ${toolName}`,
    `${text("范围", "Scope")}: ${scope}`,
    `${text("资源", "Resource")}: ${formatResourceScopeDetail(resourceScope)}`,
    `${text("来源", "Source")}: ${decisionSource}`,
    `${text("原因", "Reason")}: ${reasons || text("策略要求复核", "Policy review required")}`,
    ...(rules && rules !== "-" ? [`${text("规则", "Policy")}: ${rules}`] : []),
    `${text("处理", "Action")}: ${text(
      decision === "challenge" ? "联系管理员审批后重试" : "联系安全管理员调整策略",
      decision === "challenge" ? "Contact an admin to approve and retry" : "Contact a security admin to adjust policy",
    )}`,
    `${text("追踪", "Trace")}: ${traceId}`,
  ];
  return lines.join("\n");
}

const plugin = {
  id: "securityclaw",
  name: "SecurityClaw Security",
  description: "Runtime policy enforcement, transcript sanitization, and audit events for OpenClaw.",
  register(api: OpenClawPluginApi) {
    const resolved = resolvePluginRuntime(api);
    const pluginConfig = (api.pluginConfig ?? {}) as SecurityClawPluginConfig;
    const adminConsoleUrl = resolveAdminConsoleUrl(pluginConfig);
    const stateDir = resolvePluginStateDir(api);
    runtimeLocale = resolveRuntimeLocale();
    const adminAutoStart = pluginConfig.adminAutoStart ?? true;
    const decisionLogMaxLength = pluginConfig.decisionLogMaxLength ?? 240;
    const statusPath = pluginConfig.statusPath
      ? path.isAbsolute(pluginConfig.statusPath)
        ? pluginConfig.statusPath
        : path.resolve(PLUGIN_ROOT, pluginConfig.statusPath)
      : path.resolve(PLUGIN_ROOT, "./runtime/securityclaw-status.json");
    const dbPath = resolved.dbPath;
    const statusStore = new RuntimeStatusStore({ snapshotPath: statusPath, dbPath });
    const liveConfig = new LiveConfigResolver({
      configPath: resolved.configPath,
      dbPath,
      legacyOverridePath: resolved.legacyOverridePath,
      logger: {
        info: (message: string) => api.logger.info?.(message),
        warn: (message: string) => api.logger.warn?.(message)
      },
      transform: (config: SecurityClawConfig) => applyPluginConfigOverrides(config, pluginConfig),
      onReload: (snapshot: LiveConfigSnapshot) => {
        statusStore.updateConfig(toStatusConfig(snapshot.config, snapshot.overrideLoaded, resolved));
        api.logger.info?.(
          `securityclaw: policy refresh env=${snapshot.config.environment} policy_version=${snapshot.config.policy_version} rules=${snapshot.config.policies.length}`,
        );
      }
    });
    let runtime = buildRuntime(liveConfig.getSnapshot());
    function getRuntime(): RuntimeDependencies {
      const snapshot = liveConfig.getSnapshot();
      if (snapshot.config !== runtime.config || snapshot.overrideLoaded !== runtime.overrideLoaded) {
        runtime = buildRuntime(snapshot);
      }
      return runtime;
    }

    statusStore.markBoot(toStatusConfig(runtime.config, runtime.overrideLoaded, resolved));
    const adminBuildPromise = ensureAdminAssetsBuilt({
      logger: {
        info: (message: string) => api.logger.info?.(`securityclaw: ${message}`)
      }
    }).catch((error) => {
      api.logger.warn?.(`securityclaw: failed to refresh admin bundle (${String(error)})`);
    });
    if (adminAutoStart) {
      const autoStartDecision = shouldAutoStartAdminServer(process.env);
      if (autoStartDecision.enabled) {
        const adminServerOptions = {
          configPath: resolved.configPath,
          legacyOverridePath: resolved.legacyOverridePath,
          statusPath,
          dbPath,
          unrefOnStart: true,
          logger: {
            info: (message: string) => api.logger.info?.(`securityclaw: ${message}`),
            warn: (message: string) => api.logger.warn?.(`securityclaw: ${message}`)
          },
          ...(pluginConfig.adminPort !== undefined ? { port: pluginConfig.adminPort } : {})
        };
        void adminBuildPromise
          .then(() => startAdminServer(adminServerOptions))
          .then((result) => {
            announceAdminConsole({
              locale: runtimeLocale,
              logger: {
                info: (message: string) => api.logger.info?.(`securityclaw: ${message}`),
                warn: (message: string) => api.logger.warn?.(`securityclaw: ${message}`),
              },
              stateDir,
              state: result.state,
              url: `http://127.0.0.1:${result.runtime.port}`,
            });
          })
          .catch((error) => {
            api.logger.warn?.(`securityclaw: failed to auto-start admin dashboard (${String(error)})`);
          });
	      } else {
	        if (shouldAnnounceAdminConsoleForArgv(process.argv)) {
	          announceAdminConsole({
	            locale: runtimeLocale,
	            logger: {
	              info: (message: string) => api.logger.info?.(`securityclaw: ${message}`),
	              warn: (message: string) => api.logger.warn?.(`securityclaw: ${message}`),
	            },
	            stateDir,
	            state: "service-command",
	            url: adminConsoleUrl,
	          });
	          api.logger.info?.("securityclaw: admin dashboard is hosted by the background OpenClaw gateway service");
	        } else {
	          api.logger.info?.(
	            `securityclaw: admin auto-start skipped in ${autoStartDecision.reason}; use npm run admin for standalone dashboard`,
	          );
	        }
	      }
	    } else {
      api.logger.info?.("securityclaw: admin auto-start disabled by config");
    }

    api.logger.info?.(
      `securityclaw: boot env=${runtime.config.environment} policy_version=${runtime.config.policy_version} dlp_mode=${runtime.config.dlp.on_dlp_hit} rules=${runtime.config.policies.length}`,
    );
    if (!runtime.config.event_sink.webhook_url) {
      api.logger.info?.("securityclaw: event sink disabled (webhook_url is empty), using logger-only observability");
    }

    function resolveApprovalBridge(current: RuntimeDependencies = getRuntime()): ResolvedApprovalBridge {
      return mergeApprovalBridgeConfig(deriveApprovalBridgeFromAdminPolicies(current.accountPolicyEngine));
    }
    const approvalStore = new ChatApprovalStore(dbPath);
    const initialApprovalBridge = resolveApprovalBridge(runtime);
    if (initialApprovalBridge.enabled) {
      api.logger.info?.(
        `securityclaw: approval bridge enabled targets=${initialApprovalBridge.targets.length} approvers=${initialApprovalBridge.approvers.length}`,
      );
      if (initialApprovalBridge.approvers.length === 0) {
        api.logger.warn?.("securityclaw: approval bridge is enabled but no approvers are configured");
      }
      api.logger.info?.("securityclaw: approval bridge source=account_policies_admin");
    }

    api.registerCommand({
      name: APPROVAL_APPROVE_COMMAND,
      description: "Approve a pending SecurityClaw request in the current admin chat.",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const approvalBridge = resolveApprovalBridge();
        const commandContext: SecurityClawApprovalCommandContext = {
          channel: ctx.channel,
          ...(ctx.senderId !== undefined ? { senderId: ctx.senderId } : {}),
          ...(ctx.from !== undefined ? { from: ctx.from } : {}),
          ...(ctx.to !== undefined ? { to: ctx.to } : {}),
          ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
          ...(ctx.args !== undefined ? { args: ctx.args } : {}),
          isAuthorizedSender: ctx.isAuthorizedSender,
        };
        if (!approvalBridge.enabled) {
          return { text: text("SecurityClaw 审批桥接未启用。", "SecurityClaw approval bridge is not enabled.") };
        }
        if (!commandContext.isAuthorizedSender || !matchesApprover(approvalBridge.approvers, commandContext)) {
          return { text: text("你无权审批 SecurityClaw 请求。", "You are not allowed to approve SecurityClaw requests.") };
        }
        const approvalId = parseApprovalId(commandContext.args);
        if (!approvalId) {
          return {
            text: text(
              `用法: /${APPROVAL_APPROVE_COMMAND} <approval_id> [long]`,
              `Usage: /${APPROVAL_APPROVE_COMMAND} <approval_id> [long]`,
            ),
          };
        }
        const existing = approvalStore.getById(approvalId);
        if (!existing) {
          return { text: text(`审批请求不存在: ${approvalId}`, `Approval request not found: ${approvalId}`) };
        }
        if (existing.status !== "pending") {
          return {
            text: text(
              `审批请求当前状态为 ${existing.status}，无法重复批准。`,
              `Approval request is ${existing.status}; it cannot be approved again.`,
            ),
          };
        }
        const grantMode = parseApprovalGrantMode(commandContext.args);
        const grantExpiresAt = resolveApprovalGrantExpiry(existing, grantMode);
        approvalStore.resolve(
          approvalId,
          `${commandContext.channel ?? "unknown"}:${commandContext.from ?? "unknown"}`,
          "approved",
          { expires_at: grantExpiresAt },
        );
        return {
          text: text(
            `已为 ${existing.actor_id} 添加${formatGrantModeLabel(grantMode)}，范围=${existing.scope}，有效期至 ${formatTimestampForApproval(grantExpiresAt)}。`,
            `${formatGrantModeLabel(grantMode)} granted for ${existing.actor_id}, scope=${existing.scope}, expires at ${formatTimestampForApproval(grantExpiresAt)}.`,
          ),
        };
      },
    });

    api.registerCommand({
      name: APPROVAL_REJECT_COMMAND,
      description: "Reject a pending SecurityClaw request in the current admin chat.",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const approvalBridge = resolveApprovalBridge();
        const commandContext: SecurityClawApprovalCommandContext = {
          channel: ctx.channel,
          ...(ctx.senderId !== undefined ? { senderId: ctx.senderId } : {}),
          ...(ctx.from !== undefined ? { from: ctx.from } : {}),
          ...(ctx.to !== undefined ? { to: ctx.to } : {}),
          ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
          ...(ctx.args !== undefined ? { args: ctx.args } : {}),
          isAuthorizedSender: ctx.isAuthorizedSender,
        };
        if (!approvalBridge.enabled) {
          return { text: text("SecurityClaw 审批桥接未启用。", "SecurityClaw approval bridge is not enabled.") };
        }
        if (!commandContext.isAuthorizedSender || !matchesApprover(approvalBridge.approvers, commandContext)) {
          return { text: text("你无权审批 SecurityClaw 请求。", "You are not allowed to approve SecurityClaw requests.") };
        }
        const approvalId = parseApprovalId(commandContext.args);
        if (!approvalId) {
          return { text: text(`用法: /${APPROVAL_REJECT_COMMAND} <approval_id>`, `Usage: /${APPROVAL_REJECT_COMMAND} <approval_id>`) };
        }
        const existing = approvalStore.getById(approvalId);
        if (!existing) {
          return { text: text(`审批请求不存在: ${approvalId}`, `Approval request not found: ${approvalId}`) };
        }
        if (existing.status !== "pending") {
          return {
            text: text(
              `审批请求当前状态为 ${existing.status}，无法重复拒绝。`,
              `Approval request is ${existing.status}; it cannot be rejected again.`,
            ),
          };
        }
        approvalStore.resolve(
          approvalId,
          `${commandContext.channel ?? "unknown"}:${commandContext.from ?? "unknown"}`,
          "rejected",
        );
        return {
          text: text(
            `已拒绝 ${approvalId}，不会为 ${existing.actor_id} 增加授权。`,
            `Rejected ${approvalId}. No grant was added for ${existing.actor_id}.`,
          ),
        };
      },
    });

    api.registerCommand({
      name: APPROVAL_PENDING_COMMAND,
      description: "List recent pending SecurityClaw approval requests.",
      acceptsArgs: false,
      requireAuth: false,
      handler: async (ctx) => {
        const approvalBridge = resolveApprovalBridge();
        const commandContext: SecurityClawApprovalCommandContext = {
          channel: ctx.channel,
          ...(ctx.senderId !== undefined ? { senderId: ctx.senderId } : {}),
          ...(ctx.from !== undefined ? { from: ctx.from } : {}),
          ...(ctx.to !== undefined ? { to: ctx.to } : {}),
          ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
          ...(ctx.args !== undefined ? { args: ctx.args } : {}),
          isAuthorizedSender: ctx.isAuthorizedSender,
        };
        if (!approvalBridge.enabled) {
          return { text: text("SecurityClaw 审批桥接未启用。", "SecurityClaw approval bridge is not enabled.") };
        }
        if (!commandContext.isAuthorizedSender || !matchesApprover(approvalBridge.approvers, commandContext)) {
          return {
            text: text(
              "你无权查看 SecurityClaw 待审批请求。",
              "You are not allowed to view pending SecurityClaw approvals.",
            ),
          };
        }
        return { text: formatPendingApprovals(approvalStore.listPending(10)) };
      },
    });

    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        const hookContext = ctx as SecurityClawHookContext;
        const current = getRuntime();
        const traceId = hookContext.runId ?? hookContext.sessionId ?? hookContext.sessionKey ?? `trace-${Date.now()}`;
        const scope = resolveScope({ workspaceDir: hookContext.workspaceDir, channelId: hookContext.channelId });
        const prependSystemContext = [
          "[SecurityClaw Security Context]",
          `trace_id=${traceId}`,
          `agent_id=${hookContext.agentId ?? "unknown-agent"}`,
          `scope=${scope}`,
          `policy_version=${current.config.policy_version}`
        ].join("\n");
        emitEvent(
          current.emitter,
          createEvent(traceId, "before_prompt_build", "allow", ["SECURITY_CONTEXT_INJECTED"]),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "before_prompt_build",
          trace_id: traceId,
          actor: hookContext.agentId ?? "unknown-agent",
          scope,
          decision: "allow",
          reasons: ["SECURITY_CONTEXT_INJECTED"]
        });
        return { prependSystemContext };
      },
      { priority: 100 },
    );

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        const hookContext = ctx as SecurityClawHookContext;
        const current = getRuntime();
        const approvalBridge = resolveApprovalBridge(current);
        const normalizedToolName = normalizeToolName(event.toolName);
        const rawArguments = event.params;
        const resource = extractResourceContext(rawArguments, hookContext.workspaceDir);
        const argsSummary = summarizeForLog(rawArguments, decisionLogMaxLength);
        const decisionContext = buildDecisionContext(
          current.config,
          hookContext,
          normalizedToolName,
          [],
          resource.resourceScope,
          resource.resourcePaths,
          rawArguments,
          argsSummary,
        );
        const matchedFileRule = matchFileRule(decisionContext.resource_paths, current.config.file_rules);
        const matches = matchedFileRule ? [] : current.ruleEngine.match(decisionContext);
        const rules = matchedFileRule ? `file_rule:${matchedFileRule.id}` : matchedRuleIds(matches);
        const outcome = matchedFileRule
          ? {
              decision: matchedFileRule.decision,
              decision_source: "file_rule" as const,
              reason_codes: matchedFileRule.reason_codes?.length
                ? [...matchedFileRule.reason_codes]
                : [defaultFileRuleReasonCode(matchedFileRule.decision)],
              matched_rules: [],
              ...(matchedFileRule.decision === "challenge"
                ? { challenge_ttl_seconds: current.config.defaults.approval_ttl_seconds }
                : {}),
            }
          : current.decisionEngine.evaluate(decisionContext, matches);
        const traceId = decisionContext.security_context.trace_id;
        const ruleIds = matchedFileRule ? [`file_rule:${matchedFileRule.id}`] : matches.map((match) => match.rule.rule_id);
        const effectiveToolName = decisionContext.tool_name ?? normalizedToolName ?? "unknown-tool";
        const approvalSubject = resolveApprovalSubject(hookContext);
        const accountPolicy = current.accountPolicyEngine.getPolicy(approvalSubject);
        const accountOverride = matchedFileRule ? undefined : current.accountPolicyEngine.evaluate(approvalSubject);
        const approvalRequestKey = createApprovalRequestKey({
          policy_version: current.config.policy_version,
          scope: decisionContext.scope,
          tool_name: effectiveToolName,
          resource_scope: decisionContext.resource_scope,
          resource_paths: [],
          params: {
            operation: decisionContext.operation ?? null,
            destination_type: decisionContext.destination_type ?? null,
            dest_domain: decisionContext.dest_domain ?? null,
            rule_ids: ruleIds,
          },
        });
        let effectiveDecision = accountOverride?.decision ?? outcome.decision;
        let effectiveDecisionSource = accountOverride?.decision_source ?? outcome.decision_source;
        let effectiveReasonCodes = [...(accountOverride?.reason_codes ?? outcome.reason_codes)];
        let approvalBlockReason: string | undefined;

        if (effectiveDecision === "challenge" && approvalBridge.enabled) {
          const approvalScope = decisionContext.scope;
          const approved = approvalStore.findApproved(approvalSubject, approvalRequestKey);
          if (approved) {
            effectiveDecision = "allow";
            effectiveDecisionSource = "approval";
            effectiveReasonCodes = ["APPROVAL_GRANTED"];
          } else {
            let pending = approvalStore.findPending(approvalSubject, approvalRequestKey);
            let notificationResult: ApprovalNotificationResult = {
              sent: Boolean(pending?.notifications.length),
              notifications: pending?.notifications ?? [],
            };

            if (!pending) {
              pending = approvalStore.create({
                request_key: approvalRequestKey,
                session_scope: approvalSubject,
                expires_at: new Date(
                  Date.now() +
                    ((outcome.challenge_ttl_seconds ?? current.config.defaults.approval_ttl_seconds) * 1000),
                ).toISOString(),
                policy_version: current.config.policy_version,
                actor_id: approvalSubject,
                scope: approvalScope,
                tool_name: effectiveToolName,
                resource_scope: decisionContext.resource_scope,
                resource_paths: decisionContext.resource_paths,
                reason_codes: outcome.reason_codes,
                rule_ids: ruleIds,
                args_summary: argsSummary,
              });
            }

            if (approvalBridge.targets.length > 0 && shouldResendPendingApproval(pending)) {
              notificationResult = await notifyApprovalTargets(api, approvalBridge.targets, pending);
              if (notificationResult.notifications.length > 0) {
                pending =
                  approvalStore.updateNotifications(
                    pending.approval_id,
                    mergeApprovalNotifications(pending.notifications, notificationResult.notifications),
                  ) ?? pending;
              }
            }

            approvalBlockReason = formatApprovalBlockReason({
              toolName: event.toolName,
              scope: decisionContext.scope,
              traceId,
              resourceScope: decisionContext.resource_scope,
              reasonCodes: outcome.reason_codes,
              rules,
              approvalId: pending.approval_id,
              notificationSent: notificationResult.sent || pending.notifications.length > 0,
            });
          }
        }

	        const decisionLog = [
	          "securityclaw: before_tool_call",
	          `trace_id=${traceId}`,
	          `actor=${approvalSubject}`,
	          `scope=${decisionContext.scope}`,
	          `resource_scope=${decisionContext.resource_scope}`,
	          `paths=${decisionContext.resource_paths.length > 0 ? trimText(decisionContext.resource_paths.slice(0, 3).join("|"), 200) : "-"}`,
	          `asset_labels=${decisionContext.asset_labels.length > 0 ? decisionContext.asset_labels.join(",") : "-"}`,
	          `data_labels=${decisionContext.data_labels.length > 0 ? decisionContext.data_labels.join(",") : "-"}`,
	          `tool=${effectiveToolName}`,
	          `raw_tool=${event.toolName}`,
	          `decision=${effectiveDecision}`,
          `source=${effectiveDecisionSource}`,
          `account_mode=${accountPolicy?.mode ?? "apply_rules"}`,
          `is_admin=${accountPolicy?.is_admin === true}`,
          `rules=${rules}`,
          `reasons=${effectiveReasonCodes.join(",")}`,
          `args=${argsSummary}`
        ].join(" ");

        if (effectiveDecision === "allow") {
          api.logger.info?.(decisionLog);
        } else {
          api.logger.warn?.(decisionLog);
        }

        emitEvent(
          current.emitter,
          createEvent(
            traceId,
            "before_tool_call",
            effectiveDecision,
            effectiveReasonCodes,
            effectiveDecisionSource,
            decisionContext.resource_scope,
          ),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "before_tool_call",
          trace_id: traceId,
          actor: approvalSubject,
          scope: decisionContext.scope,
          tool: effectiveToolName,
          decision: effectiveDecision,
          decision_source: effectiveDecisionSource,
          resource_scope: decisionContext.resource_scope,
          reasons: effectiveReasonCodes,
          rules
        });

        if (effectiveDecision === "block") {
          return {
            block: true,
            blockReason: formatToolBlockReason(
              event.toolName,
              decisionContext.scope,
              traceId,
              effectiveDecision,
              effectiveDecisionSource,
              decisionContext.resource_scope,
              effectiveReasonCodes,
              rules,
            )
          };
        }

        if (effectiveDecision === "challenge") {
          return {
            block: true,
            blockReason:
              approvalBlockReason ??
              formatToolBlockReason(
                event.toolName,
                decisionContext.scope,
                traceId,
                effectiveDecision,
                effectiveDecisionSource,
                decisionContext.resource_scope,
                effectiveReasonCodes,
                rules,
              )
          };
        }

        return undefined;
      },
      { priority: 100 },
    );

    api.on("after_tool_call", async (event, ctx) => {
      const current = getRuntime();
      const decisionContext = buildDecisionContext(current.config, ctx, event.toolName);
      const traceId = decisionContext.security_context.trace_id;
      const findings = current.dlpEngine.scan(event.result);
      const decision =
        findings.length === 0 ? "allow" : current.config.dlp.on_dlp_hit === "block" ? "block" : "warn";
      if (findings.length > 0) {
        api.logger.warn?.(
          `securityclaw: after_tool_call findings tool=${event.toolName} findings=${findingsToText(findings)}`,
        );
      }
      emitEvent(
        current.emitter,
        createEvent(
          traceId,
          "after_tool_call",
          decision,
          findings.length > 0 ? ["DLP_HIT"] : ["RESULT_OK"],
        ),
        api.logger,
      );
      statusStore.recordDecision({
        ts: new Date().toISOString(),
        hook: "after_tool_call",
        trace_id: traceId,
        actor: decisionContext.actor_id,
        scope: decisionContext.scope,
        tool: event.toolName,
        decision,
        reasons: findings.length > 0 ? ["DLP_HIT"] : ["RESULT_OK"]
      });
    });

    api.on(
      "tool_result_persist",
      (event) => {
        const current = getRuntime();
        const traceId = event.toolCallId ?? event.toolName ?? `trace-${Date.now()}`;
        const sanitized = sanitizeUnknown(current.dlpEngine, event.message);
        if (sanitized.findings.length === 0) {
          emitEvent(
            current.emitter,
            createEvent(traceId, "tool_result_persist", "allow", ["PERSIST_OK"]),
            api.logger,
          );
          if (event.toolName !== undefined) {
            statusStore.recordDecision({
              ts: new Date().toISOString(),
              hook: "tool_result_persist",
              trace_id: traceId,
              tool: event.toolName,
              decision: "allow",
              reasons: ["PERSIST_OK"]
            });
          } else {
            statusStore.recordDecision({
              ts: new Date().toISOString(),
              hook: "tool_result_persist",
              trace_id: traceId,
              decision: "allow",
              reasons: ["PERSIST_OK"]
            });
          }
          return undefined;
        }
        emitEvent(
          current.emitter,
          createEvent(
            traceId,
            "tool_result_persist",
            current.config.defaults.persist_mode === "strict" ? "block" : "warn",
            ["PERSIST_SANITIZED"],
          ),
          api.logger,
        );
        if (event.toolName !== undefined) {
          statusStore.recordDecision({
            ts: new Date().toISOString(),
            hook: "tool_result_persist",
            trace_id: traceId,
            tool: event.toolName,
            decision: current.config.defaults.persist_mode === "strict" ? "block" : "warn",
            reasons: ["PERSIST_SANITIZED"]
          });
        } else {
          statusStore.recordDecision({
            ts: new Date().toISOString(),
            hook: "tool_result_persist",
            trace_id: traceId,
            decision: current.config.defaults.persist_mode === "strict" ? "block" : "warn",
            reasons: ["PERSIST_SANITIZED"]
          });
        }
        api.logger.warn?.(
          `securityclaw: tool_result_persist trace_id=${traceId} tool=${event.toolName} decision=${current.config.defaults.persist_mode === "strict" ? "block" : "warn"} findings=${findingsToText(sanitized.findings)}`,
        );
        return { message: sanitized.value };
      },
      { priority: 100 },
    );

    api.on(
      "before_message_write",
      (event) => {
        const current = getRuntime();
        if (current.config.defaults.persist_mode !== "strict") {
          return undefined;
        }
        const findings = current.dlpEngine.scan(event.message);
        if (findings.length === 0) {
          return undefined;
        }
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "before_message_write",
          trace_id: `before-write-${Date.now()}`,
          decision: "block",
          reasons: ["PERSIST_BLOCKED_DLP"]
        });
        api.logger.warn?.(
          `securityclaw: before_message_write blocked findings=${findingsToText(findings)}`,
        );
        return { block: true };
      },
      { priority: 100 },
    );

    api.on(
      "message_sending",
      async (event, ctx) => {
        const current = getRuntime();
        const traceId = ctx.conversationId ?? ctx.accountId ?? `trace-${Date.now()}`;
        const sanitized = sanitizeUnknown(current.dlpEngine, event.content);
        if (sanitized.findings.length === 0) {
          emitEvent(
            current.emitter,
            createEvent(traceId, "message_sending", "allow", ["MESSAGE_OK"]),
            api.logger,
          );
          statusStore.recordDecision({
            ts: new Date().toISOString(),
            hook: "message_sending",
            trace_id: traceId,
            decision: "allow",
            reasons: ["MESSAGE_OK"]
          });
          return undefined;
        }
        const decision = current.config.dlp.on_dlp_hit === "block" ? "block" : "warn";
        emitEvent(
          current.emitter,
          createEvent(traceId, "message_sending", decision, ["MESSAGE_SANITIZED"]),
          api.logger,
        );
        statusStore.recordDecision({
          ts: new Date().toISOString(),
          hook: "message_sending",
          trace_id: traceId,
          decision,
          reasons: ["MESSAGE_SANITIZED"]
        });
        api.logger.warn?.(
          `securityclaw: message_sending trace_id=${traceId} decision=${decision} findings=${findingsToText(sanitized.findings)}`,
        );
        if (current.config.dlp.on_dlp_hit === "block") {
          return { cancel: true };
        }
        return { content: sanitized.value as string };
      },
      { priority: 100 },
    );

    api.on(
      "gateway_stop",
      async () => {
        approvalStore.close();
        statusStore.close();
        liveConfig.close();
      },
      { priority: 100 },
    );

    api.logger.info?.(`securityclaw: loaded policy_version=${runtime.config.policy_version}`);
  }
};

export default plugin;
