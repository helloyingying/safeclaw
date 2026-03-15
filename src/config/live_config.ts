import { existsSync, statSync } from "node:fs";

import type { SafeClawConfig } from "../types.ts";
import { ConfigManager } from "./loader.ts";
import { applyRuntimeOverride, type RuntimeOverride } from "./runtime_override.ts";
import { StrategyStore } from "./strategy_store.ts";

type LiveConfigLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type LiveConfigOptions = {
  configPath: string;
  dbPath: string;
  legacyOverridePath?: string;
  logger?: LiveConfigLogger;
  transform?: (config: SafeClawConfig) => SafeClawConfig;
  onReload?: (snapshot: LiveConfigSnapshot) => void;
};

export type LiveConfigSnapshot = {
  config: SafeClawConfig;
  override?: RuntimeOverride;
  overrideLoaded: boolean;
};

function safeMtimeMs(filePath: string): number | undefined {
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }
    return statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

function overrideSignature(override: RuntimeOverride | undefined): string {
  return override ? JSON.stringify(override) : "none";
}

export class LiveConfigResolver {
  #configPath: string;
  #configManager: ConfigManager;
  #strategyStore: StrategyStore;
  #logger: LiveConfigLogger | undefined;
  #transform: ((config: SafeClawConfig) => SafeClawConfig) | undefined;
  #onReload: ((snapshot: LiveConfigSnapshot) => void) | undefined;
  #configMtimeMs: number | undefined;
  #overrideSig = "uninitialized";
  #snapshot: LiveConfigSnapshot;

  constructor(options: LiveConfigOptions) {
    this.#configPath = options.configPath;
    this.#logger = options.logger;
    this.#transform = options.transform;
    this.#onReload = options.onReload;
    this.#configManager = ConfigManager.fromFile(options.configPath);
    const initialConfig = this.#configManager.getConfig();
    this.#snapshot = {
      config: this.#transform ? this.#transform(initialConfig) : initialConfig,
      overrideLoaded: false
    };
    this.#strategyStore = new StrategyStore(options.dbPath, {
      ...(options.legacyOverridePath !== undefined ? { legacyOverridePath: options.legacyOverridePath } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {})
    });
    this.#configMtimeMs = safeMtimeMs(this.#configPath);
    this.#snapshot = this.#buildSnapshot(true);
  }

  getSnapshot(): LiveConfigSnapshot {
    const nextMtimeMs = safeMtimeMs(this.#configPath);
    const baseChanged = nextMtimeMs !== this.#configMtimeMs;
    if (baseChanged) {
      this.#configManager.reload();
      this.#configMtimeMs = nextMtimeMs;
    }

    let override: RuntimeOverride | undefined;
    try {
      override = this.#strategyStore.readOverride();
    } catch (error) {
      this.#logger?.warn?.(`safeclaw: failed to read runtime strategy override (${String(error)})`);
      return this.#snapshot;
    }

    const nextOverrideSig = overrideSignature(override);
    if (!baseChanged && nextOverrideSig === this.#overrideSig) {
      return this.#snapshot;
    }

    return this.#buildSnapshot(false, override, nextOverrideSig);
  }

  close(): void {
    this.#strategyStore.close();
  }

  #buildSnapshot(
    isInitialLoad: boolean,
    override?: RuntimeOverride,
    signature?: string,
  ): LiveConfigSnapshot {
    const base = this.#configManager.getConfig();
    let effectiveOverride = override;

    if (effectiveOverride === undefined) {
      try {
        effectiveOverride = this.#strategyStore.readOverride();
      } catch (error) {
        this.#logger?.warn?.(`safeclaw: failed to read runtime strategy override (${String(error)})`);
        return this.#snapshot;
      }
    }
    const effectiveSignature = signature ?? overrideSignature(effectiveOverride);

    try {
      const effective = effectiveOverride ? applyRuntimeOverride(base, effectiveOverride) : base;
      const config = this.#transform ? this.#transform(effective) : effective;
      this.#overrideSig = effectiveSignature;
      const snapshot: LiveConfigSnapshot = {
        config,
        overrideLoaded: Boolean(effectiveOverride)
      };
      if (effectiveOverride !== undefined) {
        snapshot.override = effectiveOverride;
      }
      this.#snapshot = snapshot;
      const action = isInitialLoad ? "loaded" : "reloaded";
      this.#logger?.info?.(
        `safeclaw: ${action} policy_version=${config.policy_version} rules=${config.policies.length} strategy_loaded=${Boolean(effectiveOverride)}`,
      );
      if (!isInitialLoad) {
        this.#onReload?.(this.#snapshot);
      }
      return this.#snapshot;
    } catch (error) {
      this.#logger?.warn?.(`safeclaw: failed to apply runtime strategy (${String(error)})`);
      return this.#snapshot;
    }
  }
}
