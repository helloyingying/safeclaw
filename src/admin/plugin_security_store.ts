import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { ClawGuardConfigSource, ClawGuardConfigSnapshot } from "./claw_guard_types.ts";
import { OpenClawConfigClient } from "./openclaw_config_client.ts";
import type { AdminRuntime } from "./server_types.ts";

export type PluginRiskTier = "low" | "medium" | "high" | "critical";
export type PluginInstallSource = "npm" | "path" | "git" | "unknown";
export type PluginState = "enabled" | "disabled";
export type PluginInstallScope = "openclaw_home" | "external" | "unknown";

export type PluginFinding = {
  code: string;
  weight: number;
  detail: string;
  evidence: string[];
};

export type PluginCodeSignals = {
  exec: number;
  network: number;
  env: number;
  file_write: number;
  dynamic_eval: number;
};

export type PluginSummary = {
  plugin_id: string;
  name: string;
  version: string;
  description: string;
  state: PluginState;
  enabled: boolean;
  source: PluginInstallSource;
  install_scope: PluginInstallScope;
  install_path: string;
  install_spec: string;
  install_reference: string;
  risk_score: number;
  risk_tier: PluginRiskTier;
  reason_codes: string[];
  findings: PluginFinding[];
  finding_count: number;
  last_scan_at: string;
  has_manifest: boolean;
  has_package_json: boolean;
  has_config_schema: boolean;
  has_integrity: boolean;
  dependency_count: number;
  channels: string[];
  skills: string[];
  entry_config_keys: string[];
  code_signals: PluginCodeSignals;
};

export type PluginStatusPayload = {
  stats: {
    total: number;
    enabled: number;
    high_critical: number;
    path_sources: number;
    exec_capable: number;
    network_capable: number;
  };
  highlights: PluginSummary[];
  generated_at: string;
  config_source: ClawGuardConfigSource;
};

export type PluginListFilters = {
  risk?: string | null;
  state?: string | null;
  source?: string | null;
};

export type PluginListPayload = {
  items: PluginSummary[];
  total: number;
  counts: {
    total: number;
    enabled: number;
    high_critical: number;
    path_sources: number;
    exec_capable: number;
    network_capable: number;
  };
  filters: {
    risk: string;
    state: string;
    source: string;
  };
  source_options: string[];
};

export type PluginDetailPayload = {
  plugin: PluginSummary;
  findings: PluginFinding[];
  manifest: {
    id: string;
    name: string;
    channels: string[];
    skills: string[];
    config_keys: string[];
  };
  package: {
    name: string;
    version: string;
    main: string;
    dependency_names: string[];
  };
  scanned_files: string[];
  generated_at: string;
  config_source: ClawGuardConfigSource;
};

type PluginInstallRecord = {
  source: PluginInstallSource;
  spec: string;
  installPath: string;
  sourcePath: string;
  version: string;
  integrity: string;
};

type PluginCandidate = {
  pluginId: string;
  installPath: string;
  source: PluginInstallSource;
  spec: string;
  sourcePath: string;
  version: string;
  integrity: string;
  enabled: boolean;
  entryConfig: Record<string, unknown>;
};

type PluginManifestSnapshot = {
  id: string;
  name: string;
  description: string;
  channels: string[];
  skills: string[];
  configKeys: string[];
  hasConfigSchema: boolean;
};

type PluginPackageSnapshot = {
  name: string;
  version: string;
  description: string;
  main: string;
  dependencyNames: string[];
};

type PluginDetailRecord = {
  plugin: PluginSummary;
  detail: PluginDetailPayload;
};

type PluginSnapshot = {
  items: PluginSummary[];
  details: Map<string, PluginDetailPayload>;
  generatedAt: string;
  configSource: ClawGuardConfigSource;
};

type PluginSecurityStoreDeps = {
  readConfigSnapshot?: () => Promise<ClawGuardConfigSnapshot>;
  now?: () => number;
};

const CACHE_TTL_MS = 15_000;
const SELF_PLUGIN_ID = "securityclaw";
const RISK_TIERS: PluginRiskTier[] = ["low", "medium", "high", "critical"];
const SCANNABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".json"]);
const RELEVANT_ROOTS = ["src", "dist", "lib", "build"];
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".next", "coverage"]);

const EXEC_SIGNAL = /\b(child_process|spawnSync?|execSync?|execFileSync?|fork)\b/;
const NETWORK_SIGNAL = /\b(fetch\(|axios\b|https?\.request\b|WebSocket\b|net\.createConnection\b|tls\.connect\b)/;
const ENV_SIGNAL = /\bprocess\.env\b/;
const FILE_WRITE_SIGNAL = /\b(writeFileSync?|appendFileSync?|unlinkSync?|rmSync|renameSync|mkdirSync|createWriteStream)\b/;
const DYNAMIC_EVAL_SIGNAL = /\b(eval\(|new Function\(|Function\()/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeReadJson(filePath: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return {};
  }
}

function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function pathInside(basePath: string, targetPath: string): boolean {
  const normalizedBase = path.resolve(basePath);
  const normalizedTarget = path.resolve(targetPath);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function normalizeInstallSource(value: unknown): PluginInstallSource {
  if (value === "npm" || value === "path" || value === "git") {
    return value;
  }
  return "unknown";
}

function riskTierFromScore(score: number): PluginRiskTier {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

function compareRiskTier(left: PluginRiskTier, right: PluginRiskTier): number {
  return RISK_TIERS.indexOf(left) - RISK_TIERS.indexOf(right);
}

function defaultManifest(): PluginManifestSnapshot {
  return {
    id: "",
    name: "",
    description: "",
    channels: [],
    skills: [],
    configKeys: [],
    hasConfigSchema: false,
  };
}

function defaultPackage(): PluginPackageSnapshot {
  return {
    name: "",
    version: "",
    description: "",
    main: "",
    dependencyNames: [],
  };
}

function collectScannableFiles(rootPath: string, packageMain: string): string[] {
  const files = new Set<string>();
  const visit = (currentPath: string): void => {
    let stats;
    try {
      stats = statSync(currentPath);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      const directoryName = path.basename(currentPath);
      if (SKIP_DIRECTORIES.has(directoryName)) {
        return;
      }
      try {
        readdirSync(currentPath)
          .sort((left, right) => left.localeCompare(right))
          .forEach((name) => visit(path.join(currentPath, name)));
      } catch {
        return;
      }
      return;
    }
    if (!stats.isFile()) {
      return;
    }
    if (SCANNABLE_EXTENSIONS.has(path.extname(currentPath))) {
      files.add(path.resolve(currentPath));
    }
  };

  RELEVANT_ROOTS
    .map((segment) => path.join(rootPath, segment))
    .filter((candidatePath) => existsSync(candidatePath))
    .forEach(visit);

  [
    "index.js",
    "index.mjs",
    "index.cjs",
    "index.ts",
    packageMain || "",
  ]
    .map((relativePath) => (relativePath ? path.join(rootPath, relativePath) : ""))
    .filter(Boolean)
    .filter((candidatePath) => existsSync(candidatePath))
    .forEach(visit);

  return Array.from(files)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 120);
}

function buildSignalCounts(filePaths: string[]): { signals: PluginCodeSignals; evidence: Record<keyof PluginCodeSignals, string[]> } {
  const evidence: Record<keyof PluginCodeSignals, string[]> = {
    exec: [],
    network: [],
    env: [],
    file_write: [],
    dynamic_eval: [],
  };

  filePaths.forEach((filePath) => {
    const content = safeReadFile(filePath);
    if (!content) {
      return;
    }
    if (EXEC_SIGNAL.test(content)) {
      evidence.exec.push(filePath);
    }
    if (NETWORK_SIGNAL.test(content)) {
      evidence.network.push(filePath);
    }
    if (ENV_SIGNAL.test(content)) {
      evidence.env.push(filePath);
    }
    if (FILE_WRITE_SIGNAL.test(content)) {
      evidence.file_write.push(filePath);
    }
    if (DYNAMIC_EVAL_SIGNAL.test(content)) {
      evidence.dynamic_eval.push(filePath);
    }
  });

  return {
    signals: {
      exec: evidence.exec.length,
      network: evidence.network.length,
      env: evidence.env.length,
      file_write: evidence.file_write.length,
      dynamic_eval: evidence.dynamic_eval.length,
    },
    evidence,
  };
}

function relativeEvidence(rootPath: string, values: string[], limit = 5): string[] {
  return values
    .map((value) => path.relative(rootPath, value) || path.basename(value))
    .slice(0, limit);
}

export class PluginSecurityStore {
  #runtime: AdminRuntime;
  #configClient: OpenClawConfigClient;
  #now: () => number;
  #cachedSnapshot: { expiresAt: number; snapshot: PluginSnapshot } | null = null;

  constructor(runtime: AdminRuntime, deps: PluginSecurityStoreDeps = {}) {
    this.#runtime = runtime;
    this.#configClient = new OpenClawConfigClient(runtime);
    this.#now = deps.now || (() => Date.now());
    if (typeof deps.readConfigSnapshot === "function") {
      this.#configClient = {
        readConfigSnapshot: deps.readConfigSnapshot,
      } as OpenClawConfigClient;
    }
  }

  async getStatus(): Promise<PluginStatusPayload> {
    const snapshot = await this.#buildSnapshot();
    const highlights = snapshot.items
      .slice()
      .sort((left, right) => {
        const riskDelta = compareRiskTier(right.risk_tier, left.risk_tier);
        if (riskDelta !== 0) return riskDelta;
        if (Number(right.enabled) !== Number(left.enabled)) return Number(right.enabled) - Number(left.enabled);
        if (right.risk_score !== left.risk_score) return right.risk_score - left.risk_score;
        return left.name.localeCompare(right.name);
      })
      .slice(0, 3);
    return {
      stats: this.#buildCounts(snapshot.items),
      highlights,
      generated_at: snapshot.generatedAt,
      config_source: snapshot.configSource,
    };
  }

  async listPlugins(filters: PluginListFilters = {}): Promise<PluginListPayload> {
    const snapshot = await this.#buildSnapshot();
    const normalizedFilters = {
      risk: normalizeText(filters.risk) || "all",
      state: normalizeText(filters.state) || "all",
      source: normalizeText(filters.source) || "all",
    };
    const filtered = snapshot.items.filter((item) => {
      if (normalizedFilters.risk !== "all" && item.risk_tier !== normalizedFilters.risk) {
        return false;
      }
      if (normalizedFilters.state !== "all" && item.state !== normalizedFilters.state) {
        return false;
      }
      if (normalizedFilters.source !== "all" && item.source !== normalizedFilters.source) {
        return false;
      }
      return true;
    });
    return {
      items: filtered,
      total: filtered.length,
      counts: this.#buildCounts(snapshot.items),
      filters: normalizedFilters,
      source_options: Array.from(new Set(snapshot.items.map((item) => item.source))).sort((left, right) => left.localeCompare(right)),
    };
  }

  async getPlugin(pluginId: string): Promise<PluginDetailPayload | undefined> {
    const snapshot = await this.#buildSnapshot();
    return snapshot.details.get(pluginId);
  }

  async refresh(): Promise<void> {
    this.#cachedSnapshot = null;
    await this.#buildSnapshot({ force: true });
  }

  #buildCounts(items: PluginSummary[]): PluginStatusPayload["stats"] {
    return {
      total: items.length,
      enabled: items.filter((item) => item.enabled).length,
      high_critical: items.filter((item) => item.risk_tier === "high" || item.risk_tier === "critical").length,
      path_sources: items.filter((item) => item.source === "path").length,
      exec_capable: items.filter((item) => item.code_signals.exec > 0).length,
      network_capable: items.filter((item) => item.code_signals.network > 0).length,
    };
  }

  async #buildSnapshot(options: { force?: boolean } = {}): Promise<PluginSnapshot> {
    if (!options.force && this.#cachedSnapshot && this.#cachedSnapshot.expiresAt > this.#now()) {
      return this.#cachedSnapshot.snapshot;
    }
    const configSnapshot = await this.#configClient.readConfigSnapshot({ fast: true });
    const pluginConfig = asRecord(asRecord(configSnapshot.config).plugins);
    const entries = asRecord(pluginConfig.entries);
    const installs = asRecord(pluginConfig.installs);
    const loadPaths = asStringArray(asRecord(pluginConfig.load).paths);
    const candidates = new Map<string, PluginCandidate>();

    Object.entries(installs).forEach(([pluginId, rawInstall]) => {
      if (pluginId === SELF_PLUGIN_ID) {
        return;
      }
      const install = asRecord(rawInstall);
      const installPath = normalizeText(install.installPath) || normalizeText(install.sourcePath);
      const entryConfig = asRecord(asRecord(entries[pluginId]).config);
      if (!installPath) {
        candidates.set(pluginId, {
          pluginId,
          installPath: "",
          source: normalizeInstallSource(install.source),
          spec: normalizeText(install.spec) || normalizeText(install.resolvedSpec),
          sourcePath: normalizeText(install.sourcePath),
          version: normalizeText(install.version) || normalizeText(install.resolvedVersion),
          integrity: normalizeText(install.integrity) || normalizeText(install.shasum),
          enabled: asRecord(entries[pluginId]).enabled !== false,
          entryConfig,
        });
        return;
      }
      candidates.set(pluginId, {
        pluginId,
        installPath: path.resolve(installPath),
        source: normalizeInstallSource(install.source),
        spec: normalizeText(install.spec) || normalizeText(install.resolvedSpec),
        sourcePath: normalizeText(install.sourcePath),
        version: normalizeText(install.version) || normalizeText(install.resolvedVersion),
        integrity: normalizeText(install.integrity) || normalizeText(install.shasum),
        enabled: asRecord(entries[pluginId]).enabled !== false,
        entryConfig,
      });
    });

    loadPaths.forEach((loadPath) => {
      const resolvedPath = path.resolve(loadPath);
      const manifest = this.#readManifest(resolvedPath);
      const packageInfo = this.#readPackage(resolvedPath);
      const pluginId = manifest.id || packageInfo.name || path.basename(resolvedPath);
      if (!pluginId || pluginId === SELF_PLUGIN_ID) {
        return;
      }
      const current = candidates.get(pluginId);
      const entryConfig = asRecord(asRecord(entries[pluginId]).config);
      candidates.set(pluginId, {
        pluginId,
        installPath: resolvedPath,
        source: current?.source || "path",
        spec: current?.spec || "",
        sourcePath: current?.sourcePath || resolvedPath,
        version: current?.version || packageInfo.version,
        integrity: current?.integrity || "",
        enabled: current?.enabled ?? (asRecord(entries[pluginId]).enabled !== false),
        entryConfig: Object.keys(current?.entryConfig || {}).length > 0 ? current!.entryConfig : entryConfig,
      });
    });

    Object.entries(entries).forEach(([pluginId, rawEntry]) => {
      if (pluginId === SELF_PLUGIN_ID || candidates.has(pluginId)) {
        return;
      }
      const installPath = path.join(this.#runtime.openClawHome, "extensions", pluginId);
      if (!existsSync(installPath)) {
        return;
      }
      candidates.set(pluginId, {
        pluginId,
        installPath,
        source: "unknown",
        spec: "",
        sourcePath: "",
        version: "",
        integrity: "",
        enabled: asRecord(rawEntry).enabled !== false,
        entryConfig: asRecord(asRecord(rawEntry).config),
      });
    });

    const scanned = Array.from(candidates.values())
      .map((candidate) => this.#scanPlugin(candidate, configSnapshot.source))
      .sort((left, right) => {
        const riskDelta = compareRiskTier(right.plugin.risk_tier, left.plugin.risk_tier);
        if (riskDelta !== 0) return riskDelta;
        if (right.plugin.risk_score !== left.plugin.risk_score) return right.plugin.risk_score - left.plugin.risk_score;
        if (Number(right.plugin.enabled) !== Number(left.plugin.enabled)) return Number(right.plugin.enabled) - Number(left.plugin.enabled);
        return left.plugin.name.localeCompare(right.plugin.name);
      });

    const snapshot: PluginSnapshot = {
      items: scanned.map((item) => item.plugin),
      details: new Map(scanned.map((item) => [item.plugin.plugin_id, item.detail])),
      generatedAt: new Date(this.#now()).toISOString(),
      configSource: configSnapshot.source,
    };
    this.#cachedSnapshot = {
      expiresAt: this.#now() + CACHE_TTL_MS,
      snapshot,
    };
    return snapshot;
  }

  #scanPlugin(candidate: PluginCandidate, configSource: ClawGuardConfigSource): PluginDetailRecord {
    const nowIso = new Date(this.#now()).toISOString();
    const installPath = candidate.installPath ? path.resolve(candidate.installPath) : "";
    const manifest = installPath ? this.#readManifest(installPath) : defaultManifest();
    const packageInfo = installPath ? this.#readPackage(installPath) : defaultPackage();
    const scannedFiles = installPath && existsSync(installPath)
      ? collectScannableFiles(installPath, packageInfo.main)
      : [];
    const { signals, evidence } = buildSignalCounts(scannedFiles);
    const findings: PluginFinding[] = [];
    const addFinding = (code: string, weight: number, detail: string, detailEvidence: string[] = []): void => {
      findings.push({
        code,
        weight,
        detail,
        evidence: detailEvidence,
      });
    };

    if (!installPath) {
      addFinding("PLUGIN_INSTALL_PATH_MISSING", 24, "The install path is missing from the current OpenClaw config.");
    } else if (!existsSync(installPath)) {
      addFinding("PLUGIN_INSTALL_PATH_MISSING", 24, "The configured install path does not exist on disk.", [installPath]);
    }

    if (!manifest.id && !manifest.name) {
      addFinding("PLUGIN_MANIFEST_MISSING", 14, "The plugin does not expose an openclaw.plugin.json manifest.");
    }

    if (!packageInfo.name && !packageInfo.version) {
      addFinding("PLUGIN_PACKAGE_METADATA_MISSING", 8, "The plugin package metadata is missing or unreadable.");
    }

    if (candidate.source === "path") {
      addFinding(
        "PLUGIN_PATH_SOURCE",
        18,
        "The plugin is loaded from a mutable local path instead of a locked package install.",
        candidate.sourcePath ? [candidate.sourcePath] : (installPath ? [installPath] : []),
      );
    }

    if (candidate.source === "npm" && !candidate.integrity) {
      addFinding("PLUGIN_INTEGRITY_MISSING", 8, "The package install does not include an integrity or shasum record.");
    }

    if (installPath && !pathInside(this.#runtime.openClawHome, installPath)) {
      addFinding("PLUGIN_EXTERNAL_INSTALL_PATH", 10, "The plugin is installed outside the OpenClaw home directory.", [installPath]);
    }

    if (!manifest.hasConfigSchema) {
      addFinding("PLUGIN_CONFIG_SCHEMA_MISSING", 6, "The plugin manifest does not declare a config schema.");
    }

    if (signals.dynamic_eval > 0) {
      addFinding(
        "PLUGIN_DYNAMIC_EVAL",
        28,
        "Dynamic code evaluation was detected while scanning the plugin source.",
        relativeEvidence(installPath, evidence.dynamic_eval),
      );
    }

    if (signals.exec > 0) {
      addFinding(
        "PLUGIN_EXECUTION_SIGNAL",
        22,
        "Process execution APIs were detected in the plugin source.",
        relativeEvidence(installPath, evidence.exec),
      );
    }

    if (signals.network > 0) {
      addFinding(
        "PLUGIN_NETWORK_SIGNAL",
        14,
        "Network egress or socket APIs were detected in the plugin source.",
        relativeEvidence(installPath, evidence.network),
      );
    }

    if (signals.env > 0) {
      addFinding(
        "PLUGIN_ENV_ACCESS",
        12,
        "Environment variable access was detected in the plugin source.",
        relativeEvidence(installPath, evidence.env),
      );
    }

    if (signals.file_write > 0) {
      addFinding(
        "PLUGIN_FILESYSTEM_WRITE",
        10,
        "Filesystem write APIs were detected in the plugin source.",
        relativeEvidence(installPath, evidence.file_write),
      );
    }

    if (packageInfo.dependencyNames.length >= 40) {
      addFinding(
        "PLUGIN_HEAVY_DEPENDENCIES",
        packageInfo.dependencyNames.length >= 80 ? 12 : 8,
        "The plugin ships with a broad dependency surface.",
        packageInfo.dependencyNames.slice(0, 8),
      );
    }

    const rawScore = findings.reduce((sum, finding) => sum + finding.weight, 0) - (candidate.enabled ? 0 : 8);
    const riskScore = clampScore(rawScore);
    const riskTier = riskTierFromScore(riskScore);
    const plugin: PluginSummary = {
      plugin_id: candidate.pluginId,
      name: manifest.name || packageInfo.name || candidate.pluginId,
      version: packageInfo.version || candidate.version,
      description: manifest.description || packageInfo.description,
      state: candidate.enabled ? "enabled" : "disabled",
      enabled: candidate.enabled,
      source: candidate.source,
      install_scope: installPath
        ? (pathInside(this.#runtime.openClawHome, installPath) ? "openclaw_home" : "external")
        : "unknown",
      install_path: installPath,
      install_spec: candidate.spec,
      install_reference: candidate.sourcePath || installPath,
      risk_score: riskScore,
      risk_tier: riskTier,
      reason_codes: findings.map((finding) => finding.code),
      findings,
      finding_count: findings.length,
      last_scan_at: nowIso,
      has_manifest: Boolean(manifest.id || manifest.name),
      has_package_json: Boolean(packageInfo.name || packageInfo.version),
      has_config_schema: manifest.hasConfigSchema,
      has_integrity: Boolean(candidate.integrity),
      dependency_count: packageInfo.dependencyNames.length,
      channels: manifest.channels,
      skills: manifest.skills,
      entry_config_keys: Object.keys(candidate.entryConfig).sort((left, right) => left.localeCompare(right)),
      code_signals: signals,
    };
    return {
      plugin,
      detail: {
        plugin,
        findings,
        manifest: {
          id: manifest.id,
          name: manifest.name,
          channels: manifest.channels,
          skills: manifest.skills,
          config_keys: manifest.configKeys,
        },
        package: {
          name: packageInfo.name,
          version: packageInfo.version,
          main: packageInfo.main,
          dependency_names: packageInfo.dependencyNames,
        },
        scanned_files: relativeEvidence(installPath || this.#runtime.openClawHome, scannedFiles, 24),
        generated_at: nowIso,
        config_source: configSource,
      },
    };
  }

  #readManifest(installPath: string): PluginManifestSnapshot {
    const manifestPath = path.join(installPath, "openclaw.plugin.json");
    if (!existsSync(manifestPath)) {
      return defaultManifest();
    }
    const manifest = safeReadJson(manifestPath);
    const configSchema = asRecord(manifest.configSchema);
    return {
      id: normalizeText(manifest.id),
      name: normalizeText(manifest.name),
      description: normalizeText(manifest.description),
      channels: asStringArray(manifest.channels),
      skills: asStringArray(manifest.skills),
      configKeys: Object.keys(asRecord(configSchema.properties)).sort((left, right) => left.localeCompare(right)),
      hasConfigSchema: Object.keys(configSchema).length > 0,
    };
  }

  #readPackage(installPath: string): PluginPackageSnapshot {
    const packagePath = path.join(installPath, "package.json");
    if (!existsSync(packagePath)) {
      return defaultPackage();
    }
    const manifest = safeReadJson(packagePath);
    return {
      name: normalizeText(manifest.name),
      version: normalizeText(manifest.version),
      description: normalizeText(manifest.description),
      main: normalizeText(manifest.main),
      dependencyNames: Object.keys(asRecord(manifest.dependencies)).sort((left, right) => left.localeCompare(right)),
    };
  }
}
