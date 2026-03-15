import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SafeClawConfig } from "../types.ts";
import { applyRuntimeOverride, readRuntimeOverride, type RuntimeOverride } from "./runtime_override.ts";

type StrategyStoreOptions = {
  legacyOverridePath?: string;
  logger?: {
    warn?: (message: string) => void;
  };
};

type OverrideRow = {
  payload_json: string;
};

const STRATEGY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strategy_override (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class StrategyStore {
  #dbPath: string;
  #db: DatabaseSync;
  #legacyOverridePath: string | undefined;
  #logger: StrategyStoreOptions["logger"] | undefined;

  constructor(dbPath: string, options: StrategyStoreOptions = {}) {
    this.#dbPath = dbPath;
    this.#legacyOverridePath = options.legacyOverridePath;
    this.#logger = options.logger;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec("PRAGMA journal_mode=WAL;");
    this.#db.exec("PRAGMA synchronous=NORMAL;");
    this.#db.exec(STRATEGY_SCHEMA_SQL);
    this.#bootstrapFromLegacyFile();
  }

  get dbPath(): string {
    return this.#dbPath;
  }

  readOverride(): RuntimeOverride | undefined {
    const row = this.#db
      .prepare("SELECT payload_json FROM strategy_override WHERE id = 1")
      .get() as OverrideRow | undefined;
    if (!row) {
      return undefined;
    }
    const raw = JSON.parse(row.payload_json) as unknown;
    if (!isObject(raw)) {
      throw new Error("runtime override in database must be an object");
    }
    return raw as RuntimeOverride;
  }

  writeOverride(override: RuntimeOverride): void {
    const now = new Date().toISOString();
    const payload: RuntimeOverride = {
      ...override,
      updated_at: override.updated_at ?? now
    };
    this.#db
      .prepare(
        `
        INSERT INTO strategy_override (id, payload_json, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(JSON.stringify(payload), payload.updated_at ?? now);
  }

  readEffective(base: SafeClawConfig): {
    effective: SafeClawConfig;
    override?: RuntimeOverride;
  } {
    const override = this.readOverride();
    if (!override) {
      return { effective: base };
    }
    return {
      effective: applyRuntimeOverride(base, override),
      override
    };
  }

  close(): void {
    this.#db.close();
  }

  #bootstrapFromLegacyFile(): void {
    if (!this.#legacyOverridePath || this.readOverride()) {
      return;
    }
    try {
      const legacy = readRuntimeOverride(this.#legacyOverridePath);
      if (!legacy) {
        return;
      }
      this.writeOverride(legacy);
      this.#logger?.warn?.(
        `migrated strategy override from legacy file (${this.#legacyOverridePath}) into sqlite (${this.#dbPath})`,
      );
    } catch (error) {
      this.#logger?.warn?.(`failed to migrate legacy override file (${String(error)})`);
    }
  }
}
