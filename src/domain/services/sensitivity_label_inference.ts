import os from "node:os";

import { getBuiltinSensitivePathRules } from "./sensitive_path_registry.ts";
import type { SensitivePathRule } from "../../types.ts";

export interface SensitivityLabelContext {
  assetLabels: string[];
  dataLabels: string[];
}

const OTP_PATTERN = /otp|one[- ]time|verification code|验证码|passcode|login (?:code|notification|alert)|登录提醒/i;
const HOME_DIR = os.homedir().replace(/\\/g, "/").toLowerCase();

function addLabel(labels: Set<string>, condition: boolean, label: string): void {
  if (condition) {
    labels.add(label);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, "i");
}

function normalizePathRulePattern(pattern: string): string {
  const normalized = pattern.replace(/\\/g, "/").trim();
  if (normalized === "~") {
    return HOME_DIR;
  }
  if (normalized.startsWith("~/")) {
    return `${HOME_DIR}/${normalized.slice(2)}`.toLowerCase();
  }
  if (normalized.startsWith("$HOME/")) {
    return `${HOME_DIR}/${normalized.slice(6)}`.toLowerCase();
  }
  if (normalized.startsWith("${HOME}/")) {
    return `${HOME_DIR}/${normalized.slice(8)}`.toLowerCase();
  }
  return normalized.toLowerCase();
}

function matchesSensitivePathRule(rule: SensitivePathRule, candidate: string): boolean {
  try {
    if (rule.match_type === "prefix") {
      return candidate.startsWith(normalizePathRulePattern(rule.pattern));
    }
    if (rule.match_type === "glob") {
      return globToRegExp(normalizePathRulePattern(rule.pattern)).test(candidate);
    }
    return new RegExp(rule.pattern, "i").test(candidate);
  } catch {
    return false;
  }
}

function resolveSensitivePathRules(rules?: SensitivePathRule[]): SensitivePathRule[] {
  if (!rules || rules.length === 0) {
    return getBuiltinSensitivePathRules();
  }
  return rules.map((rule) => ({ ...rule }));
}

function normalizeText(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function normalizePaths(resourcePaths: string[]): string[] {
  return resourcePaths
    .filter((value) => value.trim().length > 0)
    .map((value) => normalizeText(value));
}

function combinedTextCorpus(resourcePaths: string[], toolArgsSummary: string | undefined): string {
  return [...normalizePaths(resourcePaths), toolArgsSummary]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizeText(value))
    .join(" ");
}

export function inferSensitivityLabels(
  toolGroup: string | undefined,
  resourcePaths: string[],
  toolArgsSummary: string | undefined,
  sensitivePathRules?: SensitivePathRule[],
): SensitivityLabelContext {
  const normalizedPaths = normalizePaths(resourcePaths);
  const corpus = combinedTextCorpus(resourcePaths, toolArgsSummary);
  const resolvedSensitivePathRules = resolveSensitivePathRules(sensitivePathRules);
  const assetLabels = new Set<string>();
  const dataLabels = new Set<string>();

  addLabel(assetLabels, /\b(?:finance|invoice|billing|payroll|ledger)\b/.test(corpus), "financial");
  addLabel(dataLabels, /\b(?:finance|invoice|billing|payroll|ledger)\b/.test(corpus), "financial");
  addLabel(assetLabels, /\b(?:customer|client|crm|contact)\b/.test(corpus), "customer_data");
  addLabel(dataLabels, /\b(?:customer|client|crm|contact)\b/.test(corpus), "customer_data");
  addLabel(assetLabels, /\b(?:hr|personnel|resume|employee|salary)\b/.test(corpus), "hr");
  addLabel(dataLabels, /\b(?:hr|personnel|resume|employee|salary)\b/.test(corpus), "pii");

  const matchedSensitivePathLabels = new Set<string>();
  normalizedPaths.forEach((candidate) => {
    resolvedSensitivePathRules.forEach((rule) => {
      if (matchesSensitivePathRule(rule, candidate)) {
        matchedSensitivePathLabels.add(rule.asset_label);
      }
    });
  });

  matchedSensitivePathLabels.forEach((label) => assetLabels.add(label));
  addLabel(dataLabels, matchedSensitivePathLabels.has("credential"), "secret");
  addLabel(dataLabels, matchedSensitivePathLabels.has("browser_secret_store"), "browser_secret");
  addLabel(dataLabels, matchedSensitivePathLabels.has("communication_store"), "communications");
  addLabel(assetLabels, matchedSensitivePathLabels.has("browser_secret_store"), "browser_profile");

  addLabel(dataLabels, /token|secret|password|bearer|cookie|session|jwt|private key|id_rsa/.test(corpus), "secret");
  addLabel(dataLabels, OTP_PATTERN.test(corpus), "otp");
  addLabel(assetLabels, /\.github\/workflows\/|dockerfile\b|terraform|\.tf\b|k8s|kubernetes|deployment\.ya?ml|secret\.ya?ml|iam/.test(corpus), "control_plane");
  addLabel(dataLabels, toolGroup === "email" || toolGroup === "sms", "communications");
  addLabel(dataLabels, toolGroup === "album", "media");
  addLabel(dataLabels, toolGroup === "browser", "browser_secret");

  return {
    assetLabels: [...assetLabels],
    dataLabels: [...dataLabels],
  };
}
