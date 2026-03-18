import http from "node:http";
import { existsSync } from "node:fs";

import type { SecurityClawLocale } from "../i18n/locale.ts";
import { pickLocalized, resolveSecurityClawLocale } from "../i18n/locale.ts";
import { readSecurityClawAdminServerEnv } from "../runtime/process_env.ts";
import { readJsonRecordFile } from "./file_reader.ts";
import {
  DEFAULT_DECISION_PAGE_SIZE,
  MAX_DECISION_PAGE_SIZE,
  type JsonRecord,
} from "./server_types.ts";

const DEFAULT_ADMIN_ENV = readSecurityClawAdminServerEnv();
const ADMIN_DEFAULT_LOCALE = resolveSecurityClawLocale(DEFAULT_ADMIN_ENV.locale, "en");

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

export function localize(locale: SecurityClawLocale, zhText: string, enText: string): string {
  return pickLocalized(locale, zhText, enText);
}

function readHeaderLocale(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function resolveRequestLocale(req: http.IncomingMessage, url: URL): SecurityClawLocale {
  const headerLocale = readHeaderLocale(req.headers["x-securityclaw-locale"]);
  const queryLocale = url.searchParams.get("locale") ?? url.searchParams.get("lang") ?? undefined;
  return resolveSecurityClawLocale(headerLocale ?? queryLocale, ADMIN_DEFAULT_LOCALE);
}

export async function readBody(req: http.IncomingMessage): Promise<JsonRecord> {
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

export function safeReadStatus(statusPath: string): JsonRecord {
  if (!existsSync(statusPath)) {
    return {
      message: "status file not found yet",
      status_path: statusPath,
    };
  }

  try {
    return readJsonRecordFile(statusPath);
  } catch {
    return {
      message: "status file exists but cannot be parsed",
      status_path: statusPath,
    };
  }
}

export function parsePositiveInteger(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function clampDecisionPageSize(value: string | null | undefined): number {
  return Math.min(MAX_DECISION_PAGE_SIZE, parsePositiveInteger(value, DEFAULT_DECISION_PAGE_SIZE));
}
