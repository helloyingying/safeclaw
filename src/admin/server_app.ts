import http from "node:http";

import { StrategyStore } from "../config/strategy_store.ts";
import { SkillInterceptionStore } from "./skill_interception_store.ts";
import { handleApi, serveStatic } from "./server_router.ts";
import { reclaimAdminPort, resolveRuntime } from "./server_runtime.ts";
import type {
  AdminLogger,
  AdminServerOptions,
  AdminServerStartResult,
  GlobalWithSecurityClawAdmin,
} from "./server_types.ts";

export function startAdminServer(options: AdminServerOptions = {}): Promise<AdminServerStartResult> {
  const state = globalThis as GlobalWithSecurityClawAdmin;
  if (state.__securityclawAdminStartPromise) {
    return state.__securityclawAdminStartPromise;
  }

  const runtime = resolveRuntime(options);
  const logger: AdminLogger = options.logger ?? {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
  };
  const strategyStore = new StrategyStore(runtime.dbPath, {
    legacyOverridePath: runtime.legacyOverridePath,
    logger: {
      warn: (message: string) => logger.warn?.(`SecurityClaw strategy store: ${message}`),
    },
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
        handleApi(req, res, url, { runtime, strategyStore, skillStore });
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
