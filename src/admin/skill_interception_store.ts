import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Decision } from "../types.ts";

export type SkillRiskTier = "low" | "medium" | "high" | "critical";
export type SkillOperationSeverity = "S0" | "S1" | "S2" | "S3";
export type SkillScanStatus = "ready" | "stale" | "unknown";
export type SkillSource =
  | "openclaw_workspace"
  | "openclaw_home"
  | "codex_home"
  | "custom";
export type SkillLifecycleState = "normal" | "quarantined" | "trusted";

type SkillRootDescriptor = {
  path: string;
  source: SkillSource;
};

type SkillMetadata = {
  name: string;
  version: string;
  author: string;
  headline: string;
  sourceDetail: string;
  hasChangelog: boolean;
};

type DiscoveredSkill = {
  installPath: string;
  skillMdPath: string;
  source: SkillSource;
  content: string;
  metadata: SkillMetadata;
};

type RawFinding = {
  code: string;
  detail: string;
  severity: SkillOperationSeverity;
  score: number;
  excerpt?: string;
};

export type SkillFinding = {
  code: string;
  detail: string;
  severity: SkillOperationSeverity;
  decision: Decision;
  excerpt?: string;
};

export type SkillPolicyConfig = {
  thresholds: {
    medium: number;
    high: number;
    critical: number;
  };
  matrix: Record<
    SkillRiskTier | "unknown",
    Record<SkillOperationSeverity, Decision>
  >;
  defaults: {
    unscanned: {
      S2: Decision;
      S3: Decision;
    };
    drifted_action: Decision;
    trust_override_hours: number;
  };
  updated_at?: string;
};

export type SkillSummary = {
  skill_id: string;
  name: string;
  version: string;
  author: string;
  headline: string;
  source: SkillSource;
  source_detail: string;
  install_path: string;
  current_hash: string;
  risk_score: number;
  risk_tier: SkillRiskTier;
  confidence: number;
  reason_codes: string[];
  findings: SkillFinding[];
  finding_count: number;
  scan_status: SkillScanStatus;
  last_seen_at: string;
  first_seen_at: string;
  last_scan_at?: string;
  last_intercept_at?: string;
  intercept_count_24h: number;
  is_drifted: boolean;
  is_newly_installed: boolean;
  quarantined: boolean;
  trust_override: boolean;
  trust_override_expires_at?: string;
  state: SkillLifecycleState;
};

export type SkillActivity = {
  ts: string;
  kind: string;
  title: string;
  detail: string;
  severity?: SkillOperationSeverity;
  decision?: Decision;
  reason_codes?: string[];
};

type SkillInventoryRow = {
  skill_id: string;
  name: string;
  version: string | null;
  author: string | null;
  source: string;
  install_path: string;
  current_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  is_present: number;
  metadata_json: string;
};

type SkillLatestScanRow = {
  skill_id: string;
  scan_ts: string;
  risk_score: number;
  risk_tier: string;
  confidence: number;
  reason_codes_json: string;
  findings_json: string;
};

type SkillOverrideRow = {
  skill_id: string;
  quarantined: number;
  trust_override: number;
  expires_at: string | null;
  updated_by: string | null;
  updated_at: string;
};

type SkillRuntimeEventRow = {
  ts: string;
  skill_id: string;
  event_kind: string;
  tool: string | null;
  severity: string | null;
  decision: string | null;
  reason_codes_json: string;
  trace_id: string | null;
  detail: string | null;
};

type SkillInterceptAggregateRow = {
  skill_id: string;
  challenge_block_count: number;
  last_intercept_at: string | null;
};

type SkillListFilters = {
  risk?: string | null;
  state?: string | null;
  source?: string | null;
  drift?: string | null;
  intercepted?: string | null;
};

type SkillSnapshot = {
  items: SkillSummary[];
  policy: SkillPolicyConfig;
  roots: SkillRootDescriptor[];
};

type SkillStatusPayload = {
  stats: {
    total: number;
    high_critical: number;
    challenge_block_24h: number;
    drift_alerts: number;
    quarantined: number;
    trusted_overrides: number;
  };
  highlights: SkillSummary[];
  policy: SkillPolicyConfig;
  roots: Array<{ path: string; source: SkillSource }>;
  generated_at: string;
};

type SkillListPayload = {
  items: SkillSummary[];
  total: number;
  counts: {
    total: number;
    high_critical: number;
    quarantined: number;
    trusted: number;
    drifted: number;
    recent_intercepts: number;
  };
  filters: {
    risk: string;
    state: string;
    source: string;
    drift: string;
    intercepted: string;
  };
  source_options: string[];
  policy: SkillPolicyConfig;
};

type SkillDetailPayload = {
  skill: SkillSummary;
  findings: SkillFinding[];
  activity: SkillActivity[];
  policy: SkillPolicyConfig;
  roots: Array<{ path: string; source: SkillSource }>;
};

type RefreshOptions = {
  force?: boolean;
  targetSkillId?: string;
  auditActor?: string;
};

const SKILL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skill_inventory (
  skill_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  author TEXT,
  source TEXT NOT NULL,
  install_path TEXT NOT NULL UNIQUE,
  current_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  is_present INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS skill_scan_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  scan_ts TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  risk_tier TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason_codes_json TEXT NOT NULL,
  findings_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_scan_results_skill_id_scan_ts
ON skill_scan_results(skill_id, scan_ts DESC);

CREATE TABLE IF NOT EXISTS skill_runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  tool TEXT,
  severity TEXT,
  decision TEXT,
  reason_codes_json TEXT NOT NULL,
  trace_id TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_skill_runtime_events_skill_id_ts
ON skill_runtime_events(skill_id, ts DESC);

CREATE TABLE IF NOT EXISTS skill_overrides (
  skill_id TEXT PRIMARY KEY,
  quarantined INTEGER NOT NULL DEFAULT 0,
  trust_override INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_policy_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const DECISION_SET = new Set<Decision>(["allow", "warn", "challenge", "block"]);
const RISK_TIERS: SkillRiskTier[] = ["low", "medium", "high", "critical"];
const OPERATION_SEVERITIES: SkillOperationSeverity[] = ["S0", "S1", "S2", "S3"];
const STALE_SCAN_MS = 30 * 60 * 1000;
const REFRESH_CACHE_MS = 30 * 1000;
const NEW_INSTALL_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SKILL_SCAN_FILES = 80;
const MAX_SKILL_SCAN_DEPTH = 4;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const DEFAULT_SKILL_POLICY_CONFIG: SkillPolicyConfig = {
  thresholds: {
    medium: 28,
    high: 58,
    critical: 82,
  },
  matrix: {
    low: { S0: "allow", S1: "allow", S2: "warn", S3: "challenge" },
    medium: { S0: "allow", S1: "warn", S2: "challenge", S3: "block" },
    high: { S0: "warn", S1: "challenge", S2: "block", S3: "block" },
    critical: { S0: "challenge", S1: "challenge", S2: "block", S3: "block" },
    unknown: { S0: "allow", S1: "warn", S2: "challenge", S3: "block" },
  },
  defaults: {
    unscanned: { S2: "challenge", S3: "block" },
    drifted_action: "challenge",
    trust_override_hours: 6,
  },
};

function cloneDefaultSkillPolicyConfig(): SkillPolicyConfig {
  return JSON.parse(JSON.stringify(DEFAULT_SKILL_POLICY_CONFIG)) as SkillPolicyConfig;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeDecision(value: unknown, fallback: Decision): Decision {
  const candidate = typeof value === "string" ? value.trim() : "";
  return DECISION_SET.has(candidate as Decision) ? (candidate as Decision) : fallback;
}

function decisionRank(decision: Decision): number {
  if (decision === "allow") return 0;
  if (decision === "warn") return 1;
  if (decision === "challenge") return 2;
  return 3;
}

function stricterDecision(left: Decision, right: Decision): Decision {
  return decisionRank(left) >= decisionRank(right) ? left : right;
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function createShortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

function buildSkillId(name: string, installPath: string): string {
  return `${slugify(name)}-${createShortHash(path.normalize(installPath))}`;
}

function matchFirst(content: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return "";
}

function detectChangelog(content: string): boolean {
  return /(^|\n)#{1,3}\s*(?:changelog|release notes|更新记录|变更说明)(?:\s|$)/i.test(content);
}

export function extractSkillMetadata(content: string, installPath: string): SkillMetadata {
  const fallbackName = path.basename(installPath);
  const headline = matchFirst(content, [/^#\s+(.+)$/m]) || fallbackName;
  const version = matchFirst(content, [
    /(?:^|\n)\s*(?:version|版本)\s*[:：]\s*([^\n]+)/i,
    /(?:^|\n)-\s*(?:version|版本)\s*[:：]\s*([^\n]+)/i,
  ]);
  const author = matchFirst(content, [
    /(?:^|\n)\s*(?:author|作者)\s*[:：]\s*([^\n]+)/i,
    /(?:^|\n)-\s*(?:author|作者)\s*[:：]\s*([^\n]+)/i,
  ]);
  const sourceDetail = matchFirst(content, [
    /(?:^|\n)\s*(?:source|来源)\s*[:：]\s*([^\n]+)/i,
    /(?:^|\n)-\s*(?:source|来源)\s*[:：]\s*([^\n]+)/i,
  ]);

  return {
    name: headline || fallbackName,
    version,
    author,
    headline,
    sourceDetail,
    hasChangelog: detectChangelog(content),
  };
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return right.length;
  }
  if (!right) {
    return left.length;
  }

  const dp = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let prev = row - 1;
    dp[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const nextPrev = dp[column];
      if (left[row - 1] === right[column - 1]) {
        dp[column] = prev;
      } else {
        dp[column] = Math.min(prev, dp[column - 1], dp[column]) + 1;
      }
      prev = nextPrev;
    }
  }
  return dp[right.length];
}

function resolveSkillRoots(openClawHome: string): SkillRootDescriptor[] {
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const roots: SkillRootDescriptor[] = [
    {
      path: path.join(openClawHome, "workspace", "skills"),
      source: "openclaw_workspace",
    },
    {
      path: path.join(openClawHome, "skills"),
      source: "openclaw_home",
    },
    {
      path: path.join(codexHome, "skills"),
      source: "codex_home",
    },
  ];

  const seen = new Set<string>();
  return roots
    .map((entry) => ({
      path: path.normalize(entry.path),
      source: entry.source,
    }))
    .filter((entry) => {
      if (!existsSync(entry.path)) {
        return false;
      }
      try {
        if (!statSync(entry.path).isDirectory()) {
          return false;
        }
      } catch {
        return false;
      }
      if (seen.has(entry.path)) {
        return false;
      }
      seen.add(entry.path);
      return true;
    });
}

function discoverSkills(roots: SkillRootDescriptor[]): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];
  roots.forEach((root) => {
    const entries = readdirSync(root.path, { withFileTypes: true });
    entries.forEach((entry) => {
      const installPath = path.join(root.path, entry.name);
      if (!entry.isDirectory()) {
        return;
      }
      const skillMdPath = path.join(installPath, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        return;
      }
      try {
        const content = readFileSync(skillMdPath, "utf8");
        discovered.push({
          installPath: path.normalize(installPath),
          skillMdPath,
          source: root.source,
          content,
          metadata: extractSkillMetadata(content, installPath),
        });
      } catch {
        discovered.push({
          installPath: path.normalize(installPath),
          skillMdPath,
          source: root.source,
          content: "",
          metadata: {
            name: path.basename(installPath),
            version: "",
            author: "",
            headline: path.basename(installPath),
            sourceDetail: "",
            hasChangelog: false,
          },
        });
      }
    });
  });
  return discovered.sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
}

function collectSkillFiles(
  rootDir: string,
  currentDir: string,
  results: string[],
  depth = 0,
): void {
  if (results.length >= MAX_SKILL_SCAN_FILES || depth > MAX_SKILL_SCAN_DEPTH) {
    return;
  }

  let entries: Array<{ name: string }> = [];
  try {
    entries = readdirSync(currentDir, { withFileTypes: true }) as Array<{ name: string }>;
  } catch {
    return;
  }

  entries
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .forEach((entry) => {
      if (results.length >= MAX_SKILL_SCAN_FILES) {
        return;
      }
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, absolutePath);

      try {
        const stats = statSync(absolutePath);
        if (stats.isDirectory()) {
          collectSkillFiles(rootDir, absolutePath, results, depth + 1);
          return;
        }
        if (stats.isFile()) {
          results.push(relativePath);
        }
      } catch {
        // Skip unreadable paths.
      }
    });
}

function computeSkillHash(installPath: string): string {
  const files: string[] = [];
  collectSkillFiles(installPath, installPath, files);
  const hasher = createHash("sha256");
  files.forEach((relativePath) => {
    const absolutePath = path.join(installPath, relativePath);
    try {
      const stats = statSync(absolutePath);
      hasher.update(relativePath);
      hasher.update(String(stats.size));
      if (stats.size <= MAX_SKILL_FILE_BYTES) {
        hasher.update(readFileSync(absolutePath));
      }
    } catch {
      hasher.update(`missing:${relativePath}`);
    }
  });
  return hasher.digest("hex");
}

function pushFinding(
  target: RawFinding[],
  code: string,
  detail: string,
  severity: SkillOperationSeverity,
  score: number,
  excerpt?: string,
): void {
  if (target.some((item) => item.code === code)) {
    return;
  }
  target.push({
    code,
    detail,
    severity,
    score,
    ...(excerpt ? { excerpt } : {}),
  });
}

function extractExcerpt(content: string, pattern: RegExp): string | undefined {
  const match = content.match(pattern);
  if (!match?.[0]) {
    return undefined;
  }
  return match[0].trim().slice(0, 160);
}

function scoreToTier(score: number, policy: SkillPolicyConfig): SkillRiskTier {
  if (score >= policy.thresholds.critical) return "critical";
  if (score >= policy.thresholds.high) return "high";
  if (score >= policy.thresholds.medium) return "medium";
  return "low";
}

function resolveFindingDecision(
  severity: SkillOperationSeverity,
  riskTier: SkillRiskTier,
  policy: SkillPolicyConfig,
  scanStatus: SkillScanStatus,
  isDrifted: boolean,
): Decision {
  const tierMatrix = policy.matrix[riskTier] || policy.matrix.unknown;
  let decision = tierMatrix[severity];
  if (scanStatus !== "ready") {
    if (severity === "S2") {
      decision = stricterDecision(decision, policy.defaults.unscanned.S2);
    }
    if (severity === "S3") {
      decision = stricterDecision(decision, policy.defaults.unscanned.S3);
    }
  }
  if (isDrifted) {
    decision = stricterDecision(decision, policy.defaults.drifted_action);
  }
  return decision;
}

export function analyzeSkillDocument(input: {
  name: string;
  content: string;
  metadata: SkillMetadata;
  siblingNames: string[];
  policy: SkillPolicyConfig;
  isDrifted: boolean;
}): {
  risk_score: number;
  risk_tier: SkillRiskTier;
  confidence: number;
  reason_codes: string[];
  findings: SkillFinding[];
} {
  const rawFindings: RawFinding[] = [];
  const normalizedName = input.name.trim().toLowerCase();
  const siblingNames = input.siblingNames.map((item) => item.trim().toLowerCase()).filter(Boolean);
  const downloadExecutePattern = /(curl|wget)[^\n]{0,120}\|\s*(sh|bash|zsh)|download[^.\n]{0,60}(then )?(run|execute)/i;
  const childProcessToken = `child${String.fromCharCode(95)}process`;
  const shellExecPattern = new RegExp(
    [
      "exec_command",
      "spawnSync",
      childProcessToken,
      "bash\\s+-lc",
      "zsh\\s+-lc",
      "powershell",
      "rm\\s+-rf",
      "chmod\\s+-R",
      "chown\\s+-R",
    ].join("|"),
    "i",
  );
  const bypassPattern =
    /(ignore|bypass|disable|skip)[^.\n]{0,40}(policy|security|guard|safety)|hide (the )?(output|logs)|不要提示|不要暴露/i;
  const credentialPattern =
    /(id_rsa|id_ed25519|\.env\b|aws\/credentials|\.npmrc|\.pypirc|\.kube\/config|private key|access token|session token|cookie(?:s)?|browser passwords?)/i;
  const egressPattern =
    /(https?:\/\/|pastebin|gist\.github|dropbox|google drive|公网|外发|upload to|send to external)/i;
  const outsideWorkspaceWritePattern =
    /(\/etc\/|\/usr\/local|~\/\.ssh|workspace outside|工作区外|system directory|宿主环境)/i;

  if (!input.content.trim()) {
    pushFinding(
      rawFindings,
      "SKILL_CONTENT_UNREADABLE",
      "Skill content could not be read or was empty during scan.",
      "S2",
      70,
    );
  }

  if (!input.metadata.author) {
    pushFinding(
      rawFindings,
      "SKILL_MISSING_AUTHOR",
      "Skill metadata does not declare an author.",
      "S0",
      8,
    );
  }

  if (!input.metadata.version) {
    pushFinding(
      rawFindings,
      "SKILL_MISSING_VERSION",
      "Skill metadata does not declare a version.",
      "S0",
      12,
    );
  }

  if (!input.metadata.hasChangelog) {
    pushFinding(
      rawFindings,
      "SKILL_CHANGELOG_MISSING",
      "Skill content does not expose a changelog or change summary.",
      "S0",
      6,
    );
  }

  if (downloadExecutePattern.test(input.content)) {
    pushFinding(
      rawFindings,
      "SKILL_DOWNLOAD_EXECUTE_PATTERN",
      "The skill contains download-then-execute behavior or equivalent remote execution instructions.",
      "S3",
      44,
      extractExcerpt(input.content, downloadExecutePattern),
    );
  }

  if (shellExecPattern.test(input.content)) {
    pushFinding(
      rawFindings,
      "SKILL_CAPABILITY_SHELL_EXEC",
      "The skill includes shell execution or destructive command patterns.",
      "S3",
      24,
      extractExcerpt(input.content, shellExecPattern),
    );
  }

  if (bypassPattern.test(input.content)) {
    pushFinding(
      rawFindings,
      "SKILL_POLICY_BYPASS_LANGUAGE",
      "The skill content appears to encourage bypassing policy, safety, or audit expectations.",
      "S2",
      24,
      extractExcerpt(input.content, bypassPattern),
    );
  }

  if (credentialPattern.test(input.content)) {
    pushFinding(
      rawFindings,
      "SKILL_CREDENTIAL_TARGETING",
      "The skill references secrets, credential paths, tokens, or browser/session materials.",
      "S2",
      24,
      extractExcerpt(input.content, credentialPattern),
    );
  }

  if (egressPattern.test(input.content)) {
    pushFinding(
      rawFindings,
      "SKILL_PUBLIC_EGRESS_PATTERN",
      "The skill references public-network uploads or external destinations.",
      "S1",
      18,
      extractExcerpt(input.content, egressPattern),
    );
  }

  if (outsideWorkspaceWritePattern.test(input.content)) {
    pushFinding(
      rawFindings,
      "SKILL_OUTSIDE_WORKSPACE_WRITE",
      "The skill references writes or changes outside the workspace boundary.",
      "S2",
      20,
      extractExcerpt(input.content, outsideWorkspaceWritePattern),
    );
  }

  if (
    rawFindings.some((item) => item.code === "SKILL_CAPABILITY_SHELL_EXEC") &&
    rawFindings.some((item) => item.code === "SKILL_PUBLIC_EGRESS_PATTERN")
  ) {
    pushFinding(
      rawFindings,
      "SKILL_CAPABILITY_COMBINATION",
      "The skill combines shell execution with public egress indicators.",
      "S3",
      22,
    );
  }

  const suspiciousSibling = siblingNames.find((candidate) => {
    if (!candidate || candidate === normalizedName) {
      return false;
    }
    if (Math.min(candidate.length, normalizedName.length) < 5) {
      return false;
    }
    return levenshteinDistance(candidate, normalizedName) <= 2;
  });
  if (suspiciousSibling) {
    pushFinding(
      rawFindings,
      "SKILL_TYPOSQUAT_SUSPECTED",
      `The skill name is unusually similar to another installed skill: ${suspiciousSibling}.`,
      "S1",
      14,
    );
  }

  if (input.isDrifted) {
    pushFinding(
      rawFindings,
      "SKILL_DRIFT_DETECTED",
      "The skill hash changed without a matching version change.",
      "S2",
      18,
    );
  }

  const riskScore = clamp(
    rawFindings.reduce((sum, finding) => sum + finding.score, 0),
    0,
    100,
  );
  const riskTier = scoreToTier(riskScore, input.policy);
  const findings = rawFindings.map((finding) => ({
    code: finding.code,
    detail: finding.detail,
    severity: finding.severity,
    decision: resolveFindingDecision(
      finding.severity,
      riskTier,
      input.policy,
      "ready",
      input.isDrifted,
    ),
    ...(finding.excerpt ? { excerpt: finding.excerpt } : {}),
  }));
  const confidence = clamp(
    0.54 + findings.length * 0.08 + (riskTier === "high" || riskTier === "critical" ? 0.08 : 0),
    0.45,
    0.98,
  );

  return {
    risk_score: riskScore,
    risk_tier: riskTier,
    confidence: Number(confidence.toFixed(2)),
    reason_codes: findings.map((finding) => finding.code),
    findings,
  };
}

function normalizeSource(input: string): SkillSource {
  return input === "openclaw_workspace" ||
    input === "openclaw_home" ||
    input === "codex_home" ||
    input === "custom"
    ? input
    : "custom";
}

function normalizeScanStatus(lastScanAt: string | undefined): SkillScanStatus {
  if (!lastScanAt) {
    return "unknown";
  }
  const ts = Date.parse(lastScanAt);
  if (!Number.isFinite(ts)) {
    return "unknown";
  }
  return Date.now() - ts > STALE_SCAN_MS ? "stale" : "ready";
}

function resolveOverrideState(row: SkillOverrideRow | undefined): {
  quarantined: boolean;
  trustOverride: boolean;
  expiresAt?: string;
} {
  const now = Date.now();
  const expiresAt = row?.expires_at || undefined;
  const trustOverride = Boolean(
    row?.trust_override &&
      (!expiresAt || (Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > now)),
  );
  return {
    quarantined: Boolean(row?.quarantined),
    trustOverride,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function resolveLifecycleState(input: {
  quarantined: boolean;
  trustOverride: boolean;
}): SkillLifecycleState {
  if (input.quarantined) {
    return "quarantined";
  }
  if (input.trustOverride) {
    return "trusted";
  }
  return "normal";
}

function maxTimestamp(...values: Array<string | undefined>): string | undefined {
  const resolved = values
    .map((value) => (value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left);
  return resolved.length > 0 ? new Date(resolved[0]).toISOString() : undefined;
}

function normalizeSkillSummary(
  inventory: SkillInventoryRow,
  latestScan: SkillLatestScanRow | undefined,
  override: SkillOverrideRow | undefined,
  interceptAggregate: SkillInterceptAggregateRow | undefined,
): SkillSummary {
  const metadata = safeParseJson<Record<string, unknown>>(inventory.metadata_json, {});
  const findings = safeParseJson<SkillFinding[]>(latestScan?.findings_json, []);
  const reasonCodes = safeParseJson<string[]>(latestScan?.reason_codes_json, findings.map((finding) => finding.code));
  const lastScanAt = latestScan?.scan_ts || undefined;
  const scanStatus = normalizeScanStatus(lastScanAt);
  const overrideState = resolveOverrideState(override);
  const scanInterceptCount =
    lastScanAt && Number.isFinite(Date.parse(lastScanAt)) && Date.now() - Date.parse(lastScanAt) <= ACTIVITY_WINDOW_MS
      ? findings.filter((finding) => finding.decision === "challenge" || finding.decision === "block").length
      : 0;
  const runtimeInterceptCount = Number(interceptAggregate?.challenge_block_count || 0);
  const lastInterceptAt = maxTimestamp(
    interceptAggregate?.last_intercept_at || undefined,
    scanInterceptCount > 0 ? lastScanAt : undefined,
  );
  const firstSeenTs = Date.parse(inventory.first_seen_at);

  return {
    skill_id: inventory.skill_id,
    name: inventory.name,
    version: inventory.version || "",
    author: inventory.author || "",
    headline: normalizeText(metadata.headline) || inventory.name,
    source: normalizeSource(inventory.source),
    source_detail: normalizeText(metadata.source_detail),
    install_path: inventory.install_path,
    current_hash: inventory.current_hash,
    risk_score: Number(latestScan?.risk_score || 0),
    risk_tier: (latestScan?.risk_tier as SkillRiskTier) || "low",
    confidence: Number(latestScan?.confidence || 0),
    reason_codes: reasonCodes,
    findings,
    finding_count: findings.length,
    scan_status: scanStatus,
    last_seen_at: inventory.last_seen_at,
    first_seen_at: inventory.first_seen_at,
    ...(lastScanAt ? { last_scan_at: lastScanAt } : {}),
    ...(lastInterceptAt ? { last_intercept_at: lastInterceptAt } : {}),
    intercept_count_24h: scanInterceptCount + runtimeInterceptCount,
    is_drifted: Boolean(metadata.is_drifted),
    is_newly_installed:
      Number.isFinite(firstSeenTs) && Date.now() - firstSeenTs <= NEW_INSTALL_WINDOW_MS,
    quarantined: overrideState.quarantined,
    trust_override: overrideState.trustOverride,
    ...(overrideState.expiresAt ? { trust_override_expires_at: overrideState.expiresAt } : {}),
    state: resolveLifecycleState(overrideState),
  };
}

export function normalizeSkillPolicyConfig(input: unknown): SkillPolicyConfig {
  const fallback = cloneDefaultSkillPolicyConfig();
  const payload =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const thresholds =
    payload.thresholds && typeof payload.thresholds === "object" && !Array.isArray(payload.thresholds)
      ? (payload.thresholds as Record<string, unknown>)
      : {};
  const defaults =
    payload.defaults && typeof payload.defaults === "object" && !Array.isArray(payload.defaults)
      ? (payload.defaults as Record<string, unknown>)
      : {};

  fallback.thresholds.medium = clamp(
    Number.isFinite(Number(thresholds.medium)) ? Number(thresholds.medium) : fallback.thresholds.medium,
    0,
    70,
  );
  fallback.thresholds.high = clamp(
    Number.isFinite(Number(thresholds.high)) ? Number(thresholds.high) : fallback.thresholds.high,
    fallback.thresholds.medium + 1,
    90,
  );
  fallback.thresholds.critical = clamp(
    Number.isFinite(Number(thresholds.critical))
      ? Number(thresholds.critical)
      : fallback.thresholds.critical,
    fallback.thresholds.high + 1,
    100,
  );

  const matrixInput =
    payload.matrix && typeof payload.matrix === "object" && !Array.isArray(payload.matrix)
      ? (payload.matrix as Record<string, unknown>)
      : {};
  (["low", "medium", "high", "critical", "unknown"] as const).forEach((tier) => {
    const tierInput =
      matrixInput[tier] && typeof matrixInput[tier] === "object" && !Array.isArray(matrixInput[tier])
        ? (matrixInput[tier] as Record<string, unknown>)
        : {};
    OPERATION_SEVERITIES.forEach((severity) => {
      fallback.matrix[tier][severity] = normalizeDecision(
        tierInput[severity],
        fallback.matrix[tier][severity],
      );
    });
  });

  const unscanned =
    defaults.unscanned && typeof defaults.unscanned === "object" && !Array.isArray(defaults.unscanned)
      ? (defaults.unscanned as Record<string, unknown>)
      : {};
  fallback.defaults.unscanned.S2 = normalizeDecision(unscanned.S2, fallback.defaults.unscanned.S2);
  fallback.defaults.unscanned.S3 = normalizeDecision(unscanned.S3, fallback.defaults.unscanned.S3);
  fallback.defaults.drifted_action = normalizeDecision(
    defaults.drifted_action,
    fallback.defaults.drifted_action,
  );
  fallback.defaults.trust_override_hours = clamp(
    Number.isFinite(Number(defaults.trust_override_hours))
      ? Number(defaults.trust_override_hours)
      : fallback.defaults.trust_override_hours,
    1,
    24 * 7,
  );
  if (typeof payload.updated_at === "string" && payload.updated_at.trim()) {
    fallback.updated_at = payload.updated_at.trim();
  }
  return fallback;
}

export class SkillInterceptionStore {
  #db: DatabaseSync;
  #openClawHome: string;
  #lastRefreshAt = 0;
  #roots: SkillRootDescriptor[] = [];

  constructor(dbPath: string, options: { openClawHome: string }) {
    this.#openClawHome = path.resolve(options.openClawHome);
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#db.exec("PRAGMA synchronous=NORMAL;");
    this.#db.exec(SKILL_SCHEMA_SQL);
    this.#ensurePolicyRow();
  }

  close(): void {
    this.#db.close();
  }

  readPolicyConfig(): SkillPolicyConfig {
    const row = this.#db
      .prepare("SELECT payload_json FROM skill_policy_config WHERE id = 1")
      .get() as { payload_json: string } | undefined;
    if (!row) {
      const fallback = cloneDefaultSkillPolicyConfig();
      this.#writePolicyConfig(fallback);
      return fallback;
    }
    return normalizeSkillPolicyConfig(safeParseJson(row.payload_json, {}));
  }

  writePolicyConfig(input: unknown): SkillPolicyConfig {
    const policy = normalizeSkillPolicyConfig(input);
    policy.updated_at = new Date().toISOString();
    this.#writePolicyConfig(policy);
    return policy;
  }

  getStatus(): SkillStatusPayload {
    const snapshot = this.#buildSnapshot();
    const highlights = snapshot.items
      .slice()
      .sort((left, right) => {
        if (Number(right.quarantined) !== Number(left.quarantined)) {
          return Number(right.quarantined) - Number(left.quarantined);
        }
        if (Number(right.intercept_count_24h > 0) !== Number(left.intercept_count_24h > 0)) {
          return Number(right.intercept_count_24h > 0) - Number(left.intercept_count_24h > 0);
        }
        if (Number(right.is_drifted) !== Number(left.is_drifted)) {
          return Number(right.is_drifted) - Number(left.is_drifted);
        }
        if (RISK_TIERS.indexOf(right.risk_tier) !== RISK_TIERS.indexOf(left.risk_tier)) {
          return RISK_TIERS.indexOf(right.risk_tier) - RISK_TIERS.indexOf(left.risk_tier);
        }
        if (right.risk_score !== left.risk_score) {
          return right.risk_score - left.risk_score;
        }
        return right.intercept_count_24h - left.intercept_count_24h;
      })
      .slice(0, 3);
    return {
      stats: {
        total: snapshot.items.length,
        high_critical: snapshot.items.filter((item) => item.risk_tier === "high" || item.risk_tier === "critical").length,
        challenge_block_24h: snapshot.items.reduce((sum, item) => sum + item.intercept_count_24h, 0),
        drift_alerts: snapshot.items.filter((item) => item.is_drifted).length,
        quarantined: snapshot.items.filter((item) => item.quarantined).length,
        trusted_overrides: snapshot.items.filter((item) => item.trust_override).length,
      },
      highlights,
      policy: snapshot.policy,
      roots: snapshot.roots.map((root) => ({ path: root.path, source: root.source })),
      generated_at: new Date().toISOString(),
    };
  }

  listSkills(filters: SkillListFilters = {}): SkillListPayload {
    const snapshot = this.#buildSnapshot();
    const normalizedFilters = {
      risk: normalizeText(filters.risk) || "all",
      state: normalizeText(filters.state) || "all",
      source: normalizeText(filters.source) || "all",
      drift: normalizeText(filters.drift) || "all",
      intercepted: normalizeText(filters.intercepted) || "all",
    };

    const filtered = snapshot.items.filter((item) => {
      if (normalizedFilters.risk !== "all" && item.risk_tier !== normalizedFilters.risk) {
        return false;
      }
      if (normalizedFilters.state !== "all" && item.state !== normalizedFilters.state) {
        return false;
      }
      if (normalizedFilters.source !== "all" && item.source !== normalizedFilters.source) {
        return false;
      }
      if (normalizedFilters.drift === "drifted" && !item.is_drifted) {
        return false;
      }
      if (normalizedFilters.drift === "steady" && item.is_drifted) {
        return false;
      }
      if (normalizedFilters.intercepted === "recent" && item.intercept_count_24h <= 0) {
        return false;
      }
      return true;
    });

    return {
      items: filtered,
      total: filtered.length,
      counts: {
        total: snapshot.items.length,
        high_critical: snapshot.items.filter((item) => item.risk_tier === "high" || item.risk_tier === "critical").length,
        quarantined: snapshot.items.filter((item) => item.quarantined).length,
        trusted: snapshot.items.filter((item) => item.trust_override).length,
        drifted: snapshot.items.filter((item) => item.is_drifted).length,
        recent_intercepts: snapshot.items.filter((item) => item.intercept_count_24h > 0).length,
      },
      filters: normalizedFilters,
      source_options: Array.from(new Set(snapshot.items.map((item) => item.source))).sort((left, right) =>
        left.localeCompare(right),
      ),
      policy: snapshot.policy,
    };
  }

  getSkill(skillId: string): SkillDetailPayload | undefined {
    const snapshot = this.#buildSnapshot();
    const skill = snapshot.items.find((item) => item.skill_id === skillId);
    if (!skill) {
      return undefined;
    }

    const runtimeEvents = this.#db
      .prepare(
        `SELECT ts, skill_id, event_kind, tool, severity, decision, reason_codes_json, trace_id, detail
         FROM skill_runtime_events
         WHERE skill_id = ?
         ORDER BY ts DESC
         LIMIT 12`,
      )
      .all(skillId) as SkillRuntimeEventRow[];
    const scanEvents: SkillActivity[] = skill.findings.map((finding) => ({
      ts: skill.last_scan_at || skill.last_seen_at,
      kind: "finding",
      title: finding.code,
      detail: finding.detail,
      severity: finding.severity,
      decision: finding.decision,
      reason_codes: [finding.code],
    }));
    const activity = [
      ...scanEvents,
      ...runtimeEvents.map((event) => ({
        ts: event.ts,
        kind: event.event_kind,
        title: event.event_kind,
        detail: event.detail || event.tool || event.event_kind,
        ...(event.severity ? { severity: event.severity as SkillOperationSeverity } : {}),
        ...(event.decision ? { decision: event.decision as Decision } : {}),
        reason_codes: safeParseJson<string[]>(event.reason_codes_json, []),
      })),
    ]
      .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
      .slice(0, 16);

    return {
      skill,
      findings: skill.findings,
      activity,
      policy: snapshot.policy,
      roots: snapshot.roots.map((root) => ({ path: root.path, source: root.source })),
    };
  }

  rescanSkill(skillId: string, updatedBy = "admin-ui"): SkillDetailPayload | undefined {
    this.#refreshInventory({
      force: true,
      targetSkillId: skillId,
      auditActor: updatedBy,
    });
    return this.getSkill(skillId);
  }

  setQuarantine(
    skillId: string,
    input: { quarantined: boolean; updatedBy?: string },
  ): SkillDetailPayload | undefined {
    const detail = this.getSkill(skillId);
    if (!detail) {
      return undefined;
    }
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO skill_overrides (skill_id, quarantined, trust_override, expires_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET
           quarantined = excluded.quarantined,
           trust_override = COALESCE(skill_overrides.trust_override, excluded.trust_override),
           expires_at = COALESCE(skill_overrides.expires_at, excluded.expires_at),
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        skillId,
        input.quarantined ? 1 : 0,
        detail.skill.trust_override ? 1 : 0,
        detail.skill.trust_override_expires_at ?? null,
        input.updatedBy || "admin-ui",
        now,
      );
    this.#insertRuntimeEvent({
      skillId,
      eventKind: input.quarantined ? "quarantine_on" : "quarantine_off",
      decision: input.quarantined ? "block" : "allow",
      detail: input.quarantined
        ? "Skill quarantined from the admin dashboard."
        : "Skill quarantine removed from the admin dashboard.",
      reasonCodes: ["SKILL_QUARANTINE_OVERRIDE"],
      actor: input.updatedBy || "admin-ui",
    });
    return this.getSkill(skillId);
  }

  setTrustOverride(
    skillId: string,
    input: { enabled: boolean; updatedBy?: string; hours?: number },
  ): SkillDetailPayload | undefined {
    const detail = this.getSkill(skillId);
    if (!detail) {
      return undefined;
    }
    const policy = this.readPolicyConfig();
    const durationHours = clamp(
      Number.isFinite(Number(input.hours))
        ? Number(input.hours)
        : policy.defaults.trust_override_hours,
      1,
      24 * 7,
    );
    const now = new Date().toISOString();
    const expiresAt = input.enabled
      ? new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString()
      : null;

    this.#db
      .prepare(
        `INSERT INTO skill_overrides (skill_id, quarantined, trust_override, expires_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET
           quarantined = COALESCE(skill_overrides.quarantined, excluded.quarantined),
           trust_override = excluded.trust_override,
           expires_at = excluded.expires_at,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        skillId,
        detail.skill.quarantined ? 1 : 0,
        input.enabled ? 1 : 0,
        expiresAt,
        input.updatedBy || "admin-ui",
        now,
      );
    this.#insertRuntimeEvent({
      skillId,
      eventKind: input.enabled ? "trust_override_on" : "trust_override_off",
      decision: input.enabled ? "warn" : "allow",
      detail: input.enabled
        ? `Temporary trust override applied for ${durationHours}h.`
        : "Trust override removed from the admin dashboard.",
      reasonCodes: ["SKILL_TRUST_OVERRIDE_APPLIED"],
      actor: input.updatedBy || "admin-ui",
    });
    return this.getSkill(skillId);
  }

  #ensurePolicyRow(): void {
    const row = this.#db
      .prepare("SELECT COUNT(1) AS count FROM skill_policy_config WHERE id = 1")
      .get() as { count: number };
    if (Number(row.count) > 0) {
      return;
    }
    this.#writePolicyConfig(cloneDefaultSkillPolicyConfig());
  }

  #writePolicyConfig(policy: SkillPolicyConfig): void {
    const updatedAt = policy.updated_at || new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO skill_policy_config (id, payload_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(policy), updatedAt);
  }

  #refreshIfStale(force = false): void {
    if (!force && Date.now() - this.#lastRefreshAt < REFRESH_CACHE_MS) {
      return;
    }
    this.#refreshInventory({ force });
  }

  #refreshInventory(options: RefreshOptions = {}): void {
    this.#roots = resolveSkillRoots(this.#openClawHome);
    const discovered = discoverSkills(this.#roots);
    const policy = this.readPolicyConfig();
    const existingRows = this.#db
      .prepare(
        `SELECT skill_id, name, version, author, source, install_path, current_hash,
                first_seen_at, last_seen_at, is_present, metadata_json
         FROM skill_inventory`,
      )
      .all() as SkillInventoryRow[];
    const existingByPath = new Map(existingRows.map((row) => [path.normalize(row.install_path), row]));
    const latestScans = this.#db
      .prepare(
        `SELECT s.skill_id, s.scan_ts, s.risk_score, s.risk_tier, s.confidence, s.reason_codes_json, s.findings_json
         FROM skill_scan_results s
         JOIN (
           SELECT skill_id, MAX(id) AS latest_id
           FROM skill_scan_results
           GROUP BY skill_id
         ) latest ON latest.latest_id = s.id`,
      )
      .all() as SkillLatestScanRow[];
    const latestScanBySkillId = new Map(latestScans.map((row) => [row.skill_id, row]));
    const siblingNames = discovered.map((item) => item.metadata.name);
    const seenSkillIds = new Set<string>();
    let targetFound = false;

    discovered.forEach((skill) => {
      const existing = existingByPath.get(skill.installPath);
      const currentHash = computeSkillHash(skill.installPath);
      const skillId = existing?.skill_id || buildSkillId(skill.metadata.name, skill.installPath);
      const existingHash = existing?.current_hash || "";
      const existingVersion = existing?.version || "";
      const isDrifted =
        Boolean(existingHash) &&
        existingHash !== currentHash &&
        normalizeText(existingVersion) === normalizeText(skill.metadata.version) &&
        Boolean(skill.metadata.version);
      const analysis = analyzeSkillDocument({
        name: skill.metadata.name,
        content: skill.content,
        metadata: skill.metadata,
        siblingNames: siblingNames.filter((item) => item !== skill.metadata.name),
        policy,
        isDrifted,
      });
      const now = new Date().toISOString();
      const metadataPayload = {
        headline: skill.metadata.headline,
        source_detail: skill.metadata.sourceDetail,
        has_changelog: skill.metadata.hasChangelog,
        is_drifted: isDrifted,
        skill_md_path: skill.skillMdPath,
      };

      this.#db
        .prepare(
          `INSERT INTO skill_inventory (
             skill_id, name, version, author, source, install_path, current_hash,
             first_seen_at, last_seen_at, is_present, metadata_json
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(skill_id) DO UPDATE SET
             name = excluded.name,
             version = excluded.version,
             author = excluded.author,
             source = excluded.source,
             install_path = excluded.install_path,
             current_hash = excluded.current_hash,
             last_seen_at = excluded.last_seen_at,
             is_present = 1,
             metadata_json = excluded.metadata_json`,
        )
        .run(
          skillId,
          skill.metadata.name,
          skill.metadata.version || null,
          skill.metadata.author || null,
          skill.source,
          skill.installPath,
          currentHash,
          existing?.first_seen_at || now,
          now,
          JSON.stringify(metadataPayload),
        );

      const latestScan = latestScanBySkillId.get(skillId);
      const latestFindings = safeParseJson<SkillFinding[]>(latestScan?.findings_json, []);
      const shouldInsertScan =
        options.force ||
        !latestScan ||
        latestScan.scan_ts.length === 0 ||
        Date.now() - Date.parse(latestScan.scan_ts) > STALE_SCAN_MS / 2 ||
        latestScan.risk_score !== analysis.risk_score ||
        JSON.stringify(latestFindings) !== JSON.stringify(analysis.findings);
      if (shouldInsertScan) {
        this.#db
          .prepare(
            `INSERT INTO skill_scan_results (
               skill_id, scan_ts, risk_score, risk_tier, confidence, reason_codes_json, findings_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            skillId,
            now,
            analysis.risk_score,
            analysis.risk_tier,
            analysis.confidence,
            JSON.stringify(analysis.reason_codes),
            JSON.stringify(analysis.findings),
          );
      }

      if (options.targetSkillId && skillId === options.targetSkillId) {
        targetFound = true;
        this.#insertRuntimeEvent({
          skillId,
          eventKind: "rescan",
          decision: analysis.findings.some((finding) => finding.decision === "block")
            ? "block"
            : analysis.findings.some((finding) => finding.decision === "challenge")
              ? "challenge"
              : "allow",
          detail: `Manual rescan completed with risk score ${analysis.risk_score}.`,
          reasonCodes: analysis.reason_codes,
          actor: options.auditActor || "admin-ui",
        });
      } else if (isDrifted) {
        this.#insertRuntimeEvent({
          skillId,
          eventKind: "drift_detected",
          decision: policy.defaults.drifted_action,
          detail: "Skill drift detected during inventory refresh.",
          reasonCodes: ["SKILL_DRIFT_DETECTED"],
        });
      }

      seenSkillIds.add(skillId);
    });

    const missingSkillIds = existingRows
      .map((row) => row.skill_id)
      .filter((skillId) => !seenSkillIds.has(skillId));
    if (missingSkillIds.length > 0) {
      const placeholders = missingSkillIds.map(() => "?").join(", ");
      this.#db
        .prepare(`UPDATE skill_inventory SET is_present = 0 WHERE skill_id IN (${placeholders})`)
        .run(...missingSkillIds);
    }

    if (options.targetSkillId && !targetFound) {
      this.#lastRefreshAt = Date.now();
      return;
    }
    this.#lastRefreshAt = Date.now();
  }

  #buildSnapshot(): SkillSnapshot {
    this.#refreshIfStale();
    const inventoryRows = this.#db
      .prepare(
        `SELECT skill_id, name, version, author, source, install_path, current_hash,
                first_seen_at, last_seen_at, is_present, metadata_json
         FROM skill_inventory
         WHERE is_present = 1
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all() as SkillInventoryRow[];
    const latestScans = this.#db
      .prepare(
        `SELECT s.skill_id, s.scan_ts, s.risk_score, s.risk_tier, s.confidence, s.reason_codes_json, s.findings_json
         FROM skill_scan_results s
         JOIN (
           SELECT skill_id, MAX(id) AS latest_id
           FROM skill_scan_results
           GROUP BY skill_id
         ) latest ON latest.latest_id = s.id`,
      )
      .all() as SkillLatestScanRow[];
    const overrides = this.#db
      .prepare(
        `SELECT skill_id, quarantined, trust_override, expires_at, updated_by, updated_at
         FROM skill_overrides`,
      )
      .all() as SkillOverrideRow[];
    const interceptAggregates = this.#db
      .prepare(
        `SELECT skill_id,
                COUNT(1) AS challenge_block_count,
                MAX(ts) AS last_intercept_at
         FROM skill_runtime_events
         WHERE decision IN ('challenge', 'block') AND ts >= ?
         GROUP BY skill_id`,
      )
      .all(new Date(Date.now() - ACTIVITY_WINDOW_MS).toISOString()) as SkillInterceptAggregateRow[];

    const latestScanBySkillId = new Map(latestScans.map((row) => [row.skill_id, row]));
    const overrideBySkillId = new Map(overrides.map((row) => [row.skill_id, row]));
    const interceptBySkillId = new Map(interceptAggregates.map((row) => [row.skill_id, row]));
    const items = inventoryRows.map((inventory) =>
      normalizeSkillSummary(
        inventory,
        latestScanBySkillId.get(inventory.skill_id),
        overrideBySkillId.get(inventory.skill_id),
        interceptBySkillId.get(inventory.skill_id),
      ),
    );
    return {
      items,
      policy: this.readPolicyConfig(),
      roots: this.#roots,
    };
  }

  #insertRuntimeEvent(input: {
    skillId: string;
    eventKind: string;
    decision: Decision;
    detail: string;
    reasonCodes?: string[];
    actor?: string;
  }): void {
    const reasonCodes = input.reasonCodes ?? [];
    const detail = input.actor ? `${input.detail} (${input.actor})` : input.detail;
    this.#db
      .prepare(
        `INSERT INTO skill_runtime_events (
           ts, skill_id, event_kind, tool, severity, decision, reason_codes_json, trace_id, detail
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        input.skillId,
        input.eventKind,
        input.eventKind,
        null,
        input.decision,
        JSON.stringify(reasonCodes),
        `skill-${Date.now()}`,
        detail,
      );
  }
}
