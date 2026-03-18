export type AdminLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type AdminServerOptions = {
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

export type AdminRuntime = {
  port: number;
  configPath: string;
  legacyOverridePath: string;
  statusPath: string;
  dbPath: string;
  openClawHome: string;
};

export type AdminServerStartResult = {
  state: "started" | "already-running";
  runtime: AdminRuntime;
};

export type GlobalWithSecurityClawAdmin = typeof globalThis & {
  __securityclawAdminStartPromise?: Promise<AdminServerStartResult>;
};

export type JsonRecord = Record<string, unknown>;
export type DecisionValue = "allow" | "warn" | "challenge" | "block";

export type DecisionHistoryRecord = {
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

export type DecisionHistoryCounts = {
  all: number;
  allow: number;
  warn: number;
  challenge: number;
  block: number;
};

export type DecisionHistoryPage = {
  items: DecisionHistoryRecord[];
  total: number;
  page: number;
  page_size: number;
  counts: DecisionHistoryCounts;
};

export type DecisionHistoryRow = {
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

export const DEFAULT_DECISION_PAGE_SIZE = 12;
export const MAX_DECISION_PAGE_SIZE = 100;

export const EMPTY_DECISION_COUNTS: DecisionHistoryCounts = {
  all: 0,
  allow: 0,
  warn: 0,
  challenge: 0,
  block: 0,
};
