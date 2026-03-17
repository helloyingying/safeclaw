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
import { canonicalizeAccountPolicies } from "../../src/domain/services/account_policy_engine.ts";
import { resolveSafeClawLocale } from "../../src/i18n/locale.ts";

const REFRESH_INTERVAL_MS = 15000;
const DECISIONS_PER_PAGE = 12;
const ADMIN_LOCALE_STORAGE_KEY = "safeclaw.admin.locale";
const ADMIN_THEME_STORAGE_KEY = "safeclaw.admin.theme";
const ADMIN_DEFAULT_LOCALE = resolveSafeClawLocale(
  typeof navigator !== "undefined" ? navigator.language : undefined,
  "en"
);
const ADMIN_DEFAULT_THEME_PREFERENCE = "system";
const DARK_COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const ADMIN_THEME_OPTIONS = new Set(["system", "light", "dark"]);
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
    id: "events"
  },
  {
    id: "rules"
  },
  {
    id: "accounts"
  }
];

function tabLabel(tabId) {
  if (tabId === "overview") return ui("概览", "Overview");
  if (tabId === "events") return ui("决策记录", "Decisions");
  if (tabId === "rules") return ui("规则策略", "Policies");
  if (tabId === "accounts") return ui("账号策略", "Accounts");
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
  default: { "zh-CN": "默认放行", en: "Default allow" },
  approval: { "zh-CN": "审批放行", en: "Approval grant" },
  account: { "zh-CN": "账号策略", en: "Account policy" }
};

const ACCOUNT_MODE_TEXT = {
  apply_rules: { "zh-CN": "应用规则", en: "Apply rules" },
  default_allow: { "zh-CN": "默认放行", en: "Default allow" }
};

const QUICK_APPROVAL_ACTION_CHANNELS = new Set(["telegram"]);

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
  approval_exception: { "zh-CN": "审批例外", en: "Approval Exception" }
};

const SEVERITY_TEXT = {
  low: { "zh-CN": "低风险", en: "Low" },
  medium: { "zh-CN": "中风险", en: "Medium" },
  high: { "zh-CN": "高风险", en: "High" },
  critical: { "zh-CN": "严重", en: "Critical" }
};

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
  modify: { "zh-CN": "修改", en: "Modify" },
  export: { "zh-CN": "导出", en: "Export" }
};

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
    scene: "发起 break-glass 例外请求，绕过常规规则。",
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
      "zh-CN": "Break-glass 例外放行需单次审批",
      en: "Break-Glass Exception Requires Single-Use Approval"
    },
    description: {
      "zh-CN": "显式请求 break-glass 或策略例外时，要求工单、审批人角色和单次 trace 绑定。",
      en: "Requires ticket, approver role, and single-use trace binding when requesting break-glass/policy exceptions."
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

function normalizeChannel(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "";
}

function channelFromSubject(subject) {
  if (typeof subject !== "string") {
    return "";
  }
  const separator = subject.indexOf(":");
  if (separator <= 0) {
    return "";
  }
  return subject.slice(0, separator).trim().toLowerCase();
}

function resolveAccountChannel(account) {
  return normalizeChannel(account?.channel) || channelFromSubject(account?.subject);
}

function supportsQuickApprovalActions(account) {
  const channel = resolveAccountChannel(account);
  return channel ? QUICK_APPROVAL_ACTION_CHANNELS.has(channel) : false;
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
      "x-safeclaw-locale": activeLocale
    }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(getJsonError(payload, ui(`请求失败: ${response.status}`, `Request failed: ${response.status}`)));
  }
  return payload;
}

function extractPolicies(strategyPayload) {
  const list = strategyPayload?.strategy?.policies;
  return Array.isArray(list)
    ? clone(list).map((policy) => ({ ...policy, enabled: true }))
    : [];
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

function approvalSummary(requirements) {
  if (!requirements) return "";
  const parts = [];
  if (requirements.ticket_required) parts.push(ui("工单必填", "Ticket required"));
  if (toArray(requirements.approver_roles).length) parts.push(ui(`审批角色: ${formatList(requirements.approver_roles)}`, `Approver roles: ${formatList(requirements.approver_roles)}`));
  if (requirements.single_use) parts.push(ui("单次放行", "Single use"));
  if (requirements.trace_binding === "trace") parts.push(ui("绑定当前 trace", "Bound to current trace"));
  if (typeof requirements.ttl_seconds === "number") parts.push(ui(`有效期 ${requirements.ttl_seconds} 秒`, `TTL ${requirements.ttl_seconds}s`));
  return parts.join(" · ");
}

function formatSimpleList(values) {
  return toArray(values).filter(Boolean).join(ui("、", ", "));
}

function withLabel(value, labels) {
  return readLocalized(labels, value, value);
}

function localizedRuleField(ruleId, field) {
  if (!ruleId) return undefined;
  const item = RULE_TEXT_OVERRIDES[ruleId];
  const fieldValue = item?.[field];
  if (!fieldValue) return undefined;
  return fieldValue[activeLocale] || fieldValue.en || fieldValue["zh-CN"];
}

function approvalImpactSummary(requirements) {
  if (!requirements) return "";
  const parts = [];
  if (requirements.ticket_required) {
    parts.push(ui("需要填写工单号", "A ticket ID is required"));
  }
  const roles = formatSimpleList(requirements.approver_roles);
  if (roles) {
    parts.push(ui(`需要 ${roles} 审批`, `Requires approval from ${roles}`));
  }
  if (requirements.single_use) {
    parts.push(ui("每次审批仅可放行一次", "Each approval can be used once"));
  }
  if (typeof requirements.ttl_seconds === "number") {
    const minutes = Math.max(1, Math.round(requirements.ttl_seconds / 60));
    parts.push(ui(`审批通过后约 ${minutes} 分钟内有效`, `Valid for about ${minutes} minutes after approval`));
  }
  return parts.length ? ui(`此外，${parts.join("，")}。`, `In addition, ${parts.join(", ")}.`) : "";
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
  const approval = approvalImpactSummary(policy?.approval_requirements);
  return `${localizedBase}${approval ? ` ${approval}` : ""}`;
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
    return ui("这个请求需要你确认审批后，我才能继续执行。", "I need your approval before I can continue this request.");
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
      label: "SafeClaw",
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
  return resolveSafeClawLocale(queryLocale || storedLocale || navigator.language, ADMIN_DEFAULT_LOCALE);
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
  const [policies, setPolicies] = useState([]);
  const [publishedPolicies, setPublishedPolicies] = useState([]);
  const [accountPolicies, setAccountPolicies] = useState([]);
  const [publishedAccountPolicies, setPublishedAccountPolicies] = useState([]);
  const [availableSessions, setAvailableSessions] = useState([]);
  const [selectedSessionSubject, setSelectedSessionSubject] = useState("");
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

  const hasPendingRuleChanges = useMemo(
    () => JSON.stringify(policies) !== JSON.stringify(publishedPolicies),
    [policies, publishedPolicies]
  );
  const hasPendingAccountChanges = useMemo(
    () =>
      JSON.stringify(canonicalizeAccountPolicies(accountPolicies)) !==
      JSON.stringify(canonicalizeAccountPolicies(publishedAccountPolicies)),
    [accountPolicies, publishedAccountPolicies]
  );
  const hasPendingChanges = hasPendingRuleChanges || hasPendingAccountChanges;
  const groupedPolicies = useMemo(() => {
    const groups = new Map();
    policies.forEach((policy, index) => {
      const key = policy?.control_domain || policy?.group || "general";
      const list = groups.get(key) || [];
      list.push({ policy, index });
      groups.set(key, list);
    });
    return Array.from(groups.entries());
  }, [policies]);
  const policyEntries = useMemo(
    () => policies.map((policy, index) => ({ key: policy?.rule_id || String(index), policy, index })),
    [policies]
  );
  const eligibleSessions = useMemo(
    () => availableSessions,
    [availableSessions]
  );
  const availableSessionOptions = useMemo(
    () => eligibleSessions.filter((session) => !accountPolicies.some((account) => account.subject === session.subject)),
    [accountPolicies, eligibleSessions]
  );
  const selectedAdminSubject = useMemo(
    () => accountPolicies.find((account) => account.is_admin)?.subject || "",
    [accountPolicies]
  );
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
      const nextPolicies = extractPolicies(strategy);
      const nextAccountPolicies = extractAccountPolicies(accounts);
      setPublishedPolicies(nextPolicies);
      setPublishedAccountPolicies(nextAccountPolicies);
      setAvailableSessions(extractChatSessions(accounts));
      if (syncRules === true) {
        setPolicies(clone(nextPolicies));
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

  useEffect(() => {
    void loadData({ syncRules: true, syncAccounts: true, silent: false });
  }, [loadData]);

  useEffect(() => {
    void loadDecisionPage({ silent: false });
  }, [loadDecisionPage]);

  useEffect(() => {
    if (hasPendingChanges || saving) {
      return undefined;
    }
    const timer = setInterval(() => {
      void loadData({ syncRules: true, syncAccounts: true, silent: true });
      void loadDecisionPage({ silent: true });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasPendingChanges, loadData, loadDecisionPage, saving]);

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

  const savePolicies = useCallback(async (nextPolicies) => {
    const normalizedPolicies = nextPolicies.map((policy) => ({ ...policy, enabled: true }));
    setSaving(true);
    setError("");
    setMessage(ui("规则自动保存中...", "Saving policy changes..."));
    try {
      const response = await fetch("/api/strategy", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-safeclaw-locale": activeLocale
        },
        body: JSON.stringify({
          policies: normalizedPolicies
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, ui("保存失败", "Save failed")));
      }
      const suffix = payload.restart_required ? ui(" 需要重启 gateway 后完整生效。", " A gateway restart is required for full effect.") : "";
      const details = `${payload.message || ""}${suffix}`.trim();
      setMessage(details ? `${ui("规则已自动保存。", "Policies saved automatically.")} ${details}` : ui("规则已自动保存。", "Policies saved automatically."));
      setPublishedPolicies(clone(normalizedPolicies));
      await loadData({ syncRules: false, syncAccounts: false, silent: true });
    } catch (saveError) {
      setError(String(saveError));
      setMessage("");
    } finally {
      setSaving(false);
    }
  }, [loadData]);

  const saveAccounts = useCallback(async (nextAccounts) => {
    const normalizedAccounts = canonicalizeAccountPolicies(nextAccounts);
    setSaving(true);
    setError("");
    setMessage(ui("账号策略自动保存中...", "Saving account policy changes..."));
    try {
      const response = await fetch("/api/accounts", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-safeclaw-locale": activeLocale
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
      await loadData({ syncRules: false, syncAccounts: false, silent: true });
    } catch (saveError) {
      setError(String(saveError));
      setMessage("");
    } finally {
      setSaving(false);
    }
  }, [loadData]);

  useEffect(() => {
    if (loading || saving || !hasPendingRuleChanges) {
      return undefined;
    }
    setMessage(ui("检测到规则变更，正在自动保存...", "Rule changes detected. Saving automatically..."));
    const timer = setTimeout(() => {
      void savePolicies(policies);
    }, 500);
    return () => clearTimeout(timer);
  }, [hasPendingRuleChanges, loading, policies, savePolicies, saving]);

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

  function onDecisionChange(index, decision) {
    setPolicies((current) => {
      const next = clone(current);
      next[index].decision = decision;
      next[index].enabled = true;
      return next;
    });
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

  function addSelectedSessionAccount() {
    if (!selectedSessionSubject) {
      return;
    }
    const session = availableSessionOptions.find((item) => item.subject === selectedSessionSubject);
    if (!session) {
      return;
    }
    setAccountPolicies((current) => [
      ...current,
      {
        subject: session.subject,
        label: session.label,
        mode: "apply_rules",
        is_admin: false,
        session_key: session.session_key,
        session_id: session.session_id,
        agent_id: session.agent_id,
        channel: session.channel,
        chat_type: session.chat_type,
        updated_at: new Date().toISOString()
      }
    ]);
    setSelectedSessionSubject("");
  }

  function updateAccountPolicy(subject, patch) {
    setAccountPolicies((current) =>
      current.map((account) =>
        account.subject === subject
          ? {
              ...account,
              ...patch,
              updated_at: new Date().toISOString()
            }
          : account
      )
    );
  }

  function setAdminAccount(subject) {
    setAccountPolicies((current) =>
      current.map((account) => ({
        ...account,
        is_admin: account.subject === subject,
        updated_at: new Date().toISOString()
      }))
    );
  }

  function removeAccountPolicy(subject) {
    setAccountPolicies((current) => current.filter((account) => account.subject !== subject));
  }

  const tabCounts = {
    overview: stats.total,
    events: stats.total,
    rules: policies.length,
    accounts: accountPolicies.length
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
  const statusTone = error ? "error" : hasPendingChanges || saving ? "warn" : "good";
  const statusMessage = error || message || (hasPendingChanges ? ui("检测到规则变更，正在自动保存...", "Rule changes detected. Saving automatically...") : "");
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

  return (
    <div className="app">
      <section className="workspace card">
        <div className="workspace-top">
          <div className="workspace-title">
            <div className="workspace-kicker">
              <img src="/favicon.svg" alt="" className="workspace-favicon" aria-hidden="true" />
              SafeClaw Admin
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
                  onClick={() => setLocale(resolveSafeClawLocale(item.value, "en"))}
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
          </section>
        ) : null}

        {activeTab === "events" ? (
          <section
            id="panel-events"
            className="tab-panel"
            role="tabpanel"
            aria-labelledby="tab-events"
          >
            <div className="panel-card">
              <div className="card-head card-head-compact">
                <h2>{ui("决策记录", "Decisions")}</h2>
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
            <div className="panel-card">
              <div className="card-head">
                <h2>{ui("规则策略", "Policies")}</h2>
                <div className="rule-meta">
                  <span className="meta-pill">{ui("分组", "Groups")} {groupedPolicies.length}</span>
                  <span className="meta-pill">{ui("规则", "Rules")} {policies.length}</span>
                </div>
              </div>

              <div className={`rules-layout ${isRuleSideVisible ? "with-side" : ""}`}>
                <div className="rules" ref={rulesColumnRef}>
                  {policies.length === 0 ? (
                    <div className="rule">{ui("暂无规则", "No rules configured")}</div>
                  ) : (
                    groupedPolicies.map(([group, entries]) => (
                      <section key={group} className="rule-group">
                        <h4 className="rule-group-title">{controlDomainLabel(group)}</h4>
                        {entries.map(({ policy, index }) => {
                          const entryKey = policy.rule_id || String(index);
                          const isActive = entryKey === activeRuleKey;
                          return (
                            <article
                              key={entryKey}
                              className={`rule ${isActive ? "active" : ""}`}
                              ref={entryKey === firstRuleKey ? firstRuleRef : null}
                              role="button"
                              tabIndex={0}
                              aria-pressed={isActive}
                              aria-controls="active-rule-example-panel"
                              onClick={() => setActiveRuleKey(entryKey)}
                              onKeyDown={(event) => onRuleCardKeyDown(event, entryKey)}
                            >
                              <div className="rule-head">
                                <div className="rule-title">{policyTitle(policy, index)}</div>
                                <div className="rule-head-side">
                                  <DecisionTag decision={policy.decision} />
                                  <div className="rule-tags" aria-label={ui("规则标签", "Rule tags")}>
                                    <span className="tag meta-tag">{controlDomainLabel(policy.control_domain || policy.group)}</span>
                                    {policy.severity ? <span className={`tag meta-tag severity-${policy.severity}`}>{severityLabel(policy.severity)}</span> : null}
                                    {policy.owner ? <span className="tag meta-tag">{policy.owner}</span> : null}
                                  </div>
                                </div>
                              </div>
                              <div className="rule-actions" role="group" aria-label={ui(`规则 ${policy.rule_id || index + 1} 的策略动作`, `Policy actions for rule ${policy.rule_id || index + 1}`)}>
                                {DECISION_OPTIONS.map((decision) => (
                                  <button
                                    key={decision}
                                    className={`rule-action-button ${decision} ${policy.decision === decision ? "active" : ""}`}
                                    type="button"
                                    aria-pressed={policy.decision === decision}
                                    onClick={(event) => {
                                      stopRuleCardEvent(event);
                                      onDecisionChange(index, decision);
                                    }}
                                    onKeyDown={stopRuleCardEvent}
                                  >
                                    {decisionLabel(decision)}
                                  </button>
                                ))}
                              </div>
                              <div className="rule-desc">{ruleDescription(policy)}</div>
                            </article>
                          );
                        })}
                      </section>
                    ))
                  )}
                </div>

                {isRuleSideVisible ? (
                  <aside
                    id="active-rule-example-panel"
                    className="rule-side-panel"
                    aria-live="polite"
                    style={{ marginTop: `${sidePanelOffset}px` }}
                  >
                    <div className="rule-side-card">
                      <div className="rule-side-head">
                        <div className="rule-side-head-top">
                          <span className="eyebrow">{ui("规则对话示例", "Rule Conversation Example")}</span>
                          <button
                            className="ghost small rule-side-close"
                            type="button"
                            onClick={() => setActiveRuleKey("")}
                          >
                            {ui("关闭", "Close")}
                          </button>
                        </div>
                        <h3>{policyTitle(activeRuleEntry.policy, activeRuleEntry.index)}</h3>
                        <div className="rule-row">
                          <DecisionTag decision={activeRuleEntry.policy.decision} />
                          <span className="tag meta-tag">{controlDomainLabel(activeRuleEntry.policy.control_domain || activeRuleEntry.policy.group)}</span>
                        </div>
                      </div>

                      <div className="rule-side-notes">
                        <section className="rule-side-note">
                          <h5>{ui("什么时候会触发", "When It Triggers")}</h5>
                          <p>{activeRuleGuide.trigger}</p>
                        </section>
                        <section className="rule-side-note">
                          <h5>{ui("为什么更安全", "Why It Is Safer")}</h5>
                          <p>{activeRuleGuide.securityGain}</p>
                        </section>
                        <section className="rule-side-note">
                          <h5>{ui("会发生什么", "What Happens")}</h5>
                          <p>{activeRuleGuide.userImpact}</p>
                        </section>
                      </div>

                      <section className="rule-chat-panel" aria-label={ui("典型对话场景", "Typical Conversation")}>
                        <h5>{ui("典型对话场景", "Typical Conversation")}</h5>
                        <div className="rule-chat">
                          {activeRuleConversation.map((line, lineIndex) => (
                            <article key={`${line.role}-${lineIndex}`} className={`rule-message ${line.role}`}>
                              <span className="rule-message-role">{line.label}</span>
                              <p>{line.text}</p>
                            </article>
                          ))}
                        </div>
                      </section>
                    </div>
                  </aside>
                ) : null}
              </div>
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
            <div className="panel-card accounts-panel">
              <div className="card-head">
                <div>
                  <h2>{ui("账号策略", "Account Policies")}</h2>
                  <p className="accounts-intro">
                    {ui(
                      "账号策略在规则引擎之后插入判断，不改动现有规则定义。管理员审批账号只能单选一个。Telegram 会展示快捷审批按钮，其他渠道走命令审批。",
                      "Account policies are applied after rule evaluation without changing rule definitions. Only one admin approver account can be selected. Telegram provides quick-action buttons; other channels use command approvals."
                    )}
                  </p>
                </div>
                <div className="rule-meta">
                  <span className="meta-pill">{ui("已配置", "Configured")} {accountPolicies.length}</span>
                  <span className="meta-pill">{ui("可选会话", "Available Sessions")} {eligibleSessions.length}</span>
                </div>
              </div>

              <div className="account-toolbar">
                <div className="account-picker">
                  <select
                    value={selectedSessionSubject}
                    onChange={(event) => setSelectedSessionSubject(event.target.value)}
                    disabled={availableSessionOptions.length === 0}
                  >
                    <option value="">{ui("从 OpenClaw chat session 选择账号", "Select an account from OpenClaw chat sessions")}</option>
                    {availableSessionOptions.map((session) => (
                      <option key={session.subject} value={session.subject}>
                        {accountPrimaryLabel(session)}{session.channel ? ` · ${session.channel}` : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary"
                    type="button"
                    disabled={!selectedSessionSubject}
                    onClick={addSelectedSessionAccount}
                  >
                    {ui("添加账号", "Add Account")}
                  </button>
                </div>
                <div className="chart-subtitle">{ui("所有会话都可配置为管理员账号。Telegram 支持快捷按钮，其它渠道可直接回复审批命令。", "Any session can be set as an admin approver account. Telegram supports quick-action buttons; other channels can reply with approval commands.")}</div>
              </div>

              {accountPolicies.length === 0 ? (
                <div className="chart-empty">{ui("暂无账号策略。先从 OpenClaw 现有 chat session 里选择一个账号。", "No account policies yet. Select an account from existing OpenClaw chat sessions first.")}</div>
              ) : (
                <div className="account-list">
                  {accountPolicies.map((account) => (
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
                        <button
                          className="ghost small"
                          type="button"
                          onClick={() => removeAccountPolicy(account.subject)}
                        >
                          {ui("删除", "Remove")}
                        </button>
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
                          <span>{supportsQuickApprovalActions(account)
                            ? ui("管理员账号（单选，支持快捷按钮）", "Admin approver account (single-select, quick buttons supported)")
                            : ui("管理员账号（单选，命令审批）", "Admin approver account (single-select, command-based approval)")}</span>
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
