import http from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigManager } from "../src/config/loader.ts";
import {
  applyRuntimeOverride,
  readRuntimeOverride,
  writeRuntimeOverride,
  type RuntimeOverride
} from "../src/config/runtime_override.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.resolve(ROOT, "admin/public");
const DEFAULT_PORT = Number(process.env.SAFECLAW_ADMIN_PORT ?? 4780);
const DEFAULT_CONFIG_PATH = process.env.SAFECLAW_CONFIG_PATH ?? path.resolve(ROOT, "config/policy.default.yaml");
const DEFAULT_OVERRIDE_PATH = process.env.SAFECLAW_OVERRIDE_PATH ?? path.resolve(ROOT, "config/policy.overrides.json");
const DEFAULT_STATUS_PATH = process.env.SAFECLAW_STATUS_PATH ?? path.resolve(ROOT, "runtime/safeclaw-status.json");

type AdminLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type AdminServerOptions = {
  port?: number;
  configPath?: string;
  overridePath?: string;
  statusPath?: string;
  logger?: AdminLogger;
  reclaimPortOnStart?: boolean;
};

type AdminRuntime = {
  port: number;
  configPath: string;
  overridePath: string;
  statusPath: string;
};

type AdminServerStartResult = {
  state: "started" | "already-running";
  runtime: AdminRuntime;
};

type GlobalWithSafeClawAdmin = typeof globalThis & {
  __safeclawAdminStartPromise?: Promise<AdminServerStartResult>;
};

type JsonRecord = Record<string, unknown>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
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

function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  runtime: AdminRuntime,
): void {
  if (req.method === "GET" && url.pathname === "/api/status") {
    try {
      const status = safeReadStatus(runtime.statusPath);
      const { effective, override } = readEffectivePolicy(runtime);
      sendJson(res, 200, {
        paths: {
          config_path: runtime.configPath,
          override_path: runtime.overridePath,
          status_path: runtime.statusPath
        },
        status,
        totals: summarizeTotals(status),
        effective: {
          environment: effective.environment,
          policy_version: effective.policy_version,
          policy_count: effective.policies.length,
          event_sink_enabled: Boolean(effective.event_sink.webhook_url),
          override_loaded: Boolean(override)
        }
      });
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/strategy") {
    try {
      const { effective, override } = readEffectivePolicy(runtime);
      sendJson(res, 200, {
        paths: {
          config_path: runtime.configPath,
          override_path: runtime.overridePath
        },
        override: override ?? {},
        strategy: {
          environment: effective.environment,
          policy_version: effective.policy_version,
          risk: {
            base_score: effective.risk.base_score,
            warn_threshold: effective.risk.warn_threshold,
            challenge_threshold: effective.risk.challenge_threshold,
            block_threshold: effective.risk.block_threshold
          },
          policies: effective.policies
        }
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
        const current = readRuntimeOverride(runtime.overridePath) ?? {};

        const nextOverride: RuntimeOverride = {
          ...current,
          updated_at: new Date().toISOString(),
          environment:
            typeof body.environment === "string" ? body.environment : current.environment,
          policy_version:
            typeof body.policy_version === "string" ? body.policy_version : current.policy_version,
          risk:
            typeof body.risk === "object" && body.risk !== null
              ? (body.risk as RuntimeOverride["risk"])
              : current.risk,
          policies:
            Array.isArray(body.policies)
              ? (body.policies as RuntimeOverride["policies"])
              : current.policies
        };

        const base = ConfigManager.fromFile(runtime.configPath).getConfig();
        const validated = applyRuntimeOverride(base, nextOverride);
        writeRuntimeOverride(runtime.overridePath, nextOverride);

        sendJson(res, 200, {
          ok: true,
          restart_required: true,
          message: "策略已保存到 override 文件。若网关未启用热加载，请重启 openclaw-gateway。",
          effective: {
            environment: validated.environment,
            policy_version: validated.policy_version,
            policy_count: validated.policies.length
          }
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

function readEffectivePolicy(runtime: AdminRuntime): {
  base: ReturnType<ConfigManager["getConfig"]>;
  effective: ReturnType<ConfigManager["getConfig"]>;
  override?: RuntimeOverride;
} {
  const base = ConfigManager.fromFile(runtime.configPath).getConfig();
  const override = readRuntimeOverride(runtime.overridePath);
  const effective = override ? applyRuntimeOverride(base, override) : base;
  return override !== undefined ? { base, effective, override } : { base, effective };
}

function resolveRuntime(options: AdminServerOptions): AdminRuntime {
  return {
    port: options.port ?? DEFAULT_PORT,
    configPath: options.configPath ?? DEFAULT_CONFIG_PATH,
    overridePath: options.overridePath ?? DEFAULT_OVERRIDE_PATH,
    statusPath: options.statusPath ?? DEFAULT_STATUS_PATH
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
  return /(openclaw|safeclaw|admin\/server|gateway)/i.test(command);
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
        `SafeClaw admin: port ${port} is in use by pid=${pid}, but command is not OpenClaw/SafeClaw; skip terminate.`,
      );
      continue;
    }

    try {
      process.kill(pid, "SIGKILL");
      logger.warn?.(`SafeClaw admin: killed stale admin process pid=${pid} on port ${port}.`);
    } catch (error) {
      logger.warn?.(`SafeClaw admin: failed to kill pid=${pid} on port ${port} (${String(error)}).`);
    }
  }
}

export function startAdminServer(options: AdminServerOptions = {}): Promise<AdminServerStartResult> {
  const state = globalThis as GlobalWithSafeClawAdmin;
  if (state.__safeclawAdminStartPromise) {
    return state.__safeclawAdminStartPromise;
  }

  const runtime = resolveRuntime(options);
  const logger: AdminLogger = options.logger ?? {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message)
  };
  const reclaimPortOnStart = options.reclaimPortOnStart ?? true;

  if (reclaimPortOnStart) {
    reclaimAdminPort(runtime.port, logger);
  }

  const startPromise = new Promise<AdminServerStartResult>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        handleApi(req, res, url, runtime);
        return;
      }
      serveStatic(req, res, url);
    });

    let resolved = false;
    server.once("error", (error: Error & { code?: string }) => {
      if (error.code === "EADDRINUSE") {
        resolved = true;
        logger.warn?.(
          `SafeClaw admin already running on http://127.0.0.1:${runtime.port} (port in use); reusing existing server.`,
        );
        resolve({ state: "already-running", runtime });
        return;
      }
      logger.error?.(`SafeClaw admin failed to start: ${String(error)}`);
      reject(error);
    });

    server.listen(runtime.port, "127.0.0.1", () => {
      resolved = true;
      logger.info?.(`SafeClaw admin listening on http://127.0.0.1:${runtime.port}`);
      logger.info?.(`Using config: ${runtime.configPath}`);
      logger.info?.(`Using override: ${runtime.overridePath}`);
      logger.info?.(`Using status: ${runtime.statusPath}`);
      resolve({ state: "started", runtime });
    });

    server.on("close", () => {
      const current = globalThis as GlobalWithSafeClawAdmin;
      if (current.__safeclawAdminStartPromise && resolved) {
        delete current.__safeclawAdminStartPromise;
      }
    });
  });

  state.__safeclawAdminStartPromise = startPromise.catch((error) => {
    delete state.__safeclawAdminStartPromise;
    throw error;
  });
  return state.__safeclawAdminStartPromise;
}

const thisFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entryFile && entryFile === thisFile) {
  void startAdminServer().catch((error) => {
    console.error(`SafeClaw admin startup failed: ${String(error)}`);
    process.exitCode = 1;
  });
}
