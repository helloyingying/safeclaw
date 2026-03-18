import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  matchesAdminDecisionFilter,
  normalizeAdminDecisionFilterId,
} from "./dashboard_url_state.ts";
import { clampDecisionPageSize, parsePositiveInteger, safeReadStatus } from "./server_shared.ts";
import {
  EMPTY_DECISION_COUNTS,
  type AdminRuntime,
  type DecisionHistoryCounts,
  type DecisionHistoryPage,
  type DecisionHistoryRow,
  type DecisionValue,
  type JsonRecord,
} from "./server_types.ts";

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

export function readDecisionsFromStatusFallback(
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

export function readDecisionsPage(runtime: AdminRuntime, url: URL): DecisionHistoryPage {
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
