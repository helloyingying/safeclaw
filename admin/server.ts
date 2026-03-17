import http from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  matchesAdminDecisionFilter,
  normalizeAdminDecisionFilterId,
} from "../src/admin/dashboard_url_state.ts";
import { SkillInterceptionStore } from "../src/admin/skill_interception_store.ts";
import { listOpenClawChatSessions } from "../src/admin/openclaw_session_catalog.ts";
import { ConfigManager } from "../src/config/loader.ts";
import { applyRuntimeOverride, type RuntimeOverride } from "../src/config/runtime_override.ts";
import { StrategyStore } from "../src/config/strategy_store.ts";
import { AccountPolicyEngine } from "../src/domain/services/account_policy_engine.ts";
import { normalizeFileRules } from "../src/domain/services/file_rule_registry.ts";
import {
  hydrateSensitivePathConfig,
  listRemovedBuiltinSensitivePathRules,
  normalizeSensitivePathStrategyOverride,
} from "../src/domain/services/sensitive_path_registry.ts";
import type { SecurityClawLocale } from "../src/i18n/locale.ts";
import { pickLocalized, resolveSecurityClawLocale } from "../src/i18n/locale.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.resolve(ROOT, "admin/public");
const DEFAULT_PORT = Number(process.env.SECURITYCLAW_ADMIN_PORT ?? 4780);
const DEFAULT_CONFIG_PATH = process.env.SECURITYCLAW_CONFIG_PATH ?? path.resolve(ROOT, "config/policy.default.yaml");
const DEFAULT_STATUS_PATH = process.env.SECURITYCLAW_STATUS_PATH ?? path.resolve(ROOT, "runtime/securityclaw-status.json");
const DEFAULT_DB_PATH = process.env.SECURITYCLAW_DB_PATH ?? path.resolve(ROOT, "runtime/securityclaw.db");
const DEFAULT_LEGACY_OVERRIDE_PATH =
  process.env.SECURITYCLAW_LEGACY_OVERRIDE_PATH ?? path.resolve(ROOT, "config/policy.overrides.json");
const DEFAULT_OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");

type AdminLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type AdminServerOptions = {
  port?: number;
  configPath?: string;
  legacyOverridePath?: string;
  statusPath?: string;
  dbPath?: string;
  openClawHome?: string;
  logger?: AdminLogger;
  reclaimPortOnStart?: boolean;
  unrefOnStart?: boolean;
};

type AdminRuntime = {
  port: number;
  configPath: string;
  legacyOverridePath: string;
  statusPath: string;
  dbPath: string;
  openClawHome: string;
};

type AdminServerStartResult = {
  state: "started" | "already-running";
  runtime: AdminRuntime;
};

type GlobalWithSecurityClawAdmin = typeof globalThis & {
  __securityclawAdminStartPromise?: Promise<AdminServerStartResult>;
};

type JsonRecord = Record<string, unknown>;
type DecisionValue = "allow" | "warn" | "challenge" | "block";

type DecisionHistoryRecord = {
  ts: string;
  hook: string;
  trace_id: string;
  actor?: string;
  scope?: string;
  tool?: string;
  decision: DecisionValue;
  decision_source?: string;
  resource_scope?: string;
  reasons: string[];
  rules?: string;
};

type DecisionHistoryCounts = {
  all: number;
  allow: number;
  warn: number;
  challenge: number;
  block: number;
};

type DecisionHistoryPage = {
  items: DecisionHistoryRecord[];
  total: number;
  page: number;
  page_size: number;
  counts: DecisionHistoryCounts;
};

type DecisionHistoryRow = {
  ts: string;
  hook: string;
  trace_id: string;
  actor: string | null;
  scope: string | null;
  tool: string | null;
  decision: DecisionValue;
  decision_source: string | null;
  resource_scope: string | null;
  reasons_json: string;
  rules: string | null;
};

const DEFAULT_DECISION_PAGE_SIZE = 12;
const MAX_DECISION_PAGE_SIZE = 100;
const EMPTY_DECISION_COUNTS: DecisionHistoryCounts = {
  all: 0,
  allow: 0,
  warn: 0,
  challenge: 0,
  block: 0,
};

const ADMIN_DEFAULT_LOCALE = resolveSecurityClawLocale(process.env.SECURITYCLAW_LOCALE, "en");

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function localize(locale: SecurityClawLocale, zhText: string, enText: string): string {
  return pickLocalized(locale, zhText, enText);
}

function readHeaderLocale(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function resolveRequestLocale(req: http.IncomingMessage, url: URL): SecurityClawLocale {
  const headerLocale = readHeaderLocale(req.headers["x-securityclaw-locale"]);
  const queryLocale = url.searchParams.get("locale") ?? url.searchParams.get("lang") ?? undefined;
  return resolveSecurityClawLocale(headerLocale ?? queryLocale, ADMIN_DEFAULT_LOCALE);
}

async function readBody(req: http.IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as JsonRecord;
}

function safeReadStatus(statusPath: string): JsonRecord {
  if (!existsSync(statusPath)) {
    return {
      message: "status file not found yet",
      status_path: statusPath
    };
  }
  try {
    return JSON.parse(readFileSync(statusPath, "utf8")) as JsonRecord;
  } catch {
    return {
      message: "status file exists but cannot be parsed",
      status_path: statusPath
    };
  }
}

function parsePositiveInteger(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampDecisionPageSize(value: string | null | undefined): number {
  return Math.min(MAX_DECISION_PAGE_SIZE, parsePositiveInteger(value, DEFAULT_DECISION_PAGE_SIZE));
}

function parseReasons(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function countDecisions(records: Array<{ decision?: string }>): DecisionHistoryCounts {
  const counts: DecisionHistoryCounts = { ...EMPTY_DECISION_COUNTS };
  counts.all = records.length;
  records.forEach((record) => {
    if (record.decision === "allow") {
      counts.allow += 1;
      return;
    }
    if (record.decision === "warn") {
      counts.warn += 1;
      return;
    }
    if (record.decision === "challenge") {
      counts.challenge += 1;
      return;
    }
    if (record.decision === "block") {
      counts.block += 1;
    }
  });
  return counts;
}

function readDecisionsFromStatusFallback(
  statusPath: string,
  filter: ReturnType<typeof normalizeAdminDecisionFilterId>,
  page: number,
  pageSize: number,
): DecisionHistoryPage {
  const status = safeReadStatus(statusPath);
  const source = Array.isArray(status.recent_decisions) ? status.recent_decisions : [];
  const records = source
    .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      ts: String(item.ts ?? ""),
      hook: String(item.hook ?? ""),
      trace_id: String(item.trace_id ?? ""),
      decision: String(item.decision ?? "allow") as DecisionValue,
      reasons: Array.isArray(item.reasons) ? item.reasons.map((value) => String(value)) : [],
      ...(typeof item.actor === "string" ? { actor: item.actor } : {}),
      ...(typeof item.scope === "string" ? { scope: item.scope } : {}),
      ...(typeof item.tool === "string" ? { tool: item.tool } : {}),
      ...(typeof item.decision_source === "string" ? { decision_source: item.decision_source } : {}),
      ...(typeof item.resource_scope === "string" ? { resource_scope: item.resource_scope } : {}),
      ...(typeof item.rules === "string" ? { rules: item.rules } : {}),
    }));
  const filtered = records.filter((record) => matchesAdminDecisionFilter(record.decision, filter));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const resolvedPage = Math.min(page, totalPages);
  const startIndex = (resolvedPage - 1) * pageSize;

  return {
    items: filtered.slice(startIndex, startIndex + pageSize),
    total,
    page: resolvedPage,
    page_size: pageSize,
    counts: countDecisions(records),
  };
}

function readDecisionsPage(runtime: AdminRuntime, url: URL): DecisionHistoryPage {
  const filter = normalizeAdminDecisionFilterId(url.searchParams.get("decision"));
  const requestedPage = parsePositiveInteger(url.searchParams.get("page"), 1);
  const pageSize = clampDecisionPageSize(url.searchParams.get("page_size"));

  if (!existsSync(runtime.dbPath)) {
    return readDecisionsFromStatusFallback(runtime.statusPath, filter, requestedPage, pageSize);
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(runtime.dbPath);

    const countRows = db.prepare("SELECT decision, COUNT(1) AS count FROM decisions GROUP BY decision").all() as Array<{
      decision: string;
      count: number;
    }>;
    const counts: DecisionHistoryCounts = { ...EMPTY_DECISION_COUNTS };
    countRows.forEach((row) => {
      if (row.decision === "allow") {
        counts.allow = Number(row.count ?? 0);
      } else if (row.decision === "warn") {
        counts.warn = Number(row.count ?? 0);
      } else if (row.decision === "challenge") {
        counts.challenge = Number(row.count ?? 0);
      } else if (row.decision === "block") {
        counts.block = Number(row.count ?? 0);
      }
    });
    counts.all = counts.allow + counts.warn + counts.challenge + counts.block;

    const totalRow =
      filter === "all"
        ? (db.prepare("SELECT COUNT(1) AS count FROM decisions").get() as { count: number })
        : (db.prepare("SELECT COUNT(1) AS count FROM decisions WHERE decision = ?").get(filter) as {
            count: number;
          });
    const total = Number(totalRow.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const rows =
      filter === "all"
        ? (db
            .prepare(
              `SELECT ts, hook, trace_id, actor, scope, tool, decision, decision_source, resource_scope, reasons_json, rules
               FROM decisions
               ORDER BY id DESC
               LIMIT ? OFFSET ?`,
            )
            .all(pageSize, offset) as DecisionHistoryRow[])
        : (db
            .prepare(
              `SELECT ts, hook, trace_id, actor, scope, tool, decision, decision_source, resource_scope, reasons_json, rules
               FROM decisions
               WHERE decision = ?
               ORDER BY id DESC
               LIMIT ? OFFSET ?`,
            )
            .all(filter, pageSize, offset) as DecisionHistoryRow[]);

    return {
      items: rows.map((row) => ({
        ts: row.ts,
        hook: row.hook,
        trace_id: row.trace_id,
        decision: row.decision,
        reasons: parseReasons(row.reasons_json),
        ...(row.actor ? { actor: row.actor } : {}),
        ...(row.scope ? { scope: row.scope } : {}),
        ...(row.tool ? { tool: row.tool } : {}),
        ...(row.decision_source ? { decision_source: row.decision_source } : {}),
        ...(row.resource_scope ? { resource_scope: row.resource_scope } : {}),
        ...(row.rules ? { rules: row.rules } : {}),
      })),
      total,
      page,
      page_size: pageSize,
      counts,
    };
  } catch {
    return readDecisionsFromStatusFallback(runtime.statusPath, filter, requestedPage, pageSize);
  } finally {
    db?.close();
  }
}

function summarizeTotals(status: JsonRecord): JsonRecord {
  const hooks = (status.hooks ?? {}) as Record<string, Record<string, number>>;
  let total = 0;
  let block = 0;
  let challenge = 0;
  let warn = 0;
  let allow = 0;
  for (const value of Object.values(hooks)) {
    total += Number(value.total ?? 0);
    block += Number(value.block ?? 0);
    challenge += Number(value.challenge ?? 0);
    warn += Number(value.warn ?? 0);
    allow += Number(value.allow ?? 0);
  }
  return { total, allow, warn, challenge, block };
}

function readAccountPolicies(strategyStore: StrategyStore) {
  return AccountPolicyEngine.sanitize(strategyStore.readOverride()?.account_policies);
}

function readSensitivePathStrategy(
  baseConfig: ReturnType<ConfigManager["getConfig"]>,
  override: RuntimeOverride | undefined,
) {
  const baseSensitivity = hydrateSensitivePathConfig(baseConfig.sensitivity);
  const sensitivityOverride = normalizeSensitivePathStrategyOverride(override?.sensitivity);
  return {
    path_rules: baseConfig.sensitivity.path_rules,
    effective_path_rules: baseSensitivity.path_rules,
    custom_path_rules: sensitivityOverride?.custom_path_rules ?? [],
    disabled_builtin_ids: sensitivityOverride?.disabled_builtin_ids ?? [],
    removed_builtin_path_rules: listRemovedBuiltinSensitivePathRules(baseSensitivity, sensitivityOverride),
  };
}

function isExistingDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function listFileRuleDirectoryOptions(existingDirectories: string[] = []): string[] {
  return Array.from(new Set(existingDirectories.map((entry) => path.normalize(entry))))
    .filter((entry) => path.isAbsolute(entry))
    .filter((entry) => isExistingDirectory(entry))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeBrowsePath(candidate: string | null | undefined, fallback: string): string {
  if (!candidate || typeof candidate !== "string") {
    return fallback;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return fallback;
  }
  const expanded = trimmed === "~"
    ? os.homedir()
    : trimmed.startsWith("~/")
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
  if (!path.isAbsolute(expanded)) {
    return fallback;
  }
  const normalized = path.normalize(expanded);
  return isExistingDirectory(normalized) ? normalized : fallback;
}

function listDirectoryChildren(absolutePath: string): Array<{ name: string; path: string }> {
  const entries = readdirSync(absolutePath, { withFileTypes: true });
  const directories: Array<{ name: string; path: string }> = [];
  entries.forEach((entry) => {
    const childPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && isExistingDirectory(childPath))) {
      directories.push({
        name: entry.name,
        path: path.normalize(childPath),
      });
    }
  });
  return directories
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 300);
}

function listDirectoryBrowseRoots(existingDirectories: string[] = []): string[] {
  const homeDir = path.normalize(os.homedir());
  const homeRoot = path.parse(homeDir).root || "/";
  const extras = Array.from(
    new Set(existingDirectories.map((entry) => path.normalize(entry))),
  )
    .filter((entry) => path.isAbsolute(entry))
    .filter((entry) => isExistingDirectory(entry))
    .filter((entry) => entry !== homeDir && entry !== homeRoot)
    .sort((left, right) => left.localeCompare(right));
  const orderedRoots = [homeDir, ...(homeRoot !== homeDir ? [homeRoot] : []), ...extras];
  return Array.from(new Set(orderedRoots));
}

function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  runtime: AdminRuntime,
  strategyStore: StrategyStore,
  skillStore: SkillInterceptionStore,
): void {
  const locale = resolveRequestLocale(req, url);

  if (req.method === "GET" && url.pathname === "/api/status") {
    try {
      const status = safeReadStatus(runtime.statusPath);
      const { effective, override } = readEffectivePolicy(runtime, strategyStore);
      sendJson(res, 200, {
        paths: {
          config_path: runtime.configPath,
          legacy_override_path: runtime.legacyOverridePath,
          status_path: runtime.statusPath,
          db_path: runtime.dbPath
        },
        status,
        totals: summarizeTotals(status),
        effective: {
          environment: effective.environment,
          policy_version: effective.policy_version,
          policy_count: effective.policies.length,
          file_rule_count: effective.file_rules.length,
          event_sink_enabled: Boolean(effective.event_sink.webhook_url),
          strategy_loaded: Boolean(override)
        }
      });
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/decisions") {
    try {
      sendJson(res, 200, readDecisionsPage(runtime, url));
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills/status") {
    try {
      sendJson(res, 200, skillStore.getStatus());
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    try {
      sendJson(
        res,
        200,
        skillStore.listSkills({
          risk: url.searchParams.get("risk"),
          state: url.searchParams.get("state"),
          source: url.searchParams.get("source"),
          drift: url.searchParams.get("drift"),
          intercepted: url.searchParams.get("intercepted"),
        }),
      );
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/skills/policy") {
    void (async () => {
      try {
        const body = await readBody(req);
        const policy = skillStore.writePolicyConfig(body);
        sendJson(res, 200, {
          ok: true,
          restart_required: false,
          message: localize(
            locale,
            "Skill 拦截策略已保存到本地 SQLite，并会在下一次扫描与后台刷新时自动生效。",
            "Skill interception policy has been saved to local SQLite and will apply on the next scan and dashboard refresh.",
          ),
          policy,
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error) });
      }
    })();
    return;
  }

  const skillRouteMatch = url.pathname.match(/^\/api\/skills\/([^/]+?)(?:\/(rescan|quarantine|trust-override))?$/);
  if (skillRouteMatch) {
    const skillId = decodeURIComponent(skillRouteMatch[1]);
    const action = skillRouteMatch[2];

    if (req.method === "GET" && !action) {
      try {
        const detail = skillStore.getSkill(skillId);
        if (!detail) {
          sendJson(res, 404, { error: "skill not found" });
          return;
        }
        sendJson(res, 200, detail);
      } catch (error) {
        sendJson(res, 500, { error: String(error) });
      }
      return;
    }

    if (req.method === "POST" && action === "rescan") {
      try {
        const detail = skillStore.rescanSkill(skillId, "admin-ui");
        if (!detail) {
          sendJson(res, 404, { error: "skill not found" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          message: localize(
            locale,
            "Skill 已完成重扫，风险结论和最新信号已刷新。",
            "The skill has been rescanned and the latest risk signals have been refreshed.",
          ),
          detail,
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error) });
      }
      return;
    }

    if (req.method === "POST" && action === "quarantine") {
      void (async () => {
        try {
          const body = await readBody(req);
          const detail = skillStore.setQuarantine(skillId, {
            quarantined: Boolean(body.quarantined),
            updatedBy: typeof body.updated_by === "string" ? body.updated_by : "admin-ui",
          });
          if (!detail) {
            sendJson(res, 404, { error: "skill not found" });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            message: body.quarantined
              ? localize(
                  locale,
                  "Skill 已隔离，高危调用会按更严格策略阻断。",
                  "The skill is quarantined and high-risk calls will be blocked more aggressively.",
                )
              : localize(
                  locale,
                  "Skill 已解除隔离，后续将按风险策略继续评估。",
                  "The skill quarantine has been removed and future actions will follow risk policy again.",
                ),
            detail,
          });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error) });
        }
      })();
      return;
    }

    if (req.method === "POST" && action === "trust-override") {
      void (async () => {
        try {
          const body = await readBody(req);
          const detail = skillStore.setTrustOverride(skillId, {
            enabled: Boolean(body.enabled),
            updatedBy: typeof body.updated_by === "string" ? body.updated_by : "admin-ui",
            ...(typeof body.hours === "number" ? { hours: body.hours } : {}),
          });
          if (!detail) {
            sendJson(res, 404, { error: "skill not found" });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            message: body.enabled
              ? localize(
                  locale,
                  "Skill 已设置临时受信覆盖，仍会保留审计记录与过期时间。",
                  "A temporary trust override has been applied. Audit records and expiry time are preserved.",
                )
              : localize(
                  locale,
                  "Skill 的受信覆盖已撤销，风险矩阵恢复正常生效。",
                  "The trust override has been removed and the normal risk matrix is active again.",
                ),
            detail,
          });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error) });
        }
      })();
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/file-rule/directories") {
    try {
      const { effective } = readEffectivePolicy(runtime, strategyStore);
      const existingRuleDirectories = listFileRuleDirectoryOptions(effective.file_rules.map((rule) => rule.directory));
      const roots = listDirectoryBrowseRoots(existingRuleDirectories);
      const fallbackPath = roots[0] ?? path.normalize(os.homedir());
      const currentPath = normalizeBrowsePath(url.searchParams.get("path"), fallbackPath);
      const parentPath = path.dirname(currentPath);
      sendJson(res, 200, {
        current_path: currentPath,
        ...(parentPath && parentPath !== currentPath ? { parent_path: parentPath } : {}),
        roots,
        directories: listDirectoryChildren(currentPath),
      });
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/strategy") {
    try {
      const { base, effective, override } = readEffectivePolicy(runtime, strategyStore);
      sendJson(res, 200, {
        paths: {
          config_path: runtime.configPath,
          db_path: runtime.dbPath
        },
        override: override ?? {},
        strategy: {
          environment: effective.environment,
          policy_version: effective.policy_version,
          policies: effective.policies,
          file_rules: effective.file_rules,
          file_rule_directories: listFileRuleDirectoryOptions(effective.file_rules.map((rule) => rule.directory)),
          sensitivity: {
            ...readSensitivePathStrategy(base, override),
            effective_path_rules: effective.sensitivity.path_rules,
          }
        }
      });
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    try {
      const override = strategyStore.readOverride() ?? {};
      sendJson(res, 200, {
        paths: {
          db_path: runtime.dbPath,
          openclaw_home: runtime.openClawHome
        },
        account_policies: AccountPolicyEngine.sanitize(override.account_policies),
        sessions: listOpenClawChatSessions(runtime.openClawHome)
      });
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/strategy") {
    void (async () => {
      try {
        const body = await readBody(req);
        const current = strategyStore.readOverride() ?? {};
        const hasSensitivity = Object.prototype.hasOwnProperty.call(body, "sensitivity");
        const nextSensitivity = hasSensitivity
          ? normalizeSensitivePathStrategyOverride(body.sensitivity)
          : current.sensitivity;
        const hasFileRules = Object.prototype.hasOwnProperty.call(body, "file_rules");
        const nextFileRules = hasFileRules
          ? normalizeFileRules(body.file_rules)
          : normalizeFileRules(current.file_rules);

        const nextOverride: RuntimeOverride = {
          ...current,
          updated_at: new Date().toISOString(),
          environment:
            typeof body.environment === "string" ? body.environment : current.environment,
          policy_version:
            typeof body.policy_version === "string" ? body.policy_version : current.policy_version,
          policies:
            Array.isArray(body.policies)
              ? (body.policies as RuntimeOverride["policies"])
              : current.policies,
          ...(hasFileRules ? { file_rules: nextFileRules } : {}),
          ...(hasSensitivity ? { sensitivity: nextSensitivity } : {})
        };

        const base = ConfigManager.fromFile(runtime.configPath).getConfig();
        const validated = applyRuntimeOverride(base, nextOverride);
        strategyStore.writeOverride(nextOverride);

        sendJson(res, 200, {
          ok: true,
          restart_required: false,
          message: localize(
            locale,
            "策略已保存到本地 SQLite，并会在下一次安全决策时自动生效。",
            "Strategy has been saved to local SQLite and will apply on the next security decision.",
          ),
          effective: {
            environment: validated.environment,
            policy_version: validated.policy_version,
            policy_count: validated.policies.length,
            file_rule_count: validated.file_rules.length,
            sensitive_path_rule_count: validated.sensitivity.path_rules.length
          }
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error) });
      }
    })();
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/accounts") {
    void (async () => {
      try {
        const body = await readBody(req);
        const current = strategyStore.readOverride() ?? {};
        const nextOverride: RuntimeOverride = {
          ...current,
          updated_at: new Date().toISOString(),
          account_policies: AccountPolicyEngine.sanitize(body.account_policies)
        };

        const base = ConfigManager.fromFile(runtime.configPath).getConfig();
        applyRuntimeOverride(base, nextOverride);
        strategyStore.writeOverride(nextOverride);

        sendJson(res, 200, {
          ok: true,
          restart_required: false,
          message: localize(
            locale,
            "账号策略已保存到本地 SQLite，并会在下一次安全决策时自动生效。",
            "Account policies have been saved to local SQLite and will apply on the next security decision.",
          ),
          account_policy_count: readAccountPolicies(strategyStore).length
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error) });
      }
    })();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const relative = url.pathname === "/" ? "/index.html" : url.pathname;
  const absolute = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!absolute.startsWith(PUBLIC_DIR) || !existsSync(absolute)) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(absolute);
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".js"
        ? "text/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".svg"
            ? "image/svg+xml"
          : "application/octet-stream";
  sendText(res, 200, readFileSync(absolute, "utf8"), contentType);
}

function readEffectivePolicy(runtime: AdminRuntime, strategyStore: StrategyStore): {
  base: ReturnType<ConfigManager["getConfig"]>;
  effective: ReturnType<ConfigManager["getConfig"]>;
  override?: RuntimeOverride;
} {
  const base = ConfigManager.fromFile(runtime.configPath).getConfig();
  const override = strategyStore.readOverride();
  const effective = override ? applyRuntimeOverride(base, override) : base;
  return override !== undefined ? { base, effective, override } : { base, effective };
}

function resolveRuntime(options: AdminServerOptions): AdminRuntime {
  return {
    port: options.port ?? DEFAULT_PORT,
    configPath: options.configPath ?? DEFAULT_CONFIG_PATH,
    legacyOverridePath: options.legacyOverridePath ?? DEFAULT_LEGACY_OVERRIDE_PATH,
    statusPath: options.statusPath ?? DEFAULT_STATUS_PATH,
    dbPath: options.dbPath ?? DEFAULT_DB_PATH,
    openClawHome: options.openClawHome ?? DEFAULT_OPENCLAW_HOME
  };
}

function parsePids(output: string): number[] {
  return output
    .split(/\s+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function listListeningPidsByPort(port: number): number[] {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return [];
  }
  return parsePids(result.stdout);
}

function readProcessCommand(pid: number): string {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function looksLikeOpenClawProcess(command: string): boolean {
  return /(openclaw|securityclaw|admin\/server|gateway)/i.test(command);
}

function reclaimAdminPort(port: number, logger: AdminLogger): void {
  const pids = listListeningPidsByPort(port);
  for (const pid of pids) {
    if (pid === process.pid) {
      continue;
    }

    const command = readProcessCommand(pid);
    if (!looksLikeOpenClawProcess(command)) {
      logger.warn?.(
        `SecurityClaw admin: port ${port} is in use by pid=${pid}, but command is not OpenClaw/SecurityClaw; skip terminate.`,
      );
      continue;
    }

    try {
      process.kill(pid, "SIGKILL");
      logger.warn?.(`SecurityClaw admin: killed stale admin process pid=${pid} on port ${port}.`);
    } catch (error) {
      logger.warn?.(`SecurityClaw admin: failed to kill pid=${pid} on port ${port} (${String(error)}).`);
    }
  }
}

export function startAdminServer(options: AdminServerOptions = {}): Promise<AdminServerStartResult> {
  const state = globalThis as GlobalWithSecurityClawAdmin;
  if (state.__securityclawAdminStartPromise) {
    return state.__securityclawAdminStartPromise;
  }

  const runtime = resolveRuntime(options);
  const logger: AdminLogger = options.logger ?? {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message)
  };
  const strategyStore = new StrategyStore(runtime.dbPath, {
    legacyOverridePath: runtime.legacyOverridePath,
    logger: {
      warn: (message: string) => logger.warn?.(`SecurityClaw strategy store: ${message}`)
    }
  });
  const skillStore = new SkillInterceptionStore(runtime.dbPath, {
    openClawHome: runtime.openClawHome,
  });
  let strategyStoreClosed = false;
  let skillStoreClosed = false;
  function closeStrategyStore(): void {
    if (strategyStoreClosed) {
      return;
    }
    strategyStoreClosed = true;
    try {
      strategyStore.close();
    } catch {
      // Ignore close errors during shutdown paths.
    }
  }
  function closeSkillStore(): void {
    if (skillStoreClosed) {
      return;
    }
    skillStoreClosed = true;
    try {
      skillStore.close();
    } catch {
      // Ignore close errors during shutdown paths.
    }
  }
  const reclaimPortOnStart = options.reclaimPortOnStart ?? true;
  const unrefOnStart = options.unrefOnStart ?? false;

  if (reclaimPortOnStart) {
    reclaimAdminPort(runtime.port, logger);
  }

  const startPromise = new Promise<AdminServerStartResult>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        handleApi(req, res, url, runtime, strategyStore, skillStore);
        return;
      }
      serveStatic(req, res, url);
    });

    let resolved = false;
    server.once("error", (error: Error & { code?: string }) => {
      if (error.code === "EADDRINUSE") {
        resolved = true;
        closeStrategyStore();
        closeSkillStore();
        logger.warn?.(
          `SecurityClaw admin already running on http://127.0.0.1:${runtime.port} (port in use); reusing existing server.`,
        );
        resolve({ state: "already-running", runtime });
        return;
      }
      closeStrategyStore();
      closeSkillStore();
      logger.error?.(`SecurityClaw admin failed to start: ${String(error)}`);
      reject(error);
    });

    server.listen(runtime.port, "127.0.0.1", () => {
      resolved = true;
      if (unrefOnStart) {
        server.unref();
      }
      logger.info?.(`SecurityClaw admin listening on http://127.0.0.1:${runtime.port}`);
      logger.info?.(`Using config: ${runtime.configPath}`);
      logger.info?.(`Using strategy db: ${runtime.dbPath}`);
      logger.info?.(`Using legacy override import path: ${runtime.legacyOverridePath}`);
      logger.info?.(`Using status: ${runtime.statusPath}`);
      resolve({ state: "started", runtime });
    });

    server.on("close", () => {
      const current = globalThis as GlobalWithSecurityClawAdmin;
      if (current.__securityclawAdminStartPromise && resolved) {
        delete current.__securityclawAdminStartPromise;
      }
      closeStrategyStore();
      closeSkillStore();
    });
  });

  state.__securityclawAdminStartPromise = startPromise.catch((error) => {
    delete state.__securityclawAdminStartPromise;
    throw error;
  });
  return state.__securityclawAdminStartPromise;
}

const thisFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryFile && entryFile === thisFile) {
  void startAdminServer().catch((error) => {
    console.error(`SecurityClaw admin startup failed: ${String(error)}`);
    process.exitCode = 1;
  });
}
