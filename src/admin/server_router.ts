import http from "node:http";
import os from "node:os";
import path from "node:path";

import { ConfigManager } from "../config/loader.ts";
import { applyRuntimeOverride, type RuntimeOverride } from "../config/runtime_override.ts";
import { StrategyStore } from "../config/strategy_store.ts";
import { AccountPolicyEngine } from "../domain/services/account_policy_engine.ts";
import {
  compileStrategyV2,
  normalizeStrategyV2,
} from "../domain/services/strategy_model.ts";
import { listOpenClawChatSessions } from "./openclaw_session_catalog.ts";
import { SkillInterceptionStore } from "./skill_interception_store.ts";
import { readUtf8File } from "./file_reader.ts";
import { readDecisionsPage } from "./decision_history.ts";
import {
  listDirectoryBrowseRoots,
  listDirectoryChildren,
  listFileRuleDirectoryOptions,
  normalizeBrowsePath,
} from "./file_rule_directory_browser.ts";
import {
  localize,
  readBody,
  resolveRequestLocale,
  safeReadStatus,
  sendJson,
  sendText,
} from "./server_shared.ts";
import {
  countStrategyRules,
  readAccountPolicies,
  readEffectivePolicy,
  readStrategyModel,
  summarizeTotals,
} from "./server_policy.ts";
import { PUBLIC_DIR } from "./server_runtime.ts";
import type { AdminRuntime } from "./server_types.ts";

type AdminRouteDependencies = {
  runtime: AdminRuntime;
  strategyStore: StrategyStore;
  skillStore: SkillInterceptionStore;
};

function sendServerError(res: http.ServerResponse, error: unknown): void {
  sendJson(res, 500, { error: String(error) });
}

function sendClientError(res: http.ServerResponse, error: unknown): void {
  sendJson(res, 400, { ok: false, error: String(error) });
}

export function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  dependencies: AdminRouteDependencies,
): void {
  const { runtime, strategyStore, skillStore } = dependencies;
  const locale = resolveRequestLocale(req, url);

  if (req.method === "GET" && url.pathname === "/api/status") {
    try {
      const status = safeReadStatus(runtime.statusPath);
      const { effective, override } = readEffectivePolicy(runtime, strategyStore);
      sendJson(res, 200, {
        paths: {
          config_path: runtime.configPath,
          legacy_override_path: runtime.legacyOverridePath,
          status_path: runtime.statusPath,
          db_path: runtime.dbPath,
        },
        status,
        totals: summarizeTotals(status),
        effective: {
          environment: effective.environment,
          policy_version: effective.policy_version,
          policy_count: effective.policies.length,
          file_rule_count: effective.file_rules.length,
          event_sink_enabled: Boolean(effective.event_sink.webhook_url),
          strategy_loaded: Boolean(override),
        },
      });
    } catch (error) {
      sendServerError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/decisions") {
    try {
      sendJson(res, 200, readDecisionsPage(runtime, url));
    } catch (error) {
      sendServerError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills/status") {
    try {
      sendJson(res, 200, skillStore.getStatus());
    } catch (error) {
      sendServerError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    try {
      sendJson(
        res,
        200,
        skillStore.listSkills({
          risk: url.searchParams.get("risk"),
          state: url.searchParams.get("state"),
          source: url.searchParams.get("source"),
          drift: url.searchParams.get("drift"),
          intercepted: url.searchParams.get("intercepted"),
        }),
      );
    } catch (error) {
      sendServerError(res, error);
    }
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/skills/policy") {
    void (async () => {
      try {
        const body = await readBody(req);
        const policy = skillStore.writePolicyConfig(body);
        sendJson(res, 200, {
          ok: true,
          restart_required: false,
          message: localize(
            locale,
            "Skill 拦截策略已保存到本地 SQLite，并会在下一次扫描与后台刷新时自动生效。",
            "Skill interception policy has been saved to local SQLite and will apply on the next scan and dashboard refresh.",
          ),
          policy,
        });
      } catch (error) {
        sendClientError(res, error);
      }
    })();
    return;
  }

  const skillRouteMatch = url.pathname.match(/^\/api\/skills\/([^/]+?)(?:\/(rescan|quarantine|trust-override))?$/);
  if (skillRouteMatch) {
    const skillId = decodeURIComponent(skillRouteMatch[1]);
    const action = skillRouteMatch[2];

    if (req.method === "GET" && !action) {
      try {
        const detail = skillStore.getSkill(skillId);
        if (!detail) {
          sendJson(res, 404, { error: "skill not found" });
          return;
        }
        sendJson(res, 200, detail);
      } catch (error) {
        sendServerError(res, error);
      }
      return;
    }

    if (req.method === "POST" && action === "rescan") {
      try {
        const detail = skillStore.rescanSkill(skillId, "admin-ui");
        if (!detail) {
          sendJson(res, 404, { error: "skill not found" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          message: localize(
            locale,
            "Skill 已完成重扫，风险结论和最新信号已刷新。",
            "The skill has been rescanned and the latest risk signals have been refreshed.",
          ),
          detail,
        });
      } catch (error) {
        sendClientError(res, error);
      }
      return;
    }

    if (req.method === "POST" && action === "quarantine") {
      void (async () => {
        try {
          const body = await readBody(req);
          const detail = skillStore.setQuarantine(skillId, {
            quarantined: Boolean(body.quarantined),
            updatedBy: typeof body.updated_by === "string" ? body.updated_by : "admin-ui",
          });
          if (!detail) {
            sendJson(res, 404, { error: "skill not found" });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            message: body.quarantined
              ? localize(
                  locale,
                  "Skill 已隔离，高危调用会按更严格策略阻断。",
                  "The skill is quarantined and high-risk calls will be blocked more aggressively.",
                )
              : localize(
                  locale,
                  "Skill 已解除隔离，后续将按风险策略继续评估。",
                  "The skill quarantine has been removed and future actions will follow risk policy again.",
                ),
            detail,
          });
        } catch (error) {
          sendClientError(res, error);
        }
      })();
      return;
    }

    if (req.method === "POST" && action === "trust-override") {
      void (async () => {
        try {
          const body = await readBody(req);
          const detail = skillStore.setTrustOverride(skillId, {
            enabled: Boolean(body.enabled),
            updatedBy: typeof body.updated_by === "string" ? body.updated_by : "admin-ui",
            ...(typeof body.hours === "number" ? { hours: body.hours } : {}),
          });
          if (!detail) {
            sendJson(res, 404, { error: "skill not found" });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            message: body.enabled
              ? localize(
                  locale,
                  "Skill 已设置临时受信覆盖，仍会保留审计记录与过期时间。",
                  "A temporary trust override has been applied. Audit records and expiry time are preserved.",
                )
              : localize(
                  locale,
                  "Skill 的受信覆盖已撤销，风险矩阵恢复正常生效。",
                  "The trust override has been removed and the normal risk matrix is active again.",
                ),
            detail,
          });
        } catch (error) {
          sendClientError(res, error);
        }
      })();
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/file-rule/directories") {
    try {
      const { effective } = readEffectivePolicy(runtime, strategyStore);
      const existingRuleDirectories = listFileRuleDirectoryOptions(effective.file_rules.map((rule) => rule.directory));
      const roots = listDirectoryBrowseRoots(existingRuleDirectories);
      const fallbackPath = roots[0] ?? path.normalize(os.homedir());
      const currentPath = normalizeBrowsePath(url.searchParams.get("path"), fallbackPath);
      const parentPath = path.dirname(currentPath);
      sendJson(res, 200, {
        current_path: currentPath,
        ...(parentPath && parentPath !== currentPath ? { parent_path: parentPath } : {}),
        roots,
        directories: listDirectoryChildren(currentPath),
      });
    } catch (error) {
      sendServerError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/strategy") {
    try {
      const { effective, override } = readEffectivePolicy(runtime, strategyStore);
      const strategyModel = readStrategyModel(effective, override);
      sendJson(res, 200, {
        paths: {
          config_path: runtime.configPath,
          db_path: runtime.dbPath,
        },
        override: override ?? {},
        strategy: {
          environment: effective.environment,
          policy_version: effective.policy_version,
          model: strategyModel,
          file_rule_directories: listFileRuleDirectoryOptions(effective.file_rules.map((rule) => rule.directory)),
          compiled: {
            policy_count: effective.policies.length,
            rule_count: countStrategyRules(strategyModel),
            capability_count: strategyModel.tool_policy.capabilities.length,
            file_rule_count: effective.file_rules.length,
            sensitive_path_rule_count: effective.sensitivity.path_rules.length,
          },
        },
      });
    } catch (error) {
      sendServerError(res, error);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    try {
      const override = strategyStore.readOverride() ?? {};
      sendJson(res, 200, {
        paths: {
          db_path: runtime.dbPath,
          openclaw_home: runtime.openClawHome,
        },
        account_policies: AccountPolicyEngine.sanitize(override.account_policies),
        sessions: listOpenClawChatSessions(runtime.openClawHome),
      });
    } catch (error) {
      sendServerError(res, error);
    }
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/strategy") {
    void (async () => {
      try {
        const body = await readBody(req);
        const current = strategyStore.readOverride() ?? {};
        const base = ConfigManager.fromFile(runtime.configPath).getConfig();
        const currentStrategy = readStrategyModel(current.strategy ? applyRuntimeOverride(base, current) : base, current);
        const nextStrategy = normalizeStrategyV2(body.strategy ?? body.strategy_v2 ?? currentStrategy);
        if (!nextStrategy) {
          throw new Error("strategy payload must be a StrategyV2 object");
        }
        compileStrategyV2(base, nextStrategy);

        const nextOverride: RuntimeOverride = {
          ...current,
          updated_at: new Date().toISOString(),
          environment: typeof body.environment === "string" ? body.environment : current.environment,
          policy_version: typeof body.policy_version === "string" ? body.policy_version : current.policy_version,
          strategy: nextStrategy,
        };

        const validated = applyRuntimeOverride(base, nextOverride);
        strategyStore.writeOverride(nextOverride);

        sendJson(res, 200, {
          ok: true,
          restart_required: false,
          message: localize(
            locale,
            "策略已保存到本地 SQLite，并会在下一次安全决策时自动生效。",
            "Strategy has been saved to local SQLite and will apply on the next security decision.",
          ),
          effective: {
            environment: validated.environment,
            policy_version: validated.policy_version,
            policy_count: validated.policies.length,
            capability_count: nextStrategy.tool_policy.capabilities.length,
            rule_count: countStrategyRules(nextStrategy),
            file_rule_count: validated.file_rules.length,
            sensitive_path_rule_count: validated.sensitivity.path_rules.length,
          },
        });
      } catch (error) {
        sendClientError(res, error);
      }
    })();
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/accounts") {
    void (async () => {
      try {
        const body = await readBody(req);
        const current = strategyStore.readOverride() ?? {};
        const nextOverride: RuntimeOverride = {
          ...current,
          updated_at: new Date().toISOString(),
          account_policies: AccountPolicyEngine.sanitize(body.account_policies),
        };

        const base = ConfigManager.fromFile(runtime.configPath).getConfig();
        applyRuntimeOverride(base, nextOverride);
        strategyStore.writeOverride(nextOverride);

        sendJson(res, 200, {
          ok: true,
          restart_required: false,
          message: localize(
            locale,
            "账号策略已保存到本地 SQLite，并会在下一次安全决策时自动生效。",
            "Account policies have been saved to local SQLite and will apply on the next security decision.",
          ),
          account_policy_count: readAccountPolicies(strategyStore).length,
        });
      } catch (error) {
        sendClientError(res, error);
      }
    })();
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const relative = url.pathname === "/" ? "/index.html" : url.pathname;
  const absolute = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!absolute.startsWith(PUBLIC_DIR)) {
    sendText(res, 404, "Not found");
    return;
  }

  try {
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
    sendText(res, 200, readUtf8File(absolute), contentType);
  } catch {
    sendText(res, 404, "Not found");
  }
}
