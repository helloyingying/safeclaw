import type { ClawGuardExemptionRecord } from "./claw_guard_types.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeExemptionRecord(value: unknown): ClawGuardExemptionRecord | null {
  const record = asRecord(value);
  const findingId = readString(record.findingId);
  const createdAt = readString(record.createdAt);
  const updatedAt = readString(record.updatedAt);
  const reason = readString(record.reason);
  if (!findingId || !createdAt || !updatedAt) {
    return null;
  }
  return {
    findingId,
    createdAt,
    updatedAt,
    ...(reason ? { reason } : {}),
  };
}

function compareExemptionRecords(left: ClawGuardExemptionRecord, right: ClawGuardExemptionRecord): number {
  return left.findingId.localeCompare(right.findingId, "en-US");
}

export function readClawGuardExemptions(config: Record<string, unknown>): ClawGuardExemptionRecord[] {
  const pluginConfig = asRecord(asRecord(asRecord(asRecord(config.plugins).entries).securityclaw).config);
  const records = new Map<string, ClawGuardExemptionRecord>();
  for (const entry of asArray(pluginConfig.hardeningExemptions)) {
    const normalized = normalizeExemptionRecord(entry);
    if (!normalized) {
      continue;
    }
    const current = records.get(normalized.findingId);
    if (!current || current.updatedAt.localeCompare(normalized.updatedAt, "en-US") < 0) {
      records.set(normalized.findingId, normalized);
    }
  }
  return Array.from(records.values()).sort(compareExemptionRecords);
}

export function readClawGuardExemptionMap(config: Record<string, unknown>): Map<string, ClawGuardExemptionRecord> {
  return new Map(readClawGuardExemptions(config).map((record) => [record.findingId, record] as const));
}

export function upsertClawGuardExemption(
  currentRecords: ClawGuardExemptionRecord[],
  input: {
    findingId: string;
    reason?: string;
    timestamp?: string;
  },
): ClawGuardExemptionRecord[] {
  const timestamp = readString(input.timestamp) || new Date().toISOString();
  const nextRecord: ClawGuardExemptionRecord = {
    findingId: input.findingId,
    createdAt: currentRecords.find((record) => record.findingId === input.findingId)?.createdAt || timestamp,
    updatedAt: timestamp,
    ...(readString(input.reason) ? { reason: readString(input.reason) } : {}),
  };
  return Array.from(
    new Map(
      [...currentRecords.filter((record) => record.findingId !== input.findingId), nextRecord].map((record) => [
        record.findingId,
        record,
      ]),
    ).values(),
  ).sort(compareExemptionRecords);
}

export function removeClawGuardExemption(
  currentRecords: ClawGuardExemptionRecord[],
  findingId: string,
): ClawGuardExemptionRecord[] {
  return currentRecords.filter((record) => record.findingId !== findingId).sort(compareExemptionRecords);
}

export function buildClawGuardExemptionsPatch(records: ClawGuardExemptionRecord[]): Record<string, unknown> {
  return {
    plugins: {
      entries: {
        securityclaw: {
          config: {
            hardeningExemptions: records.map((record) => ({
              findingId: record.findingId,
              ...(record.reason ? { reason: record.reason } : {}),
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            })),
          },
        },
      },
    },
  };
}
