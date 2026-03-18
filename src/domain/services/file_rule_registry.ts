import os from "node:os";
import path from "node:path";

import type { Decision, FileRule, FileRuleOperation } from "../../types.ts";

const VALID_DECISIONS = new Set<Decision>(["allow", "warn", "challenge", "block"]);
const FILE_RULE_OPERATION_ORDER: FileRuleOperation[] = ["read", "list", "search", "write", "delete", "archive", "execute"];
const FILE_RULE_OPERATION_INDEX = new Map(FILE_RULE_OPERATION_ORDER.map((value, index) => [value, index]));

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeDirectoryPath(value: string): string | undefined {
  let normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "~") {
    normalized = os.homedir();
  } else if (normalized.startsWith("~/")) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }
  if (!path.isAbsolute(normalized)) {
    return undefined;
  }

  const normalizedPath = path.normalize(normalized);
  const root = path.parse(normalizedPath).root;
  if (normalizedPath === root) {
    return normalizedPath;
  }
  return normalizedPath.replace(/[\\/]+$/, "");
}

function normalizedPathForCompare(value: string): string {
  const normalized = path.normalize(value);
  if (process.platform === "win32" || process.platform === "darwin") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function isPathInsideDirectory(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeDecision(value: unknown): Decision | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return VALID_DECISIONS.has(value as Decision) ? (value as Decision) : undefined;
}

function normalizeOperation(value: unknown): FileRuleOperation | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized ? (normalized as FileRuleOperation) : undefined;
}

function compareOperations(left: FileRuleOperation, right: FileRuleOperation): number {
  const leftIndex = FILE_RULE_OPERATION_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = FILE_RULE_OPERATION_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  return left.localeCompare(right);
}

function normalizeOperations(value: unknown): FileRuleOperation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = Array.from(
    new Set(
      value
        .map((entry) => normalizeOperation(entry))
        .filter((entry): entry is FileRuleOperation => Boolean(entry)),
    ),
  ).sort(compareOperations);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeReasonCodes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => trimmedString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

function operationKey(operations: readonly FileRuleOperation[] | undefined): string {
  return operations?.length ? operations.join("|") : "*";
}

function dedupeKey(rule: Pick<FileRule, "directory" | "operations">): string {
  return `${normalizedPathForCompare(rule.directory)}::${operationKey(rule.operations)}`;
}

function sortRules(rules: FileRule[]): FileRule[] {
  return [...rules].sort((left, right) => {
    const byDirectory = normalizedPathForCompare(left.directory).localeCompare(normalizedPathForCompare(right.directory));
    if (byDirectory !== 0) {
      return byDirectory;
    }
    const byOperations = operationKey(left.operations).localeCompare(operationKey(right.operations));
    if (byOperations !== 0) {
      return byOperations;
    }
    return left.id.localeCompare(right.id);
  });
}

export function defaultFileRuleReasonCode(decision: Decision): string {
  if (decision === "allow") {
    return "USER_FILE_RULE_ALLOW";
  }
  if (decision === "warn") {
    return "USER_FILE_RULE_WARN";
  }
  if (decision === "challenge") {
    return "USER_FILE_RULE_CHALLENGE";
  }
  return "USER_FILE_RULE_BLOCK";
}

export function normalizeFileRule(value: unknown): FileRule | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = trimmedString(record.id);
  const directory = trimmedString(record.directory);
  const decision = normalizeDecision(record.decision);
  const operations = normalizeOperations(record.operations);
  const reasonCodes = normalizeReasonCodes(record.reason_codes);
  const updatedAt = trimmedString(record.updated_at);
  const normalizedDirectory = directory ? normalizeDirectoryPath(directory) : undefined;
  if (!id || !normalizedDirectory || !decision) {
    return undefined;
  }

  return {
    id,
    directory: normalizedDirectory,
    decision,
    ...(operations ? { operations } : {}),
    ...(reasonCodes ? { reason_codes: reasonCodes } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
  };
}

export function normalizeFileRules(value: unknown): FileRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const dedupedByDirectory = new Map<string, FileRule>();
  value.forEach((entry) => {
    const normalized = normalizeFileRule(entry);
    if (!normalized) {
      return;
    }
    dedupedByDirectory.set(dedupeKey(normalized), normalized);
  });
  return sortRules(Array.from(dedupedByDirectory.values()));
}

export function matchFileRule(resourcePaths: string[], rules: FileRule[], operation?: string): FileRule | undefined {
  if (!rules.length || !resourcePaths.length) {
    return undefined;
  }

  const normalizedOperation = normalizeOperation(operation);
  const normalizedPaths = resourcePaths
    .map((entry) => normalizeDirectoryPath(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (!normalizedPaths.length) {
    return undefined;
  }

  const matches: FileRule[] = [];
  rules.forEach((rule) => {
    const normalizedDirectory = normalizeDirectoryPath(rule.directory);
    if (!normalizedDirectory) {
      return;
    }
    const normalizedOperations = normalizeOperations(rule.operations);
    if (normalizedOperations?.length) {
      if (!normalizedOperation || !normalizedOperations.includes(normalizedOperation)) {
        return;
      }
    }
    const matched = normalizedPaths.some((candidate) => isPathInsideDirectory(normalizedDirectory, candidate));
    if (matched) {
      matches.push({
        ...rule,
        directory: normalizedDirectory,
        ...(normalizedOperations ? { operations: normalizedOperations } : {}),
      });
    }
  });

  if (!matches.length) {
    return undefined;
  }

  matches.sort((left, right) => {
    const leftDepth = left.directory.split(path.sep).length;
    const rightDepth = right.directory.split(path.sep).length;
    if (rightDepth !== leftDepth) {
      return rightDepth - leftDepth;
    }
    const leftSpecificity = left.operations?.length ?? Number.MAX_SAFE_INTEGER;
    const rightSpecificity = right.operations?.length ?? Number.MAX_SAFE_INTEGER;
    if (leftSpecificity !== rightSpecificity) {
      return leftSpecificity - rightSpecificity;
    }
    const byDirectory = normalizedPathForCompare(left.directory).localeCompare(normalizedPathForCompare(right.directory));
    if (byDirectory !== 0) {
      return byDirectory;
    }
    const byOperations = operationKey(left.operations).localeCompare(operationKey(right.operations));
    if (byOperations !== 0) {
      return byOperations;
    }
    return left.id.localeCompare(right.id);
  });
  return matches[0];
}
