import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type { AdminRuntime } from "./server_types.ts";
import type { ClawGuardConfigSnapshot } from "./claw_guard_types.ts";
import type { RunProcessSyncResult } from "../runtime/process_runner.ts";
import { HardeningCache } from "./hardening_cache.ts";

type OpenClawConfigClientDeps = {
  runCli?: (args: string[], timeoutMs?: number) => RunProcessSyncResult | Promise<RunProcessSyncResult>;
  loadLocalConfig?: () => Promise<unknown>;
  hardeningCache?: HardeningCache;
};

type ReadConfigSnapshotOptions = {
  fast?: boolean;
  requireWritable?: boolean;
};

const requireFromHere = createRequire(import.meta.url);
const OPENCLAW_ENTRY = requireFromHere.resolve("openclaw");
const OPENCLAW_CLI_ENTRY = path.resolve(path.dirname(OPENCLAW_ENTRY), "../openclaw.mjs");
const DEFAULT_RPC_TIMEOUT_MS = 15000;
const FAST_RPC_TIMEOUT_MS = 8000;
const FAST_RPC_GRACE_MS = 1200;
const OPENCLAW_CLI_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_HIDE_BANNER: "1",
  OPENCLAW_SUPPRESS_NOTES: "1",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function extractJsonPayload(raw: string): unknown {
  const candidates: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "{" || char === "[") {
      candidates.push(index);
    }
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = raw.slice(candidates[index]).trim();
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  throw new Error("OpenClaw CLI did not return a JSON payload");
}

async function defaultLoadLocalConfig(openClawHome: string): Promise<unknown> {
  try {
    const raw = await readFile(path.join(openClawHome, "openclaw.json"), "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    // Fall through to OpenClaw's loader when the plain JSON file is unavailable
    // or uses features beyond raw JSON.
  }
  // @ts-expect-error openclaw does not expose a root declaration file.
  const module = await import("openclaw");
  return typeof module.loadConfig === "function" ? module.loadConfig() : {};
}

function summarizeCliFailure(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("[plugins]"))
    .filter((line) => line !== "Config warnings:")
    .filter((line) => !line.startsWith("- "));

  const selected = lines.filter((line) => (
    line.startsWith("Gateway call failed:")
    || line.startsWith("Gateway target:")
    || line.startsWith("Source:")
    || line.startsWith("Config:")
    || line.startsWith("Bind:")
    || /timeout|unreachable|refused|unauthorized|rpc|failed|error/i.test(line)
  ));

  const summary = (selected.length > 0 ? selected : lines.slice(-2)).slice(0, 5).join("\n").trim();
  return summary || "OpenClaw CLI exited before returning a config payload";
}

function formatReadOnlyFallbackReason(error: unknown): string {
  return `Gateway RPC is unavailable. Read-only fallback is active. ${String(error)}`;
}

function waitFor(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });
}

function extractCliJson(result: RunProcessSyncResult): unknown {
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const candidates = [
    stdout,
    [stdout, stderr].filter(Boolean).join("\n").trim(),
    stderr,
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  for (const candidate of candidates) {
    try {
      return extractJsonPayload(candidate);
    } catch {
      continue;
    }
  }

  throw new Error("OpenClaw CLI did not return a JSON payload");
}

export class OpenClawConfigClient {
  private readonly runtime: AdminRuntime;
  private readonly deps: OpenClawConfigClientDeps;

  constructor(runtime: AdminRuntime, deps: OpenClawConfigClientDeps = {}) {
    this.runtime = runtime;
    this.deps = deps;
  }

  private runCliWithCommand(command: string, args: string[], timeoutMs: number): Promise<RunProcessSyncResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let processError: unknown;
      let timedOut = false;

      const child = spawn(command, args, {
        cwd: this.runtime.openClawHome,
        env: OPENCLAW_CLI_ENV,
        stdio: "pipe",
        windowsHide: true,
      });

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        processError = error;
      });

      const timer = timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            processError = new Error(`OpenClaw command timed out after ${timeoutMs}ms`);
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;

      child.on("close", (code) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve({
          status: timedOut ? null : code,
          stdout,
          stderr,
          ...(processError ? { error: processError } : {}),
        });
      });
    });
  }

  private async runCli(args: string[], timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<RunProcessSyncResult> {
    if (typeof this.deps.runCli === "function") {
      return this.deps.runCli(args, timeoutMs);
    }
    const direct = await this.runCliWithCommand("openclaw", args, timeoutMs);
    const directError = direct.error as NodeJS.ErrnoException | undefined;
    if (!directError || directError.code !== "ENOENT") {
      return direct;
    }
    return this.runCliWithCommand(process.execPath, [OPENCLAW_CLI_ENTRY, ...args], timeoutMs);
  }

  private async loadLocalConfig(): Promise<unknown> {
    if (typeof this.deps.loadLocalConfig === "function") {
      return this.deps.loadLocalConfig();
    }
    return defaultLoadLocalConfig(this.runtime.openClawHome);
  }

  private async parseCliJson(args: string[], timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<unknown> {
    const result = await this.runCli(args, timeoutMs);
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    if (result.error || result.status !== 0) {
      throw new Error(summarizeCliFailure(combined || String(result.error || "OpenClaw command failed")));
    }
    return extractCliJson(result);
  }

  private async readRpcSnapshot(timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<ClawGuardConfigSnapshot> {
    const payload = asRecord(await this.parseCliJson(["gateway", "call", "config.get", "--params", "{}", "--json"], timeoutMs));
    const config = asRecord(payload.config || payload.resolved || payload.parsed);
    const snapshot: ClawGuardConfigSnapshot = {
      config,
      ...(typeof payload.path === "string" ? { configPath: payload.path } : {}),
      source: "gateway-rpc",
      gatewayOnline: true,
      writeSupported: typeof payload.hash === "string" && payload.hash.length > 0,
      ...(typeof payload.hash === "string" ? { baseHash: payload.hash } : {}),
      ...(typeof payload.hash === "string"
        ? {}
        : { writeReason: "Gateway config hash is unavailable, so patch writes are disabled." }),
    };
    this.deps.hardeningCache?.rememberSnapshot(snapshot);
    return snapshot;
  }

  private async readLocalSnapshot(writeReason?: string): Promise<ClawGuardConfigSnapshot> {
    const config = asRecord(await this.loadLocalConfig());
    const snapshot: ClawGuardConfigSnapshot = {
      config,
      configPath: path.join(this.runtime.openClawHome, "openclaw.json"),
      source: "local-file",
      gatewayOnline: false,
      writeSupported: false,
      ...(writeReason ? { writeReason } : {}),
    };
    this.deps.hardeningCache?.rememberSnapshot(snapshot);
    return snapshot;
  }

  async readConfigSnapshot(options: ReadConfigSnapshotOptions = {}): Promise<ClawGuardConfigSnapshot> {
    const { fast = false, requireWritable = false } = options;

    if (fast && !requireWritable) {
      const cachedSnapshot = this.deps.hardeningCache?.getFastSnapshot();
      if (cachedSnapshot) {
        return cachedSnapshot;
      }

      try {
        const localSnapshot = await this.readLocalSnapshot();
        const rpcAttempt = this.readRpcSnapshot(FAST_RPC_TIMEOUT_MS)
          .then((snapshot) => ({ kind: "rpc" as const, snapshot }))
          .catch((error) => ({ kind: "rpc-error" as const, error }));
        const raced = await Promise.race([rpcAttempt, waitFor(FAST_RPC_GRACE_MS)]);
        if (raced !== "timeout") {
          if (raced.kind === "rpc") {
            return raced.snapshot;
          }
          return {
            ...localSnapshot,
            writeReason: formatReadOnlyFallbackReason(raced.error),
          };
        }
        this.deps.hardeningCache?.scheduleRpcRefresh(() => this.readRpcSnapshot(FAST_RPC_TIMEOUT_MS));
        return localSnapshot;
      } catch {
        return this.readRpcSnapshot(FAST_RPC_TIMEOUT_MS);
      }
    }

    try {
      return await this.readRpcSnapshot();
    } catch (error) {
      if (requireWritable) {
        throw error;
      }
      return this.readLocalSnapshot(formatReadOnlyFallbackReason(error));
    }
  }

  async applyPatch(input: {
    patch: Record<string, unknown>;
    baseHash: string;
    note: string;
  }): Promise<void> {
    const payload = await this.parseCliJson([
      "gateway",
      "call",
      "config.patch",
      "--params",
      JSON.stringify({
        raw: JSON.stringify(input.patch),
        baseHash: input.baseHash,
        note: input.note,
      }),
      "--json",
    ]);
    const record = asRecord(payload);
    if (record.error) {
      throw new Error(String(record.error));
    }
  }
}
