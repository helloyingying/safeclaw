import { readFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

export function readUtf8File(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

export function readJsonRecordFile(filePath: string): JsonRecord {
  return JSON.parse(readUtf8File(filePath)) as JsonRecord;
}

