import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type Decision = "allow" | "warn" | "challenge" | "block";
type DecisionSource = "rule" | "default" | "approval" | "account" | "file_rule";

type HookCounter = {
  total: number;
  allow: number;
  warn: number;
  challenge: number;
  block: number;
  last_ts?: string;
  last_tool?: string;
  last_scope?: string;
};

export type StatusRecord = {
  ts: string;
  hook: string;
  trace_id: string;
  actor?: string;
  scope?: string;
  tool?: string;
  decision: Decision;
  decision_source?: DecisionSource;
  resource_scope?: string;
  reasons: string[];
  rules?: string;
};

type RuntimeStatus = {
  updated_at: string;
  started_at: string;
  config: {
    environment: string;
    policy_version: string;
    policy_count: number;
    config_path: string;
    strategy_db_path: string;
    strategy_loaded: boolean;
    legacy_override_path?: string;
  };
  hooks: Record<string, HookCounter>;
  recent_decisions: StatusRecord[];
};

type RuntimeStatusStoreOptions = {
  snapshotPath: string;
  dbPath?: string;
  maxRecent?: number;
};

type HookRow = {
  hook: string;
  total: number;
  allow: number;
  warn: number;
  challenge: number;
  block: number;
  last_ts: string | null;
  last_tool: string | null;
  last_scope: string | null;
};

type DecisionRow = {
  ts: string;
  hook: string;
  trace_id: string;
  actor: string | null;
  scope: string | null;
  tool: string | null;
  decision: Decision;
  decision_source: DecisionSource | null;
  resource_scope: string | null;
  reasons_json: string;
  rules: string | null;
};

const DEFAULT_HOOKS = [
  "before_prompt_build",
  "before_tool_call",
  "after_tool_call",
  "tool_result_persist",
  "before_message_write",
  "message_sending"
];

function createHookCounter(): HookCounter {
  return {
    total: 0,
    allow: 0,
    warn: 0,
    challenge: 0,
    block: 0
  };
}

function createEmptyStatus(): RuntimeStatus {
  const hooks: Record<string, HookCounter> = {};
  for (const hook of DEFAULT_HOOKS) {
    hooks[hook] = createHookCounter();
  }
  return {
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    config: {
      environment: "unknown",
      policy_version: "unknown",
      policy_count: 0,
      config_path: "",
      strategy_db_path: "",
      strategy_loaded: false
    },
    hooks,
    recent_decisions: []
  };
}

function parseReasons(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function optionalString(value: string | null): string | undefined {
  return value ?? undefined;
}

function resolveDbPathFromSnapshotPath(snapshotPath: string): string {
  const snapshotDir = path.dirname(path.resolve(snapshotPath));
  if (path.basename(snapshotDir) === "runtime") {
    return path.resolve(snapshotDir, "..", "data", "securityclaw.db");
  }
  return path.resolve(snapshotDir, "securityclaw.db");
}

const STATUS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hook_counters (
  hook TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  allow INTEGER NOT NULL DEFAULT 0,
  warn INTEGER NOT NULL DEFAULT 0,
  challenge INTEGER NOT NULL DEFAULT 0,
  block INTEGER NOT NULL DEFAULT 0,
  last_ts TEXT,
  last_tool TEXT,
  last_scope TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  hook TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  actor TEXT,
  scope TEXT,
  tool TEXT,
  decision TEXT NOT NULL,
  decision_source TEXT,
  resource_scope TEXT,
  reasons_json TEXT NOT NULL,
  rules TEXT
);

CREATE INDEX IF NOT EXISTS idx_decisions_recent ON decisions(id DESC);
`;

export class RuntimeStatusStore {
  #snapshotPath: string;
  #dbPath: string;
  #maxRecent: number;
  #db: DatabaseSync;

  constructor(statusPath: string, maxRecent?: number);
  constructor(options: RuntimeStatusStoreOptions);
  constructor(statusPathOrOptions: string | RuntimeStatusStoreOptions, maxRecent = 80) {
    const options =
      typeof statusPathOrOptions === "string"
        ? ({
            snapshotPath: statusPathOrOptions,
            dbPath: resolveDbPathFromSnapshotPath(statusPathOrOptions),
            maxRecent
          } satisfies RuntimeStatusStoreOptions)
        : {
            snapshotPath: statusPathOrOptions.snapshotPath,
            dbPath: statusPathOrOptions.dbPath ?? resolveDbPathFromSnapshotPath(statusPathOrOptions.snapshotPath),
            maxRecent: statusPathOrOptions.maxRecent ?? 80
          };
    this.#snapshotPath = options.snapshotPath;
    this.#dbPath = options.dbPath ?? resolveDbPathFromSnapshotPath(options.snapshotPath);
    this.#maxRecent = options.maxRecent ?? 80;
    mkdirSync(path.dirname(this.#snapshotPath), { recursive: true });
    mkdirSync(path.dirname(this.#dbPath), { recursive: true });
    this.#db = new DatabaseSync(this.#dbPath);
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#db.exec("PRAGMA synchronous=NORMAL;");
    this.#db.exec(STATUS_SCHEMA_SQL);
    this.#ensureDefaultHooks();
    this.#bootstrapFromLegacySnapshot();
  }

  markBoot(config: RuntimeStatus["config"]): void {
    try {
      const now = new Date().toISOString();
      this.#db.exec("BEGIN IMMEDIATE;");
      try {
        this.#writeConfigMeta(config, now, true);
        this.#db.exec("COMMIT;");
      } catch (error) {
        this.#db.exec("ROLLBACK;");
        throw error;
      }
      this.#flushSnapshot();
    } catch {
      // Swallow status persistence errors to avoid impacting guard execution.
    }
  }

  updateConfig(config: RuntimeStatus["config"]): void {
    try {
      const now = new Date().toISOString();
      this.#db.exec("BEGIN IMMEDIATE;");
      try {
        this.#writeConfigMeta(config, now, false);
        this.#db.exec("COMMIT;");
      } catch (error) {
        this.#db.exec("ROLLBACK;");
        throw error;
      }
      this.#flushSnapshot();
    } catch {
      // Swallow status persistence errors to avoid impacting guard execution.
    }
  }

  recordDecision(record: StatusRecord): void {
    try {
      this.#db.exec("BEGIN IMMEDIATE;");
      try {
        const allow = record.decision === "allow" ? 1 : 0;
        const warn = record.decision === "warn" ? 1 : 0;
        const challenge = record.decision === "challenge" ? 1 : 0;
        const block = record.decision === "block" ? 1 : 0;

        this.#db
          .prepare(
            `
            INSERT INTO hook_counters (
              hook, total, allow, warn, challenge, block, last_ts, last_tool, last_scope
            ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(hook) DO UPDATE SET
              total = hook_counters.total + 1,
              allow = hook_counters.allow + excluded.allow,
              warn = hook_counters.warn + excluded.warn,
              challenge = hook_counters.challenge + excluded.challenge,
              block = hook_counters.block + excluded.block,
              last_ts = excluded.last_ts,
              last_tool = excluded.last_tool,
              last_scope = excluded.last_scope
          `,
          )
          .run(record.hook, allow, warn, challenge, block, record.ts, record.tool ?? null, record.scope ?? null);

        this.#db
          .prepare(
            `
            INSERT INTO decisions (
              ts, hook, trace_id, actor, scope, tool, decision, decision_source, resource_scope, reasons_json, rules
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            record.ts,
            record.hook,
            record.trace_id,
            record.actor ?? null,
            record.scope ?? null,
            record.tool ?? null,
            record.decision,
            record.decision_source ?? null,
            record.resource_scope ?? null,
            JSON.stringify(record.reasons),
            record.rules ?? null,
          );

        this.#setMeta("updated_at", new Date().toISOString());
        this.#db.exec("COMMIT;");
      } catch (error) {
        this.#db.exec("ROLLBACK;");
        throw error;
      }
      this.#flushSnapshot();
    } catch {
      // Swallow status persistence errors to avoid impacting guard execution.
    }
  }

  close(): void {
    this.#db.close();
  }

  #ensureDefaultHooks(): void {
    const insert = this.#db.prepare("INSERT OR IGNORE INTO hook_counters (hook) VALUES (?)");
    for (const hook of DEFAULT_HOOKS) {
      insert.run(hook);
    }
  }

  #setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        `
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      )
      .run(key, value);
  }

  #writeConfigMeta(config: RuntimeStatus["config"], now: string, includeStartedAt: boolean): void {
    if (includeStartedAt) {
      this.#setMeta("started_at", now);
    }
    this.#setMeta("updated_at", now);
    this.#setMeta("config", JSON.stringify(config));
  }

  #getMeta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  #hasPersistedData(): boolean {
    const decisionCount = this.#db.prepare("SELECT COUNT(1) AS count FROM decisions").get() as { count: number };
    if (Number(decisionCount.count ?? 0) > 0) {
      return true;
    }
    const nonZeroHooks = this.#db
      .prepare("SELECT COUNT(1) AS count FROM hook_counters WHERE total > 0")
      .get() as { count: number };
    if (Number(nonZeroHooks.count ?? 0) > 0) {
      return true;
    }
    return Boolean(this.#getMeta("started_at") || this.#getMeta("config"));
  }

  #bootstrapFromLegacySnapshot(): void {
    if (this.#hasPersistedData() || !existsSync(this.#snapshotPath)) {
      return;
    }
    let legacy: RuntimeStatus | undefined;
    try {
      const raw = JSON.parse(readFileSync(this.#snapshotPath, "utf8")) as unknown;
      if (raw && typeof raw === "object") {
        legacy = raw as RuntimeStatus;
      }
    } catch {
      return;
    }
    if (!legacy) {
      return;
    }

    try {
      const startedAt =
        typeof legacy.started_at === "string" && legacy.started_at.length > 0
          ? legacy.started_at
          : new Date().toISOString();
      const updatedAt =
        typeof legacy.updated_at === "string" && legacy.updated_at.length > 0
          ? legacy.updated_at
          : startedAt;

      this.#db.exec("BEGIN IMMEDIATE;");
      try {
        this.#setMeta("started_at", startedAt);
        this.#setMeta("updated_at", updatedAt);

        if (legacy.config && typeof legacy.config === "object") {
          const legacyConfig = legacy.config as RuntimeStatus["config"] & {
            override_path?: string;
            override_loaded?: boolean;
          };
          this.#setMeta(
            "config",
            JSON.stringify({
              environment: legacyConfig.environment ?? "unknown",
              policy_version: legacyConfig.policy_version ?? "unknown",
              policy_count: legacyConfig.policy_count ?? 0,
              config_path: legacyConfig.config_path ?? "",
              strategy_db_path: legacyConfig.strategy_db_path ?? legacyConfig.override_path ?? "",
              strategy_loaded: legacyConfig.strategy_loaded ?? legacyConfig.override_loaded ?? false,
              legacy_override_path: legacyConfig.legacy_override_path
            }),
          );
        }

        const upsertHook = this.#db.prepare(
          `
          INSERT INTO hook_counters (
            hook, total, allow, warn, challenge, block, last_ts, last_tool, last_scope
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(hook) DO UPDATE SET
            total = excluded.total,
            allow = excluded.allow,
            warn = excluded.warn,
            challenge = excluded.challenge,
            block = excluded.block,
            last_ts = excluded.last_ts,
            last_tool = excluded.last_tool,
            last_scope = excluded.last_scope
        `,
        );

        for (const hook of Object.keys(legacy.hooks ?? {})) {
          const counter = legacy.hooks[hook];
          upsertHook.run(
            hook,
            Number(counter?.total ?? 0),
            Number(counter?.allow ?? 0),
            Number(counter?.warn ?? 0),
            Number(counter?.challenge ?? 0),
            Number(counter?.block ?? 0),
            counter?.last_ts ?? null,
            counter?.last_tool ?? null,
            counter?.last_scope ?? null,
          );
        }

        const insertDecision = this.#db.prepare(
          `
          INSERT INTO decisions (
            ts, hook, trace_id, actor, scope, tool, decision, decision_source, resource_scope, reasons_json, rules
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        );
        const legacyDecisions = Array.isArray(legacy.recent_decisions) ? [...legacy.recent_decisions].reverse() : [];
        for (const item of legacyDecisions) {
          if (!item || typeof item !== "object") {
            continue;
          }
          insertDecision.run(
            item.ts ?? new Date().toISOString(),
            item.hook ?? "unknown",
            item.trace_id ?? `legacy-${Date.now()}`,
            item.actor ?? null,
            item.scope ?? null,
            item.tool ?? null,
            item.decision ?? "allow",
            item.decision_source ?? null,
            item.resource_scope ?? null,
            JSON.stringify(Array.isArray(item.reasons) ? item.reasons : []),
            item.rules ?? null,
          );
        }

        this.#db.exec("COMMIT;");
      } catch (error) {
        this.#db.exec("ROLLBACK;");
        throw error;
      }

      this.#flushSnapshot();
    } catch {
      // Ignore bootstrap failures and continue with empty database.
    }
  }

  #readStatus(): RuntimeStatus {
    const fallback = createEmptyStatus();
    const startedAt = this.#getMeta("started_at") ?? fallback.started_at;
    const updatedAt = this.#getMeta("updated_at") ?? startedAt;

    const configRaw = this.#getMeta("config");
    let config = fallback.config;
    if (configRaw) {
      try {
        const parsed = JSON.parse(configRaw) as RuntimeStatus["config"] & {
          override_path?: string;
          override_loaded?: boolean;
        };
        if (parsed && typeof parsed === "object") {
          const nextConfig: RuntimeStatus["config"] = {
            environment: parsed.environment ?? fallback.config.environment,
            policy_version: parsed.policy_version ?? fallback.config.policy_version,
            policy_count: parsed.policy_count ?? fallback.config.policy_count,
            config_path: parsed.config_path ?? fallback.config.config_path,
            strategy_db_path:
              parsed.strategy_db_path ?? parsed.override_path ?? fallback.config.strategy_db_path,
            strategy_loaded:
              parsed.strategy_loaded ?? parsed.override_loaded ?? fallback.config.strategy_loaded
          };
          if (parsed.legacy_override_path !== undefined) {
            nextConfig.legacy_override_path = parsed.legacy_override_path;
          }
          config = nextConfig;
        }
      } catch {
        // Ignore malformed config payload and keep fallback values.
      }
    }

    const hooks: Record<string, HookCounter> = {};
    for (const hook of DEFAULT_HOOKS) {
      hooks[hook] = createHookCounter();
    }

    const rows = this.#db
      .prepare(
        `
        SELECT hook, total, allow, warn, challenge, block, last_ts, last_tool, last_scope
        FROM hook_counters
      `,
      )
      .all() as HookRow[];

    for (const row of rows) {
      const counter: HookCounter = {
        total: Number(row.total ?? 0),
        allow: Number(row.allow ?? 0),
        warn: Number(row.warn ?? 0),
        challenge: Number(row.challenge ?? 0),
        block: Number(row.block ?? 0)
      };
      const lastTs = optionalString(row.last_ts);
      const lastTool = optionalString(row.last_tool);
      const lastScope = optionalString(row.last_scope);
      if (lastTs !== undefined) {
        counter.last_ts = lastTs;
      }
      if (lastTool !== undefined) {
        counter.last_tool = lastTool;
      }
      if (lastScope !== undefined) {
        counter.last_scope = lastScope;
      }
      hooks[row.hook] = counter;
    }

    const decisions = this.#db
      .prepare(
        `
        SELECT ts, hook, trace_id, actor, scope, tool, decision, decision_source, resource_scope, reasons_json, rules
        FROM decisions
        ORDER BY id DESC
        LIMIT ?
      `,
      )
      .all(this.#maxRecent) as DecisionRow[];

    const recent = decisions.map((row) => {
      const result: StatusRecord = {
        ts: row.ts,
        hook: row.hook,
        trace_id: row.trace_id,
        decision: row.decision,
        reasons: parseReasons(row.reasons_json)
      };
      const actor = optionalString(row.actor);
      const scope = optionalString(row.scope);
      const tool = optionalString(row.tool);
      const decisionSource = optionalString(row.decision_source);
      const resourceScope = optionalString(row.resource_scope);
      const rules = optionalString(row.rules);
      if (actor) {
        result.actor = actor;
      }
      if (scope) {
        result.scope = scope;
      }
      if (tool) {
        result.tool = tool;
      }
      if (decisionSource) {
        result.decision_source = decisionSource as DecisionSource;
      }
      if (resourceScope) {
        result.resource_scope = resourceScope;
      }
      if (rules) {
        result.rules = rules;
      }
      return result;
    });

    return {
      updated_at: updatedAt,
      started_at: startedAt,
      config,
      hooks,
      recent_decisions: recent
    };
  }

  #flushSnapshot(): void {
    const snapshot = this.#readStatus();
    writeFileSync(this.#snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}
