import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ResponsiveContainer,
  Cell,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  LineChart,
  Line
} from "recharts";

import {
  buildAdminDashboardSearch,
  readAdminDashboardUrlState
} from "../../src/admin/dashboard_url_state.ts";
import {
  createAccountPolicyDraftFromSession,
  DEFAULT_MAIN_ADMIN_SESSION_KEY,
  ensureDefaultAdminAccount,
  mergeAccountPoliciesWithSessions,
  pruneAccountPolicyOverrides,
} from "../../src/admin/account_catalog.ts";
import { canonicalizeAccountPolicies } from "../../src/domain/services/account_policy_engine.ts";
import { resolveSecurityClawLocale } from "../../src/i18n/locale.ts";

const REFRESH_INTERVAL_MS = 15000;
const DECISIONS_PER_PAGE = 12;
const ADMIN_LOCALE_STORAGE_KEY = "securityclaw.admin.locale";
const ADMIN_THEME_STORAGE_KEY = "securityclaw.admin.theme";
const ADMIN_DEFAULT_LOCALE = resolveSecurityClawLocale(
  typeof navigator !== "undefined" ? navigator.language : undefined,
  "en"
);
const ADMIN_DEFAULT_THEME_PREFERENCE = "system";
const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const ADMIN_THEME_OPTIONS = new Set(["system", "light", "dark"]);
const ADMIN_BRAND_TEXT = "SecurityClaw Admin";
let activeLocale = ADMIN_DEFAULT_LOCALE;

function ui(zhText, enText) {
  return activeLocale === "zh-CN" ? zhText : enText;
}

function readLocalized(map, key, fallback = "-") {
  if (!key) return fallback;
  const record = map[key];
  if (!record) return key || fallback;
  return record[activeLocale] || record.en || record["zh-CN"] || key || fallback;
}

function normalizeAdminThemePreference(value) {
  return ADMIN_THEME_OPTIONS.has(value) ? value : ADMIN_DEFAULT_THEME_PREFERENCE;
}

function readSystemTheme() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia(DARK_COLOR_SCHEME_QUERY).matches ? "dark" : "light";
}

function resolveAdminTheme(preference, systemTheme = readSystemTheme()) {
  const normalized = normalizeAdminThemePreference(preference);
  return normalized === "system" ? systemTheme : normalized;
}

function ToolbarIconSystem() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="11" rx="2.5" />
      <path d="M9 19h6" />
      <path d="M12 16v3" />
    </svg>
  );
}

function ToolbarIconSun() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5" />
      <path d="M12 19v2.5" />
      <path d="M4.5 12H2" />
      <path d="M22 12h-2.5" />
      <path d="M5.8 5.8 4 4" />
      <path d="M20 20l-1.8-1.8" />
      <path d="M18.2 5.8 20 4" />
      <path d="M4 20l1.8-1.8" />
    </svg>
  );
}

function ToolbarIconMoon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17 14.5A6.5 6.5 0 0 1 9.5 7a7.5 7.5 0 1 0 7.5 7.5Z" />
    </svg>
  );
}

function ToolbarMonogram({ text }) {
  return (
    <span className="toolbar-monogram" aria-hidden="true">
      {text}
    </span>
  );
}

const TAB_ITEMS = [
  {
    id: "overview"
  },
  {
    id: "accounts"
  },
  {
    id: "rules"
  },
  {
    id: "skills"
  },
  {
    id: "events"
  }
];

function tabLabel(tabId) {
  if (tabId === "overview") return ui("概览", "Overview");
  if (tabId === "accounts") return ui("账号", "Accounts");
  if (tabId === "rules") return ui("策略", "Strategy");
  if (tabId === "skills") return ui("Skill", "Skill");
  if (tabId === "events") return ui("拦截记录", "Interceptions");
  return tabId;
}

function decisionFilterLabel(filterId) {
  if (filterId === "all") return ui("全部", "All");
  if (filterId === "allow") return ui("放行", "Allow");
  if (filterId === "warn") return ui("提醒", "Warn");
  if (filterId === "challenge") return ui("需确认", "Needs Approval");
  if (filterId === "block") return ui("拦截", "Block");
  return filterId;
}

const DECISION_TEXT = {
  allow: { "zh-CN": "放行", en: "Allow" },
  warn: { "zh-CN": "提醒", en: "Warn" },
  challenge: { "zh-CN": "需确认", en: "Needs Approval" },
  block: { "zh-CN": "拦截", en: "Block" }
};
const DECISION_OPTIONS = ["allow", "warn", "challenge", "block"];
const CHART_PALETTES = {
  light: ["#1e4f94", "#2d66ab", "#3f7fc2", "#5f97d1", "#7badde", "#9dc3e8", "#c2dcf2", "#dbeaf8"],
  dark: ["#38bdf8", "#60a5fa", "#34d399", "#f59e0b", "#a78bfa", "#2dd4bf", "#fb7185", "#facc15"]
};

const CHART_THEME = {
  light: {
    grid: "#e7eef8",
    axis: "#c8d8eb",
    tick: "#5f748b",
    total: "#1e40af",
    risk: "#c03a4b"
  },
  dark: {
    grid: "rgba(148, 163, 184, 0.18)",
    axis: "rgba(148, 163, 184, 0.4)",
    tick: "#9fb2c7",
    total: "#60a5fa",
    risk: "#fb7185"
  }
};

const DECISION_SOURCE_TEXT = {
  rule: { "zh-CN": "规则命中", en: "Rule match" },
  file_rule: { "zh-CN": "目录例外", en: "Directory override" },
  default: { "zh-CN": "默认放行", en: "Default allow" },
  approval: { "zh-CN": "审批放行", en: "Approval grant" },
  account: { "zh-CN": "账号策略", en: "Account policy" }
};

const ACCOUNT_MODE_TEXT = {
  apply_rules: { "zh-CN": "应用规则", en: "Apply rules" },
  default_allow: { "zh-CN": "默认放行", en: "Default allow" }
};

const SCOPE_TEXT = {
  default: { "zh-CN": "默认会话", en: "Default session" },
  workspace: { "zh-CN": "工作区会话", en: "Workspace session" }
};

const CONTROL_DOMAIN_TEXT = {
  execution_control: { "zh-CN": "执行控制", en: "Execution Control" },
  data_access: { "zh-CN": "数据访问", en: "Data Access" },
  data_egress: { "zh-CN": "数据外发", en: "Data Egress" },
  credential_protection: { "zh-CN": "凭据保护", en: "Credential Protection" },
  change_control: { "zh-CN": "变更控制", en: "Change Control" },
  approval_exception: { "zh-CN": "紧急例外", en: "Emergency Exception" }
};

const SEVERITY_TEXT = {
  low: { "zh-CN": "低风险", en: "Low" },
  medium: { "zh-CN": "中风险", en: "Medium" },
  high: { "zh-CN": "高风险", en: "High" },
  critical: { "zh-CN": "严重", en: "Critical" }
};

const SKILL_RISK_TIER_TEXT = {
  low: { "zh-CN": "低风险", en: "Low" },
  medium: { "zh-CN": "中风险", en: "Medium" },
  high: { "zh-CN": "高风险", en: "High" },
  critical: { "zh-CN": "严重风险", en: "Critical" }
};

const SKILL_STATE_TEXT = {
  normal: { "zh-CN": "正常", en: "Normal" },
  quarantined: { "zh-CN": "已隔离", en: "Quarantined" },
  trusted: { "zh-CN": "受信覆盖", en: "Trust Override" }
};

const SKILL_SCAN_STATUS_TEXT = {
  ready: { "zh-CN": "已就绪", en: "Ready" },
  stale: { "zh-CN": "已过期", en: "Stale" },
  unknown: { "zh-CN": "未扫描", en: "Unscanned" }
};

const SKILL_SOURCE_TEXT = {
  openclaw_workspace: { "zh-CN": "OpenClaw 工作区", en: "OpenClaw Workspace" },
  openclaw_home: { "zh-CN": "OpenClaw 本地目录", en: "OpenClaw Home" },
  codex_home: { "zh-CN": "Codex 技能目录", en: "Codex Home" },
  custom: { "zh-CN": "自定义来源", en: "Custom Source" }
};

const SKILL_SEVERITY_TEXT = {
  S0: { "zh-CN": "S0 低敏读取", en: "S0 Low-Sensitivity Read" },
  S1: { "zh-CN": "S1 普通写入 / 公网请求", en: "S1 Standard Write / Network" },
  S2: { "zh-CN": "S2 越界读写 / 敏感读取", en: "S2 Sensitive / Outside Workspace" },
  S3: { "zh-CN": "S3 执行 / 敏感外发", en: "S3 Execution / Sensitive Egress" }
};

const SKILL_REASON_TEXT = {
  SKILL_CONTENT_UNREADABLE: { "zh-CN": "内容不可读", en: "Content Unreadable" },
  SKILL_MISSING_AUTHOR: { "zh-CN": "缺少作者信息", en: "Missing Author" },
  SKILL_MISSING_VERSION: { "zh-CN": "缺少版本信息", en: "Missing Version" },
  SKILL_CHANGELOG_MISSING: { "zh-CN": "缺少变更说明", en: "Missing Changelog" },
  SKILL_DOWNLOAD_EXECUTE_PATTERN: { "zh-CN": "检测到下载后执行模式", en: "Download-and-Execute Pattern" },
  SKILL_CAPABILITY_SHELL_EXEC: { "zh-CN": "包含执行能力", en: "Shell Execution Capability" },
  SKILL_POLICY_BYPASS_LANGUAGE: { "zh-CN": "存在绕过策略语义", en: "Policy Bypass Language" },
  SKILL_CREDENTIAL_TARGETING: { "zh-CN": "命中凭据 / 令牌目标", en: "Credential Targeting" },
  SKILL_PUBLIC_EGRESS_PATTERN: { "zh-CN": "存在公网外发语义", en: "Public Egress Pattern" },
  SKILL_OUTSIDE_WORKSPACE_WRITE: { "zh-CN": "涉及工作区外变更", en: "Outside-Workspace Change" },
  SKILL_CAPABILITY_COMBINATION: { "zh-CN": "高危能力组合", en: "High-Risk Capability Combination" },
  SKILL_TYPOSQUAT_SUSPECTED: { "zh-CN": "疑似相似名伪装", en: "Possible Typosquat" },
  SKILL_DRIFT_DETECTED: { "zh-CN": "内容变了但版本没变", en: "Changed Without Version Update" },
  SKILL_TRUST_OVERRIDE_APPLIED: { "zh-CN": "受信覆盖已应用", en: "Trust Override Applied" },
  SKILL_QUARANTINE_OVERRIDE: { "zh-CN": "隔离状态变更", en: "Quarantine Changed" }
};

const SKILL_ACTIVITY_TEXT = {
  finding: { "zh-CN": "扫描信号", en: "Scan Signal" },
  rescan: { "zh-CN": "人工重扫", en: "Manual Rescan" },
  drift_detected: { "zh-CN": "发现未声明变更", en: "Undeclared Change Detected" },
  quarantine_on: { "zh-CN": "已隔离", en: "Quarantined" },
  quarantine_off: { "zh-CN": "解除隔离", en: "Quarantine Removed" },
  trust_override_on: { "zh-CN": "设为受信", en: "Trust Override On" },
  trust_override_off: { "zh-CN": "撤销受信", en: "Trust Override Removed" }
};

const SKILL_RISK_FILTER_OPTIONS = ["all", "low", "medium", "high", "critical"];
const SKILL_STATE_FILTER_OPTIONS = ["all", "normal", "quarantined", "trusted"];
const SKILL_DRIFT_FILTER_OPTIONS = ["all", "drifted", "steady"];
const SKILL_INTERCEPT_FILTER_OPTIONS = ["all", "recent"];
const SKILL_POLICY_TIERS = ["low", "medium", "high", "critical", "unknown"];
const SKILL_SEVERITY_LEVELS = ["S0", "S1", "S2", "S3"];

const CONTROL_DOMAIN_SECURITY_GAIN_TEXT = {
  execution_control: "降低误执行高危命令、系统损坏和被植入后门的风险。",
  data_access: "减少越权读取、批量拉取和误触敏感信息的风险。",
  data_egress: "避免机密信息直接流向公网或不受控的外部渠道。",
  credential_protection: "保护账号、密钥、令牌等核心凭据，减少账号被盗用风险。",
  change_control: "降低关键发布和基础设施配置被误改后引发生产事故的风险。",
  approval_exception: "确保紧急例外仍有审批责任人和完整审计链路。"
};

const DECISION_IMPACT_TEXT = {
  allow: "命中后会继续执行，用户几乎无感知，但会保留审计记录。",
  warn: "命中后会继续执行，同时给出风险提醒，便于用户及时纠正。",
  challenge: "命中后会先暂停，需审批通过后才继续，流程会比平时慢一些。",
  block: "命中后会立即拦截，操作不会执行，需要改用更安全方案。"
};

const OPERATION_TEXT = {
  read: { "zh-CN": "读取", en: "Read" },
  search: { "zh-CN": "搜索", en: "Search" },
  list: { "zh-CN": "枚举", en: "List" },
  write: { "zh-CN": "写入", en: "Write" },
  delete: { "zh-CN": "删除", en: "Delete" },
  archive: { "zh-CN": "归档", en: "Archive" },
  execute: { "zh-CN": "执行", en: "Execute" },
  modify: { "zh-CN": "修改", en: "Modify" },
  export: { "zh-CN": "导出", en: "Export" }
};

const FILE_RULE_OPERATION_OPTIONS = ["read", "list", "search", "write", "delete", "archive", "execute"];

const TOOL_GROUP_TEXT = {
  execution: { "zh-CN": "执行命令", en: "Command Execution" },
  filesystem: { "zh-CN": "文件访问", en: "Filesystem Access" },
  network: { "zh-CN": "网络访问", en: "Network Access" },
  archive: { "zh-CN": "归档导出", en: "Archive / Export" },
  email: { "zh-CN": "邮箱访问", en: "Email Access" },
  sms: { "zh-CN": "短信访问", en: "SMS Access" },
  album: { "zh-CN": "相册访问", en: "Album Access" },
  browser: { "zh-CN": "浏览器数据访问", en: "Browser Data Access" },
  business: { "zh-CN": "业务系统访问", en: "Business System Access" }
};

const CAPABILITY_TEXT = {
  runtime: { "zh-CN": "命令执行与环境", en: "Execution & Runtime" },
  filesystem: { "zh-CN": "文件系统", en: "Filesystem" },
  network: { "zh-CN": "网络与外发", en: "Network & Egress" },
  browser: { "zh-CN": "浏览器数据", en: "Browser Data" },
  messaging: { "zh-CN": "消息与通信", en: "Messaging" },
  archive: { "zh-CN": "归档与导出", en: "Archive & Export" },
  media: { "zh-CN": "媒体与相册", en: "Media & Photos" },
  business: { "zh-CN": "业务系统", en: "Business Systems" },
  automation: { "zh-CN": "自动化任务", en: "Automation" },
  memory: { "zh-CN": "记忆与知识库", en: "Memory & Knowledge" },
  nodes: { "zh-CN": "节点与代理协作", en: "Nodes & Agent Coordination" },
  sessions: { "zh-CN": "会话控制", en: "Session Control" }
};

const CAPABILITY_DESCRIPTION_TEXT = {
  runtime: {
    "zh-CN": "控制 shell / exec 一类命令执行，以及对宿主环境的直接影响。",
    en: "Controls shell-style execution and other actions that directly affect the host runtime environment."
  },
  filesystem: {
    "zh-CN": "控制读取、搜索、写入、删除、归档和执行文件等文件系统操作。",
    en: "Controls file reads, searches, writes, deletes, archive actions, and file execution behavior."
  },
  network: {
    "zh-CN": "控制访问外部网络、调用 API，以及把数据发送到外部地址。",
    en: "Controls outbound network access, API calls, and sending data to external destinations."
  },
  browser: {
    "zh-CN": "控制读取浏览器 Cookie、凭据、历史记录和站点数据。",
    en: "Controls access to browser cookies, credentials, history, and site data."
  },
  messaging: {
    "zh-CN": "控制读取或导出邮件、短信等通信内容。",
    en: "Controls reading or exporting email, SMS, and other communication content."
  },
  archive: {
    "zh-CN": "控制压缩、打包、归档和导出行为。",
    en: "Controls compression, packaging, archiving, and export actions."
  },
  media: {
    "zh-CN": "控制访问相册、图片、音视频和 OCR 类媒体资料。",
    en: "Controls access to photos, screenshots, audio, video, and OCR-oriented media."
  },
  business: {
    "zh-CN": "控制 CRM、ERP、工单、财务等业务系统访问。",
    en: "Controls access to CRM, ERP, ticketing, finance, and other business systems."
  },
  automation: {
    "zh-CN": "控制计划任务、自动触发和无人值守执行。",
    en: "Controls scheduled jobs, automated triggers, and unattended execution."
  },
  memory: {
    "zh-CN": "控制持久记忆、知识库写入和历史检索。",
    en: "Controls persistent memory, knowledge-base writes, and historical retrieval."
  },
  nodes: {
    "zh-CN": "控制多节点、多代理之间的调用与协作边界。",
    en: "Controls cross-node and multi-agent invocation boundaries."
  },
  sessions: {
    "zh-CN": "控制跨会话读取、接管和上下文复用等会话级操作。",
    en: "Controls cross-session reads, takeovers, and context reuse."
  }
};

const DESTINATION_TYPE_TEXT = {
  public: { "zh-CN": "公网", en: "Public Internet" },
  personal_storage: { "zh-CN": "个人网盘", en: "Personal Storage" },
  paste_service: { "zh-CN": "粘贴站点", en: "Paste Service" },
  internal: { "zh-CN": "内部网络", en: "Internal Network" },
  unknown: { "zh-CN": "未知地址", en: "Unknown Destination" }
};

const TRUST_LEVEL_TEXT = {
  trusted: { "zh-CN": "受信输入", en: "Trusted Input" },
  untrusted: { "zh-CN": "未受信输入", en: "Untrusted Input" }
};

const DATA_LABEL_TEXT = {
  secret: { "zh-CN": "机密信息", en: "Secrets" },
  pii: { "zh-CN": "个人隐私", en: "PII" },
  customer_data: { "zh-CN": "客户数据", en: "Customer Data" },
  financial: { "zh-CN": "财务数据", en: "Financial Data" },
  communications: { "zh-CN": "通信内容", en: "Communications" },
  otp: { "zh-CN": "验证码", en: "OTP" },
  browser_secret: { "zh-CN": "浏览器凭据", en: "Browser Secrets" },
  media: { "zh-CN": "媒体资料", en: "Media" }
};

const RULE_IMPACT_EXAMPLES = {
  "high-risk-command-block": {
    scene: "执行 `rm -rf` 或 `curl ... | sh` 这类高危命令。",
    result: "系统会直接拦截，命令不会落地执行。",
    tip: "先缩小操作范围到具体文件，再改成可审查的分步执行。"
  },
  "untrusted-execution-challenge": {
    scene: "执行聊天里收到的陌生命令。",
    result: "系统会先要求审批，审批通过后才能执行。",
    tip: "先确认命令来源和用途，再提交审批，避免执行恶意指令。"
  },
  "workspace-outside-write-block": {
    scene: "删除工作区外目录，或者改写系统目录文件。",
    result: "系统会立即拦截，防止误删系统文件或污染宿主环境。",
    tip: "把操作限定在工作区内，或由管理员走受控变更流程。"
  },
  "sensitive-directory-enumeration-challenge": {
    scene: "批量列出 `.ssh`、`.kube` 或 `Downloads` 目录内容。",
    result: "系统会进入审批，确认后才允许继续枚举。",
    tip: "仅查询必要目录和必要文件，减少不必要的高敏暴露。"
  },
  "credential-path-access-challenge": {
    scene: "读取 `.env`、`id_rsa`、`aws/credentials` 这类凭据文件。",
    result: "系统会先要求审批，再决定是否允许读取。",
    tip: "优先使用脱敏配置或只读必要字段，避免整文件暴露。"
  },
  "public-network-egress-challenge": {
    scene: "把数据请求发到公网 API 或个人网盘。",
    result: "系统会先要求审批，防止数据未经确认外发。",
    tip: "先确认目的地可信且业务必要，再由审批放行。"
  },
  "sensitive-public-egress-block": {
    scene: "把含客户信息或财务信息的数据发送到公网。",
    result: "系统会直接拦截，避免高敏数据泄露。",
    tip: "先做脱敏处理，确认不含敏感标签后再发往外部。"
  },
  "sensitive-archive-challenge": {
    scene: "打包压缩客户数据并导出。",
    result: "系统会进入审批，审批通过才允许归档导出。",
    tip: "尽量按最小范围导出，避免一次性打包过多敏感数据。"
  },
  "critical-control-plane-change-challenge": {
    scene: "修改 `Dockerfile`、`*.tf` 或 `k8s` 部署文件。",
    result: "系统会先要求审批，防止关键配置误改上线。",
    tip: "先在变更单说明影响范围与回滚方案，再申请放行。"
  },
  "email-content-access-challenge": {
    scene: "读取邮箱正文、附件，或者导出邮件。",
    result: "系统会进入审批，确认后才允许读取或导出。",
    tip: "优先按关键词和时间范围缩小查询，减少无关数据暴露。"
  },
  "sms-content-access-challenge": {
    scene: "读取短信内容、历史会话，或者导出短信。",
    result: "系统会先要求审批，审批通过后才能继续。",
    tip: "只读取与任务相关的短信范围，避免批量拉取全部记录。"
  },
  "sms-otp-block": {
    scene: "读取包含验证码或登录提醒的短信。",
    result: "系统会直接拦截，避免账号验证信息被滥用。",
    tip: "验证码应由账号持有人手动输入，不应由代理读取。"
  },
  "album-sensitive-read-challenge": {
    scene: "读取相册里的截图、证件照或 OCR 扫描件。",
    result: "系统会进入审批，审批通过后才允许访问。",
    tip: "先缩小到单个文件，再确认是否真的需要读取图片内容。"
  },
  "browser-credential-block": {
    scene: "读取浏览器 Cookie、密码或自动填充内容。",
    result: "系统会直接拦截，防止凭据被提取后冒用。",
    tip: "改用正规登录或令牌授权流程，不要直接抓取浏览器凭据。"
  },
  "business-system-bulk-read-block": {
    scene: "从 CRM/ERP 等系统批量读取或导出大量记录。",
    result: "系统会直接拦截，防止业务数据被一次性带出。",
    tip: "先拆分为小批次、最小字段范围，并走审批或脱敏流程。"
  },
  "break-glass-exception-challenge": {
    scene: "发起紧急例外请求，临时绕过常规规则。",
    result: "系统会要求单次审批并绑定当前 trace 后才放行。",
    tip: "仅在紧急故障处置时使用，并在工单里补齐风险说明。"
  }
};

const RULE_TEXT_OVERRIDES = {
  "high-risk-command-block": {
    title: {
      "zh-CN": "高危命令模式默认拦截",
      en: "Block High-Risk Command Patterns"
    },
    description: {
      "zh-CN": "阻断删除、权限递归修改、下载后执行、提权和停用系统审计等高危命令模式。",
      en: "Blocks high-risk command patterns such as destructive deletion, recursive permission changes, download-and-execute behavior, privilege escalation, and audit shutdown commands."
    }
  },
  "untrusted-execution-challenge": {
    title: {
      "zh-CN": "未受信输入驱动执行需审批",
      en: "Approval Required for Untrusted Execution"
    },
    description: {
      "zh-CN": "当未受信内容直接驱动执行类操作时，要求一次性、绑定 trace 的审批。",
      en: "Requires single-use, trace-bound approval when execution is directly driven by untrusted inputs."
    }
  },
  "workspace-outside-write-block": {
    title: {
      "zh-CN": "工作区外或系统目录写入删除默认拦截",
      en: "Block Writes/Deletes Outside Workspace or in System Paths"
    },
    description: {
      "zh-CN": "阻断对工作区外和系统目录的写入、删除或覆盖类操作。",
      en: "Blocks write, delete, or overwrite operations targeting paths outside the workspace or system directories."
    }
  },
  "sensitive-directory-enumeration-challenge": {
    title: {
      "zh-CN": "枚举敏感目录需审批",
      en: "Approval Required for Sensitive Directory Enumeration"
    },
    description: {
      "zh-CN": "对凭据目录、配置目录和下载区等高风险目录的枚举与搜索默认进入审批。",
      en: "Routes enumeration and search actions on high-risk directories (credentials/config/downloads) to approval."
    }
  },
  "credential-path-access-challenge": {
    title: {
      "zh-CN": "敏感凭据路径访问需审批",
      en: "Approval Required for Credential Path Access"
    },
    description: {
      "zh-CN": "读取 .env、SSH、Kube、包管理凭据和云访问凭据时默认要求审批。",
      en: "Requires approval before reading sensitive credential paths such as .env, SSH keys, kube config, package credentials, and cloud credentials."
    }
  },
  "public-network-egress-challenge": {
    title: {
      "zh-CN": "访问公网接口需审批",
      en: "Approval Required for Public Network Egress"
    },
    description: {
      "zh-CN": "访问公网、未知域、个人网盘或 paste 类站点时，至少要求显式审批。",
      en: "Requires explicit approval for requests to public or unknown destinations, personal cloud storage, or paste services."
    }
  },
  "sensitive-public-egress-block": {
    title: {
      "zh-CN": "敏感数据向公网外发默认拦截",
      en: "Block Sensitive Data Egress to Public Destinations"
    },
    description: {
      "zh-CN": "当请求命中客户、财务、PII、通信或密钥类数据标签时，禁止直接向公网外发。",
      en: "Blocks direct public egress when data is labeled as customer, financial, PII, communications, or secrets."
    }
  },
  "sensitive-archive-challenge": {
    title: {
      "zh-CN": "敏感内容归档导出需审批",
      en: "Approval Required for Sensitive Archive/Export"
    },
    description: {
      "zh-CN": "对客户数据、财务资料、密钥或媒体资料进行归档、压缩或导出时要求审批。",
      en: "Requires approval for archive/compress/export actions on customer data, financial data, secrets, or media."
    }
  },
  "critical-control-plane-change-challenge": {
    title: {
      "zh-CN": "关键控制面文件变更需审批",
      en: "Approval Required for Critical Control-Plane Changes"
    },
    description: {
      "zh-CN": "修改 CI/CD、部署、容器、Terraform、Kubernetes 或 IAM 相关文件时默认进入审批。",
      en: "Requires approval for changes to CI/CD, deployment, container, Terraform, Kubernetes, or IAM-related files."
    }
  },
  "email-content-access-challenge": {
    title: {
      "zh-CN": "读取邮箱正文或附件需审批",
      en: "Approval Required for Email Content Access"
    },
    description: {
      "zh-CN": "邮箱正文、附件、搜索结果和批量导出默认纳入审批流。",
      en: "Routes email body, attachments, search results, and bulk export actions into approval flow."
    }
  },
  "sms-content-access-challenge": {
    title: {
      "zh-CN": "读取短信内容需审批",
      en: "Approval Required for SMS Content Access"
    },
    description: {
      "zh-CN": "短信正文、会话历史、搜索结果和导出默认纳入审批流。",
      en: "Routes SMS body, conversation history, search results, and export actions into approval flow."
    }
  },
  "sms-otp-block": {
    title: {
      "zh-CN": "读取短信验证码或登录通知默认拦截",
      en: "Block OTP/Login SMS Access"
    },
    description: {
      "zh-CN": "命中 OTP、验证码或登录提醒等短信内容时直接拦截。",
      en: "Directly blocks SMS access when OTP, verification code, or login-alert content is detected."
    }
  },
  "album-sensitive-read-challenge": {
    title: {
      "zh-CN": "读取截图、扫描件或证件照片需审批",
      en: "Approval Required for Sensitive Album Reads"
    },
    description: {
      "zh-CN": "相册中的截图、录屏、扫描件、证件和 OCR 文本读取默认进入审批。",
      en: "Routes access to screenshots, screen recordings, scans, IDs, and OCR-related album content to approval."
    }
  },
  "browser-credential-block": {
    title: {
      "zh-CN": "读取浏览器 Cookie、密码或自动填充默认拦截",
      en: "Block Browser Credential Access"
    },
    description: {
      "zh-CN": "浏览器凭据、Cookie、自动填充和下载历史等高敏内容读取默认阻断。",
      en: "Blocks access to browser credentials, cookies, autofill, and other high-sensitivity browser secrets."
    }
  },
  "business-system-bulk-read-block": {
    title: {
      "zh-CN": "业务系统批量读取默认拦截",
      en: "Block Bulk Reads from Business Systems"
    },
    description: {
      "zh-CN": "CRM、ERP、HR、财务、工单与客服系统的批量读取或导出默认拦截。",
      en: "Blocks bulk read/export actions from CRM, ERP, HR, finance, ticketing, and customer-support systems."
    }
  },
  "break-glass-exception-challenge": {
    title: {
      "zh-CN": "紧急例外请求需单次审批",
      en: "Emergency Exception Requires Single-Use Approval"
    },
    description: {
      "zh-CN": "显式请求紧急例外或策略破例时，要求工单、审批人角色和单次 trace 绑定。",
      en: "Requires a ticket, approver role, and single-use trace binding when requesting an emergency/policy exception."
    }
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(activeLocale === "zh-CN" ? "zh-CN" : "en-US", { hour12: false });
}

function decisionLabel(decision) {
  return readLocalized(DECISION_TEXT, decision, String(decision || "-"));
}

function decisionSourceLabel(source) {
  return readLocalized(DECISION_SOURCE_TEXT, source, "-");
}

function accountModeLabel(mode) {
  return readLocalized(ACCOUNT_MODE_TEXT, mode, mode || "-");
}

function scopeLabel(scope) {
  if (!scope) return ui("未知作用域", "Unknown scope");
  return readLocalized(SCOPE_TEXT, scope, scope);
}

function resourceScopeLabel(scope) {
  if (!scope) return "-";
  if (scope === "workspace_inside") return ui("工作区内", "Inside workspace");
  if (scope === "workspace_outside") return ui("工作区外", "Outside workspace");
  if (scope === "system") return ui("系统目录", "System directory");
  if (scope === "none") return ui("无路径", "No path");
  return scope;
}

function accountPrimaryLabel(account) {
  if (!account) return ui("未命名账号", "Unnamed account");
  return account.label || account.subject || ui("未命名账号", "Unnamed account");
}

function accountMetaLabel(account) {
  const parts = [];
  if (account?.channel) parts.push(account.channel);
  if (account?.chat_type) parts.push(account.chat_type);
  if (account?.agent_id) parts.push(`agent:${account.agent_id}`);
  return parts.join(" · ") || "OpenClaw chat session";
}

function getJsonError(payload, fallback) {
  if (payload && typeof payload === "object" && payload.error) {
    return String(payload.error);
  }
  return fallback;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-securityclaw-locale": activeLocale
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(getJsonError(payload, ui(`请求失败: ${response.status}`, `Request failed: ${response.status}`)));
  }
  return payload;
}

function extractPolicies(strategyPayload) {
  return flattenStrategyRules(extractStrategyModel(strategyPayload));
}

function normalizeDirectoryPathKey(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.toLowerCase();
}

function normalizeFileRuleOperations(operations) {
  if (!Array.isArray(operations)) {
    return [];
  }
  return Array.from(
    new Set(
      operations
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter((entry) => FILE_RULE_OPERATION_OPTIONS.includes(entry))
    )
  ).sort(
    (left, right) => FILE_RULE_OPERATION_OPTIONS.indexOf(left) - FILE_RULE_OPERATION_OPTIONS.indexOf(right)
  );
}

function serializeFileRuleOperations(operations) {
  const normalized = normalizeFileRuleOperations(operations);
  return normalized.length ? normalized.join("|") : "*";
}

function fileRuleIdentityKey(rule) {
  return `${normalizeDirectoryPathKey(rule?.directory)}::${serializeFileRuleOperations(rule?.operations)}`;
}

function compareFileRules(left, right) {
  const byDirectory = String(left?.directory || "").localeCompare(String(right?.directory || ""));
  if (byDirectory !== 0) return byDirectory;
  const byOperations = serializeFileRuleOperations(left?.operations).localeCompare(serializeFileRuleOperations(right?.operations));
  if (byOperations !== 0) return byOperations;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeFileRule(rule) {
  if (!rule || typeof rule !== "object") {
    return null;
  }
  const id = typeof rule.id === "string" ? rule.id.trim() : "";
  const directory = typeof rule.directory === "string" ? rule.directory.trim() : "";
  const decision = typeof rule.decision === "string" ? rule.decision.trim() : "";
  if (!id || !directory || !DECISION_OPTIONS.includes(decision)) {
    return null;
  }
  return {
    id,
    directory,
    decision,
    ...(normalizeFileRuleOperations(rule.operations).length
      ? { operations: normalizeFileRuleOperations(rule.operations) }
      : {}),
    reason_codes: Array.isArray(rule.reason_codes)
      ? rule.reason_codes.map((entry) => String(entry)).filter(Boolean)
      : undefined
  };
}

function normalizeFileRules(rules) {
  if (!Array.isArray(rules)) {
    return [];
  }
  const deduped = new Map();
  rules.forEach((rule) => {
    const normalized = normalizeFileRule(rule);
    if (normalized) {
      deduped.set(fileRuleIdentityKey(normalized), normalized);
    }
  });
  return Array.from(deduped.values()).sort(compareFileRules);
}

function extractFileRules(strategyPayload) {
  return normalizeFileRules(extractStrategyModel(strategyPayload)?.exceptions?.directory_overrides);
}

function serializeFileRules(rules) {
  return JSON.stringify(normalizeFileRules(rules));
}

function normalizeStrategyModel(strategyModel) {
  if (!strategyModel || typeof strategyModel !== "object") {
    return {
      version: "v2",
      tool_policy: {
        capabilities: []
      },
      classifiers: {
        disabled_builtin_ids: [],
        custom_sensitive_paths: [],
        volume_thresholds: {
          bulk_file_count: 20,
          bulk_bytes: 1000000,
          bulk_record_count: 100
        }
      },
      exceptions: {
        directory_overrides: []
      }
    };
  }
  const capabilities = Array.isArray(strategyModel?.tool_policy?.capabilities)
    ? clone(strategyModel.tool_policy.capabilities)
    : [];
  const directoryOverrides = normalizeFileRules(strategyModel?.exceptions?.directory_overrides);
  return {
    version: "v2",
    tool_policy: {
      capabilities
    },
    classifiers: {
      disabled_builtin_ids: Array.isArray(strategyModel?.classifiers?.disabled_builtin_ids)
        ? clone(strategyModel.classifiers.disabled_builtin_ids)
        : [],
      custom_sensitive_paths: Array.isArray(strategyModel?.classifiers?.custom_sensitive_paths)
        ? clone(strategyModel.classifiers.custom_sensitive_paths)
        : [],
      volume_thresholds: strategyModel?.classifiers?.volume_thresholds
        ? clone(strategyModel.classifiers.volume_thresholds)
        : {
            bulk_file_count: 20,
            bulk_bytes: 1000000,
            bulk_record_count: 100
          }
    },
    exceptions: {
      directory_overrides: directoryOverrides
    }
  };
}

function extractStrategyModel(strategyPayload) {
  return normalizeStrategyModel(strategyPayload?.strategy?.model);
}

function flattenStrategyRules(strategyModel) {
  const capabilities = toArray(strategyModel?.tool_policy?.capabilities);
  return capabilities.flatMap((capability) =>
    toArray(capability?.rules).map((rule) => ({
      ...clone(rule),
      capability_id: capability?.capability_id,
      enabled: rule?.enabled !== false,
      match: clone(rule?.context || {})
    }))
  );
}

function updateStrategyRuleDecision(strategyModel, ruleId, decision) {
  const nextStrategy = normalizeStrategyModel(strategyModel);
  nextStrategy.tool_policy.capabilities = nextStrategy.tool_policy.capabilities.map((capability) => ({
    ...capability,
    rules: toArray(capability?.rules).map((rule) =>
      rule?.rule_id === ruleId
        ? {
            ...rule,
            decision,
            enabled: true
          }
        : rule
    )
  }));
  return nextStrategy;
}

function updateStrategyCapabilityDefaultDecision(strategyModel, capabilityId, decision) {
  const nextStrategy = normalizeStrategyModel(strategyModel);
  nextStrategy.tool_policy.capabilities = nextStrategy.tool_policy.capabilities.map((capability) =>
    capability?.capability_id === capabilityId
      ? {
          ...capability,
          default_decision: decision
        }
      : capability
  );
  return nextStrategy;
}

function strategyDirectoryOverrides(strategyModel) {
  return normalizeFileRules(strategyModel?.exceptions?.directory_overrides);
}

function withStrategyDirectoryOverrides(strategyModel, directoryOverrides) {
  const nextStrategy = normalizeStrategyModel(strategyModel);
  nextStrategy.exceptions = {
    ...(nextStrategy.exceptions || {}),
    directory_overrides: normalizeFileRules(directoryOverrides)
  };
  return nextStrategy;
}

function strategyRuleEntries(strategyModel) {
  const capabilities = toArray(strategyModel?.tool_policy?.capabilities);
  return capabilities.flatMap((capability) =>
    toArray(capability?.rules).map((rule, index) => ({
      key: `${capability?.capability_id || "unknown"}:${rule?.rule_id || index}`,
      capability,
      rule,
      index
    }))
  );
}

function normalizeDirectoryPickerEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const pathValue = typeof entry.path === "string" ? entry.path.trim() : "";
      const nameValue = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!pathValue) {
        return null;
      }
      return {
        path: pathValue,
        name: nameValue || pathValue,
      };
    })
    .filter(Boolean);
}

function normalizeDirectoryPickerRoots(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    new Set(
      entries
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function defaultFileRuleReasonCode(decision) {
  if (decision === "allow") {
    return "USER_FILE_RULE_ALLOW";
  }
  if (decision === "warn") {
    return "USER_FILE_RULE_WARN";
  }
  if (decision === "challenge") {
    return "USER_FILE_RULE_CHALLENGE";
  }
  return "USER_FILE_RULE_BLOCK";
}

function extractAccountPolicies(accountPayload) {
  const list = accountPayload?.account_policies;
  return canonicalizeAccountPolicies(Array.isArray(list) ? clone(list) : []);
}

function extractChatSessions(accountPayload) {
  const list = accountPayload?.sessions;
  return Array.isArray(list) ? clone(list) : [];
}

function formatList(values) {
  return values.join(" | ");
}

function summarizeMatch(match) {
  const scopes = toArray(match?.scope);
  const tools = toArray(match?.tool);
  const toolGroups = toArray(match?.tool_group);
  const operations = toArray(match?.operation);
  const identities = toArray(match?.identity);
  const resourceScopes = toArray(match?.resource_scope);
  const fileTypes = toArray(match?.file_type);
  const assetLabels = toArray(match?.asset_labels);
  const dataLabels = toArray(match?.data_labels);
  const trustLevels = toArray(match?.trust_level);
  const destinationTypes = toArray(match?.destination_type);
  const destinationDomains = toArray(match?.dest_domain);
  const destinationIpClasses = toArray(match?.dest_ip_class);
  const pathMatchers = [
    ...toArray(match?.path_prefix),
    ...toArray(match?.path_glob),
    ...toArray(match?.path_regex)
  ];
  const argMatchers = [...toArray(match?.tool_args_summary), ...toArray(match?.tool_args_regex)];

  const parts = [];
  if (scopes.length) parts.push(ui(`范围: ${formatList(scopes)}`, `Scope: ${formatList(scopes)}`));
  if (tools.length) parts.push(ui(`工具: ${formatList(tools)}`, `Tools: ${formatList(tools)}`));
  if (toolGroups.length) parts.push(ui(`工具组: ${formatList(toolGroups)}`, `Tool groups: ${formatList(toolGroups)}`));
  if (operations.length) parts.push(ui(`动作: ${formatList(operations)}`, `Operations: ${formatList(operations)}`));
  if (identities.length) parts.push(ui(`身份: ${formatList(identities)}`, `Identity: ${formatList(identities)}`));
  if (resourceScopes.length) parts.push(ui(`资源范围: ${formatList(resourceScopes.map(resourceScopeLabel))}`, `Resource scopes: ${formatList(resourceScopes.map(resourceScopeLabel))}`));
  if (fileTypes.length) parts.push(ui(`文件类型: ${formatList(fileTypes)}`, `File types: ${formatList(fileTypes)}`));
  if (assetLabels.length) parts.push(ui(`资产标签: ${formatList(assetLabels)}`, `Asset labels: ${formatList(assetLabels)}`));
  if (dataLabels.length) parts.push(ui(`数据标签: ${formatList(dataLabels)}`, `Data labels: ${formatList(dataLabels)}`));
  if (trustLevels.length) parts.push(ui(`信任级别: ${formatList(trustLevels)}`, `Trust levels: ${formatList(trustLevels)}`));
  if (destinationTypes.length) parts.push(ui(`目的地类型: ${formatList(destinationTypes)}`, `Destination types: ${formatList(destinationTypes)}`));
  if (destinationDomains.length) parts.push(ui(`目的地域名: ${formatList(destinationDomains)}`, `Destination domains: ${formatList(destinationDomains)}`));
  if (destinationIpClasses.length) parts.push(ui(`目标 IP: ${formatList(destinationIpClasses)}`, `Destination IP classes: ${formatList(destinationIpClasses)}`));
  if (pathMatchers.length) parts.push(ui(`路径条件: ${pathMatchers.length} 条`, `Path conditions: ${pathMatchers.length}`));
  if (argMatchers.length) parts.push(ui(`参数特征: ${argMatchers.length} 条`, `Argument patterns: ${argMatchers.length}`));
  if (typeof match?.min_file_count === "number") parts.push(ui(`文件数 >= ${match.min_file_count}`, `File count >= ${match.min_file_count}`));
  if (typeof match?.min_bytes === "number") parts.push(ui(`字节数 >= ${match.min_bytes}`, `Bytes >= ${match.min_bytes}`));
  if (typeof match?.min_record_count === "number") parts.push(ui(`记录数 >= ${match.min_record_count}`, `Records >= ${match.min_record_count}`));
  return parts.join(" · ") || ui("无附加匹配条件", "No extra match conditions");
}

function ruleDescription(policy) {
  const overrideDescription = localizedRuleField(policy?.rule_id, "description");
  if (overrideDescription) {
    return overrideDescription;
  }
  if (policy?.description && activeLocale === "zh-CN") {
    return policy.description;
  }
  const action = decisionLabel(policy?.decision);
  const match = summarizeMatch(policy?.match);
  return ui(`命中条件时执行“${action}”。${match}。`, `When matched, action is "${action}". ${match}.`);
}

function controlDomainLabel(domain) {
  if (!domain) return ui("未分类", "Uncategorized");
  return readLocalized(CONTROL_DOMAIN_TEXT, domain, domain);
}

function capabilityLabel(capabilityId) {
  if (!capabilityId) return ui("未分类能力", "Uncategorized Capability");
  return readLocalized(CAPABILITY_TEXT, capabilityId, capabilityId);
}

function capabilityDescription(capabilityId) {
  if (!capabilityId) {
    return ui("用于承载一组相近能力的默认策略和附加限制。", "Holds the default posture and additional restrictions for a related set of capabilities.");
  }
  return readLocalized(
    CAPABILITY_DESCRIPTION_TEXT,
    capabilityId,
    ui("用于承载这组能力的默认策略和附加限制。", "Holds the default posture and additional restrictions for this capability group.")
  );
}

function severityLabel(severity) {
  return readLocalized(SEVERITY_TEXT, severity, severity || ui("未分级", "Unrated"));
}

function policyTitle(policy, index) {
  const overrideTitle = localizedRuleField(policy?.rule_id, "title");
  if (overrideTitle) {
    return overrideTitle;
  }
  if (policy?.title && activeLocale === "zh-CN") {
    return policy.title;
  }
  return policy?.rule_id || ui(`规则 ${index + 1}`, `Rule ${index + 1}`);
}

function formatSimpleList(values) {
  return toArray(values).filter(Boolean).join(ui("、", ", "));
}

function withLabel(value, labels) {
  return readLocalized(labels, value, value);
}

function fileRuleOperationsSummary(rule) {
  const operations = normalizeFileRuleOperations(rule?.operations);
  if (!operations.length) {
    return ui("全部文件类操作", "All filesystem operations");
  }
  return ui(
    `仅限 ${formatSimpleList(operations.map((value) => withLabel(value, OPERATION_TEXT)))}`,
    `Only ${formatSimpleList(operations.map((value) => withLabel(value, OPERATION_TEXT)))}`
  );
}

function localizedRuleField(ruleId, field) {
  if (!ruleId) return undefined;
  const item = RULE_TEXT_OVERRIDES[ruleId];
  const fieldValue = item?.[field];
  if (!fieldValue) return undefined;
  return fieldValue[activeLocale] || fieldValue.en || fieldValue["zh-CN"];
}

function impactTriggerSummary(policy) {
  const overrideDescription = localizedRuleField(policy?.rule_id, "description");
  if (overrideDescription) {
    return overrideDescription;
  }
  if (policy?.description && activeLocale === "zh-CN") {
    return policy.description;
  }
  const match = policy?.match || {};
  const parts = [];
  const toolGroups = toArray(match.tool_group).map((value) => withLabel(value, TOOL_GROUP_TEXT));
  const operations = toArray(match.operation).map((value) => withLabel(value, OPERATION_TEXT));
  const trustLevels = toArray(match.trust_level).map((value) => withLabel(value, TRUST_LEVEL_TEXT));
  const destinationTypes = toArray(match.destination_type).map((value) => withLabel(value, DESTINATION_TYPE_TEXT));
  const dataLabels = toArray(match.data_labels).map((value) => withLabel(value, DATA_LABEL_TEXT));
  const pathExample = toArray(match.path_glob)[0] || toArray(match.path_prefix)[0];

  if (toolGroups.length) {
    parts.push(ui(`涉及${formatSimpleList(toolGroups)}相关操作`, `Involves ${formatSimpleList(toolGroups)} operations`));
  }
  if (operations.length) {
    parts.push(ui(`动作属于${formatSimpleList(operations)}`, `Operation is ${formatSimpleList(operations)}`));
  }
  if (trustLevels.length) {
    parts.push(ui(`输入来源是${formatSimpleList(trustLevels)}`, `Input source is ${formatSimpleList(trustLevels)}`));
  }
  if (destinationTypes.length) {
    parts.push(ui(`目标是${formatSimpleList(destinationTypes)}`, `Destination is ${formatSimpleList(destinationTypes)}`));
  }
  if (dataLabels.length) {
    parts.push(ui(`内容被识别为${formatSimpleList(dataLabels)}`, `Content is labeled as ${formatSimpleList(dataLabels)}`));
  }
  if (pathExample) {
    parts.push(ui(`路径命中类似 ${pathExample}`, `Path matches patterns like ${pathExample}`));
  }
  return parts.join(ui("，", ", ")) || ui("当操作命中这条规则定义的风险条件时会触发。", "Triggered when operations match the risk conditions of this rule.");
}

function securityGainSummary(policy) {
  const domain = policy?.control_domain || policy?.group;
  const base = CONTROL_DOMAIN_SECURITY_GAIN_TEXT[domain]
    ? ui(CONTROL_DOMAIN_SECURITY_GAIN_TEXT[domain], "Reduces operational mistakes and sensitive data exposure risks.")
    : ui("减少误操作和敏感数据泄露风险。", "Reduces operational mistakes and sensitive data exposure risks.");
  if (policy?.decision === "block") {
    return ui(`${base} 这条规则会在关键风险点直接刹车。`, `${base} This rule hard-stops high-risk operations.`);
  }
  if (policy?.decision === "challenge") {
    return ui(`${base} 这条规则会在高风险场景加一道人工确认。`, `${base} This rule adds human approval in high-risk cases.`);
  }
  if (policy?.decision === "warn") {
    return ui(`${base} 这条规则会在不中断流程的前提下提醒风险。`, `${base} This rule warns while keeping the workflow moving.`);
  }
  return ui(`${base} 同时保留审计记录，便于回溯。`, `${base} Audit trails are preserved for traceability.`);
}

function userImpactSummary(policy) {
  const base = DECISION_IMPACT_TEXT[policy?.decision] || DECISION_IMPACT_TEXT.allow;
  const localizedBase = ui(
    base,
    {
      [DECISION_IMPACT_TEXT.allow]: "Execution continues with minimal friction and audit logging remains enabled.",
      [DECISION_IMPACT_TEXT.warn]: "Execution continues with a risk warning so users can correct behavior in time.",
      [DECISION_IMPACT_TEXT.challenge]: "Execution pauses until approval is granted, so the workflow becomes slower but safer.",
      [DECISION_IMPACT_TEXT.block]: "Execution is stopped immediately and must be replaced with a safer approach.",
    }[base] || "This decision path affects execution behavior and audit posture.",
  );
  return localizedBase;
}

function capabilityBaselineSummary(capability) {
  const restrictionCount = toArray(capability?.rules).length;
  const followup = restrictionCount > 0
    ? ui(
      `这只是这组能力的起始动作，后续 ${restrictionCount} 条附加限制仍可能把它升级成提醒、确认或拦截。`,
      `This is only the baseline for the capability. The ${restrictionCount} additional restrictions can still escalate it to warn, approval, or block.`
    )
    : ui(
      "当前没有额外附加限制，所以这组能力会直接按这个默认策略处理。",
      "There are no additional restrictions right now, so this capability follows the baseline action directly."
    );
  return `${userImpactSummary({ decision: capability?.default_decision })} ${followup}`;
}

function skillDefaultActionSummary(kind, decision) {
  const action = decisionLabel(decision);
  const impact = userImpactSummary({ decision });
  if (kind === "unscanned_S2") {
    return ui(
      `当 Skill 还没完成扫描、但调用已经达到 S2 时，会先按“${action}”兜底，避免敏感读写在未看清前被放宽。${impact}`,
      `When a skill has not been scanned yet and the call already reaches S2, it falls back to "${action}" so sensitive reads/writes are not relaxed before inspection. ${impact}`
    );
  }
  if (kind === "unscanned_S3") {
    return ui(
      `当 Skill 还没完成扫描、且调用达到 S3 时，会先按“${action}”处理，优先收紧执行和敏感外发。${impact}`,
      `When a skill has not been scanned yet and the call reaches S3, it falls back to "${action}" to tighten execution and sensitive egress first. ${impact}`
    );
  }
  return ui(
    `当 Skill 内容变了但版本没变时，会先按“${action}”处理，避免未声明变更直接继承旧信任。${impact}`,
    `When a skill changes without a version bump, it falls back to "${action}" so undeclared changes do not inherit previous trust by default. ${impact}`
  );
}

function fallbackImpactExample(policy, index) {
  return {
    scene: ui(
      `执行「${policyTitle(policy, index)}」覆盖范围内的操作。`,
      `Run an operation covered by "${policyTitle(policy, index)}".`,
    ),
    result: ui(
      `系统会按当前策略“${decisionLabel(policy?.decision)}”处理这次请求。`,
      `The system handles this request as "${decisionLabel(policy?.decision)}" under current policy.`,
    ),
    tip: policy?.decision === "block"
      ? ui("如果业务必须执行，请先缩小操作范围，再联系管理员评估例外放行。", "If business must proceed, reduce scope first, then request an exception review.")
      : ui("先确认操作必要性，再继续或提交审批。", "Confirm necessity first, then continue or request approval.")
  };
}

function ruleImpactGuide(policy, index) {
  const predefinedExample = RULE_IMPACT_EXAMPLES[policy?.rule_id];
  return {
    trigger: impactTriggerSummary(policy),
    securityGain: securityGainSummary(policy),
    userImpact: userImpactSummary(policy),
    example: activeLocale === "zh-CN" && predefinedExample
      ? predefinedExample
      : fallbackImpactExample(policy, index)
  };
}

function assistantDecisionLine(policy) {
  if (policy?.decision === "block") {
    return ui("这个请求风险太高，我不能直接执行。", "This request is too risky to execute directly.");
  }
  if (policy?.decision === "challenge") {
    return ui("这个请求需要管理员确认后，我才能继续执行。", "An administrator needs to approve this request before I can continue.");
  }
  if (policy?.decision === "warn") {
    return ui("这个请求可以继续，但我会先提醒你潜在风险。", "This request can continue, but I need to warn you about potential risk first.");
  }
  return ui("这个请求可以继续，我会按规则保留审计记录。", "This request can continue and I will keep audit logs according to policy.");
}

function buildRuleConversation(policy, index) {
  const guide = ruleImpactGuide(policy, index);
  return [
    {
      role: "user",
      label: ui("你", "You"),
      text: guide.example.scene
    },
    {
      role: "assistant",
      label: ui("助手", "Assistant"),
      text: assistantDecisionLine(policy)
    },
    {
      role: "system",
      label: "SecurityClaw",
      text: guide.example.result
    },
    {
      role: "assistant",
      label: ui("助手", "Assistant"),
      text: ui(`更安全的做法：${guide.example.tip}`, `Safer approach: ${guide.example.tip}`)
    }
  ];
}

function formatPercent(value, total) {
  if (!total) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function normalizeLabel(value, fallback = ui("未标记", "Unlabeled")) {
  if (typeof value !== "string") {
    return fallback;
  }
  const text = value.trim();
  return text || fallback;
}

function buildDistribution(items, getLabel, options = {}) {
  const fallbackLabel = options.fallbackLabel || ui("未标记", "Unlabeled");
  const limit = typeof options.limit === "number" ? options.limit : 0;
  const counts = new Map();

  items.forEach((item) => {
    const label = normalizeLabel(getLabel(item), fallbackLabel);
    counts.set(label, (counts.get(label) || 0) + 1);
  });

  const sorted = Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, activeLocale === "zh-CN" ? "zh-CN" : "en-US"));

  if (limit > 0 && sorted.length > limit) {
    const top = sorted.slice(0, limit);
    const rest = sorted.slice(limit).reduce((sum, item) => sum + item.count, 0);
    if (rest > 0) {
      top.push({ label: ui("其他", "Others"), count: rest });
    }
    return top;
  }

  return sorted;
}

function withChartColors(items, theme = "light") {
  const palette = CHART_PALETTES[theme] || CHART_PALETTES.light;
  return items.map((item, index) => ({
    ...item,
    color: item.color || palette[index % palette.length]
  }));
}

function parseRuleIds(rawRules) {
  if (typeof rawRules !== "string" || !rawRules.trim() || rawRules.trim() === "-") {
    return [];
  }
  return rawRules
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== "-");
}

function buildTrendSeries(records, bucketCount = 12, bucketHours = 2) {
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const alignedEnd = Math.floor(Date.now() / bucketMs) * bucketMs + bucketMs;
  const start = alignedEnd - bucketCount * bucketMs;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    startTs: start + index * bucketMs,
    total: 0,
    risk: 0
  }));

  records.forEach((item) => {
    const ts = Date.parse(item?.ts || "");
    if (!Number.isFinite(ts) || ts < start || ts >= alignedEnd) {
      return;
    }
    const bucketIndex = Math.floor((ts - start) / bucketMs);
    if (bucketIndex < 0 || bucketIndex >= buckets.length) {
      return;
    }
    buckets[bucketIndex].total += 1;
    if (item?.decision !== "allow") {
      buckets[bucketIndex].risk += 1;
    }
  });

  return {
    start,
    end: alignedEnd,
    bucketHours,
    buckets
  };
}

function formatClock(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return date.toLocaleTimeString(activeLocale === "zh-CN" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function buildPageItems(currentPage, totalPages) {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, start + 4);
  const adjustedStart = Math.max(1, end - 4);
  return Array.from({ length: end - adjustedStart + 1 }, (_, index) => adjustedStart + index);
}

function DecisionTag({ decision }) {
  return <span className={`tag ${decision || "allow"}`}>{decisionLabel(decision)}</span>;
}

function FileRuleOperationSelector({ operations, onToggle }) {
  const normalizedOperations = normalizeFileRuleOperations(operations);
  const appliesToAll = normalizedOperations.length === 0;
  return (
    <div className="file-rule-operation-group" role="group" aria-label={ui("适用操作", "Applies to operations")}>
      <button
        className={`file-rule-operation-chip ${appliesToAll ? "active" : ""}`}
        type="button"
        onClick={() => onToggle("__all__")}
        aria-pressed={appliesToAll}
      >
        {ui("全部", "All")}
      </button>
      {FILE_RULE_OPERATION_OPTIONS.map((operation) => (
        <button
          key={operation}
          className={`file-rule-operation-chip ${normalizedOperations.includes(operation) ? "active" : ""}`}
          type="button"
          onClick={() => onToggle(operation)}
          aria-pressed={normalizedOperations.includes(operation)}
        >
          {withLabel(operation, OPERATION_TEXT)}
        </button>
      ))}
    </div>
  );
}

function OverviewStatCard({ label, value, tone, onClick }) {
  return (
    <div className={`stat ${tone || ""}`}>
      <div className="stat-head">
        <b>{label}</b>
      </div>
      {typeof onClick === "function" ? (
        <button
          className="stat-value-button"
          type="button"
          onClick={onClick}
          aria-label={`${label}: ${value}`}
          title={label}
        >
          {value}
        </button>
      ) : (
        <span className="stat-value">{value}</span>
      )}
    </div>
  );
}

function buildDecisionApiPath(decisionFilter, decisionPage) {
  const searchParams = new URLSearchParams({
    page: String(decisionPage),
    page_size: String(DECISIONS_PER_PAGE)
  });
  if (decisionFilter !== "all") {
    searchParams.set("decision", decisionFilter);
  }
  return `/api/decisions?${searchParams.toString()}`;
}

function skillRiskLabel(value) {
  return readLocalized(SKILL_RISK_TIER_TEXT, value, value || "-");
}

function skillStateLabel(value) {
  return readLocalized(SKILL_STATE_TEXT, value, value || "-");
}

function skillScanStatusLabel(value) {
  return readLocalized(SKILL_SCAN_STATUS_TEXT, value, value || "-");
}

function skillSourceLabel(value, detail) {
  const source = readLocalized(SKILL_SOURCE_TEXT, value, value || ui("未知来源", "Unknown Source"));
  return detail ? `${source} · ${detail}` : source;
}

function skillSeverityLabel(value) {
  return readLocalized(SKILL_SEVERITY_TEXT, value, value || "-");
}

function skillReasonLabel(value) {
  return readLocalized(SKILL_REASON_TEXT, value, value || "-");
}

function skillActivityLabel(value) {
  return readLocalized(SKILL_ACTIVITY_TEXT, value, value || "-");
}

function skillRiskFilterLabel(value) {
  if (value === "all") return ui("全部风险", "All Risk Tiers");
  return skillRiskLabel(value);
}

function skillStateFilterLabel(value) {
  if (value === "all") return ui("全部状态", "All States");
  return skillStateLabel(value);
}

function skillDriftFilterLabel(value) {
  if (value === "all") return ui("全部变更状态", "All Change States");
  if (value === "drifted") return ui("仅看未声明变更", "Changed Without Version Update");
  return ui("无未声明变更", "No Undeclared Change");
}

function skillInterceptFilterLabel(value) {
  if (value === "all") return ui("全部拦截状态", "All Interception States");
  return ui("24 小时内有需确认 / 拦截", "Challenge / Block in Last 24h");
}

function normalizeSkillPolicyDraft(policy) {
  if (!policy || typeof policy !== "object") {
    return null;
  }
  return clone(policy);
}

function buildSkillListApiPath(filters) {
  const searchParams = new URLSearchParams();
  if (filters?.risk && filters.risk !== "all") {
    searchParams.set("risk", filters.risk);
  }
  if (filters?.state && filters.state !== "all") {
    searchParams.set("state", filters.state);
  }
  if (filters?.source && filters.source !== "all") {
    searchParams.set("source", filters.source);
  }
  if (filters?.drift && filters.drift !== "all") {
    searchParams.set("drift", filters.drift);
  }
  if (filters?.intercepted && filters.intercepted !== "all") {
    searchParams.set("intercepted", filters.intercepted);
  }
  const query = searchParams.toString();
  return query ? `/api/skills?${query}` : "/api/skills";
}

function formatHash(value, length = 10) {
  if (typeof value !== "string" || !value.trim()) {
    return "-";
  }
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function formatConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0%";
  }
  return `${Math.round(numeric * 100)}%`;
}

function trimLabel(value, max = 10) {
  if (typeof value !== "string") {
    return "";
  }
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{label || payload[0]?.name || ui("明细", "Details")}</div>
      {payload.map((entry, index) => (
        <div key={`${entry.dataKey || entry.name || "value"}-${index}`} className="chart-tooltip-row">
          <span className="chart-tooltip-key">{entry.name || entry.dataKey}</span>
          <span className="chart-tooltip-value">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

function DistributionChart({ title, subtitle, items, total, emptyText, theme }) {
  const chartTheme = CHART_THEME[theme] || CHART_THEME.light;
  const data = items.map((item) => ({
    name: item.label,
    value: item.count,
    color: item.color,
    percent: total > 0 ? Math.round((item.count / total) * 100) : 0
  }));
  const height = 270;

  return (
    <article className="panel-card chart-card">
      <div className="chart-head">
        <h3>{title}</h3>
        <span className="chart-subtitle">{subtitle}</span>
      </div>
      {data.length === 0 ? (
        <div className="chart-empty">{emptyText}</div>
      ) : (
        <div className="chart-surface">
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} margin={{ top: 4, right: 8, left: 6, bottom: 34 }}>
              <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
              <YAxis
                allowDecimals={false}
                tick={{ fill: chartTheme.tick, fontSize: 12 }}
                axisLine={{ stroke: chartTheme.axis }}
                tickLine={false}
              />
              <XAxis
                dataKey="name"
                tick={{ fill: chartTheme.tick, fontSize: 12 }}
                tickFormatter={(value) => trimLabel(value, 8)}
                interval={0}
                axisLine={{ stroke: chartTheme.axis }}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="value" name={ui("次数", "Count")} radius={[6, 6, 0, 0]} maxBarSize={54}>
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </article>
  );
}

function readInitialAdminLocale() {
  if (typeof window === "undefined") {
    return ADMIN_DEFAULT_LOCALE;
  }
  const queryLocale = new URLSearchParams(window.location.search).get("locale");
  const storedLocale = window.localStorage.getItem(ADMIN_LOCALE_STORAGE_KEY) || undefined;
  return resolveSecurityClawLocale(queryLocale || storedLocale || navigator.language, ADMIN_DEFAULT_LOCALE);
}

function readInitialAdminThemePreference() {
  if (typeof window === "undefined") {
    return ADMIN_DEFAULT_THEME_PREFERENCE;
  }
  const queryTheme = new URLSearchParams(window.location.search).get("theme");
  const storedTheme = window.localStorage.getItem(ADMIN_THEME_STORAGE_KEY) || undefined;
  return normalizeAdminThemePreference(queryTheme || storedTheme);
}

function readInitialAdminDashboardViewState() {
  if (typeof window === "undefined") {
    return {
      tab: "overview",
      decisionFilter: "all",
      decisionPage: 1
    };
  }
  return readAdminDashboardUrlState({
    search: window.location.search,
    hash: window.location.hash
  });
}

function App() {
  const [locale, setLocale] = useState(readInitialAdminLocale);
  activeLocale = locale;
  const [themePreference, setThemePreference] = useState(readInitialAdminThemePreference);
  const [systemTheme, setSystemTheme] = useState(readSystemTheme);
  const theme = useMemo(() => resolveAdminTheme(themePreference, systemTheme), [themePreference, systemTheme]);
  const [statusPayload, setStatusPayload] = useState(null);
  const [strategyModel, setStrategyModel] = useState(() => normalizeStrategyModel(null));
  const [publishedStrategyModel, setPublishedStrategyModel] = useState(() => normalizeStrategyModel(null));
  const [selectedFileDirectory, setSelectedFileDirectory] = useState("");
  const [newFileRuleDecision, setNewFileRuleDecision] = useState("challenge");
  const [newFileRuleOperations, setNewFileRuleOperations] = useState([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerLoading, setFilePickerLoading] = useState(false);
  const [filePickerError, setFilePickerError] = useState("");
  const [filePickerCurrentPath, setFilePickerCurrentPath] = useState("");
  const [filePickerParentPath, setFilePickerParentPath] = useState("");
  const [filePickerRoots, setFilePickerRoots] = useState([]);
  const [filePickerDirectories, setFilePickerDirectories] = useState([]);
  const [fileRuleDeleteTarget, setFileRuleDeleteTarget] = useState(null);
  const [accountPolicies, setAccountPolicies] = useState([]);
  const [publishedAccountPolicies, setPublishedAccountPolicies] = useState([]);
  const [availableSessions, setAvailableSessions] = useState([]);
  const [skillStatusPayload, setSkillStatusPayload] = useState(null);
  const [skillListPayload, setSkillListPayload] = useState(null);
  const [skillDetailPayload, setSkillDetailPayload] = useState(null);
  const [skillPolicy, setSkillPolicy] = useState(null);
  const [publishedSkillPolicy, setPublishedSkillPolicy] = useState(null);
  const [skillRiskFilter, setSkillRiskFilter] = useState("all");
  const [skillStateFilter, setSkillStateFilter] = useState("all");
  const [skillSourceFilter, setSkillSourceFilter] = useState("all");
  const [skillDriftFilter, setSkillDriftFilter] = useState("all");
  const [skillInterceptFilter, setSkillInterceptFilter] = useState("all");
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [skillListLoading, setSkillListLoading] = useState(true);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillPolicySaving, setSkillPolicySaving] = useState(false);
  const [skillActionLoading, setSkillActionLoading] = useState("");
  const [skillConfirmAction, setSkillConfirmAction] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [decisionLoading, setDecisionLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState(() => readInitialAdminDashboardViewState().tab);
  const [decisionFilter, setDecisionFilter] = useState(() => readInitialAdminDashboardViewState().decisionFilter);
  const [decisionPage, setDecisionPage] = useState(() => readInitialAdminDashboardViewState().decisionPage);
  const [decisionPayload, setDecisionPayload] = useState(null);
  const [activeRuleKey, setActiveRuleKey] = useState("");
  const [sidePanelOffset, setSidePanelOffset] = useState(0);
  const rulesColumnRef = useRef(null);
  const firstRuleRef = useRef(null);
  const policies = useMemo(() => flattenStrategyRules(strategyModel), [strategyModel]);
  const publishedPolicies = useMemo(() => flattenStrategyRules(publishedStrategyModel), [publishedStrategyModel]);
  const fileRules = useMemo(() => strategyDirectoryOverrides(strategyModel), [strategyModel]);
  const publishedFileRules = useMemo(() => strategyDirectoryOverrides(publishedStrategyModel), [publishedStrategyModel]);
  const capabilityPolicies = useMemo(() => toArray(strategyModel?.tool_policy?.capabilities), [strategyModel]);
  const hasFilesystemCapability = useMemo(
    () => capabilityPolicies.some((capability) => capability?.capability_id === "filesystem"),
    [capabilityPolicies]
  );

  const hasPendingRuleChanges = useMemo(
    () => JSON.stringify(policies) !== JSON.stringify(publishedPolicies),
    [policies, publishedPolicies]
  );
  const hasPendingFileRuleChanges = useMemo(
    () => serializeFileRules(fileRules) !== serializeFileRules(publishedFileRules),
    [fileRules, publishedFileRules]
  );
  const hasPendingAccountChanges = useMemo(
    () =>
      JSON.stringify(canonicalizeAccountPolicies(accountPolicies)) !==
      JSON.stringify(canonicalizeAccountPolicies(publishedAccountPolicies)),
    [accountPolicies, publishedAccountPolicies]
  );
  const hasPendingSkillPolicyChanges = useMemo(
    () => JSON.stringify(skillPolicy || null) !== JSON.stringify(publishedSkillPolicy || null),
    [publishedSkillPolicy, skillPolicy]
  );
  const hasPendingChanges = hasPendingRuleChanges || hasPendingFileRuleChanges || hasPendingAccountChanges;
  const hasPendingDashboardChanges = hasPendingChanges || hasPendingSkillPolicyChanges;
  const groupedPolicies = useMemo(
    () =>
      capabilityPolicies.map((capability, index) => [
        capability?.capability_id || `capability-${index}`,
        toArray(capability?.rules).map((rule, ruleIndex) => ({
          capability,
          policy: {
            ...clone(rule),
            match: clone(rule?.context || {}),
            enabled: rule?.enabled !== false
          },
          index: ruleIndex
        }))
      ]),
    [capabilityPolicies]
  );
  const policyEntries = useMemo(
    () =>
      strategyRuleEntries(strategyModel).map((entry) => ({
        key: entry.key,
        policy: {
          ...clone(entry.rule),
          match: clone(entry.rule?.context || {}),
          enabled: entry.rule?.enabled !== false
        },
        index: entry.index,
        capability: entry.capability
      })),
    [strategyModel]
  );
  const displayAccounts = useMemo(
    () => mergeAccountPoliciesWithSessions(ensureDefaultAdminAccount(accountPolicies, availableSessions), availableSessions),
    [accountPolicies, availableSessions]
  );
  const selectedAdminSubject = useMemo(
    () => displayAccounts.find((account) => account.is_admin)?.subject || "",
    [displayAccounts]
  );
  const normalizedFileRules = useMemo(() => normalizeFileRules(fileRules), [fileRules]);
  const normalizedNewFileRuleOperations = useMemo(
    () => normalizeFileRuleOperations(newFileRuleOperations),
    [newFileRuleOperations]
  );
  const selectedDirectoryRuleExists = useMemo(() => {
    if (!selectedFileDirectory) {
      return false;
    }
    const selectedKey = fileRuleIdentityKey({
      directory: selectedFileDirectory,
      operations: normalizedNewFileRuleOperations
    });
    return normalizedFileRules.some((rule) => fileRuleIdentityKey(rule) === selectedKey);
  }, [normalizedFileRules, normalizedNewFileRuleOperations, selectedFileDirectory]);
  const skillItems = useMemo(() => toArray(skillListPayload?.items), [skillListPayload]);
  const skillSourceOptions = useMemo(() => toArray(skillListPayload?.source_options), [skillListPayload]);
  const skillOverviewHighlights = useMemo(() => toArray(skillStatusPayload?.highlights), [skillStatusPayload]);
  const skillSummaryCounts = skillListPayload?.counts || {
    total: 0,
    high_critical: 0,
    quarantined: 0,
    trusted: 0,
    drifted: 0,
    recent_intercepts: 0
  };
  const skillOverviewStats = skillStatusPayload?.stats || {
    total: 0,
    high_critical: 0,
    challenge_block_24h: 0,
    drift_alerts: 0,
    quarantined: 0,
    trusted_overrides: 0
  };
  const firstRuleKey = policyEntries[0]?.key || "";

  useEffect(() => {
    activeLocale = locale;
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, locale);
    }
  }, [locale]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.title = `${ADMIN_BRAND_TEXT} · ${tabLabel(activeTab)}`;
    }
  }, [activeTab, locale]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const mediaQuery = window.matchMedia(DARK_COLOR_SCHEME_QUERY);
    const handleChange = (event) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    setSystemTheme(mediaQuery.matches ? "dark" : "light");
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ADMIN_THEME_STORAGE_KEY, themePreference);
    }
  }, [theme, themePreference]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const syncFromLocation = () => {
      const next = readAdminDashboardUrlState({
        search: window.location.search,
        hash: window.location.hash
      });
      setActiveTab(next.tab);
      setDecisionFilter(next.decisionFilter);
      setDecisionPage(next.decisionPage);
    };

    window.addEventListener("popstate", syncFromLocation);
    window.addEventListener("hashchange", syncFromLocation);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
      window.removeEventListener("hashchange", syncFromLocation);
    };
  }, []);

  const navigateDashboard = useCallback((nextViewState) => {
    const resolvedTab = nextViewState.tab ?? activeTab;
    const resolvedDecisionFilter = nextViewState.decisionFilter ?? decisionFilter;
    const resolvedDecisionPage = nextViewState.decisionPage ?? decisionPage;

    setActiveTab(resolvedTab);
    setDecisionFilter(resolvedDecisionFilter);
    setDecisionPage(resolvedDecisionPage);

    if (typeof window === "undefined") {
      return;
    }

    const nextSearch = buildAdminDashboardSearch({
      currentSearch: window.location.search,
      tab: resolvedTab,
      decisionFilter: resolvedDecisionFilter,
      decisionPage: resolvedDecisionPage
    });
    const nextUrl = `${window.location.pathname}${nextSearch}`;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl !== currentUrl || window.location.hash) {
      window.history.pushState({}, "", nextUrl);
    }
  }, [activeTab, decisionFilter, decisionPage]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const nextSearch = buildAdminDashboardSearch({
      currentSearch: window.location.search,
      tab: activeTab,
      decisionFilter,
      decisionPage
    });
    const nextUrl = `${window.location.pathname}${nextSearch}`;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl !== currentUrl || window.location.hash) {
      window.history.replaceState({}, "", nextUrl);
    }
  }, [activeTab, decisionFilter, decisionPage]);

  const loadData = useCallback(async (options = {}) => {
    const {
      syncRules = true,
      syncAccounts = true,
      silent = false
    } = options;
    if (!silent) {
      setLoading(true);
    }
    setError("");
    try {
      const [status, strategy, accounts] = await Promise.all([
        getJson("/api/status"),
        getJson("/api/strategy"),
        getJson("/api/accounts")
      ]);
      setStatusPayload(status);
      const nextStrategyModel = extractStrategyModel(strategy);
      const nextFileRules = extractFileRules(strategy);
      const nextAccountPolicies = extractAccountPolicies(accounts);
      const nextSessions = extractChatSessions(accounts);
      setPublishedStrategyModel(nextStrategyModel);
      setPublishedAccountPolicies(nextAccountPolicies);
      setAvailableSessions(nextSessions);
      if (syncRules === true) {
        setStrategyModel(clone(nextStrategyModel));
        setSelectedFileDirectory((current) => current || nextFileRules[0]?.directory || "");
      }
      if (syncAccounts === true) {
        setAccountPolicies(clone(nextAccountPolicies));
      }
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDecisionPage = useCallback(async (options = {}) => {
    const { silent = false } = options;
    if (!silent) {
      setDecisionLoading(true);
    }
    try {
      const payload = await getJson(buildDecisionApiPath(decisionFilter, decisionPage));
      setDecisionPayload(payload);
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setDecisionLoading(false);
    }
  }, [decisionFilter, decisionPage]);

  const loadSkillData = useCallback(async (options = {}) => {
    const {
      silent = false,
      syncPolicy = true
    } = options;
    if (!silent) {
      setSkillListLoading(true);
    }
    try {
      const [status, list] = await Promise.all([
        getJson("/api/skills/status"),
        getJson(
          buildSkillListApiPath({
            risk: skillRiskFilter,
            state: skillStateFilter,
            source: skillSourceFilter,
            drift: skillDriftFilter,
            intercepted: skillInterceptFilter
          })
        )
      ]);
      const nextPolicy = normalizeSkillPolicyDraft(status?.policy || list?.policy);
      setSkillStatusPayload(status);
      setSkillListPayload(list);
      if (nextPolicy) {
        setPublishedSkillPolicy(nextPolicy);
        if (syncPolicy) {
          setSkillPolicy(clone(nextPolicy));
        } else {
          setSkillPolicy((current) => current || clone(nextPolicy));
        }
      }
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setSkillListLoading(false);
    }
  }, [skillDriftFilter, skillInterceptFilter, skillRiskFilter, skillSourceFilter, skillStateFilter]);

  const loadSkillDetail = useCallback(async (skillId, options = {}) => {
    const { silent = false } = options;
    if (!skillId) {
      setSkillDetailPayload(null);
      return;
    }
    if (!silent) {
      setSkillDetailLoading(true);
    }
    try {
      const payload = await getJson(`/api/skills/${encodeURIComponent(skillId)}`);
      setSkillDetailPayload(payload);
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setSkillDetailLoading(false);
    }
  }, []);

  const loadDirectoryPicker = useCallback(async (targetPath = "") => {
    setFilePickerLoading(true);
    setFilePickerError("");
    try {
      const trimmedPath = typeof targetPath === "string" ? targetPath.trim() : "";
      const query = trimmedPath ? `?path=${encodeURIComponent(trimmedPath)}` : "";
      const payload = await getJson(`/api/file-rule/directories${query}`);
      const currentPath = typeof payload?.current_path === "string" ? payload.current_path.trim() : "";
      const parentPath = typeof payload?.parent_path === "string" ? payload.parent_path.trim() : "";
      setFilePickerCurrentPath(currentPath);
      setFilePickerParentPath(parentPath);
      setFilePickerRoots(normalizeDirectoryPickerRoots(payload?.roots));
      setFilePickerDirectories(normalizeDirectoryPickerEntries(payload?.directories));
    } catch (loadError) {
      setFilePickerError(String(loadError));
    } finally {
      setFilePickerLoading(false);
    }
  }, []);

  const openDirectoryPicker = useCallback(() => {
    setFilePickerOpen(true);
    void loadDirectoryPicker(selectedFileDirectory || normalizedFileRules[0]?.directory || "");
  }, [loadDirectoryPicker, normalizedFileRules, selectedFileDirectory]);

  useEffect(() => {
    void loadData({ syncRules: true, syncAccounts: true, silent: false });
  }, [loadData]);

  useEffect(() => {
    void loadDecisionPage({ silent: false });
  }, [loadDecisionPage]);

  useEffect(() => {
    void loadSkillData({
      silent: false,
      syncPolicy: !hasPendingSkillPolicyChanges
    });
  }, [hasPendingSkillPolicyChanges, loadSkillData]);

  useEffect(() => {
    if (skillItems.length === 0) {
      setSelectedSkillId("");
      setSkillDetailPayload(null);
      return;
    }
    const selectedStillExists = skillItems.some((item) => item.skill_id === selectedSkillId);
    if (!selectedStillExists) {
      setSelectedSkillId(skillItems[0].skill_id);
    }
  }, [selectedSkillId, skillItems]);

  useEffect(() => {
    if (!selectedSkillId) {
      setSkillDetailPayload(null);
      return;
    }
    void loadSkillDetail(selectedSkillId, { silent: activeTab !== "skills" });
  }, [activeTab, loadSkillDetail, selectedSkillId]);

  useEffect(() => {
    if (!filePickerOpen && !fileRuleDeleteTarget && !skillConfirmAction) {
      return undefined;
    }
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (skillConfirmAction) {
          setSkillConfirmAction(null);
          return;
        }
        if (fileRuleDeleteTarget) {
          setFileRuleDeleteTarget("");
          return;
        }
        setFilePickerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filePickerOpen, fileRuleDeleteTarget, skillConfirmAction]);

  useEffect(() => {
    if (hasPendingDashboardChanges || saving || skillPolicySaving || skillActionLoading) {
      return undefined;
    }
    const timer = setInterval(() => {
      void loadData({ syncRules: true, syncAccounts: true, silent: true });
      void loadDecisionPage({ silent: true });
      void loadSkillData({ silent: true, syncPolicy: true });
      if (selectedSkillId) {
        void loadSkillDetail(selectedSkillId, { silent: true });
      }
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [
    hasPendingDashboardChanges,
    loadData,
    loadDecisionPage,
    loadSkillData,
    loadSkillDetail,
    saving,
    selectedSkillId,
    skillActionLoading,
    skillPolicySaving
  ]);

  const decisions = toArray(statusPayload?.status?.recent_decisions);
  const decisionCounts = decisionPayload?.counts || {
    all: 0,
    allow: 0,
    warn: 0,
    challenge: 0,
    block: 0
  };
  const filteredDecisionTotal = Number(decisionPayload?.total || 0);
  const latestDecision = decisions[0] || null;
  const totalDecisionPages = Math.max(1, Math.ceil(filteredDecisionTotal / DECISIONS_PER_PAGE));
  const pagedDecisions = toArray(decisionPayload?.items);
  const pageItems = buildPageItems(decisionPage, totalDecisionPages);
  const firstDecisionIndex = filteredDecisionTotal === 0 ? 0 : (decisionPage - 1) * DECISIONS_PER_PAGE + 1;
  const lastDecisionIndex = Math.min(decisionPage * DECISIONS_PER_PAGE, filteredDecisionTotal);
  const decisionFilterOptions = [
    { value: "all", count: decisionCounts.all },
    { value: "allow", count: decisionCounts.allow },
    { value: "warn", count: decisionCounts.warn },
    { value: "challenge", count: decisionCounts.challenge },
    { value: "block", count: decisionCounts.block }
  ];

  const stats = {
    total: decisionCounts.all,
    allow: decisionCounts.allow,
    warn: decisionCounts.warn,
    challenge: decisionCounts.challenge,
    block: decisionCounts.block
  };
  const beforeToolDecisions = useMemo(
    () => decisions.filter((item) => item.hook === "before_tool_call"),
    [decisions]
  );
  const analyticsSamples = beforeToolDecisions.length > 0 ? beforeToolDecisions : decisions;
  const policyTitleById = useMemo(() => {
    const table = new Map();
    policies.forEach((policy, index) => {
      if (policy?.rule_id) {
        table.set(policy.rule_id, policyTitle(policy, index));
      }
    });
    return table;
  }, [policies]);
  const messageSourceDistribution = useMemo(
    () => withChartColors(
      buildDistribution(
        analyticsSamples,
        (item) => `${normalizeLabel(item.actor, ui("匿名会话", "Anonymous Session"))} · ${scopeLabel(item.scope)}`,
        { limit: 6, fallbackLabel: ui("未标记", "Unlabeled") }
      ),
      theme
    ),
    [analyticsSamples, theme]
  );
  const decisionSourceDistribution = useMemo(
    () => withChartColors(
      buildDistribution(
        analyticsSamples,
        (item) => (item.decision_source ? decisionSourceLabel(item.decision_source) : ui("未标记", "Unlabeled")),
        { limit: 5, fallbackLabel: ui("未标记", "Unlabeled") }
      ),
      theme
    ),
    [analyticsSamples, theme]
  );
  const strategySource = useMemo(() => {
    const riskSamples = analyticsSamples.filter((item) => item.decision !== "allow");
    return riskSamples.length > 0 ? riskSamples : analyticsSamples;
  }, [analyticsSamples]);
  const strategyHitDistribution = useMemo(() => {
    const counts = new Map();
    strategySource.forEach((item) => {
      parseRuleIds(item.rules).forEach((ruleId) => {
        const label = policyTitleById.get(ruleId) || ruleId;
        counts.set(label, (counts.get(label) || 0) + 1);
      });
    });
    const distribution = Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, activeLocale === "zh-CN" ? "zh-CN" : "en-US"));
    const top = distribution.slice(0, 8);
    const rest = distribution.slice(8).reduce((sum, item) => sum + item.count, 0);
    if (rest > 0) {
      top.push({ label: ui("其他", "Others"), count: rest });
    }
    return withChartColors(top, theme);
  }, [policyTitleById, strategySource, theme]);
  const strategyHitTotal = strategyHitDistribution.reduce((sum, item) => sum + item.count, 0);
  const toolDistribution = useMemo(
    () => withChartColors(
      buildDistribution(
        analyticsSamples,
        (item) => normalizeLabel(item.tool, ui("未知工具", "Unknown Tool")),
        { limit: 6, fallbackLabel: ui("未知工具", "Unknown Tool") }
      ),
      theme
    ),
    [analyticsSamples, theme]
  );
  const chartTheme = CHART_THEME[theme] || CHART_THEME.light;
  const trendSeries = useMemo(() => buildTrendSeries(analyticsSamples), [analyticsSamples]);
  const trendTotals = useMemo(() => trendSeries.buckets.map((bucket) => bucket.total), [trendSeries]);
  const trendRisks = useMemo(() => trendSeries.buckets.map((bucket) => bucket.risk), [trendSeries]);
  const trendData = useMemo(
    () => trendSeries.buckets.map((bucket) => ({
      time: formatClock(bucket.startTs),
      total: bucket.total,
      risk: bucket.risk
    })),
    [trendSeries]
  );
  const trendTickStep = Math.max(1, Math.floor(trendData.length / 6));
  const trendPeak = useMemo(() => Math.max(...trendTotals, 1), [trendTotals]);
  const trendRangeLabel = `${formatClock(trendSeries.start)} - ${formatClock(trendSeries.end)}`;
  const trendTotalCount = trendTotals.reduce((sum, value) => sum + value, 0);
  const trendRiskCount = trendRisks.reduce((sum, value) => sum + value, 0);

  const saveStrategy = useCallback(async (nextStrategyModel) => {
    const normalizedStrategy = normalizeStrategyModel(nextStrategyModel);
    normalizedStrategy.exceptions.directory_overrides = normalizeFileRules(
      normalizedStrategy.exceptions.directory_overrides
    ).map((rule) => ({
      ...rule,
      reason_codes: rule.reason_codes?.length ? rule.reason_codes : [defaultFileRuleReasonCode(rule.decision)],
    }));
    setSaving(true);
    setError("");
    setMessage(ui("策略模型自动保存中...", "Saving strategy model changes..."));
    try {
      const response = await fetch("/api/strategy", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-securityclaw-locale": activeLocale
        },
        body: JSON.stringify({
          strategy: normalizedStrategy
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, ui("保存失败", "Save failed")));
      }
      const suffix = payload.restart_required ? ui(" 需要重启 gateway 后完整生效。", " A gateway restart is required for full effect.") : "";
      const details = `${payload.message || ""}${suffix}`.trim();
      setMessage(
        details
          ? `${ui("策略已自动保存。", "Strategy saved automatically.")} ${details}`
          : ui("策略已自动保存。", "Strategy saved automatically.")
      );
      setPublishedStrategyModel(clone(normalizedStrategy));
      await loadData({ syncRules: false, syncAccounts: false, silent: true });
    } catch (saveError) {
      setError(String(saveError));
      setMessage("");
    } finally {
      setSaving(false);
    }
  }, [loadData]);

  const saveAccounts = useCallback(async (nextAccounts) => {
    const normalizedAccounts = canonicalizeAccountPolicies(pruneAccountPolicyOverrides(nextAccounts));
    setSaving(true);
    setError("");
    setMessage(ui("账号策略自动保存中...", "Saving account policy changes..."));
    try {
      const response = await fetch("/api/accounts", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-securityclaw-locale": activeLocale
        },
        body: JSON.stringify({
          account_policies: normalizedAccounts
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, ui("保存失败", "Save failed")));
      }
      const suffix = payload.restart_required ? ui(" 需要重启 gateway 后完整生效。", " A gateway restart is required for full effect.") : "";
      const details = `${payload.message || ""}${suffix}`.trim();
      setMessage(details ? `${ui("账号策略已自动保存。", "Account policies saved automatically.")} ${details}` : ui("账号策略已自动保存。", "Account policies saved automatically."));
      setPublishedAccountPolicies(clone(normalizedAccounts));
      setAccountPolicies(clone(normalizedAccounts));
      await loadData({ syncRules: false, syncAccounts: false, silent: true });
    } catch (saveError) {
      setError(String(saveError));
      setMessage("");
    } finally {
      setSaving(false);
    }
  }, [loadData]);

  const saveSkillPolicyChanges = useCallback(async () => {
    if (!skillPolicy) {
      return;
    }
    setSkillPolicySaving(true);
    setError("");
    setMessage(ui("Skill 拦截策略保存中...", "Saving skill interception policy..."));
    try {
      const response = await fetch("/api/skills/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-securityclaw-locale": activeLocale
        },
        body: JSON.stringify(skillPolicy)
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, ui("保存失败", "Save failed")));
      }
      const nextPolicy = normalizeSkillPolicyDraft(payload?.policy);
      if (nextPolicy) {
        setPublishedSkillPolicy(clone(nextPolicy));
        setSkillPolicy(clone(nextPolicy));
      }
      setMessage(payload?.message || ui("Skill 拦截策略已保存。", "Skill interception policy saved."));
      await loadSkillData({ silent: true, syncPolicy: true });
      if (selectedSkillId) {
        await loadSkillDetail(selectedSkillId, { silent: true });
      }
    } catch (saveError) {
      setError(String(saveError));
      setMessage("");
    } finally {
      setSkillPolicySaving(false);
    }
  }, [loadSkillData, loadSkillDetail, selectedSkillId, skillPolicy]);

  const runSkillAction = useCallback(async (skillId, action, body = {}) => {
    setSkillActionLoading(`${action}:${skillId}`);
    setError("");
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skillId)}/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-securityclaw-locale": activeLocale
        },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, ui("操作失败", "Action failed")));
      }
      setMessage(payload?.message || ui("Skill 状态已更新。", "Skill status updated."));
      if (payload?.detail) {
        setSkillDetailPayload(payload.detail);
      } else if (selectedSkillId === skillId) {
        await loadSkillDetail(skillId, { silent: true });
      }
      await loadSkillData({ silent: true, syncPolicy: false });
    } catch (actionError) {
      setError(String(actionError));
      setMessage("");
    } finally {
      setSkillActionLoading("");
    }
  }, [loadSkillData, loadSkillDetail, selectedSkillId]);

  useEffect(() => {
    if (loading || saving || (!hasPendingRuleChanges && !hasPendingFileRuleChanges)) {
      return undefined;
    }
    setMessage(
      ui(
        "检测到策略模型变更，正在自动保存...",
        "Strategy model changes detected. Saving automatically..."
      )
    );
    const timer = setTimeout(() => {
      void saveStrategy(strategyModel);
    }, 500);
    return () => clearTimeout(timer);
  }, [hasPendingFileRuleChanges, hasPendingRuleChanges, loading, saveStrategy, saving, strategyModel]);

  useEffect(() => {
    if (loading || saving || !hasPendingAccountChanges) {
      return undefined;
    }
    setMessage(ui("检测到账号策略变更，正在自动保存...", "Account policy changes detected. Saving automatically..."));
    const timer = setTimeout(() => {
      void saveAccounts(accountPolicies);
    }, 500);
    return () => clearTimeout(timer);
  }, [accountPolicies, hasPendingAccountChanges, loading, saveAccounts, saving]);

  useEffect(() => {
    if (decisionLoading) {
      return;
    }
    setDecisionPage((current) => Math.min(current, totalDecisionPages));
  }, [decisionLoading, totalDecisionPages]);

  useEffect(() => {
    if (!activeRuleKey) {
      return;
    }
    const exists = policyEntries.some((entry) => entry.key === activeRuleKey);
    if (!exists) {
      setActiveRuleKey("");
    }
  }, [activeRuleKey, policyEntries]);

  useEffect(() => {
    function updateOffset() {
      const column = rulesColumnRef.current;
      const firstRule = firstRuleRef.current;
      if (!column || !firstRule) {
        setSidePanelOffset(0);
        return;
      }
      const columnTop = column.getBoundingClientRect().top;
      const firstRuleTop = firstRule.getBoundingClientRect().top;
      setSidePanelOffset(Math.max(0, Math.round(firstRuleTop - columnTop)));
    }

    updateOffset();
    window.addEventListener("resize", updateOffset);
    let observer = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(updateOffset);
      if (rulesColumnRef.current) {
        observer.observe(rulesColumnRef.current);
      }
      if (firstRuleRef.current) {
        observer.observe(firstRuleRef.current);
      }
    }

    return () => {
      window.removeEventListener("resize", updateOffset);
      if (observer) {
        observer.disconnect();
      }
    };
  }, [activeTab, firstRuleKey, policyEntries.length]);

  function switchTab(tabId) {
    navigateDashboard({
      tab: tabId,
      decisionFilter,
      decisionPage
    });
  }

  function openSkillWorkspace(skillId = "") {
    if (skillId) {
      setSelectedSkillId(skillId);
    }
    switchTab("skills");
  }

  function openDecisionRecords(filterId) {
    navigateDashboard({
      tab: "events",
      decisionFilter: filterId,
      decisionPage: 1
    });
  }

  function selectDecisionFilter(filterId) {
    navigateDashboard({
      tab: "events",
      decisionFilter: filterId,
      decisionPage: 1
    });
  }

  function updateSkillPolicyDraft(mutator) {
    setSkillPolicy((current) => {
      const next = normalizeSkillPolicyDraft(current);
      if (!next) {
        return current;
      }
      mutator(next);
      return next;
    });
  }

  function updateSkillThreshold(field, value) {
    updateSkillPolicyDraft((next) => {
      next.thresholds[field] = Number(value);
    });
  }

  function updateSkillMatrixDecision(tier, severity, decision) {
    updateSkillPolicyDraft((next) => {
      next.matrix[tier][severity] = decision;
    });
  }

  function updateSkillDefaultAction(key, value) {
    updateSkillPolicyDraft((next) => {
      if (key === "drifted_action") {
        next.defaults.drifted_action = value;
        return;
      }
      if (key === "trust_override_hours") {
        next.defaults.trust_override_hours = Number(value);
        return;
      }
      if (key === "unscanned_S2") {
        next.defaults.unscanned.S2 = value;
        return;
      }
      if (key === "unscanned_S3") {
        next.defaults.unscanned.S3 = value;
      }
    });
  }

  function resetSkillPolicyDraft() {
    setSkillPolicy(normalizeSkillPolicyDraft(publishedSkillPolicy));
  }

  function triggerSkillRescan(skillId) {
    void runSkillAction(skillId, "rescan");
  }

  function requestSkillConfirm(kind, skill, enable) {
    if (!skill?.skill_id) {
      return;
    }
    setSkillConfirmAction({
      kind,
      skillId: skill.skill_id,
      enable,
      skillName: skill.name
    });
  }

  function cancelSkillConfirmAction() {
    setSkillConfirmAction(null);
  }

  function confirmSkillAction() {
    if (!skillConfirmAction?.skillId) {
      return;
    }
    const targetSkillId = skillConfirmAction.skillId;
    if (skillConfirmAction.kind === "quarantine") {
      void runSkillAction(targetSkillId, "quarantine", {
        quarantined: Boolean(skillConfirmAction.enable),
        updated_by: "admin-ui"
      });
      setSkillConfirmAction(null);
      return;
    }
    if (skillConfirmAction.kind === "trust") {
      void runSkillAction(targetSkillId, "trust-override", {
        enabled: Boolean(skillConfirmAction.enable),
        updated_by: "admin-ui",
        hours: Number(skillPolicy?.defaults?.trust_override_hours || 6)
      });
      setSkillConfirmAction(null);
    }
  }

  function onDecisionChange(ruleId, decision) {
    setStrategyModel((current) => updateStrategyRuleDecision(current, ruleId, decision));
  }

  function onRuleCardKeyDown(event, entryKey) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveRuleKey(entryKey);
    }
  }

  function stopRuleCardEvent(event) {
    event.stopPropagation();
  }

  function updateAccountPolicy(subject, patch) {
    const nowIso = new Date().toISOString();
    const session = availableSessions.find((item) => item.subject === subject);
    setAccountPolicies((current) => {
      const currentIndex = current.findIndex((account) => account.subject === subject);
      const base =
        currentIndex >= 0
          ? current[currentIndex]
          : createAccountPolicyDraftFromSession(session, subject);
      const nextAccount = {
        ...base,
        ...patch,
        updated_at: nowIso
      };
      if (currentIndex >= 0) {
        return pruneAccountPolicyOverrides(
          current.map((account, index) => (index === currentIndex ? nextAccount : account))
        );
      }
      return pruneAccountPolicyOverrides([...current, nextAccount]);
    });
  }

  function setAdminAccount(subject) {
    const nowIso = new Date().toISOString();
    const session = availableSessions.find((item) => item.subject === subject);
    setAccountPolicies((current) => {
      let next = current.map((account) =>
        account.subject === subject
          ? {
              ...account,
              is_admin: true,
              updated_at: nowIso
            }
          : account.is_admin
            ? {
                ...account,
                is_admin: false,
                updated_at: nowIso
              }
            : account
      );
      if (!next.some((account) => account.subject === subject) && subject !== DEFAULT_MAIN_ADMIN_SESSION_KEY) {
        next = [
          ...next,
          {
            ...createAccountPolicyDraftFromSession(session, subject),
            is_admin: true,
            updated_at: nowIso
          }
        ];
      }
      if (subject === DEFAULT_MAIN_ADMIN_SESSION_KEY) {
        next = next.map((account) =>
          account.subject === subject
            ? {
                ...account,
                is_admin: false,
                updated_at: nowIso
              }
            : account
        );
      }
      return pruneAccountPolicyOverrides(next);
    });
  }

  function toggleDraftFileRuleOperation(operation) {
    setNewFileRuleOperations((current) => {
      if (operation === "__all__") {
        return [];
      }
      if (!FILE_RULE_OPERATION_OPTIONS.includes(operation)) {
        return current;
      }
      const normalizedCurrent = normalizeFileRuleOperations(current);
      return normalizedCurrent.includes(operation)
        ? normalizedCurrent.filter((entry) => entry !== operation)
        : normalizeFileRuleOperations([...normalizedCurrent, operation]);
    });
  }

  function updateDirectoryFileRule(ruleId, updater) {
    setStrategyModel((currentStrategy) => {
      const normalizedCurrent = strategyDirectoryOverrides(currentStrategy);
      let changed = false;
      const nextRules = normalizedCurrent.map((rule) => {
        if (rule.id !== ruleId) {
          return rule;
        }
        const nextRule = normalizeFileRule(updater(rule));
        if (!nextRule) {
          return rule;
        }
        changed = true;
        return nextRule;
      });
      if (!changed) {
        return currentStrategy;
      }
      const nextTarget = nextRules.find((rule) => rule.id === ruleId);
      if (nextTarget) {
        const duplicate = nextRules.find(
          (rule) => rule.id !== ruleId && fileRuleIdentityKey(rule) === fileRuleIdentityKey(nextTarget)
        );
        if (duplicate) {
          setMessage(
            ui(
              "同一目录和操作范围已经存在另一条例外，请直接修改那条规则。",
              "Another override already covers the same directory and operation scope. Edit that one directly."
            )
          );
          return currentStrategy;
        }
      }
      return withStrategyDirectoryOverrides(currentStrategy, nextRules);
    });
  }

  function setDirectoryFileRuleDecision(ruleId, decision) {
    const normalizedDecision = typeof decision === "string" ? decision.trim() : "";
    if (!ruleId || !normalizedDecision || !DECISION_OPTIONS.includes(normalizedDecision)) {
      return;
    }
    updateDirectoryFileRule(ruleId, (rule) => ({
      ...rule,
      decision: normalizedDecision,
      reason_codes: [defaultFileRuleReasonCode(normalizedDecision)]
    }));
  }

  function setDirectoryFileRuleOperations(ruleId, operations) {
    if (!ruleId) {
      return;
    }
    updateDirectoryFileRule(ruleId, (rule) => ({
      ...rule,
      ...(normalizeFileRuleOperations(operations).length
        ? { operations: normalizeFileRuleOperations(operations) }
        : { operations: undefined })
    }));
  }

  function toggleDirectoryFileRuleOperation(ruleId, operation) {
    const currentRule = normalizedFileRules.find((rule) => rule.id === ruleId);
    if (!currentRule) {
      return;
    }
    const currentOperations = normalizeFileRuleOperations(currentRule.operations);
    if (operation === "__all__") {
      setDirectoryFileRuleOperations(ruleId, []);
      return;
    }
    if (!FILE_RULE_OPERATION_OPTIONS.includes(operation)) {
      return;
    }
    const nextOperations = currentOperations.includes(operation)
      ? currentOperations.filter((entry) => entry !== operation)
      : [...currentOperations, operation];
    setDirectoryFileRuleOperations(ruleId, nextOperations);
  }

  function applySelectedFileRule() {
    if (!selectedFileDirectory) {
      return;
    }
    if (selectedDirectoryRuleExists) {
      setMessage(
        ui(
          "该目录已存在规则，请在下方规则列表里调整处理方式。",
          "A rule already exists for this directory. Edit the action in the rule list below."
        )
      );
      return;
    }
    setStrategyModel((currentStrategy) =>
      withStrategyDirectoryOverrides(currentStrategy, [
        ...strategyDirectoryOverrides(currentStrategy),
        {
          id: `file-rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          directory: selectedFileDirectory,
          decision: newFileRuleDecision,
          ...(normalizedNewFileRuleOperations.length ? { operations: normalizedNewFileRuleOperations } : {}),
          reason_codes: [defaultFileRuleReasonCode(newFileRuleDecision)]
        }
      ])
    );
  }

  function removeFileRule(ruleId) {
    if (!ruleId) {
      return;
    }
    setStrategyModel((currentStrategy) =>
      withStrategyDirectoryOverrides(
        currentStrategy,
        strategyDirectoryOverrides(currentStrategy).filter((rule) => rule.id !== ruleId)
      )
    );
  }

  function requestRemoveFileRule(rule) {
    const normalizedRule = normalizeFileRule(rule);
    if (!normalizedRule) {
      return;
    }
    setFileRuleDeleteTarget(normalizedRule);
  }

  function cancelRemoveFileRule() {
    setFileRuleDeleteTarget(null);
  }

  function confirmRemoveFileRule() {
    if (!fileRuleDeleteTarget?.id) {
      return;
    }
    removeFileRule(fileRuleDeleteTarget.id);
    setFileRuleDeleteTarget(null);
  }

  function closeDirectoryPicker() {
    setFilePickerOpen(false);
    setFilePickerError("");
  }

  function chooseCurrentDirectory() {
    if (!filePickerCurrentPath) {
      return;
    }
    setSelectedFileDirectory(filePickerCurrentPath);
    setFilePickerOpen(false);
    setFilePickerError("");
  }

  const selectedSkill = skillDetailPayload?.skill || skillItems.find((item) => item.skill_id === selectedSkillId) || null;
  const selectedSkillFindings = toArray(skillDetailPayload?.findings || selectedSkill?.findings);
  const selectedSkillActivity = toArray(skillDetailPayload?.activity);
  const accountCount = displayAccounts.length;
  const tabCounts = {
    overview: stats.total,
    events: stats.total,
    rules: policies.length,
    skills: skillOverviewStats.total,
    accounts: accountCount
  };
  const recentBlockCount = decisions.filter((item) => item.decision === "block").length;
  const recentChallengeCount = decisions.filter((item) => item.decision === "challenge").length;
  const recentWarnCount = decisions.filter((item) => item.decision === "warn").length;
  const postureTitle = recentBlockCount > 0
    ? ui("防护规则正在主动拦截风险操作", "Protection rules are actively blocking risky operations")
    : recentChallengeCount > 0
      ? ui("当前以需确认为主的审慎策略", "Current posture emphasizes approval-required decisions")
      : recentWarnCount > 0
        ? ui("当前以提醒为主，规则正在提示潜在风险", "Current posture is warning-first and highlighting potential risk")
      : ui("当前以放行为主，运行相对平稳", "Current posture is mostly allow and relatively stable");
  const postureDescription = latestDecision
    ? `${decisionLabel(latestDecision.decision)} · ${latestDecision.tool || ui("未知操作", "Unknown operation")} · ${resourceScopeLabel(latestDecision.resource_scope)}`
    : ui("等待新的运行数据进入控制台。", "Waiting for new runtime data.");
  const skillPostureTitle = skillOverviewStats.high_critical > 0
    ? ui("Skill 风险面正在重点关注高风险对象", "Skill posture is focused on high-risk items")
    : skillOverviewStats.challenge_block_24h > 0
      ? ui("Skill 扫描整体平稳，但仍有近期拦截活动", "Skill posture is stable overall with recent interceptions")
      : ui("Skill 库整体稳定，当前没有明显高风险对象", "Skill library is stable with no obvious high-risk items");
  const skillPostureDescription = skillOverviewHighlights[0]
    ? `${skillOverviewHighlights[0].name} · ${skillRiskLabel(skillOverviewHighlights[0].risk_tier)} · ${ui("风险分", "Risk")} ${skillOverviewHighlights[0].risk_score}`
    : ui("等待扫描目录中的 Skill 清单同步到概览。", "Waiting for installed skills to sync into overview.");
  const statusTone = error
    ? "error"
    : hasPendingDashboardChanges || saving || skillPolicySaving
      ? "warn"
      : "good";
  const statusMessage = error || message || (hasPendingChanges
    ? ui("检测到策略变更，正在自动保存...", "Strategy changes detected. Saving automatically...")
    : hasPendingSkillPolicyChanges
      ? ui("Skill 拦截策略有未保存修改。", "Skill interception policy has unsaved changes.")
      : "");
  const shouldShowStatus = Boolean(statusMessage);
  const activeRuleEntry = policyEntries.find((entry) => entry.key === activeRuleKey) || null;
  const activeRuleGuide = activeRuleEntry ? ruleImpactGuide(activeRuleEntry.policy, activeRuleEntry.index) : null;
  const activeRuleConversation = activeRuleEntry
    ? buildRuleConversation(activeRuleEntry.policy, activeRuleEntry.index)
    : [];
  const isRuleSideVisible = Boolean(activeRuleEntry && activeRuleGuide);
  const hasActiveDecisionFilter = decisionFilter !== "all";
  const decisionFilterSummary = hasActiveDecisionFilter
    ? ui(`当前筛选：${decisionFilterLabel(decisionFilter)}，共 ${filteredDecisionTotal} 条记录。`, `Filter: ${decisionFilterLabel(decisionFilter)}. ${filteredDecisionTotal} records in total.`)
    : ui(`当前展示全部决策记录，共 ${filteredDecisionTotal} 条。`, `Showing all decision records. ${filteredDecisionTotal} records in total.`);
  const themeControls = [
    {
      value: "system",
      label: ui("跟随系统外观", "Follow system appearance"),
      icon: <ToolbarIconSystem />
    },
    {
      value: "light",
      label: ui("切换到浅色模式", "Switch to light mode"),
      icon: <ToolbarIconSun />
    },
    {
      value: "dark",
      label: ui("切换到暗色模式", "Switch to dark mode"),
      icon: <ToolbarIconMoon />
    }
  ];
  const localeControls = [
    {
      value: "zh-CN",
      label: ui("切换到简体中文", "Switch to Simplified Chinese"),
      icon: <ToolbarMonogram text="文" />
    },
    {
      value: "en",
      label: ui("切换到英文", "Switch to English"),
      icon: <ToolbarMonogram text="A" />
    }
  ];

  function renderFilesystemOverridesSection(inline = true) {
    return (
      <>
        <section
          className={inline ? "sensitive-path-panel sensitive-path-panel-inline" : "sensitive-path-panel"}
          aria-label={ui("目录例外", "Directory overrides")}
        >
          <div className="sensitive-path-head">
            <div>
              <span className="eyebrow">{ui("Directory Overrides", "Directory Overrides")}</span>
              <h3>{ui("目录例外只作用于文件系统", "Directory overrides apply to filesystem only")}</h3>
              <p className="sensitive-path-intro">
                {ui(
                  "目录例外是文件系统域内的覆盖层，不属于某一个具体文件动作。你可以把它收窄到读、枚举、搜索、写入、删除、归档或执行；不选操作时，默认覆盖这个目录下的全部文件类操作。",
                  "Directory overrides are a filesystem-scoped overlay rather than a child of one specific file action. You can narrow them to read, list, search, write, delete, archive, or execute. Leaving the scope empty applies the override to all filesystem-related operations in that directory."
                )}
              </p>
            </div>
            <div className="rule-meta">
              <span className="meta-pill">{ui("目录例外", "Directory Overrides")} {normalizedFileRules.length}</span>
              <span className="meta-pill">{selectedFileDirectory ? ui("已选择目录", "Directory Selected") : ui("未选择目录", "No Directory Selected")}</span>
            </div>
          </div>

          <div className="sensitive-path-toolbar">
            <button className="ghost" type="button" onClick={openDirectoryPicker}>
              {ui("选择目录", "Choose Directory")}
            </button>

            <div className="sensitive-path-selected" title={selectedFileDirectory || undefined}>
              {selectedFileDirectory || ui("尚未选择目录", "No directory selected yet")}
            </div>

            <label className="sensitive-path-field file-rule-action-field">
              <span>{ui("处理方式", "Action")}</span>
              <select value={newFileRuleDecision} onChange={(event) => setNewFileRuleDecision(event.target.value)}>
                {DECISION_OPTIONS.map((decisionOption) => (
                  <option key={decisionOption} value={decisionOption}>{decisionLabel(decisionOption)}</option>
                ))}
              </select>
            </label>

            <label className="sensitive-path-field sensitive-path-field-wide">
              <span>{ui("适用操作", "Applies to operations")}</span>
              <FileRuleOperationSelector
                operations={newFileRuleOperations}
                onToggle={toggleDraftFileRuleOperation}
              />
            </label>

            <button
              className="primary"
              type="button"
              disabled={!selectedFileDirectory || selectedDirectoryRuleExists}
              onClick={applySelectedFileRule}
            >
              {ui("添加", "Add")}
            </button>
          </div>

          {selectedDirectoryRuleExists ? (
            <div className="sensitive-path-validation">
              {ui(
                "当前目录和操作范围已存在例外。若需调整，请在下方已配置目录例外列表中修改。",
                "A directory override already exists for the same directory and operation scope. Edit it in the configured list below."
              )}
            </div>
          ) : null}

          <div className="sensitive-path-note">
            {ui(
              `目录例外只影响文件系统相关操作，不会改动 ${capabilityLabel("network")}、${capabilityLabel("runtime")} 等其他能力。若命中目录例外，当前目录会优先按这里的处理方式执行；删掉后再回落到默认策略和附加限制。`,
              `Directory overrides only affect filesystem-related operations and do not change other capabilities such as ${capabilityLabel("network")} or ${capabilityLabel("runtime")}. When an override matches, it takes precedence for that directory; deleting it falls back to the baseline policy and additional restrictions.`
            )}
          </div>

          {normalizedFileRules.length === 0 ? (
            <div className="chart-empty">{ui("当前没有配置目录例外。", "No directory overrides configured yet.")}</div>
          ) : (
            <div className="sensitive-path-list">
              {normalizedFileRules.map((rule) => (
                <article key={rule.id} className="sensitive-path-item configured">
                  <div className="sensitive-path-item-main">
                    <div className="sensitive-path-item-pattern">{rule.directory}</div>
                    <div className="sensitive-path-item-tags">
                      <span className={`tag ${rule.decision}`}>{decisionLabel(rule.decision)}</span>
                      <span className="tag meta-tag">{fileRuleOperationsSummary(rule)}</span>
                    </div>
                  </div>
                  <div className="file-rule-item-actions">
                    <label className="sensitive-path-field file-rule-action-field">
                      <span>{ui("处理方式", "Action")}</span>
                      <select
                        value={rule.decision}
                        onChange={(event) => setDirectoryFileRuleDecision(rule.id, event.target.value)}
                      >
                        {DECISION_OPTIONS.map((decisionOption) => (
                          <option key={decisionOption} value={decisionOption}>{decisionLabel(decisionOption)}</option>
                        ))}
                      </select>
                    </label>
                    <label className="sensitive-path-field sensitive-path-field-wide">
                      <span>{ui("适用操作", "Applies to operations")}</span>
                      <FileRuleOperationSelector
                        operations={rule.operations}
                        onToggle={(operation) => toggleDirectoryFileRuleOperation(rule.id, operation)}
                      />
                    </label>
                    <button className="ghost small" type="button" onClick={() => requestRemoveFileRule(rule)}>
                      {ui("删除", "Remove")}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {filePickerOpen ? (
          <div className="directory-picker-backdrop" role="dialog" aria-modal="true" aria-label={ui("目录选择器", "Directory picker")} onClick={closeDirectoryPicker}>
            <div className="directory-picker-card" onClick={(event) => event.stopPropagation()}>
              <div className="directory-picker-head">
                <h4>{ui("选择目录", "Choose Directory")}</h4>
                <button className="ghost small" type="button" onClick={closeDirectoryPicker}>
                  {ui("关闭", "Close")}
                </button>
              </div>
              <div className="directory-picker-toolbar">
                <button
                  className="ghost small"
                  type="button"
                  disabled={!filePickerParentPath || filePickerLoading}
                  onClick={() => void loadDirectoryPicker(filePickerParentPath)}
                >
                  {ui("上级目录", "Up")}
                </button>
                <div className="directory-picker-current">{filePickerCurrentPath || "-"}</div>
                <button className="primary small" type="button" disabled={!filePickerCurrentPath} onClick={chooseCurrentDirectory}>
                  {ui("选择当前目录", "Select Current Directory")}
                </button>
              </div>

              {filePickerRoots.length > 0 ? (
                <div className="directory-picker-roots">
                  {filePickerRoots.map((root) => (
                    <button
                      key={root}
                      className="ghost small"
                      type="button"
                      onClick={() => void loadDirectoryPicker(root)}
                      disabled={filePickerLoading}
                    >
                      {root}
                    </button>
                  ))}
                </div>
              ) : null}

              {filePickerError ? <div className="sensitive-path-validation">{filePickerError}</div> : null}

              <div className="directory-picker-list">
                {filePickerLoading ? (
                  <div className="chart-empty">{ui("目录加载中...", "Loading directories...")}</div>
                ) : filePickerDirectories.length === 0 ? (
                  <div className="chart-empty">{ui("当前目录没有可进入的子目录。", "No child directories in current path.")}</div>
                ) : (
                  filePickerDirectories.map((entry) => (
                    <button
                      key={entry.path}
                      className="directory-picker-item"
                      type="button"
                      onClick={() => void loadDirectoryPicker(entry.path)}
                    >
                      <span className="directory-picker-item-name">{entry.name}</span>
                      <span className="directory-picker-item-path">{entry.path}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}

        {fileRuleDeleteTarget ? (
          <div
            className="confirm-dialog-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={ui("删除确认", "Delete confirmation")}
            onClick={cancelRemoveFileRule}
          >
            <div className="confirm-dialog-card" onClick={(event) => event.stopPropagation()}>
              <h4>{ui("确认删除这条目录例外？", "Delete this directory override?")}</h4>
              <p className="confirm-dialog-text">
                {ui(
                  "删除后，这个目录会回落到文件系统默认策略和附加限制继续判断。",
                  "After deletion, this directory falls back to the filesystem baseline and additional restrictions."
                )}
              </p>
              <div className="confirm-dialog-path">{fileRuleDeleteTarget.directory}</div>
              <div className="confirm-dialog-text">{fileRuleOperationsSummary(fileRuleDeleteTarget)}</div>
              <div className="confirm-dialog-actions">
                <button className="ghost small" type="button" onClick={cancelRemoveFileRule}>
                  {ui("取消", "Cancel")}
                </button>
                <button className="primary small" type="button" onClick={confirmRemoveFileRule}>
                  {ui("确认删除", "Delete")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="app">
      <section className="workspace card">
        <div className="workspace-top">
          <div className="workspace-title">
            <div className="workspace-kicker">
              <img src="/favicon.svg" alt="" className="workspace-favicon" aria-hidden="true" />
              {ADMIN_BRAND_TEXT}
            </div>
            <h1>{ui("管理后台", "Admin Dashboard")}</h1>
            <div className="tablist" role="tablist" aria-label={ui("后台模块页签", "Dashboard tabs")}>
              {TAB_ITEMS.map((tab) => (
                <button
                  key={tab.id}
                  id={`tab-${tab.id}`}
                  className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls={`panel-${tab.id}`}
                  onClick={() => switchTab(tab.id)}
                >
                  <span className="tab-label">{tabLabel(tab.id)}</span>
                  <span className="tab-count">{tabCounts[tab.id]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar-controls">
            <div className="control-group" role="group" aria-label={ui("外观设置", "Appearance settings")}>
              {themeControls.map((item) => (
                <button
                  key={item.value}
                  className={`toolbar-icon-button ${themePreference === item.value ? "active" : ""}`}
                  type="button"
                  aria-label={item.label}
                  aria-pressed={themePreference === item.value}
                  title={item.label}
                  onClick={() => setThemePreference(item.value)}
                >
                  {item.icon}
                </button>
              ))}
            </div>
            <div className="control-group" role="group" aria-label={ui("语言设置", "Language settings")}>
              {localeControls.map((item) => (
                <button
                  key={item.value}
                  className={`toolbar-icon-button toolbar-icon-button-text ${locale === item.value ? "active" : ""}`}
                  type="button"
                  aria-label={item.label}
                  aria-pressed={locale === item.value}
                  title={item.label}
                  onClick={() => setLocale(resolveSecurityClawLocale(item.value, "en"))}
                >
                  {item.icon}
                </button>
              ))}
            </div>
          </div>
        </div>

        {shouldShowStatus ? (
          <div className={`status-inline status-banner ${statusTone}`}>
            <span className="status-dot" />
            <span>{statusMessage}</span>
          </div>
        ) : null}

        {activeTab === "overview" ? (
          <section
            id="panel-overview"
            className="tab-panel overview-panel"
            role="tabpanel"
            aria-labelledby="tab-overview"
          >
            <div className="panel-card overview-shell dashboard-panel">
              <div className="card-head">
                <h2>{ui("概览", "Overview")}</h2>
              </div>
              <div className="overview-grid">
                <div className="panel-card">
                  <div className="stats">
                    <OverviewStatCard
                      label={ui("决策记录", "Decision Records")}
                      value={stats.total}
                      onClick={() => openDecisionRecords("all")}
                    />
                    <OverviewStatCard
                      label={ui("放行", "Allow")}
                      value={stats.allow}
                      tone="good"
                      onClick={() => openDecisionRecords("allow")}
                    />
                    <OverviewStatCard
                      label={ui("提醒", "Warn")}
                      value={stats.warn}
                      tone="warn"
                      onClick={() => openDecisionRecords("warn")}
                    />
                    <OverviewStatCard
                      label={ui("需确认", "Needs Approval")}
                      value={stats.challenge}
                      tone="warn"
                      onClick={() => openDecisionRecords("challenge")}
                    />
                    <OverviewStatCard
                      label={ui("拦截", "Block")}
                      value={stats.block}
                      tone="bad"
                      onClick={() => openDecisionRecords("block")}
                    />
                  </div>
                </div>

                <aside className="panel-card insight-card">
                  <div className="insight-head">
                    <span className="eyebrow">{ui("当前态势", "Current Posture")}</span>
                    <h3>{postureTitle}</h3>
                    <p>{postureDescription}</p>
                  </div>
                  <div className="insight-list">
                    <div className="insight-item">
                      <span>{ui("需确认占比", "Approval Ratio")}</span>
                      <strong>{formatPercent(stats.challenge, stats.total)}</strong>
                    </div>
                    <div className="insight-item">
                      <span>{ui("拦截占比", "Block Ratio")}</span>
                      <strong>{formatPercent(stats.block, stats.total)}</strong>
                    </div>
                    <div className="insight-item">
                      <span>{ui("规则分组", "Rule Groups")}</span>
                      <strong>{groupedPolicies.length}</strong>
                    </div>
                    <div className="insight-item">
                      <span>{ui("生效规则", "Active Rules")}</span>
                      <strong>{policies.length}</strong>
                    </div>
                  </div>
                </aside>

                <article className="panel-card overview-skill-card">
                  <div className="overview-skill-head">
                    <div>
                      <span className="eyebrow">{ui("Skill 拦截", "Skill Interception")}</span>
                      <h3>{skillPostureTitle}</h3>
                      <p>{skillPostureDescription}</p>
                    </div>
                    <button
                      className="ghost small"
                      type="button"
                      onClick={() => openSkillWorkspace()}
                    >
                      {ui("查看 Skill 面板", "Open Skill Panel")}
                    </button>
                  </div>

                  <div className="overview-skill-stats">
                    <div className="overview-skill-stat">
                      <span>{ui("已发现 Skill", "Discovered Skills")}</span>
                      <strong>{skillOverviewStats.total}</strong>
                    </div>
                    <div className="overview-skill-stat">
                      <span>{ui("高风险 / 严重", "High / Critical")}</span>
                      <strong>{skillOverviewStats.high_critical}</strong>
                    </div>
                    <div className="overview-skill-stat">
                      <span>{ui("24 小时需确认 / 拦截", "24h Challenge / Block")}</span>
                      <strong>{skillOverviewStats.challenge_block_24h}</strong>
                    </div>
                    <div className="overview-skill-stat">
                      <span>{ui("未声明变更告警", "Undeclared Change Alerts")}</span>
                      <strong>{skillOverviewStats.drift_alerts}</strong>
                    </div>
                    <div className="overview-skill-stat">
                      <span>{ui("已隔离", "Quarantined")}</span>
                      <strong>{skillOverviewStats.quarantined}</strong>
                    </div>
                  </div>

                  {skillOverviewHighlights.length === 0 ? (
                    <div className="chart-empty">
                      {ui("当前还没有可展示的 Skill 风险快照。", "No skill highlights are available yet.")}
                    </div>
                  ) : (
                    <div className="overview-skill-highlights">
                      {skillOverviewHighlights.map((skill) => (
                        <button
                          key={skill.skill_id}
                          className="overview-skill-item"
                          type="button"
                          onClick={() => openSkillWorkspace(skill.skill_id)}
                        >
                          <div className="overview-skill-item-main">
                            <div className="overview-skill-item-head">
                              <strong>{skill.name}</strong>
                              <div className="skill-row-tags">
                                <span className={`tag meta-tag severity-${skill.risk_tier}`}>{skillRiskLabel(skill.risk_tier)}</span>
                                {skill.quarantined ? <span className="tag block">{ui("已隔离", "Quarantined")}</span> : null}
                                {!skill.quarantined && skill.is_drifted ? <span className="tag warn">{ui("内容已变更", "Changed Without Version Update")}</span> : null}
                              </div>
                            </div>
                            <div className="overview-skill-item-meta">
                              {skillSourceLabel(skill.source)} · {ui("风险分", "Risk")} {skill.risk_score} · {ui("24h 拦截", "24h Intercepts")} {skill.intercept_count_24h}
                            </div>
                          </div>
                          <div className="overview-skill-item-side">
                            <span>{ui("最近扫描", "Last Scan")}</span>
                            <strong>{formatTime(skill.last_scan_at || skill.last_seen_at)}</strong>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              </div>

              <div className="overview-charts">
                <DistributionChart
                  title={ui("消息来源分布", "Message Source Distribution")}
                  subtitle="actor + scope"
                  items={messageSourceDistribution}
                  total={analyticsSamples.length}
                  emptyText={ui("暂无消息来源数据", "No source data yet")}
                  theme={theme}
                />

                <DistributionChart
                  title={ui("决策来源分布", "Decision Source Distribution")}
                  subtitle="rule / default / approval / account"
                  items={decisionSourceDistribution}
                  total={analyticsSamples.length}
                  emptyText={ui("暂无决策来源数据", "No decision source data yet")}
                  theme={theme}
                />

                <DistributionChart
                  title={ui("拦截策略命中 Top", "Top Policy Hits")}
                  subtitle={strategySource.length > 0 ? ui("按规则命中次数排序", "Sorted by hit count") : ui("暂无风险样本", "No risk samples")}
                  items={strategyHitDistribution}
                  total={strategyHitTotal}
                  emptyText={ui("暂无策略命中记录", "No policy hit records")}
                  theme={theme}
                />

                <DistributionChart
                  title={ui("工具调用分布", "Tool Call Distribution")}
                  subtitle={ui("按最近样本聚合", "Aggregated from recent samples")}
                  items={toolDistribution}
                  total={analyticsSamples.length}
                  emptyText={ui("暂无工具调用记录", "No tool call records")}
                  theme={theme}
                />

                <article className="panel-card chart-card trend-card">
                  <div className="chart-head">
                    <h3>{ui("24 小时趋势", "24h Trend")}</h3>
                    <span className="chart-subtitle">{trendRangeLabel}{ui("（", " (")}{trendSeries.bucketHours}h {ui("/ 桶）", "per bucket)")}</span>
                  </div>
                  <div className="chart-surface">
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={trendData} margin={{ top: 12, right: 24, left: 4, bottom: 0 }}>
                        <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                        <XAxis
                          dataKey="time"
                          tick={{ fill: chartTheme.tick, fontSize: 12 }}
                          tickFormatter={(value, index) => (index % trendTickStep === 0 ? value : "")}
                          axisLine={{ stroke: chartTheme.axis }}
                          tickLine={false}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fill: chartTheme.tick, fontSize: 12 }}
                          axisLine={{ stroke: chartTheme.axis }}
                          tickLine={false}
                        />
                        <Tooltip content={<ChartTooltip />} />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="total"
                          name={ui("总请求", "Total Requests")}
                          stroke={chartTheme.total}
                          strokeWidth={2.5}
                          dot={{ r: 2 }}
                          activeDot={{ r: 4 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="risk"
                          name={ui("风险请求", "Risk Requests")}
                          stroke={chartTheme.risk}
                          strokeWidth={2.5}
                          dot={{ r: 2 }}
                          activeDot={{ r: 4 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="trend-meta">
                    <div className="trend-legend">
                      <span className="trend-chip total">{ui("总请求", "Total")} {trendTotalCount}</span>
                      <span className="trend-chip risk">{ui("风险请求", "Risk")} {trendRiskCount}</span>
                    </div>
                    <span className="trend-peak">{ui("峰值", "Peak")} {trendPeak}</span>
                  </div>
                </article>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "events" ? (
          <section
            id="panel-events"
            className="tab-panel"
            role="tabpanel"
            aria-labelledby="tab-events"
          >
            <div className="panel-card dashboard-panel">
              <div className="card-head card-head-compact">
                <h2>{ui("拦截记录", "Interceptions")}</h2>
                <div className="header-actions">
                  {hasActiveDecisionFilter ? (
                    <span className="meta-pill meta-pill-highlight">
                      {ui("筛选", "Filter")} {decisionFilterLabel(decisionFilter)}
                    </span>
                  ) : null}
                  <button
                    className="ghost small"
                    type="button"
                    onClick={() =>
                      Promise.all([
                        loadData({
                          syncRules: !hasPendingChanges && !saving,
                          syncAccounts: !hasPendingChanges && !saving,
                          silent: false
                        }),
                        loadDecisionPage({ silent: false })
                      ])
                    }
                  >
                    {ui("刷新", "Refresh")}
                  </button>
                </div>
              </div>
              <div className="decision-toolbar">
                <div className="decision-filter-group" role="group" aria-label={ui("决策筛选", "Decision filters")}>
                  {decisionFilterOptions.map((option) => (
                    <button
                      key={option.value}
                      className={`filter-chip ${decisionFilter === option.value ? "active" : ""}`}
                      type="button"
                      aria-pressed={decisionFilter === option.value}
                      onClick={() => selectDecisionFilter(option.value)}
                    >
                      <span>{decisionFilterLabel(option.value)}</span>
                      <span className="filter-chip-count">{option.count}</span>
                    </button>
                  ))}
                </div>
                <div className="decision-toolbar-note">{decisionFilterSummary}</div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{ui("时间", "Time")}</th>
                      <th>{ui("决策", "Decision")}</th>
                      <th>{ui("来源", "Source")}</th>
                      <th>{ui("资源范围", "Resource Scope")}</th>
                      <th>{ui("环节", "Hook")}</th>
                      <th>{ui("操作", "Tool")}</th>
                      <th>{ui("原因", "Reasons")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDecisionTotal === 0 ? (
                      <tr>
                        <td colSpan={7}>
                          {loading || decisionLoading
                            ? ui("加载中...", "Loading...")
                            : hasActiveDecisionFilter
                              ? ui(`暂无“${decisionFilterLabel(decisionFilter)}”记录`, `No "${decisionFilterLabel(decisionFilter)}" records`)
                              : ui("暂无决策记录", "No decision records")}
                        </td>
                      </tr>
                    ) : (
                      pagedDecisions.map((item, index) => (
                        <tr key={`${item.trace_id || "trace"}-${firstDecisionIndex + index}`}>
                          <td>{formatTime(item.ts)}</td>
                          <td>
                            <DecisionTag decision={item.decision} />
                          </td>
                          <td>{decisionSourceLabel(item.decision_source)}</td>
                          <td>{resourceScopeLabel(item.resource_scope)}</td>
                          <td>{item.hook || "-"}</td>
                          <td>{item.tool || "-"}</td>
                          <td>{toArray(item.reasons).join(ui("，", ", ")) || "-"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {filteredDecisionTotal > 0 ? (
                <div className="pagination">
                  <div className="pagination-summary">
                    {ui("显示", "Showing")} {firstDecisionIndex}-{lastDecisionIndex} / {filteredDecisionTotal} · {ui("第", "Page ")}{decisionPage} / {totalDecisionPages}
                  </div>
                  <div className="pagination-controls">
                    <button
                      className="ghost small"
                      type="button"
                      disabled={decisionPage === 1}
                      onClick={() =>
                        navigateDashboard({
                          tab: "events",
                          decisionFilter,
                          decisionPage: Math.max(1, decisionPage - 1)
                        })
                      }
                    >
                      {ui("上一页", "Prev")}
                    </button>
                    {pageItems.map((page) => (
                      <button
                        key={page}
                        className={`page-button ${page === decisionPage ? "active" : ""}`}
                        type="button"
                        aria-current={page === decisionPage ? "page" : undefined}
                        onClick={() =>
                          navigateDashboard({
                            tab: "events",
                            decisionFilter,
                            decisionPage: page
                          })
                        }
                      >
                        {page}
                      </button>
                    ))}
                    <button
                      className="ghost small"
                      type="button"
                      disabled={decisionPage === totalDecisionPages}
                      onClick={() =>
                        navigateDashboard({
                          tab: "events",
                          decisionFilter,
                          decisionPage: Math.min(totalDecisionPages, decisionPage + 1)
                        })
                      }
                    >
                      {ui("下一页", "Next")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeTab === "rules" ? (
          <section
            id="panel-rules"
            className="tab-panel"
            role="tabpanel"
            aria-labelledby="tab-rules"
          >
            <div className="panel-card strategy-panel dashboard-panel">
              <div className="card-head">
                <h2>{ui("策略", "Strategy")}</h2>
                <div className="rule-meta">
                  <span className="meta-pill">{ui("能力", "Capabilities")} {capabilityPolicies.length}</span>
                  <span className="meta-pill">{ui("附加限制", "Additional Restrictions")} {policies.length}</span>
                  <span className="meta-pill">{ui("目录例外", "Directory Overrides")} {normalizedFileRules.length}</span>
                </div>
              </div>

              <section className="rule-group rule-group-shell" aria-label={ui("访问基线", "Access baseline")}>
                <div className="card-head">
                  <div>
                    <span className="eyebrow">{ui("Access", "Access")}</span>
                    <h3>{ui("先看能力默认策略，再看附加限制", "Capability baseline first, then additional restrictions")}</h3>
                    <p className="sensitive-path-intro">
                      {ui(
                        "先定义每类能力的默认处理方式，再看哪些风险条件会升级成提醒、确认或拦截。需要管理员确认的规则会在执行时生成审批单，策略页不再展示工单、角色、trace 绑定这类内部审批字段。",
                        "Define the default posture for each capability first, then inspect which risk conditions escalate to warn, challenge, or block. Rules that need admin approval will still generate approval requests at runtime, but this page no longer exposes internal fields such as ticket, role, or trace binding."
                      )}
                    </p>
                  </div>
                </div>

                {capabilityPolicies.length === 0 ? (
                  <div className="chart-empty">{ui("暂无能力配置。", "No capability policies configured.")}</div>
                ) : (
                  <div className="rule-capability-list">
                    {capabilityPolicies.map((capability) => (
                      <section key={capability.capability_id} className="rule-group rule-capability-group">
                        <div className="rule-head rule-capability-head">
                          <div>
                            <div className="rule-title">{capabilityLabel(capability.capability_id)}</div>
                            <div className="rule-desc">
                              {capabilityDescription(capability.capability_id)}
                            </div>
                          </div>
                          <div className="rule-head-side">
                            <DecisionTag decision={capability.default_decision} />
                            <span className="tag meta-tag">{ui("Baseline", "Baseline")}</span>
                          </div>
                        </div>

                        <div className="rule-actions" role="group" aria-label={ui(`${capabilityLabel(capability.capability_id)} 默认策略`, `${capabilityLabel(capability.capability_id)} baseline policy`)}>
                          {DECISION_OPTIONS.map((decision) => (
                            <button
                              key={`${capability.capability_id}-${decision}`}
                              className={`rule-action-button ${decision} ${capability.default_decision === decision ? "active" : ""}`}
                              type="button"
                              aria-pressed={capability.default_decision === decision}
                              onClick={() =>
                                setStrategyModel((current) =>
                                  updateStrategyCapabilityDefaultDecision(current, capability.capability_id, decision)
                                )
                              }
                            >
                              {decisionLabel(decision)}
                            </button>
                          ))}
                        </div>

                        <div className={`rule-helper ${capability.default_decision}`}>
                          <span className="rule-helper-label">
                            {ui("默认策略说明", "Baseline effect")} · {decisionLabel(capability.default_decision)}
                          </span>
                          <p>{capabilityBaselineSummary(capability)}</p>
                        </div>

                        {toArray(capability.rules).length === 0 ? (
                          <div className="chart-empty">{ui("当前能力下没有额外附加限制。", "No additional restrictions for this capability.")}</div>
                        ) : (
                          <div className="rules">
                            {toArray(capability.rules).map((rule, index) => {
                              const policy = { ...rule, match: rule.context };
                              return (
                                <article key={`${capability.capability_id}:${rule.rule_id || index}`} className="rule">
                                  <div className="rule-head">
                                    <div className="rule-title">{policyTitle(policy, index)}</div>
                                    <div className="rule-head-side">
                                      <DecisionTag decision={rule.decision} />
                                      <div className="rule-tags" aria-label={ui("规则标签", "Rule tags")}>
                                        <span className="tag meta-tag">{controlDomainLabel(rule.control_domain || rule.group)}</span>
                                        {rule.severity ? <span className={`tag meta-tag severity-${rule.severity}`}>{severityLabel(rule.severity)}</span> : null}
                                        {rule.owner ? <span className="tag meta-tag">{rule.owner}</span> : null}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="rule-actions" role="group" aria-label={ui(`规则 ${rule.rule_id || index + 1} 的策略动作`, `Policy actions for rule ${rule.rule_id || index + 1}`)}>
                                    {DECISION_OPTIONS.map((decision) => (
                                      <button
                                        key={`${rule.rule_id}-${decision}`}
                                        className={`rule-action-button ${decision} ${rule.decision === decision ? "active" : ""}`}
                                        type="button"
                                        aria-pressed={rule.decision === decision}
                                        onClick={() => onDecisionChange(rule.rule_id, decision)}
                                      >
                                        {decisionLabel(decision)}
                                      </button>
                                    ))}
                                  </div>
                                  <div className="rule-desc">{ruleDescription(policy)}</div>
                                  <div className={`rule-helper ${rule.decision}`}>
                                    <span className="rule-helper-label">
                                      {ui("当前处理方式", "Current handling")} · {decisionLabel(rule.decision)}
                                    </span>
                                    <p>{userImpactSummary(rule)}</p>
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        )}

                        {capability.capability_id === "filesystem" ? renderFilesystemOverridesSection(true) : null}
                      </section>
                    ))}
                  </div>
                )}
              </section>

              {!hasFilesystemCapability ? renderFilesystemOverridesSection(false) : null}
            </div>
          </section>
        ) : null}

        {activeTab === "skills" ? (
          <section
            id="panel-skills"
            className="tab-panel"
            role="tabpanel"
            aria-labelledby="tab-skills"
          >
            <div className="panel-card skills-panel dashboard-panel">
              <div className="card-head">
                <div>
                  <h2>{ui("Skill", "Skill")}</h2>
                  <p className="skills-intro">
                    {ui(
                      "后台会自动发现本地已安装 skills，给出风险等级、内容是否发生未声明变更，以及人工处置入口。低风险默认无感，高风险行为集中在详情和策略区处理。",
                      "The dashboard discovers locally installed skills, scores their risk, highlights content changes without version updates, and exposes admin actions. Low-risk skills stay quiet while high-risk handling is concentrated in the detail and policy areas."
                    )}
                  </p>
                </div>
                <div className="header-actions">
                  <span className="meta-pill">{ui("扫描目录", "Roots")} {toArray(skillStatusPayload?.roots).length}</span>
                  <button
                    className="ghost small"
                    type="button"
                    onClick={() => void loadSkillData({ silent: false, syncPolicy: !hasPendingSkillPolicyChanges })}
                  >
                    {ui("刷新", "Refresh")}
                  </button>
                </div>
              </div>

              <div className="skills-metrics">
                <OverviewStatCard
                  label={ui("已发现 Skill", "Discovered Skills")}
                  value={skillOverviewStats.total}
                />
                <OverviewStatCard
                  label={ui("高风险 / 严重", "High / Critical")}
                  value={skillOverviewStats.high_critical}
                  tone="bad"
                />
                <OverviewStatCard
                  label={ui("24 小时需确认 / 拦截", "24h Challenge / Block")}
                  value={skillOverviewStats.challenge_block_24h}
                  tone="warn"
                />
                <OverviewStatCard
                  label={ui("未声明变更告警", "Undeclared Change Alerts")}
                  value={skillOverviewStats.drift_alerts}
                  tone="warn"
                />
                <OverviewStatCard
                  label={ui("已隔离", "Quarantined")}
                  value={skillOverviewStats.quarantined}
                  tone="bad"
                />
                <OverviewStatCard
                  label={ui("受信覆盖", "Trust Overrides")}
                  value={skillOverviewStats.trusted_overrides}
                />
              </div>

              <div className="skills-layout">
                <div className="panel-card skill-list-panel">
                  <div className="skill-list-head">
                    <div>
                      <span className="eyebrow">{ui("筛选与列表", "Filters and List")}</span>
                      <h3>{ui("优先按风险和处置状态收敛视图", "Narrow the list by risk and disposition")}</h3>
                    </div>
                    <div className="rule-meta">
                      <span className="meta-pill">{ui("列表总数", "Listed")} {skillItems.length}</span>
                      <span className="meta-pill">{ui("最近有拦截", "Recent Intercepts")} {skillSummaryCounts.recent_intercepts}</span>
                    </div>
                  </div>

                  <div className="skills-toolbar">
                    <label className="skill-filter-field">
                      <span>{ui("风险", "Risk")}</span>
                      <select value={skillRiskFilter} onChange={(event) => setSkillRiskFilter(event.target.value)}>
                        {SKILL_RISK_FILTER_OPTIONS.map((option) => (
                          <option key={option} value={option}>{skillRiskFilterLabel(option)}</option>
                        ))}
                      </select>
                    </label>

                    <label className="skill-filter-field">
                      <span>{ui("状态", "State")}</span>
                      <select value={skillStateFilter} onChange={(event) => setSkillStateFilter(event.target.value)}>
                        {SKILL_STATE_FILTER_OPTIONS.map((option) => (
                          <option key={option} value={option}>{skillStateFilterLabel(option)}</option>
                        ))}
                      </select>
                    </label>

                    <label className="skill-filter-field">
                      <span>{ui("来源", "Source")}</span>
                      <select value={skillSourceFilter} onChange={(event) => setSkillSourceFilter(event.target.value)}>
                        <option value="all">{ui("全部来源", "All Sources")}</option>
                        {skillSourceOptions.map((option) => (
                          <option key={option} value={option}>{skillSourceLabel(option)}</option>
                        ))}
                      </select>
                    </label>

                    <label className="skill-filter-field">
                      <span>{ui("内容变更", "Change Status")}</span>
                      <select value={skillDriftFilter} onChange={(event) => setSkillDriftFilter(event.target.value)}>
                        {SKILL_DRIFT_FILTER_OPTIONS.map((option) => (
                          <option key={option} value={option}>{skillDriftFilterLabel(option)}</option>
                        ))}
                      </select>
                    </label>

                    <label className="skill-filter-field">
                      <span>{ui("拦截", "Interception")}</span>
                      <select value={skillInterceptFilter} onChange={(event) => setSkillInterceptFilter(event.target.value)}>
                        {SKILL_INTERCEPT_FILTER_OPTIONS.map((option) => (
                          <option key={option} value={option}>{skillInterceptFilterLabel(option)}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {skillListLoading ? (
                    <div className="chart-empty">{ui("Skill 列表加载中...", "Loading skills...")}</div>
                  ) : skillItems.length === 0 ? (
                    <div className="chart-empty">
                      {ui("当前筛选下没有匹配的 Skill。", "No skills match the current filters.")}
                    </div>
                  ) : (
                    <div className="skill-list">
                      {skillItems.map((skill) => (
                        <button
                          key={skill.skill_id}
                          className={`skill-row ${selectedSkillId === skill.skill_id ? "active" : ""}`}
                          type="button"
                          onClick={() => setSelectedSkillId(skill.skill_id)}
                        >
                          <div className="skill-row-main">
                            <div className="skill-row-head">
                              <div>
                                <div className="skill-row-title">{skill.name}</div>
                                <div className="skill-row-meta">
                                  {skill.version || ui("未声明版本", "No version declared")}
                                  {" · "}
                                  {skill.author || ui("未声明作者", "No author declared")}
                                </div>
                              </div>
                              <div className="skill-row-tags">
                                <span className={`tag meta-tag severity-${skill.risk_tier}`}>{skillRiskLabel(skill.risk_tier)}</span>
                                <span className={`tag ${skill.state === "quarantined" ? "block" : skill.state === "trusted" ? "warn" : "allow"}`}>
                                  {skillStateLabel(skill.state)}
                                </span>
                              </div>
                            </div>

                            <div className="skill-row-subline">{skillSourceLabel(skill.source, skill.source_detail)}</div>

                            <div className="skill-row-foot">
                              <span>{ui("最近扫描", "Last scan")} {formatTime(skill.last_scan_at || skill.last_seen_at)}</span>
                              <span>{ui("近 24h 拦截", "24h intercepts")} {skill.intercept_count_24h}</span>
                              <span>{ui("哈希", "Hash")} {formatHash(skill.current_hash, 12)}</span>
                            </div>
                          </div>

                          <div className="skill-row-side">
                            <strong>{skill.risk_score}</strong>
                            <span>{ui("风险分", "Risk Score")}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <aside className="panel-card skill-detail-panel">
                  {!selectedSkill ? (
                    <div className="chart-empty">{ui("选择一个 Skill 查看详情。", "Select a skill to inspect details.")}</div>
                  ) : (
                    <>
                      <div className="skill-detail-head">
                        <div>
                          <span className="eyebrow">{ui("实时画像", "Live Profile")}</span>
                          <h3>{selectedSkill.name}</h3>
                          <p className="skill-detail-intro">
                            {selectedSkill.headline || ui("当前 Skill 没有额外摘要。", "No additional summary is available for this skill.")}
                          </p>
                        </div>
                        <div className="skill-detail-actions">
                          <button
                            className="ghost small"
                            type="button"
                            onClick={() => triggerSkillRescan(selectedSkill.skill_id)}
                            disabled={skillActionLoading === `rescan:${selectedSkill.skill_id}`}
                          >
                            {skillActionLoading === `rescan:${selectedSkill.skill_id}`
                              ? ui("重扫中...", "Rescanning...")
                              : ui("重扫", "Rescan")}
                          </button>
                          <button
                            className="ghost small"
                            type="button"
                            onClick={() => requestSkillConfirm("quarantine", selectedSkill, !selectedSkill.quarantined)}
                            disabled={Boolean(skillActionLoading)}
                          >
                            {selectedSkill.quarantined ? ui("解除隔离", "Remove Quarantine") : ui("隔离", "Quarantine")}
                          </button>
                          <button
                            className="primary small"
                            type="button"
                            onClick={() => requestSkillConfirm("trust", selectedSkill, !selectedSkill.trust_override)}
                            disabled={Boolean(skillActionLoading)}
                          >
                            {selectedSkill.trust_override ? ui("撤销受信", "Remove Override") : ui("设为受信", "Trust Override")}
                          </button>
                        </div>
                      </div>

                      <div className="skill-score-card">
                        <div className="skill-score-top">
                          <div>
                            <div className="skill-score-label">{ui("综合风险", "Composite Risk")}</div>
                            <div className="skill-score-value">{selectedSkill.risk_score}</div>
                          </div>
                          <div className="skill-score-side">
                            <span className={`tag meta-tag severity-${selectedSkill.risk_tier}`}>{skillRiskLabel(selectedSkill.risk_tier)}</span>
                            <span className={`tag ${selectedSkill.scan_status === "ready" ? "allow" : selectedSkill.scan_status === "stale" ? "warn" : "challenge"}`}>
                              {skillScanStatusLabel(selectedSkill.scan_status)}
                            </span>
                          </div>
                        </div>
                        <div className="skill-score-track" aria-hidden="true">
                          <span style={{ width: `${Math.max(6, selectedSkill.risk_score)}%` }} />
                        </div>
                        <div className="skill-score-meta">
                          <span>{ui("置信度", "Confidence")} {formatConfidence(selectedSkill.confidence)}</span>
                          <span>{ui("近 24h challenge / block", "24h challenge / block")} {selectedSkill.intercept_count_24h}</span>
                          {selectedSkill.is_drifted ? <span>{ui("内容变了但版本没变", "Changed without version update")}</span> : null}
                        </div>
                      </div>

                      <div className="skill-meta-grid">
                        <div className="skill-meta-item">
                          <span>{ui("版本", "Version")}</span>
                          <strong>{selectedSkill.version || ui("未声明", "Undeclared")}</strong>
                        </div>
                        <div className="skill-meta-item">
                          <span>{ui("作者", "Author")}</span>
                          <strong>{selectedSkill.author || ui("未声明", "Undeclared")}</strong>
                        </div>
                        <div className="skill-meta-item">
                          <span>{ui("来源", "Source")}</span>
                          <strong>{skillSourceLabel(selectedSkill.source, selectedSkill.source_detail)}</strong>
                        </div>
                        <div className="skill-meta-item">
                          <span>{ui("状态", "State")}</span>
                          <strong>{skillStateLabel(selectedSkill.state)}</strong>
                        </div>
                        <div className="skill-meta-item skill-meta-item-wide">
                          <span>{ui("安装路径", "Install Path")}</span>
                          <strong>{selectedSkill.install_path}</strong>
                        </div>
                        <div className="skill-meta-item skill-meta-item-wide">
                          <span>{ui("当前哈希", "Current Hash")}</span>
                          <strong>{selectedSkill.current_hash}</strong>
                        </div>
                      </div>

                      <section className="skill-section">
                        <div className="skill-section-head">
                          <h4>{ui("当前发现的风险信号", "Current Risk Signals")}</h4>
                          <span className="meta-pill">{selectedSkillFindings.length}</span>
                        </div>
                        {selectedSkillFindings.length === 0 ? (
                          <div className="chart-empty">{ui("最近一次扫描没有发现新的高风险信号。", "No new high-risk signals were found in the latest scan.")}</div>
                        ) : (
                          <div className="skill-finding-list">
                            {selectedSkillFindings.map((finding, index) => (
                              <article key={`${finding.code}-${index}`} className="skill-finding-card">
                                <div className="skill-finding-head">
                                  <strong>{skillReasonLabel(finding.code)}</strong>
                                  <div className="skill-row-tags">
                                    <span className="tag meta-tag">{skillSeverityLabel(finding.severity)}</span>
                                    <DecisionTag decision={finding.decision} />
                                  </div>
                                </div>
                                <p>{finding.detail}</p>
                                {finding.excerpt ? <code>{finding.excerpt}</code> : null}
                              </article>
                            ))}
                          </div>
                        )}
                      </section>

                      <section className="skill-section">
                        <div className="skill-section-head">
                          <h4>{ui("最近活动", "Recent Activity")}</h4>
                          <span className="meta-pill">{selectedSkillActivity.length}</span>
                        </div>
                        {skillDetailLoading && selectedSkillActivity.length === 0 ? (
                          <div className="chart-empty">{ui("活动加载中...", "Loading activity...")}</div>
                        ) : selectedSkillActivity.length === 0 ? (
                          <div className="chart-empty">{ui("当前没有额外活动记录。", "No extra activity records yet.")}</div>
                        ) : (
                          <div className="skill-activity-list">
                            {selectedSkillActivity.map((activity, index) => (
                              <article key={`${activity.kind}-${activity.ts}-${index}`} className="skill-activity-item">
                                <div className="skill-activity-top">
                                  <strong>{skillActivityLabel(activity.kind)}</strong>
                                  <span>{formatTime(activity.ts)}</span>
                                </div>
                                <div className="skill-activity-title">{activity.title === activity.kind ? skillActivityLabel(activity.kind) : activity.title}</div>
                                <p>{activity.detail}</p>
                              </article>
                            ))}
                          </div>
                        )}
                      </section>
                    </>
                  )}
                </aside>
              </div>

              <section className="panel-card skill-policy-panel">
                <div className="card-head">
                  <div>
                    <h3>{ui("拦截策略设置", "Interception Policy")}</h3>
                    <p className="skills-intro">
                      {ui(
                        "这里控制分数阈值、风险 × 严重度矩阵，以及未扫描 / 内容变了但版本没变时的默认动作。策略区使用显式保存，避免误触即时生效。",
                        "This section controls score thresholds, the risk-by-severity matrix, and default actions for unscanned skills or ones whose content changed without a version update. Saving is explicit to avoid accidental live changes."
                      )}
                    </p>
                  </div>
                  <div className="header-actions">
                    <span className={`meta-pill ${hasPendingSkillPolicyChanges ? "meta-pill-highlight" : ""}`}>
                      {hasPendingSkillPolicyChanges ? ui("有未保存修改", "Unsaved Changes") : ui("已同步", "In Sync")}
                    </span>
                    <button
                      className="ghost small"
                      type="button"
                      disabled={!hasPendingSkillPolicyChanges || skillPolicySaving}
                      onClick={resetSkillPolicyDraft}
                    >
                      {ui("重置", "Reset")}
                    </button>
                    <button
                      className="primary small"
                      type="button"
                      disabled={!hasPendingSkillPolicyChanges || skillPolicySaving}
                      onClick={() => void saveSkillPolicyChanges()}
                    >
                      {skillPolicySaving ? ui("保存中...", "Saving...") : ui("保存策略", "Save Policy")}
                    </button>
                  </div>
                </div>

                {skillPolicy ? (
                  <div className="skill-policy-sections">
                    <section className="skill-policy-section">
                      <div className="skill-policy-section-head">
                        <h4>{ui("分数阈值", "Score Thresholds")}</h4>
                        <p>
                          {ui(
                            "用分数把 Skill 风险归到 low / medium / high / critical，便于矩阵规则继续决定动作。",
                            "Use score cutoffs to place skills into low / medium / high / critical before the policy matrix decides the final action."
                          )}
                        </p>
                      </div>

                      <div className="skill-policy-grid">
                        <label className="skill-policy-field">
                          <span>{ui("Medium 阈值", "Medium Threshold")}</span>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={skillPolicy.thresholds.medium}
                            onChange={(event) => updateSkillThreshold("medium", event.target.value)}
                          />
                        </label>
                        <label className="skill-policy-field">
                          <span>{ui("High 阈值", "High Threshold")}</span>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={skillPolicy.thresholds.high}
                            onChange={(event) => updateSkillThreshold("high", event.target.value)}
                          />
                        </label>
                        <label className="skill-policy-field">
                          <span>{ui("Critical 阈值", "Critical Threshold")}</span>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={skillPolicy.thresholds.critical}
                            onChange={(event) => updateSkillThreshold("critical", event.target.value)}
                          />
                        </label>
                        <label className="skill-policy-field">
                          <span>{ui("临时受信时长（小时）", "Trust Override Duration (h)")}</span>
                          <input
                            type="number"
                            min="1"
                            max="168"
                            value={skillPolicy.defaults.trust_override_hours}
                            onChange={(event) => updateSkillDefaultAction("trust_override_hours", event.target.value)}
                          />
                        </label>
                      </div>
                    </section>

                    <section className="skill-policy-section">
                      <div className="skill-policy-section-head">
                        <h4>{ui("风险 × 严重度矩阵", "Risk-by-Severity Matrix")}</h4>
                        <p>
                          {ui(
                            "先按综合风险分层，再结合调用严重度决定最终动作。矩阵越往右下越应该更严格。",
                            "The final action comes from the combination of composite risk tier and call severity. Cells toward the bottom-right should usually be stricter."
                          )}
                        </p>
                      </div>

                      <div className="skill-policy-table-wrap">
                        <table className="skill-policy-table">
                          <thead>
                            <tr>
                              <th>{ui("风险 \\ 严重度", "Risk \\ Severity")}</th>
                              {SKILL_SEVERITY_LEVELS.map((severity) => (
                                <th key={severity}>{skillSeverityLabel(severity)}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {SKILL_POLICY_TIERS.map((tier) => (
                              <tr key={tier}>
                                <th scope="row">
                                  {tier === "unknown" ? ui("未扫描 / 过期", "Unscanned / Stale") : skillRiskLabel(tier)}
                                </th>
                                {SKILL_SEVERITY_LEVELS.map((severity) => (
                                  <td key={`${tier}-${severity}`}>
                                    <select
                                      value={skillPolicy.matrix[tier][severity]}
                                      onChange={(event) => updateSkillMatrixDecision(tier, severity, event.target.value)}
                                    >
                                      {DECISION_OPTIONS.map((decision) => (
                                        <option key={decision} value={decision}>{decisionLabel(decision)}</option>
                                      ))}
                                    </select>
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    <section className="skill-policy-section">
                      <div className="skill-policy-section-head">
                        <h4>{ui("兜底动作", "Fallback Actions")}</h4>
                        <p>
                          {ui(
                            "这些规则处理两类容易被忽略的情况：还没扫描完成，以及内容变了但版本没跟着变。",
                            "These defaults cover two easy-to-miss cases: a skill has not been scanned yet, or its content changed without a version update."
                          )}
                        </p>
                      </div>

                      <div className="skill-policy-grid skill-policy-grid-secondary">
                        <label className="skill-policy-field">
                          <span>{ui("未扫描 S2 默认动作", "Unscanned S2 Default")}</span>
                          <select
                            value={skillPolicy.defaults.unscanned.S2}
                            onChange={(event) => updateSkillDefaultAction("unscanned_S2", event.target.value)}
                          >
                            {DECISION_OPTIONS.map((decision) => (
                              <option key={decision} value={decision}>{decisionLabel(decision)}</option>
                            ))}
                          </select>
                          <div className={`rule-helper skill-policy-field-note ${skillPolicy.defaults.unscanned.S2}`}>
                            <span className="rule-helper-label">
                              {ui("当前处理方式", "Current handling")} · {decisionLabel(skillPolicy.defaults.unscanned.S2)}
                            </span>
                            <p>{skillDefaultActionSummary("unscanned_S2", skillPolicy.defaults.unscanned.S2)}</p>
                          </div>
                        </label>
                        <label className="skill-policy-field">
                          <span>{ui("未扫描 S3 默认动作", "Unscanned S3 Default")}</span>
                          <select
                            value={skillPolicy.defaults.unscanned.S3}
                            onChange={(event) => updateSkillDefaultAction("unscanned_S3", event.target.value)}
                          >
                            {DECISION_OPTIONS.map((decision) => (
                              <option key={decision} value={decision}>{decisionLabel(decision)}</option>
                            ))}
                          </select>
                          <div className={`rule-helper skill-policy-field-note ${skillPolicy.defaults.unscanned.S3}`}>
                            <span className="rule-helper-label">
                              {ui("当前处理方式", "Current handling")} · {decisionLabel(skillPolicy.defaults.unscanned.S3)}
                            </span>
                            <p>{skillDefaultActionSummary("unscanned_S3", skillPolicy.defaults.unscanned.S3)}</p>
                          </div>
                        </label>
                        <label className="skill-policy-field">
                          <span>{ui("内容变了但版本没变时的默认动作", "Default Action for Undeclared Change")}</span>
                          <select
                            value={skillPolicy.defaults.drifted_action}
                            onChange={(event) => updateSkillDefaultAction("drifted_action", event.target.value)}
                          >
                            {DECISION_OPTIONS.map((decision) => (
                              <option key={decision} value={decision}>{decisionLabel(decision)}</option>
                            ))}
                          </select>
                          <div className={`rule-helper skill-policy-field-note ${skillPolicy.defaults.drifted_action}`}>
                            <span className="rule-helper-label">
                              {ui("当前处理方式", "Current handling")} · {decisionLabel(skillPolicy.defaults.drifted_action)}
                            </span>
                            <p>{skillDefaultActionSummary("drifted_action", skillPolicy.defaults.drifted_action)}</p>
                          </div>
                        </label>
                      </div>
                    </section>
                  </div>
                ) : (
                  <div className="chart-empty">{ui("策略加载中...", "Loading policy...")}</div>
                )}
              </section>

              {skillConfirmAction ? (
                <div
                  className="confirm-dialog-backdrop"
                  role="dialog"
                  aria-modal="true"
                  aria-label={ui("Skill 操作确认", "Skill action confirmation")}
                  onClick={cancelSkillConfirmAction}
                >
                  <div className="confirm-dialog-card" onClick={(event) => event.stopPropagation()}>
                    <h4>
                      {skillConfirmAction.kind === "quarantine"
                        ? skillConfirmAction.enable
                          ? ui("确认隔离这个 Skill？", "Quarantine this skill?")
                          : ui("确认解除隔离？", "Remove quarantine?")
                        : skillConfirmAction.enable
                          ? ui("确认设置临时受信？", "Apply trust override?")
                          : ui("确认撤销受信覆盖？", "Remove trust override?")}
                    </h4>
                    <p className="confirm-dialog-text">
                      {skillConfirmAction.kind === "quarantine"
                        ? skillConfirmAction.enable
                          ? ui("隔离后，这个 Skill 的高危调用会以更严格策略处理，适合先止血再排查。", "Once quarantined, this skill's high-risk calls will be handled with stricter blocking. Use this to contain risk first.")
                          : ui("解除隔离后，Skill 会重新按风险矩阵参与评估。", "Removing quarantine puts the skill back on the normal risk matrix.")
                        : skillConfirmAction.enable
                          ? ui(`受信覆盖会保留审计，并按当前默认时长 ${skillPolicy?.defaults?.trust_override_hours || 6} 小时自动过期。`, `The trust override remains audited and will expire after ${skillPolicy?.defaults?.trust_override_hours || 6} hours by default.`)
                          : ui("撤销后，Skill 会重新使用正常风险等级和决策矩阵。", "Removing the override restores the normal risk tier and decision matrix.")}
                    </p>
                    <div className="confirm-dialog-path">{skillConfirmAction.skillName || skillConfirmAction.skillId}</div>
                    <div className="confirm-dialog-actions">
                      <button className="ghost small" type="button" onClick={cancelSkillConfirmAction}>
                        {ui("取消", "Cancel")}
                      </button>
                      <button className="primary small" type="button" onClick={confirmSkillAction}>
                        {ui("确认", "Confirm")}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeTab === "accounts" ? (
          <section
            id="panel-accounts"
            className="tab-panel"
            role="tabpanel"
            aria-labelledby="tab-accounts"
          >
            <div className="panel-card accounts-panel dashboard-panel">
              <div className="card-head">
                <div>
                  <h2>{ui("账号", "Accounts")}</h2>
                  <p className="accounts-intro">
                    {ui(
                      "设置账号模式和管理员。默认管理员为 main。",
                      "Set account mode and admin. main is the default admin."
                    )}
                  </p>
                </div>
                <div className="rule-meta">
                  <span className="meta-pill">{ui("账号", "Accounts")} {accountCount}</span>
                </div>
              </div>

              {accountCount === 0 ? (
                <div className="chart-empty">{ui("还没有账号。", "No accounts yet.")}</div>
              ) : (
                <div className="account-list">
                  {displayAccounts.map((account) => (
                    <article key={account.subject} className="account-card">
                      <div className="account-card-head">
                        <div>
                          <div className="account-title-row">
                            <h3>{accountPrimaryLabel(account)}</h3>
                            {account.is_admin ? <span className="tag meta-tag">{ui("管理员", "Admin")}</span> : null}
                            <span className={`tag ${account.mode === "default_allow" ? "warn" : "allow"}`}>
                              {accountModeLabel(account.mode)}
                            </span>
                          </div>
                          <div className="account-subject">{account.subject}</div>
                          <div className="account-meta">{accountMetaLabel(account)}</div>
                        </div>
                      </div>

                      <div className="account-controls">
                        <label className="account-field">
                          <span>{ui("规则模式", "Rule Mode")}</span>
                          <select
                            value={account.mode || "apply_rules"}
                            onChange={(event) => updateAccountPolicy(account.subject, { mode: event.target.value })}
                          >
                            <option value="apply_rules">{ui("应用规则", "Apply Rules")}</option>
                            <option value="default_allow">{ui("默认放行", "Default Allow")}</option>
                          </select>
                        </label>

                        <label className="account-toggle">
                          <input
                            type="radio"
                            name="admin-account"
                            checked={selectedAdminSubject === account.subject}
                            onChange={(event) => {
                              if (event.target.checked) {
                                setAdminAccount(account.subject);
                              }
                            }}
                          />
                          <span>{ui("管理员", "Admin")}</span>
                        </label>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : null}
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
