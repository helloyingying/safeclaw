import os from "node:os";
import path from "node:path";

const HOME_DIR = os.homedir();
const SHELL_TOKEN_PATTERN = /"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g;
const SHELL_PATH_HINT_PATTERN = /(?:~\/?|\/|\.\/|\.\.\/|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)/;
const LEADING_ENV_PATH_PATTERN =
  /^(?:\$(?<bare>[A-Za-z_][A-Za-z0-9_]*)|\$\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)\})(?<suffix>(?:\/.*)?)$/;

function stripShellQuotes(value: string): string {
  return value.trim().replace(/^["'`]+|["'`]+$/g, "");
}

function isLeadingEnvironmentPath(value: string): boolean {
  return LEADING_ENV_PATH_PATTERN.test(value);
}

function extractPathCandidateFromToken(token: string): string | undefined {
  const unquoted = stripShellQuotes(token);
  if (!unquoted) {
    return undefined;
  }

  if (isPathLikeCandidate(unquoted)) {
    return unquoted;
  }

  const assignmentIndex = unquoted.indexOf("=");
  if (assignmentIndex <= 0) {
    return undefined;
  }

  const suffix = stripShellQuotes(unquoted.slice(assignmentIndex + 1));
  return isPathLikeCandidate(suffix) ? suffix : undefined;
}

function expandLeadingEnvironmentPath(candidate: string): string {
  if (candidate === "~") {
    return HOME_DIR;
  }
  if (candidate.startsWith("~/")) {
    return path.join(HOME_DIR, candidate.slice(2));
  }

  const match = candidate.match(LEADING_ENV_PATH_PATTERN);
  if (!match) {
    return candidate;
  }

  const variableName = match.groups?.bare ?? match.groups?.braced;
  if (!variableName) {
    return candidate;
  }

  const resolvedRoot = process.env[variableName] ?? (variableName === "HOME" ? HOME_DIR : undefined);
  if (!resolvedRoot) {
    return candidate;
  }

  const suffix = match.groups?.suffix ?? "";
  if (!suffix) {
    return resolvedRoot;
  }

  return path.join(resolvedRoot, suffix.slice(1));
}

export function isPathLikeCandidate(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === "~" ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    isLeadingEnvironmentPath(trimmed)
  );
}

export function hasEmbeddedPathHint(value: string): boolean {
  return SHELL_PATH_HINT_PATTERN.test(value);
}

export function extractEmbeddedPathCandidates(value: string): string[] {
  const tokens = value.match(SHELL_TOKEN_PATTERN) ?? [];
  const results: string[] = [];

  for (const token of tokens) {
    const candidate = extractPathCandidateFromToken(token);
    if (candidate) {
      results.push(candidate);
    }
  }

  return results;
}

export function resolvePathCandidate(candidate: string, workspaceDir?: string): string | undefined {
  if (!candidate) {
    return undefined;
  }

  const normalized = path.normalize(expandLeadingEnvironmentPath(stripShellQuotes(candidate)));
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  if (!workspaceDir) {
    return undefined;
  }
  return path.normalize(path.resolve(workspaceDir, normalized));
}
