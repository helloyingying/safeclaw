import type { SecurityClawLocale } from "../i18n/locale.ts";
import { readClawGuardExemptionMap } from "./claw_guard_exemptions.ts";
import type {
  ClawGuardConfigSnapshot,
  ClawGuardExemptedFinding,
  ClawGuardFinding,
  ClawGuardFindingGroup,
  ClawGuardFindingGroupKind,
  ClawGuardFindingRelation,
  ClawGuardPassedItem,
  ClawGuardRepairChoice,
  ClawGuardSeverity,
} from "./claw_guard_types.ts";

const HIGH_RISK_TOOL_PROFILES = new Set(["coding"]);
const LOOPBACK_BINDS = new Set(["loopback", "localhost", "127.0.0.1", "::1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const REQUIRED_SANDBOX_DENY_TOKENS = ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"];
const WORKSPACE_PROMPT_GUARDRAILS = [
  {
    id: "prompt_injection",
    label: {
      "zh-CN": "提示注入防护",
      en: "prompt-injection guardrails",
    },
    patterns: [
      /prompt injection/i,
      /ignore (?:any|all|previous|prior) instructions/i,
      /treat all external content as untrusted data/i,
      /treat .*?(?:page|web|link|attachment|message).*? as untrusted/i,
      /directive-like instructions/i,
      /提示注入/,
      /忽略(?:任何|所有|之前|上文)指令/,
      /外部(?:页面|链接|附件|消息).{0,12}(?:不可信|视为不可信)/,
    ],
  },
  {
    id: "sensitive_paths",
    label: {
      "zh-CN": "敏感路径限制",
      en: "sensitive-path restrictions",
    },
    patterns: [
      /(\.ssh|secrets?\.json|auth-profiles\.json|credentials)/i,
      /~\/\.(?:ssh|gnupg|aws|config\/gh)\//i,
      /\*(?:key|secret|password|token|credential)\*/i,
      /\.(?:pem|p12)\b/i,
      /sensitive path/i,
      /sensitive file/i,
      /敏感路径/,
      /敏感文件/,
      /禁止.*(?:密钥|凭证|token|证书|\.ssh)/,
    ],
  },
  {
    id: "external_confirmation",
    label: {
      "zh-CN": "外发前确认",
      en: "confirmation before external send",
    },
    patterns: [
      /confirm before .*?(?:send|share|post|upload|publish)/i,
      /require confirmation before .*?(?:sending|sharing|posting)/i,
      /explicit user confirmation/i,
      /ask before acting externally/i,
      /sending\/uploading .* externally/i,
      /外发前确认/,
      /发送前确认/,
      /分享前确认/,
      /发布前确认/,
    ],
  },
  {
    id: "config_change_owner_only",
    label: {
      "zh-CN": "仅创建者可改配置",
      en: "creator-only config changes",
    },
    patterns: [
      /creator[- ]only/i,
      /owner[- ]only/i,
      /only the creator is allowed to query or modify system configurations/i,
      /requests from others .*?(?:rejected|reject)/i,
      /only .*?(?:creator|owner|admin).*?(?:change|edit|modify).*?(?:config|settings)/i,
      /(?:配置|设置).{0,10}(?:仅|只).{0,10}(?:创建者|所有者|管理员).{0,10}(?:修改|变更)/,
      /(?:创建者|所有者|管理员).{0,10}(?:才能|方可).{0,10}(?:修改|变更).{0,10}(?:配置|设置)/,
    ],
  },
] as const;
const CHANNEL_LABELS: Record<string, { "zh-CN": string; en: string }> = {
  telegram: { "zh-CN": "Telegram", en: "Telegram" },
  feishu: { "zh-CN": "飞书", en: "Feishu" },
  whatsapp: { "zh-CN": "WhatsApp", en: "WhatsApp" },
  signal: { "zh-CN": "Signal", en: "Signal" },
  imessage: { "zh-CN": "iMessage", en: "iMessage" },
  bluebubbles: { "zh-CN": "BlueBubbles", en: "BlueBubbles" },
  msteams: { "zh-CN": "Microsoft Teams", en: "Microsoft Teams" },
  zalo: { "zh-CN": "Zalo", en: "Zalo" },
  zalouser: { "zh-CN": "Zalo User", en: "Zalo User" },
  googlechat: { "zh-CN": "Google Chat", en: "Google Chat" },
  matrix: { "zh-CN": "Matrix", en: "Matrix" },
  discord: { "zh-CN": "Discord", en: "Discord" },
  slack: { "zh-CN": "Slack", en: "Slack" },
};

type ClawGuardBuildResult = {
  findings: ClawGuardFinding[];
  exempted: ClawGuardExemptedFinding[];
  groups: ClawGuardFindingGroup[];
  passed: ClawGuardPassedItem[];
};

type GroupDraft = {
  id: string;
  kind: ClawGuardFindingGroupKind;
  scopeType: "global" | "channel";
  scopeId?: string;
  title: string;
  summary: string;
  severity: ClawGuardSeverity;
  configPaths: Set<string>;
  childFindingIds: Set<string>;
  recommendedFindingId?: string;
};

type ConfiguredChannelSnapshot = {
  channelId: string;
  channel: Record<string, unknown>;
  basePath: string;
};

function text(locale: SecurityClawLocale, zhText: string, enText: string): string {
  return locale === "zh-CN" ? zhText : enText;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  return asArray(value)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function hasConfiguredSecret(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return false;
}

function channelLabel(channelId: string, locale: SecurityClawLocale): string {
  const entry = CHANNEL_LABELS[channelId];
  if (entry) {
    return entry[locale] || entry.en;
  }
  return channelId;
}

function isChannelEnabled(channel: Record<string, unknown>): boolean {
  const enabled = readBoolean(channel.enabled);
  return enabled !== false;
}

function buildFindingId(ruleId: string, scopeId?: string): string {
  return scopeId ? `${ruleId}::${scopeId}` : ruleId;
}

function buildGroupId(kind: ClawGuardFindingGroupKind, scopeId?: string): string {
  return scopeId ? `${kind}::${scopeId}` : kind;
}

function buildChoice(
  locale: SecurityClawLocale,
  id: string,
  zhLabel: string,
  enLabel: string,
  zhDescription: string,
  enDescription: string,
  options: Partial<ClawGuardRepairChoice> = {},
): ClawGuardRepairChoice {
  return {
    id,
    label: text(locale, zhLabel, enLabel),
    description: text(locale, zhDescription, enDescription),
    ...(options.recommended !== undefined ? { recommended: options.recommended } : {}),
    ...(options.disabled !== undefined ? { disabled: options.disabled } : {}),
    ...(options.disabledReason ? { disabledReason: options.disabledReason } : {}),
  };
}

function buildRelation(
  type: ClawGuardFindingRelation["type"],
  targetFindingId: string,
  choiceId?: string,
): ClawGuardFindingRelation {
  return {
    type,
    targetFindingId,
    ...(choiceId ? { choiceId } : {}),
  };
}

function severityRank(severity: ClawGuardSeverity): number {
  if (severity === "critical") return 0;
  if (severity === "high") return 1;
  if (severity === "medium") return 2;
  return 3;
}

function compareFindings(left: ClawGuardFinding, right: ClawGuardFinding): number {
  return severityRank(left.severity) - severityRank(right.severity) || left.title.localeCompare(right.title, "en-US");
}

function comparePassed(left: ClawGuardPassedItem, right: ClawGuardPassedItem): number {
  return left.title.localeCompare(right.title, "en-US");
}

function compareGroups(left: ClawGuardFindingGroup, right: ClawGuardFindingGroup): number {
  return severityRank(left.severity) - severityRank(right.severity) || left.title.localeCompare(right.title, "en-US");
}

function maxSeverity(left: ClawGuardSeverity, right: ClawGuardSeverity): ClawGuardSeverity {
  return severityRank(left) <= severityRank(right) ? left : right;
}

function sortConfigPaths(paths: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(paths).filter(Boolean))).sort((left, right) => left.localeCompare(right, "en-US"));
}

function hasRestrictedAllowlistEntries(value: unknown): boolean {
  return readStringArray(value).some((entry) => entry !== "*");
}

function describePathList(paths: string[], limit = 4): string {
  if (paths.length === 0) {
    return "-";
  }
  if (paths.length <= limit) {
    return paths.join(", ");
  }
  return `${paths.slice(0, limit).join(", ")} +${paths.length - limit}`;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (LOOPBACK_HOSTS.has(normalized)) {
    return true;
  }
  return normalized.startsWith("127.");
}

type BrowserCdpEndpoint = {
  configPath: string;
  value: string;
  protocol: string;
  host: string;
  loopback: boolean;
};

function collectBrowserCdpEndpoints(config: Record<string, unknown>): BrowserCdpEndpoint[] {
  const browser = asRecord(config.browser);
  const endpoints: BrowserCdpEndpoint[] = [];

  function pushEndpoint(configPath: string, rawValue: unknown): void {
    const value = readString(rawValue);
    if (!value) {
      return;
    }
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
      endpoints.push({
        configPath,
        value,
        protocol: parsed.protocol,
        host,
        loopback: isLoopbackHost(host),
      });
    } catch {
      // Invalid browser config is surfaced elsewhere in OpenClaw itself.
    }
  }

  pushEndpoint("browser.cdpUrl", browser.cdpUrl);
  const profiles = asRecord(browser.profiles);
  for (const [profileId, rawProfile] of Object.entries(profiles)) {
    pushEndpoint(`browser.profiles.${profileId}.cdpUrl`, asRecord(rawProfile).cdpUrl);
  }

  return endpoints;
}

function readChannelWildcardRequireMention(channel: Record<string, unknown>): boolean {
  if (readBoolean(channel.requireMention) === true) {
    return true;
  }
  const groups = asRecord(channel.groups);
  const wildcard = asRecord(groups["*"]);
  if (readBoolean(wildcard.requireMention) === true) {
    return true;
  }

  const specificGroups = Object.entries(groups).filter(([groupId]) => groupId !== "*");
  if (specificGroups.length === 0) {
    return false;
  }
  return specificGroups.every(([, value]) => readBoolean(asRecord(value).requireMention) === true);
}

function hasEffectiveAllowlist(channel: Record<string, unknown>): boolean {
  if (hasRestrictedAllowlistEntries(channel.groupAllowFrom)) {
    return true;
  }
  const groups = asRecord(channel.groups);
  return Object.entries(groups)
    .filter(([groupId]) => groupId !== "*")
    .some(([, value]) => {
      const entry = asRecord(value);
      return readBoolean(entry.allow) === true || hasRestrictedAllowlistEntries(entry.allowFrom);
    });
}

function hasEffectiveDmAllowlist(channel: Record<string, unknown>): boolean {
  return hasRestrictedAllowlistEntries(channel.allowFrom);
}

function hasDiscordExplicitRequireMentionDisabled(channel: Record<string, unknown>): boolean {
  const guilds = asRecord(channel.guilds);
  return Object.values(guilds).some((rawGuild) => {
    const guild = asRecord(rawGuild);
    if (readBoolean(guild.requireMention) === false) {
      return true;
    }
    const channels = asRecord(guild.channels);
    return Object.values(channels).some((rawChannel) => readBoolean(asRecord(rawChannel).requireMention) === false);
  });
}

function hasDiscordGuildAllowlist(channel: Record<string, unknown>): boolean {
  const guilds = asRecord(channel.guilds);
  return Object.keys(guilds).some((guildId) => guildId.trim().length > 0);
}

function collectDiscordRequireMentionConfigPaths(channel: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const guilds = asRecord(channel.guilds);

  for (const [guildId, rawGuild] of Object.entries(guilds)) {
    if (!guildId.trim()) {
      continue;
    }
    const guild = asRecord(rawGuild);
    if (readBoolean(guild.requireMention) === false) {
      paths.push(`channels.discord.guilds.${guildId}.requireMention`);
    }

    const channels = asRecord(guild.channels);
    for (const [channelId, rawChannel] of Object.entries(channels)) {
      if (readBoolean(asRecord(rawChannel).requireMention) === false) {
        paths.push(`channels.discord.guilds.${guildId}.channels.${channelId}.requireMention`);
      }
    }
  }

  return paths;
}

function readChannelRequireMention(channelId: string, channel: Record<string, unknown>): boolean {
  if (channelId === "discord") {
    return !hasDiscordExplicitRequireMentionDisabled(channel);
  }
  return readChannelWildcardRequireMention(channel);
}

function readChannelAllowlist(channelId: string, channel: Record<string, unknown>): boolean {
  if (channelId === "discord") {
    return hasDiscordGuildAllowlist(channel);
  }
  return hasEffectiveAllowlist(channel);
}

function readChannelRequireMentionConfigPaths(channelId: string, basePath: string): string[] {
  if (channelId === "discord") {
    return [`${basePath}.guilds`];
  }
  return [`${basePath}.groups.*.requireMention`];
}

function readChannelAllowlistConfigPaths(channelId: string, basePath: string): string[] {
  if (channelId === "discord") {
    return [`${basePath}.groupPolicy`, `${basePath}.guilds`];
  }
  return [`${basePath}.groupPolicy`, `${basePath}.groupAllowFrom`];
}

function collectConfiguredChannels(config: Record<string, unknown>): ConfiguredChannelSnapshot[] {
  const snapshots: ConfiguredChannelSnapshot[] = [];
  const seen = new Set<string>();
  const append = (channelId: string, rawChannel: unknown, basePath: string) => {
    if (seen.has(channelId)) {
      return;
    }
    const channel = asRecord(rawChannel);
    if (Object.keys(channel).length === 0) {
      return;
    }
    seen.add(channelId);
    snapshots.push({ channelId, channel, basePath });
  };

  for (const [channelId, rawChannel] of Object.entries(asRecord(config.channels))) {
    append(channelId, rawChannel, `channels.${channelId}`);
  }

  for (const channelId of Object.keys(CHANNEL_LABELS)) {
    append(channelId, config[channelId], channelId);
  }

  return snapshots;
}

function collectSandboxToolPolicyGaps(config: Record<string, unknown>): {
  missingAllowlist: boolean;
  missingDenyTokens: string[];
} {
  const sandboxTools = asRecord(asRecord(asRecord(config.tools).sandbox).tools);
  const allow = readStringArray(sandboxTools.allow);
  const deny = new Set(readStringArray(sandboxTools.deny).map((value) => value.toLowerCase()));
  const missingDenyTokens = REQUIRED_SANDBOX_DENY_TOKENS.filter((token) => !deny.has(token.toLowerCase()));
  return {
    missingAllowlist: allow.length === 0,
    missingDenyTokens,
  };
}

function collectWorkspaceBootstrapAudit(snapshot: ClawGuardConfigSnapshot, locale: SecurityClawLocale): {
  needsFinding: boolean;
  currentSummary: string;
  recommendationSummary: string;
  configPaths: string[];
  passedSummary: string;
} {
  const workspace = snapshot.workspace;
  if (!workspace) {
    return {
      needsFinding: true,
      currentSummary: text(locale, "没有拿到 workspace bootstrap 文件上下文", "Workspace bootstrap context is unavailable"),
      recommendationSummary: text(
        locale,
        "确认 system tab 能读到当前 workspace 下的 SOUL.md，然后补上约束。",
        "Make sure the system tab can read SOUL.md from the active workspace, then add the required guardrails.",
      ),
      configPaths: ["workspace/SOUL.md"],
      passedSummary: "-",
    };
  }

  const combinedContent = workspace.soul.content || "";
  const missingFiles = [
    !workspace.soul.exists ? "SOUL.md" : "",
  ].filter(Boolean);
  const readErrors = [
    workspace.soul.readError ? `SOUL.md: ${workspace.soul.readError}` : "",
  ].filter(Boolean);
  const missingGuardrails = WORKSPACE_PROMPT_GUARDRAILS
    .filter((entry) => entry.patterns.every((pattern) => !pattern.test(combinedContent)))
    .map((entry) => entry.label[locale] || entry.label.en);
  const currentBits = [
    missingFiles.length > 0
      ? text(locale, `缺少文件: ${missingFiles.join(", ")}`, `Missing files: ${missingFiles.join(", ")}`)
      : "",
    readErrors.length > 0
      ? text(locale, `读取失败: ${readErrors.join("; ")}`, `Read errors: ${readErrors.join("; ")}`)
      : "",
    missingGuardrails.length > 0
      ? text(locale, `缺少约束: ${missingGuardrails.join("、")}`, `Missing guardrails: ${missingGuardrails.join(", ")}`)
      : "",
  ].filter(Boolean);

  return {
    needsFinding: currentBits.length > 0,
    currentSummary: currentBits.join("； ") || text(locale, "SOUL.md 已覆盖基础约束", "SOUL.md covers the baseline guardrails"),
    recommendationSummary: text(
      locale,
      "补上提示注入防护、敏感路径限制、外发前确认，以及仅创建者可修改配置的约束。",
      "Add prompt-injection guardrails, sensitive-path restrictions, confirmation before external send, and creator-only config-change rules.",
    ),
    configPaths: ["workspace/SOUL.md"],
    passedSummary: text(locale, "SOUL.md 已覆盖基础约束", "SOUL.md covers the baseline guardrails"),
  };
}

function isBrowserConfigured(config: Record<string, unknown>): boolean {
  const browser = asRecord(config.browser);
  if (Object.keys(browser).length === 0) {
    return false;
  }
  return readBoolean(browser.enabled) !== false || Object.keys(browser).length > 1;
}

function createGroupDraft(
  kind: ClawGuardFindingGroupKind,
  locale: SecurityClawLocale,
  scopeId?: string,
): GroupDraft {
  if (kind === "gateway") {
    return {
      id: buildGroupId("gateway"),
      kind,
      scopeType: "global",
      title: text(locale, "gateway 与运行时基础配置", "Gateway and runtime baseline"),
      summary: text(
        locale,
        "网络暴露面、服务发现和日志脱敏都在同一层运行时基线上，适合一起检查。",
        "Network exposure, service discovery, and log redaction sit on the same runtime baseline and should be reviewed together.",
      ),
      severity: "low",
      configPaths: new Set<string>(),
      childFindingIds: new Set<string>(),
    };
  }

  if (kind === "sandbox") {
    return {
      id: buildGroupId("sandbox"),
      kind,
      scopeType: "global",
      title: text(locale, "沙箱执行边界", "Sandbox execution boundary"),
      summary: text(
        locale,
        "普通沙箱和浏览器沙箱会一起决定执行边界。",
        "The standard sandbox and browser sandbox together define the execution boundary.",
      ),
      severity: "low",
      configPaths: new Set<string>(),
      childFindingIds: new Set<string>(),
    };
  }

  if (kind === "workspace") {
    return {
      id: buildGroupId("workspace"),
      kind,
      scopeType: "global",
      title: "SOUL.md",
      summary: text(
        locale,
        "SOUL.md 会直接影响系统提示和行为边界，适合单独审计。",
        "SOUL.md feeds directly into prompt/bootstrap behavior and should be audited on its own.",
      ),
      severity: "low",
      configPaths: new Set<string>(),
      childFindingIds: new Set<string>(),
    };
  }

  return {
    id: buildGroupId("channel", scopeId),
    kind,
    scopeType: "channel",
    ...(scopeId ? { scopeId } : {}),
    title: text(locale, `${channelLabel(scopeId || "-", locale)} 渠道入口`, `${channelLabel(scopeId || "-", locale)} channel access`),
    summary: text(
      locale,
      "同一渠道的私信入口、群入口和群内限制会互相影响，适合一起看。",
      "DM entry, group entry, and in-group limits on the same channel affect each other and should be reviewed together.",
    ),
    severity: "low",
    configPaths: new Set<string>(),
    childFindingIds: new Set<string>(),
  };
}

export function buildClawGuardFindings(
  snapshot: ClawGuardConfigSnapshot,
  locale: SecurityClawLocale,
): ClawGuardBuildResult {
  const findings: ClawGuardFinding[] = [];
  const exempted: ClawGuardExemptedFinding[] = [];
  const passed: ClawGuardPassedItem[] = [];
  const groups = new Map<string, GroupDraft>();
  const config = asRecord(snapshot.config);
  const exemptionByFindingId = readClawGuardExemptionMap(config);

  function ensureGroup(kind: ClawGuardFindingGroupKind, scopeId?: string): GroupDraft {
    const id = buildGroupId(kind, scopeId);
    const current = groups.get(id);
    if (current) {
      return current;
    }
    const next = createGroupDraft(kind, locale, scopeId);
    groups.set(id, next);
    return next;
  }

  function pickRecommendedFindingId(group: GroupDraft, finding: ClawGuardFinding): void {
    if (!group.recommendedFindingId) {
      group.recommendedFindingId = finding.id;
      return;
    }
    const current = findings.find((item) => item.id === group.recommendedFindingId);
    if (!current || severityRank(finding.severity) < severityRank(current.severity)) {
      group.recommendedFindingId = finding.id;
    }
  }

  function recordFinding(finding: ClawGuardFinding): void {
    const exemption = exemptionByFindingId.get(finding.id);
    if (exemption) {
      exempted.push({
        ...finding,
        exemption,
      });
      return;
    }

    findings.push(finding);
    const group = groups.get(finding.groupId);
    if (!group) {
      return;
    }
    group.severity = maxSeverity(group.severity, finding.severity);
    finding.configPaths.forEach((configPath) => group.configPaths.add(configPath));
    group.childFindingIds.add(finding.id);
    pickRecommendedFindingId(group, finding);
  }

  function recordPassed(item: ClawGuardPassedItem): void {
    passed.push(item);
  }

  const gateway = asRecord(config.gateway);
  const gatewayAuth = asRecord(gateway.auth);
  const bind = readString(gateway.bind);
  const authMode = readString(gatewayAuth.mode);
  const authToken = gatewayAuth.token;
  const gatewayGroupId = ensureGroup("gateway").id;

  if (bind && !LOOPBACK_BINDS.has(bind.toLowerCase())) {
    recordFinding({
      id: buildFindingId("gateway_public_bind"),
      ruleId: "gateway_public_bind",
      scopeType: "global",
      severity: "critical",
      title: text(locale, "gateway 当前不是 loopback 绑定", "Gateway is not bound to loopback"),
      summary: text(
        locale,
        "当前绑定会把 gateway 暴露到宿主机以外的网络面。",
        "The current bind exposes the gateway beyond the local host.",
      ),
      currentSummary: bind,
      recommendationSummary: text(locale, "改成 loopback", 'Set `gateway.bind` to `loopback`'),
      configPaths: ["gateway.bind"],
      repairKind: "direct",
      repairChoices: [],
      restartRequired: true,
      groupId: gatewayGroupId,
      relations: [
        buildRelation("related", buildFindingId("gateway_missing_token_auth")),
      ],
    });
  } else if (bind) {
    recordPassed({
      id: buildFindingId("gateway_public_bind"),
      title: text(locale, "gateway 已限制为 loopback", "Gateway is limited to loopback"),
      summary: bind,
      configPaths: ["gateway.bind"],
    });
  }

  if (authMode !== "token" || !hasConfiguredSecret(authToken)) {
    recordFinding({
      id: buildFindingId("gateway_missing_token_auth"),
      ruleId: "gateway_missing_token_auth",
      scopeType: "global",
      severity: "critical",
      title: text(locale, "gateway 没有启用 token 鉴权", "Gateway token authentication is not enabled"),
      summary: text(
        locale,
        "当前配置不能明确保证 gateway 只接受带 token 的请求。",
        "The current config does not clearly enforce token-based access to the gateway.",
      ),
      currentSummary: text(
        locale,
        `auth.mode=${authMode || "-"}` + (hasConfiguredSecret(authToken) ? "" : "，token 缺失"),
        `auth.mode=${authMode || "-"}` + (hasConfiguredSecret(authToken) ? "" : ", token missing"),
      ),
      recommendationSummary: text(
        locale,
        "启用 token 模式；缺 token 时自动生成一个随机 token",
        "Enable token mode and generate a random token when one is missing",
      ),
      configPaths: ["gateway.auth.mode", "gateway.auth.token"],
      repairKind: "direct",
      repairChoices: [],
      restartRequired: true,
      groupId: gatewayGroupId,
      relations: [
        buildRelation("related", buildFindingId("gateway_public_bind")),
      ],
    });
  } else {
    recordPassed({
      id: buildFindingId("gateway_missing_token_auth"),
      title: text(locale, "gateway 已启用 token 鉴权", "Gateway token authentication is enabled"),
      summary: text(locale, "mode=token，token 已配置", "mode=token, token configured"),
      configPaths: ["gateway.auth.mode", "gateway.auth.token"],
    });
  }

  const mdnsMode = readString(asRecord(asRecord(config.discovery).mdns).mode) || "minimal";
  if (mdnsMode !== "off") {
    recordFinding({
      id: buildFindingId("discovery_mdns_not_off"),
      ruleId: "discovery_mdns_not_off",
      scopeType: "global",
      severity: bind && !LOOPBACK_BINDS.has(bind.toLowerCase()) ? "high" : "medium",
      title: text(locale, "mDNS 广播没有关闭", "mDNS discovery is not turned off"),
      summary: text(
        locale,
        "当前还会在局域网广播 OpenClaw 服务信息，手册建议直接关闭。",
        "OpenClaw is still broadcasting service metadata on the local network. The hardening guide recommends turning it off.",
      ),
      currentSummary: `discovery.mdns.mode=${mdnsMode}`,
      recommendationSummary: text(locale, "改成 off", 'Set `discovery.mdns.mode` to `off`'),
      configPaths: ["discovery.mdns.mode"],
      repairKind: "direct",
      repairChoices: [],
      restartRequired: true,
      groupId: gatewayGroupId,
      relations: [
        buildRelation("related", buildFindingId("gateway_public_bind")),
      ],
    });
  } else {
    recordPassed({
      id: buildFindingId("discovery_mdns_not_off"),
      title: text(locale, "mDNS 广播已关闭", "mDNS discovery is turned off"),
      summary: "discovery.mdns.mode=off",
      configPaths: ["discovery.mdns.mode"],
    });
  }

  const logging = asRecord(config.logging);
  const redactSensitive = readString(logging.redactSensitive) || "tools";
  const redactPatterns = readStringArray(logging.redactPatterns);
  const hasRedactPatternsSetting = Object.prototype.hasOwnProperty.call(logging, "redactPatterns");
  if (redactSensitive === "off") {
    recordFinding({
      id: buildFindingId("logging_redaction_disabled"),
      ruleId: "logging_redaction_disabled",
      scopeType: "global",
      severity: "high",
      title: text(locale, "日志敏感信息脱敏已关闭", "Sensitive log redaction is disabled"),
      summary: text(
        locale,
        "当前日志和状态输出可能直接暴露 token、凭证或工具参数里的敏感字段。",
        "Logs and status output can currently expose tokens, credentials, or sensitive tool fields.",
      ),
      currentSummary: 'logging.redactSensitive="off"',
      recommendationSummary: text(locale, "改成 tools", 'Set `logging.redactSensitive` to `tools`'),
      configPaths: ["logging.redactSensitive"],
      repairKind: "direct",
      repairChoices: [],
      restartRequired: true,
      groupId: gatewayGroupId,
      relations: [],
    });
  } else {
    recordPassed({
      id: buildFindingId("logging_redaction_disabled"),
      title: text(locale, "日志敏感信息脱敏已开启", "Sensitive log redaction is enabled"),
      summary: `logging.redactSensitive=${redactSensitive}`,
      configPaths: ["logging.redactSensitive"],
    });
  }

  if (redactSensitive !== "off" && hasRedactPatternsSetting && redactPatterns.length === 0) {
    recordFinding({
      id: buildFindingId("logging_redact_patterns_missing"),
      ruleId: "logging_redact_patterns_missing",
      scopeType: "global",
      severity: "medium",
      title: text(locale, "日志没有补充自定义脱敏规则", "Logs have no custom redaction patterns"),
      summary: text(
        locale,
        "内置脱敏只能覆盖通用字段；业务侧 token、工单号或内部标识仍然建议补充到自定义规则里。",
        "Built-in redaction only covers common fields. Business-specific tokens, ticket IDs, or internal identifiers should still be added as custom rules.",
      ),
      currentSummary: text(locale, "logging.redactPatterns 为空", "logging.redactPatterns is empty"),
      recommendationSummary: text(
        locale,
        "补充业务侧 token、工单号或内部标识的正则脱敏规则",
        "Add custom regex redaction rules for business tokens, ticket IDs, and internal identifiers",
      ),
      configPaths: ["logging.redactPatterns"],
      repairKind: "read_only",
      repairChoices: [],
      restartRequired: true,
      groupId: gatewayGroupId,
      relations: [],
    });
  } else {
    recordPassed({
      id: buildFindingId("logging_redact_patterns_missing"),
      title: redactPatterns.length > 0
        ? text(locale, "日志已补充自定义脱敏规则", "Logs include custom redaction patterns")
        : text(locale, "日志使用默认脱敏规则集", "Logs use the default redaction set"),
      summary: redactPatterns.length > 0
        ? text(locale, `共 ${redactPatterns.length} 条规则`, `${redactPatterns.length} custom patterns`)
        : text(locale, "未额外配置 redactPatterns", "No extra redactPatterns configured"),
      configPaths: ["logging.redactPatterns"],
    });
  }

  const remoteCdpEndpoints = collectBrowserCdpEndpoints(config).filter((entry) => !entry.loopback);
  if (remoteCdpEndpoints.length > 0) {
    const hasInsecureProtocol = remoteCdpEndpoints.some((entry) => entry.protocol === "http:" || entry.protocol === "ws:");
    recordFinding({
      id: buildFindingId("browser_cdp_not_loopback"),
      ruleId: "browser_cdp_not_loopback",
      scopeType: "global",
      severity: hasInsecureProtocol ? "high" : "medium",
      title: text(locale, "浏览器 CDP 入口没有限制在本机", "Browser CDP is not limited to loopback"),
      summary: text(
        locale,
        "当前浏览器调试入口指向非 loopback 地址，等价于把浏览器控制面暴露到了更大的网络范围。",
        "Browser debugging is currently pointed at a non-loopback address, which exposes browser control to a broader network surface.",
      ),
      currentSummary: describePathList(remoteCdpEndpoints.map((entry) => `${entry.configPath}=${entry.value}`), 2),
      recommendationSummary: text(
        locale,
        "把 CDP 入口限制在 localhost/127.0.0.1/::1，或改走独立浏览器沙箱",
        "Keep CDP on localhost/127.0.0.1/::1, or route browser access through the dedicated browser sandbox",
      ),
      configPaths: remoteCdpEndpoints.map((entry) => entry.configPath),
      repairKind: "read_only",
      repairChoices: [],
      restartRequired: true,
      groupId: gatewayGroupId,
      relations: [
        buildRelation("related", buildFindingId("browser_sandbox_missing")),
      ],
    });
  } else if (collectBrowserCdpEndpoints(config).length > 0) {
    recordPassed({
      id: buildFindingId("browser_cdp_not_loopback"),
      title: text(locale, "浏览器 CDP 已限制在本机", "Browser CDP stays on loopback"),
      summary: text(locale, "所有已配置的 CDP 地址都在 loopback", "All configured CDP endpoints stay on loopback"),
      configPaths: collectBrowserCdpEndpoints(config).map((entry) => entry.configPath),
    });
  }

  const channels = collectConfiguredChannels(config);
  for (const { channelId, channel, basePath } of channels) {
    if (Object.keys(channel).length === 0 || !isChannelEnabled(channel)) {
      continue;
    }

    const label = channelLabel(channelId, locale);
    const dmPolicy = readString(channel.dmPolicy);
    const groupPolicy = readString(channel.groupPolicy);
    const mentionRequired = readChannelRequireMention(channelId, channel);
    const allowlistAvailable = readChannelAllowlist(channelId, channel);
    const dmAllowlistAvailable = hasEffectiveDmAllowlist(channel);
    const channelGroupId = ensureGroup("channel", channelId).id;
    const dmAllowlistFindingId = buildFindingId("dm_allowlist_missing", channelId);
    const groupPolicyFindingId = buildFindingId("group_policy_too_open", channelId);
    const requireMentionFindingId = buildFindingId("group_missing_require_mention", channelId);
    const allowlistFindingId = buildFindingId("group_missing_allowlist", channelId);

    if (dmPolicy === "open") {
      recordFinding({
        id: buildFindingId("dm_policy_too_open", channelId),
        ruleId: "dm_policy_too_open",
        scopeType: "channel",
        scopeId: channelId,
        severity: "high",
        title: text(locale, `${label} 私信入口对所有人开放`, `${label} direct messages are open to everyone`),
        summary: text(
          locale,
          "任意用户都可以直接从私信触发机器人。",
          "Any sender can trigger the bot directly in DMs.",
        ),
        currentSummary: "open",
        recommendationSummary: text(locale, "默认收紧到 pairing", 'Change `dmPolicy` to `pairing`'),
        configPaths: [`${basePath}.dmPolicy`],
        repairKind: "direct",
        repairChoices: [],
        restartRequired: true,
        groupId: channelGroupId,
        relations: [
          buildRelation("related", groupPolicyFindingId),
        ],
      });
    } else if (dmPolicy) {
      recordPassed({
        id: buildFindingId("dm_policy_too_open", channelId),
        title: text(locale, `${label} 私信入口没有对所有人开放`, `${label} DM access is not open to everyone`),
        summary: dmPolicy,
        configPaths: [`${basePath}.dmPolicy`],
      });
    }

    if (dmPolicy === "allowlist" && !dmAllowlistAvailable) {
      recordFinding({
        id: dmAllowlistFindingId,
        ruleId: "dm_allowlist_missing",
        scopeType: "channel",
        scopeId: channelId,
        severity: "high",
        title: text(locale, `${label} 私信 allowlist 为空`, `${label} DM allowlist is empty`),
        summary: text(
          locale,
          "当前私信模式已经切到 allowlist，但没有看到有效的 allowFrom 发送者白名单。",
          "DM access is already set to allowlist, but no effective sender allowlist is configured.",
        ),
        currentSummary: text(locale, "dmPolicy=allowlist，但 allowFrom 为空或只有 *", "dmPolicy=allowlist, but allowFrom is empty or only contains *"),
        recommendationSummary: text(locale, "补上 allowFrom；如果还没准备好，先改回 pairing", "Add allowFrom entries, or switch back to pairing until the allowlist is ready"),
        configPaths: [`${basePath}.dmPolicy`, `${basePath}.allowFrom`],
        repairKind: "direct",
        repairChoices: [],
        restartRequired: true,
        groupId: channelGroupId,
        relations: [
          buildRelation("related", buildFindingId("dm_policy_too_open", channelId)),
        ],
      });
    } else if (dmPolicy === "allowlist") {
      recordPassed({
        id: dmAllowlistFindingId,
        title: text(locale, `${label} 私信 allowlist 已生效`, `${label} DM allowlist is in effect`),
        summary: text(locale, "allowFrom 已配置", "allowFrom is configured"),
        configPaths: [`${basePath}.dmPolicy`, `${basePath}.allowFrom`],
      });
    }

    const allowlistChoiceDisabledReason = allowlistAvailable
      ? undefined
      : text(
          locale,
          "当前没有可直接复用的群白名单或成员 allowlist。",
          "No reusable group allowlist or sender allowlist is configured yet.",
        );
    const groupChoices = [
      buildChoice(
        locale,
        "disable_groups",
        "禁用群聊（推荐）",
        "Disable Groups (Recommended)",
        "直接把群聊入口关掉，默认最保守。",
        "Turn group access off completely. This is the safest default.",
        { recommended: true },
      ),
      buildChoice(
        locale,
        "use_allowlist",
        "切到 allowlist",
        "Switch to Allowlist",
        "保留群聊，但只允许现有白名单里的群或成员触发。",
        "Keep groups enabled, but allow only the groups or senders already on the allowlist.",
        allowlistChoiceDisabledReason
          ? { disabled: true, disabledReason: allowlistChoiceDisabledReason }
          : {},
      ),
    ];

    if (groupPolicy === "open") {
      recordFinding({
        id: groupPolicyFindingId,
        ruleId: "group_policy_too_open",
        scopeType: "channel",
        scopeId: channelId,
        severity: "high",
        title: text(locale, `${label} 群聊入口对所有成员开放`, `${label} group access is open to all members`),
        summary: text(
          locale,
          "当前群聊里任何成员都可能触发机器人。",
          "Any member in a group can trigger the bot right now.",
        ),
        currentSummary: "open",
        recommendationSummary: text(locale, "默认改为 disabled", 'Default fix: change `groupPolicy` to `disabled`'),
        configPaths: [`${basePath}.groupPolicy`],
        repairKind: "direct",
        repairChoices: groupChoices,
        defaultOptions: { choice: "disable_groups" },
        restartRequired: true,
        groupId: channelGroupId,
        relations: [
          buildRelation("choice_resolves", requireMentionFindingId, "disable_groups"),
          buildRelation("choice_resolves", allowlistFindingId, "disable_groups"),
          buildRelation("choice_resolves", allowlistFindingId, "use_allowlist"),
          buildRelation("related", requireMentionFindingId),
          buildRelation("related", allowlistFindingId),
        ],
      });
    } else if (groupPolicy) {
      recordPassed({
        id: groupPolicyFindingId,
        title: text(locale, `${label} 群聊入口不是完全开放`, `${label} group access is not fully open`),
        summary: groupPolicy,
        configPaths: [`${basePath}.groupPolicy`],
      });
    }

    if (groupPolicy && groupPolicy !== "disabled") {
      if (!mentionRequired) {
        recordFinding({
          id: requireMentionFindingId,
          ruleId: "group_missing_require_mention",
          scopeType: "channel",
          scopeId: channelId,
          severity: "medium",
          title: text(locale, `${label} 群聊当前没有要求 @ 机器人`, `${label} groups do not require mentioning the bot`),
          summary: text(
            locale,
            "普通群聊对话也可能触发机器人，噪声和误触发会更多。",
            "Regular group chatter can trigger the bot, which raises noise and accidental replies.",
          ),
          currentSummary: channelId === "discord"
            ? text(locale, "某些 guild 或 channel 显式关闭了 requireMention", "Some guild or channel entries explicitly set requireMention=false")
            : text(locale, "requireMention 未开启", "requireMention is not enabled"),
          recommendationSummary: text(locale, "默认要求先 @ 机器人", "Require mentioning the bot before it replies"),
          configPaths: channelId === "discord"
            ? collectDiscordRequireMentionConfigPaths(channel).length > 0
              ? collectDiscordRequireMentionConfigPaths(channel)
              : readChannelRequireMentionConfigPaths(channelId, basePath)
            : readChannelRequireMentionConfigPaths(channelId, basePath),
          repairKind: "direct",
          repairChoices: [],
          restartRequired: true,
          groupId: channelGroupId,
          relations: [
            buildRelation("related", groupPolicyFindingId),
            buildRelation("related", allowlistFindingId),
          ],
        });
      } else {
        recordPassed({
          id: requireMentionFindingId,
          title: text(locale, `${label} 群聊已要求 @ 机器人`, `${label} groups require mentioning the bot`),
          summary: channelId === "discord"
            ? text(locale, "Discord 默认 mention gating 生效", "Discord default mention gating is active")
            : text(locale, "requireMention=true", "requireMention=true"),
          configPaths: readChannelRequireMentionConfigPaths(channelId, basePath),
        });
      }

      if (!allowlistAvailable) {
        recordFinding({
          id: allowlistFindingId,
          ruleId: "group_missing_allowlist",
          scopeType: "channel",
          scopeId: channelId,
          severity: "high",
          title: text(locale, `${label} 群聊没有收紧到明确白名单`, `${label} group access is not narrowed to an explicit allowlist`),
          summary: text(
            locale,
            "当前看不到有效的群级白名单或群内成员 allowlist。",
            "No effective group allowlist or sender allowlist is configured.",
          ),
          currentSummary: text(locale, "群范围和群内触发人都没有收紧", "Neither groups nor group senders are narrowed"),
          recommendationSummary: text(
            locale,
            "推荐禁用群聊；若已有白名单，也可以切到 allowlist",
            "Recommended: disable groups. If you already have allowlists, switch to allowlist mode.",
          ),
          configPaths: readChannelAllowlistConfigPaths(channelId, basePath),
          repairKind: "guided",
          repairChoices: groupChoices,
          defaultOptions: { choice: "disable_groups" },
          restartRequired: true,
          groupId: channelGroupId,
          relations: [
            buildRelation("related", groupPolicyFindingId),
            buildRelation("related", requireMentionFindingId),
            buildRelation("choice_resolves", groupPolicyFindingId, "disable_groups"),
          ],
        });
      } else {
        recordPassed({
          id: allowlistFindingId,
          title: text(locale, `${label} 群聊已经有白名单约束`, `${label} group access already has allowlist controls`),
          summary: channelId === "discord"
            ? text(locale, "guild allowlist 已配置", "guild allowlist is configured")
            : text(locale, "群或成员白名单已配置", "Group or sender allowlists are configured"),
          configPaths: readChannelAllowlistConfigPaths(channelId, basePath),
        });
      }
    }
  }

  const toolProfile = readString(asRecord(config.tools).profile);
  const sandbox = asRecord(asRecord(asRecord(config.agents).defaults).sandbox);
  const sandboxMode = readString(sandbox.mode);
  const sandboxScope = readString(sandbox.scope) || "agent";
  const sandboxWorkspaceAccess = readString(sandbox.workspaceAccess) || "none";
  const browserSandbox = asRecord(sandbox.browser);
  const browserSandboxEnabled = readBoolean(browserSandbox.enabled) === true;
  const sandboxGroupId = ensureGroup("sandbox").id;
  if (HIGH_RISK_TOOL_PROFILES.has(toolProfile.toLowerCase())) {
    if (!sandboxMode || sandboxMode === "off") {
      recordFinding({
        id: buildFindingId("sandbox_disabled_for_high_risk_profile"),
        ruleId: "sandbox_disabled_for_high_risk_profile",
        scopeType: "global",
        severity: "high",
        title: text(locale, "高风险工具画像下没有启用普通沙箱", "High-risk tool profile does not use the standard sandbox"),
        summary: text(
          locale,
          "当前工具画像是 coding，但普通执行默认还在宿主机上。",
          "The active tool profile is coding, but execution still defaults to the host.",
        ),
        currentSummary: text(
          locale,
          `tools.profile=${toolProfile}，sandbox.mode=${sandboxMode || "off"}`,
          `tools.profile=${toolProfile}, sandbox.mode=${sandboxMode || "off"}`,
        ),
        recommendationSummary: text(locale, "默认启用 non-main 沙箱", 'Enable `agents.defaults.sandbox.mode = "non-main"`'),
        configPaths: ["tools.profile", "agents.defaults.sandbox.mode"],
        repairKind: "direct",
        repairChoices: [],
        restartRequired: true,
        groupId: sandboxGroupId,
        relations: [
          buildRelation("related", buildFindingId("browser_sandbox_missing")),
        ],
      });
    } else {
      recordPassed({
        id: buildFindingId("sandbox_disabled_for_high_risk_profile"),
        title: text(locale, "高风险工具画像已经启用普通沙箱", "High-risk tool profile already uses the standard sandbox"),
        summary: sandboxMode,
        configPaths: ["tools.profile", "agents.defaults.sandbox.mode"],
      });
    }
  }

  if (sandboxMode && sandboxMode !== "off") {
    if (sandboxWorkspaceAccess !== "none" || sandboxScope !== "session") {
      recordFinding({
        id: buildFindingId("sandbox_isolation_defaults_missing"),
        ruleId: "sandbox_isolation_defaults_missing",
        scopeType: "global",
        severity: "high",
        title: text(locale, "沙箱隔离边界还不够紧", "Sandbox isolation defaults are still too broad"),
        summary: text(
          locale,
          "当前沙箱还允许宿主 workspace 映射，或多个会话共享一个容器范围，不符合手册里的最小隔离建议。",
          "The sandbox still exposes host workspace access, or multiple sessions share one container scope. This is broader than the hardening guide's minimum isolation posture.",
        ),
        currentSummary: text(
          locale,
          `workspaceAccess=${sandboxWorkspaceAccess}，scope=${sandboxScope}`,
          `workspaceAccess=${sandboxWorkspaceAccess}, scope=${sandboxScope}`,
        ),
        recommendationSummary: text(
          locale,
          "默认改成 workspaceAccess=none、scope=session",
          'Set `workspaceAccess="none"` and `scope="session"`',
        ),
        configPaths: ["agents.defaults.sandbox.workspaceAccess", "agents.defaults.sandbox.scope"],
        repairKind: "direct",
        repairChoices: [],
        restartRequired: true,
        groupId: sandboxGroupId,
        relations: [
          buildRelation("related", buildFindingId("sandbox_tool_policy_too_permissive")),
        ],
      });
    } else {
      recordPassed({
        id: buildFindingId("sandbox_isolation_defaults_missing"),
        title: text(locale, "沙箱隔离边界已收紧", "Sandbox isolation defaults are tightened"),
        summary: text(locale, "workspaceAccess=none，scope=session", "workspaceAccess=none, scope=session"),
        configPaths: ["agents.defaults.sandbox.workspaceAccess", "agents.defaults.sandbox.scope"],
      });
    }

    const sandboxToolPolicyGaps = collectSandboxToolPolicyGaps(config);
    if (sandboxToolPolicyGaps.missingAllowlist || sandboxToolPolicyGaps.missingDenyTokens.length > 0) {
      const gapSummary = [
        sandboxToolPolicyGaps.missingAllowlist
          ? text(locale, "缺少 sandbox 工具 allowlist", "sandbox tool allowlist is missing")
          : "",
        sandboxToolPolicyGaps.missingDenyTokens.length > 0
          ? text(
              locale,
              `缺少 deny: ${sandboxToolPolicyGaps.missingDenyTokens.join(", ")}`,
              `missing deny entries: ${sandboxToolPolicyGaps.missingDenyTokens.join(", ")}`,
            )
          : "",
      ].filter(Boolean).join("； ");
      recordFinding({
        id: buildFindingId("sandbox_tool_policy_too_permissive"),
        ruleId: "sandbox_tool_policy_too_permissive",
        scopeType: "global",
        severity: HIGH_RISK_TOOL_PROFILES.has(toolProfile.toLowerCase()) ? "high" : "medium",
        title: text(locale, "沙箱里的工具范围还不够明确", "Sandbox tool policy is still too permissive"),
        summary: text(
          locale,
          "当前看不到足够明确的 sandbox 工具 allow/deny 约束，进入沙箱后的会话仍可能继承过宽的工具集。",
          "The sandbox does not have a sufficiently explicit allow/deny policy, so sandboxed sessions can still inherit an overly broad tool set.",
        ),
        currentSummary: gapSummary,
        recommendationSummary: text(
          locale,
          "为 tools.sandbox.tools 配置明确的 allowlist，并补上 runtime/fs/ui/nodes/cron/gateway 的 deny 约束。",
          "Add an explicit allowlist under tools.sandbox.tools and deny runtime/fs/ui/nodes/cron/gateway access inside the sandbox.",
        ),
        configPaths: ["tools.sandbox.tools.allow", "tools.sandbox.tools.deny"],
        repairKind: "read_only",
        repairChoices: [],
        restartRequired: true,
        groupId: sandboxGroupId,
        relations: [
          buildRelation("related", buildFindingId("sandbox_isolation_defaults_missing")),
        ],
      });
    } else {
      recordPassed({
        id: buildFindingId("sandbox_tool_policy_too_permissive"),
        title: text(locale, "沙箱工具范围已单独收紧", "Sandbox tool policy is explicitly narrowed"),
        summary: text(locale, "sandbox allow/deny 已配置", "sandbox allow/deny is configured"),
        configPaths: ["tools.sandbox.tools.allow", "tools.sandbox.tools.deny"],
      });
    }
  }

  if (isBrowserConfigured(config)) {
    if (!browserSandboxEnabled) {
      recordFinding({
        id: buildFindingId("browser_sandbox_missing"),
        ruleId: "browser_sandbox_missing",
        scopeType: "global",
        severity: "medium",
        title: text(locale, "浏览器能力已启用，但没有浏览器沙箱", "Browser capability is enabled without a browser sandbox"),
        summary: text(
          locale,
          "当前浏览器能力没有切到独立浏览器沙箱容器。",
          "Browser access is not routed through a dedicated browser sandbox container.",
        ),
        currentSummary: text(locale, "sandbox.browser.enabled 未开启", "sandbox.browser.enabled is not enabled"),
        recommendationSummary: text(
          locale,
          "启用浏览器沙箱；必要时同时补上普通沙箱模式",
          "Enable the browser sandbox and add a standard sandbox mode when needed",
        ),
        configPaths: ["browser", "agents.defaults.sandbox.browser.enabled", "agents.defaults.sandbox.mode"],
        repairKind: "guided",
        repairChoices: [],
        restartRequired: true,
        groupId: sandboxGroupId,
        relations: [
          buildRelation("choice_resolves", buildFindingId("sandbox_disabled_for_high_risk_profile")),
          buildRelation("related", buildFindingId("sandbox_disabled_for_high_risk_profile")),
        ],
      });
    } else {
      recordPassed({
        id: buildFindingId("browser_sandbox_missing"),
        title: text(locale, "浏览器能力已经走浏览器沙箱", "Browser capability already uses a browser sandbox"),
        summary: text(locale, "sandbox.browser.enabled=true", "sandbox.browser.enabled=true"),
        configPaths: ["browser", "agents.defaults.sandbox.browser.enabled"],
      });
    }
  }

  if (browserSandboxEnabled) {
    const browserPostureGaps = [
      readBoolean(browserSandbox.allowHostControl) === true
        ? text(locale, "allowHostControl=true", "allowHostControl=true")
        : "",
      readBoolean(browserSandbox.headless) !== true
        ? text(locale, "headless 未开启", "headless is not enabled")
        : "",
      readBoolean(browserSandbox.autoStart) === false
        ? text(locale, "autoStart=false", "autoStart=false")
        : "",
    ].filter(Boolean);

    if (browserPostureGaps.length > 0) {
      recordFinding({
        id: buildFindingId("sandbox_browser_posture_missing"),
        ruleId: "sandbox_browser_posture_missing",
        scopeType: "global",
        severity: "medium",
        title: text(locale, "浏览器沙箱姿态还不够稳妥", "Browser sandbox posture is not hardened enough"),
        summary: text(
          locale,
          "浏览器沙箱已经启用，但当前仍允许宿主控制、非 headless 调试，或禁用了自动拉起。",
          "The browser sandbox is enabled, but it still allows host control, runs without headless mode, or disables auto-start.",
        ),
        currentSummary: browserPostureGaps.join(text(locale, "； ", "; ")),
        recommendationSummary: text(
          locale,
          "建议保持 allowHostControl=false、headless=true、autoStart=true。",
          "Keep allowHostControl=false, headless=true, and autoStart=true.",
        ),
        configPaths: [
          "agents.defaults.sandbox.browser.allowHostControl",
          "agents.defaults.sandbox.browser.headless",
          "agents.defaults.sandbox.browser.autoStart",
        ],
        repairKind: "direct",
        repairChoices: [],
        restartRequired: true,
        groupId: sandboxGroupId,
        relations: [
          buildRelation("related", buildFindingId("browser_sandbox_missing")),
        ],
      });
    } else {
      recordPassed({
        id: buildFindingId("sandbox_browser_posture_missing"),
        title: text(locale, "浏览器沙箱姿态已按建议设置", "Browser sandbox posture matches the baseline"),
        summary: text(locale, "allowHostControl=false，headless=true，autoStart=true", "allowHostControl=false, headless=true, autoStart=true"),
        configPaths: [
          "agents.defaults.sandbox.browser.allowHostControl",
          "agents.defaults.sandbox.browser.headless",
          "agents.defaults.sandbox.browser.autoStart",
        ],
      });
    }
  }

  const workspaceAudit = collectWorkspaceBootstrapAudit(snapshot, locale);
  const workspaceGroupId = ensureGroup("workspace").id;
  if (workspaceAudit.needsFinding) {
    recordFinding({
      id: buildFindingId("workspace_bootstrap_guardrails_missing"),
      ruleId: "workspace_bootstrap_guardrails_missing",
      scopeType: "global",
      severity: "medium",
      title: text(locale, "SOUL.md 缺少系统约束", "SOUL.md is missing system guardrails"),
      summary: text(
        locale,
        "当前 SOUL.md 里缺少关键约束，提示注入、敏感路径和外发确认都可能只靠模型自己判断。",
        "SOUL.md is missing key guardrails, so prompt injection, sensitive paths, and external-send confirmation can be left to model judgment alone.",
      ),
      currentSummary: workspaceAudit.currentSummary,
      recommendationSummary: workspaceAudit.recommendationSummary,
      configPaths: workspaceAudit.configPaths,
      repairKind: "read_only",
      repairChoices: [],
      restartRequired: false,
      groupId: workspaceGroupId,
      relations: [],
    });
  } else {
    recordPassed({
      id: buildFindingId("workspace_bootstrap_guardrails_missing"),
      title: text(locale, "SOUL.md 已覆盖基础约束", "SOUL.md covers the baseline guardrails"),
      summary: workspaceAudit.passedSummary,
      configPaths: workspaceAudit.configPaths,
    });
  }

  return {
    findings: Array.from(findings).sort(compareFindings),
    exempted: Array.from(exempted).sort((left, right) => compareFindings(left, right)),
    groups: Array.from(groups.values())
      .filter((group) => group.childFindingIds.size > 0)
      .map((group) => ({
        id: group.id,
        kind: group.kind,
        scopeType: group.scopeType,
        ...(group.scopeId ? { scopeId: group.scopeId } : {}),
        title: group.title,
        summary: group.summary,
        severity: group.severity,
        configPaths: sortConfigPaths(group.configPaths),
        childFindingIds: Array.from(group.childFindingIds).sort((left, right) => left.localeCompare(right, "en-US")),
        ...(group.recommendedFindingId ? { recommendedFindingId: group.recommendedFindingId } : {}),
      }))
      .sort(compareGroups),
    passed: Array.from(passed).sort(comparePassed),
  };
}
