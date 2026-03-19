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
  if (asArray(channel.groupAllowFrom).length > 0) {
    return true;
  }
  const groups = asRecord(channel.groups);
  return Object.entries(groups)
    .filter(([groupId]) => groupId !== "*")
    .some(([, value]) => {
      const entry = asRecord(value);
      return readBoolean(entry.allow) === true || asArray(entry.allowFrom).length > 0;
    });
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
      title: text(locale, "gateway 基础配置", "Gateway baseline"),
      summary: text(
        locale,
        "公开绑定和 token 鉴权都在同一层入口上，适合一起检查。",
        "Public bind and token authentication live at the same entry layer and should be reviewed together.",
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

  const channels = asRecord(config.channels);
  for (const [channelId, rawChannel] of Object.entries(channels)) {
    const channel = asRecord(rawChannel);
    if (Object.keys(channel).length === 0 || !isChannelEnabled(channel)) {
      continue;
    }

    const label = channelLabel(channelId, locale);
    const dmPolicy = readString(channel.dmPolicy);
    const groupPolicy = readString(channel.groupPolicy);
    const mentionRequired = readChannelWildcardRequireMention(channel);
    const allowlistAvailable = hasEffectiveAllowlist(channel);
    const channelGroupId = ensureGroup("channel", channelId).id;
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
        configPaths: [`channels.${channelId}.dmPolicy`],
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
        configPaths: [`channels.${channelId}.dmPolicy`],
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
        configPaths: [`channels.${channelId}.groupPolicy`],
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
        configPaths: [`channels.${channelId}.groupPolicy`],
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
          currentSummary: text(locale, "requireMention 未开启", "requireMention is not enabled"),
          recommendationSummary: text(locale, "默认要求先 @ 机器人", "Require mentioning the bot before it replies"),
          configPaths: [`channels.${channelId}.groups.*.requireMention`],
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
          summary: text(locale, "requireMention=true", "requireMention=true"),
          configPaths: [`channels.${channelId}.groups.*.requireMention`],
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
          configPaths: [`channels.${channelId}.groupPolicy`, `channels.${channelId}.groupAllowFrom`],
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
          summary: text(locale, "群或成员白名单已配置", "Group or sender allowlists are configured"),
          configPaths: [`channels.${channelId}.groupPolicy`, `channels.${channelId}.groupAllowFrom`],
        });
      }
    }
  }

  const toolProfile = readString(asRecord(config.tools).profile);
  const sandbox = asRecord(asRecord(asRecord(config.agents).defaults).sandbox);
  const sandboxMode = readString(sandbox.mode);
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

  if (isBrowserConfigured(config)) {
    const browserSandbox = asRecord(sandbox.browser);
    if (readBoolean(browserSandbox.enabled) !== true) {
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
