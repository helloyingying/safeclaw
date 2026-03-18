import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function isExistingDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function listFileRuleDirectoryOptions(existingDirectories: string[] = []): string[] {
  return Array.from(new Set(existingDirectories.map((entry) => path.normalize(entry))))
    .filter((entry) => path.isAbsolute(entry))
    .filter((entry) => isExistingDirectory(entry))
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeBrowsePath(candidate: string | null | undefined, fallback: string): string {
  if (!candidate || typeof candidate !== "string") {
    return fallback;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return fallback;
  }
  const expanded =
    trimmed === "~"
      ? os.homedir()
      : trimmed.startsWith("~/")
        ? path.join(os.homedir(), trimmed.slice(2))
        : trimmed;
  if (!path.isAbsolute(expanded)) {
    return fallback;
  }
  const normalized = path.normalize(expanded);
  return isExistingDirectory(normalized) ? normalized : fallback;
}

export function listDirectoryChildren(absolutePath: string): Array<{ name: string; path: string }> {
  const entries = readdirSync(absolutePath, { withFileTypes: true });
  const directories: Array<{ name: string; path: string }> = [];
  entries.forEach((entry) => {
    const childPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && isExistingDirectory(childPath))) {
      directories.push({
        name: entry.name,
        path: path.normalize(childPath),
      });
    }
  });
  return directories
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 300);
}

export function listDirectoryBrowseRoots(existingDirectories: string[] = []): string[] {
  const homeDir = path.normalize(os.homedir());
  const homeRoot = path.parse(homeDir).root || "/";
  const extras = Array.from(new Set(existingDirectories.map((entry) => path.normalize(entry))))
    .filter((entry) => path.isAbsolute(entry))
    .filter((entry) => isExistingDirectory(entry))
    .filter((entry) => entry !== homeDir && entry !== homeRoot)
    .sort((left, right) => left.localeCompare(right));
  const orderedRoots = [homeDir, ...(homeRoot !== homeDir ? [homeRoot] : []), ...extras];
  return Array.from(new Set(orderedRoots));
}
