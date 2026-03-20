export type FilesystemOperation = "list" | "read" | "search" | "write" | "delete" | "archive";

export type ShellFilesystemSemantic = {
  operation: FilesystemOperation;
  toolName: `filesystem.${FilesystemOperation}`;
};

const SEGMENT_SPLITTER = /&&|\|\||;|\||\n/;
const TOKEN_PATTERN = /"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const WRITE_REDIRECTION_PATTERN = /(^|[^<])(?:>>?|1>>?|2>>?)\s*(?![&|])/;

const WRAPPER_COMMANDS = new Set([
  "sudo",
  "doas",
  "command",
  "builtin",
  "env",
  "nohup",
  "time",
  "stdbuf",
  "nice",
  "ionice",
]);

const LIST_COMMANDS = new Set([
  "ls",
  "dir",
  "tree",
  "fd",
  "fdfind",
  "du",
]);

const READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "stat",
  "file",
  "readlink",
  "realpath",
  "wc",
  "strings",
]);

const SEARCH_COMMANDS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ripgrep",
  "ack",
  "ag",
  "awk",
  "jq",
]);

const WRITE_COMMANDS = new Set([
  "touch",
  "cp",
  "mv",
  "mkdir",
  "mktemp",
  "install",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "tee",
  "dd",
  "rsync",
  "scp",
]);

const DELETE_COMMANDS = new Set([
  "rm",
  "unlink",
  "rmdir",
  "shred",
]);

const ARCHIVE_COMMANDS = new Set([
  "zip",
  "tar",
  "gzip",
  "gunzip",
  "bzip2",
  "bunzip2",
  "xz",
  "unxz",
  "7z",
  "7za",
  "zstd",
  "unzstd",
]);

const FILE_METADATA_COMMANDS = new Set([
  "test",
  "[",
  "basename",
  "dirname",
]);

const OPERATION_PRIORITY: Record<FilesystemOperation, number> = {
  list: 1,
  read: 2,
  search: 3,
  archive: 4,
  write: 5,
  delete: 6,
};

type PendingHeredoc = {
  marker: string;
  allowTabs: boolean;
};

function toTokens(segment: string): string[] {
  return segment.match(TOKEN_PATTERN) ?? [];
}

function normalizeToken(token: string): string {
  const unquoted = token.replace(/^["'`]+|["'`]+$/g, "");
  const basename = unquoted.includes("/") ? (unquoted.split("/").at(-1) ?? unquoted) : unquoted;
  return basename.toLowerCase();
}

function resolvePrimaryCommand(tokens: string[]): { command?: string; remaining: string[] } {
  let index = 0;
  while (index < tokens.length) {
    const raw = tokens[index];
    const normalized = normalizeToken(raw);
    if (!normalized || normalized === "(" || normalized === ")") {
      index += 1;
      continue;
    }
    if (ENV_ASSIGNMENT_PATTERN.test(normalized)) {
      index += 1;
      continue;
    }
    if (WRAPPER_COMMANDS.has(normalized)) {
      index += 1;
      while (index < tokens.length && (tokens[index].startsWith("-") || ENV_ASSIGNMENT_PATTERN.test(tokens[index]))) {
        index += 1;
      }
      continue;
    }
    return {
      command: normalized,
      remaining: tokens.slice(index + 1),
    };
  }
  return { remaining: [] };
}

function extractHeredocMarkers(line: string): PendingHeredoc[] {
  const markers: PendingHeredoc[] = [];
  const matches = line.matchAll(/<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g);
  for (const match of matches) {
    const marker = match[3];
    if (!marker) {
      continue;
    }
    markers.push({
      marker,
      allowTabs: match[1] === "-",
    });
  }
  return markers;
}

function stripHeredocBodies(commandText: string): string {
  const lines = commandText.split(/\r?\n/);
  if (lines.length <= 1) {
    return commandText;
  }

  const sanitized: string[] = [];
  const pending: PendingHeredoc[] = [];

  for (const line of lines) {
    if (pending.length > 0) {
      const current = pending[0];
      const candidate = current.allowTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === current.marker) {
        pending.shift();
      }
      continue;
    }

    sanitized.push(line);
    pending.push(...extractHeredocMarkers(line));
  }

  return sanitized.join("\n");
}

function classifyGitOperation(remaining: string[]): FilesystemOperation | undefined {
  let subcommand: string | undefined;
  let skipNext = false;

  for (const token of remaining) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const normalized = normalizeToken(token);
    if (!normalized) {
      continue;
    }
    if (normalized === "-c" || normalized === "--git-dir" || normalized === "--work-tree") {
      skipNext = true;
      continue;
    }
    if (normalized === "-c" || normalized.startsWith("-c")) {
      continue;
    }
    if (normalized === "-C" || normalized === "--super-prefix" || normalized === "--exec-path") {
      skipNext = true;
      continue;
    }
    if (normalized.startsWith("-")) {
      continue;
    }
    subcommand = normalized;
    break;
  }

  if (!subcommand) {
    return undefined;
  }
  if (subcommand === "grep") {
    return "search";
  }
  if (["status", "log", "show", "diff", "cat-file", "blame"].includes(subcommand)) {
    return "read";
  }
  if (["ls-files"].includes(subcommand)) {
    return "list";
  }
  if (["archive"].includes(subcommand)) {
    return "archive";
  }
  if (["rm", "clean"].includes(subcommand)) {
    return "delete";
  }
  if (
    [
      "add",
      "mv",
      "commit",
      "checkout",
      "restore",
      "reset",
      "revert",
      "cherry-pick",
      "merge",
      "rebase",
      "am",
      "apply",
      "stash",
      "pull",
      "clone",
    ].includes(subcommand)
  ) {
    return "write";
  }
  return undefined;
}

function classifyFindOperation(segment: string): FilesystemOperation {
  const normalized = segment.toLowerCase();
  if (/\s-delete(\s|$)/.test(normalized) || /-exec\s+[^\n;]*\brm\b/.test(normalized)) {
    return "delete";
  }
  if (/-exec\s+[^\n;]*\b(cp|mv|chmod|chown|touch|mkdir)\b/.test(normalized)) {
    return "write";
  }
  if (/\s-(name|iname|path|ipath|regex|iregex)\b/.test(normalized)) {
    return "search";
  }
  return "list";
}

function classifyTarOperation(segment: string): FilesystemOperation {
  const normalized = segment.toLowerCase();
  if (/(^|\s)--extract(\s|$)|(^|\s)-[^\s]*x/.test(normalized)) {
    return "write";
  }
  if (/(^|\s)--list(\s|$)|(^|\s)-[^\s]*t/.test(normalized)) {
    return "list";
  }
  return "archive";
}

function classifyArchiveCommand(command: string, segment: string): FilesystemOperation {
  if (command === "tar") {
    return classifyTarOperation(segment);
  }
  if (["gunzip", "bunzip2", "unxz", "unzstd"].includes(command)) {
    return "write";
  }
  return "archive";
}

function classifySegment(segment: string): FilesystemOperation | undefined {
  const tokens = toTokens(segment);
  if (tokens.length === 0) {
    return undefined;
  }

  const { command, remaining } = resolvePrimaryCommand(tokens);
  if (!command) {
    return undefined;
  }

  const normalizedSegment = segment.toLowerCase();

  if (command === "git") {
    return classifyGitOperation(remaining);
  }
  if (command === "find") {
    return classifyFindOperation(segment);
  }
  if (ARCHIVE_COMMANDS.has(command)) {
    return classifyArchiveCommand(command, segment);
  }
  if (DELETE_COMMANDS.has(command)) {
    return "delete";
  }
  if (WRITE_COMMANDS.has(command)) {
    return "write";
  }
  if (SEARCH_COMMANDS.has(command)) {
    return "search";
  }
  if (READ_COMMANDS.has(command)) {
    return "read";
  }
  if (LIST_COMMANDS.has(command)) {
    return "list";
  }
  if (command === "sed" || command === "perl") {
    if (/\s-i(?:\s|$)/.test(normalizedSegment)) {
      return "write";
    }
    return "search";
  }
  if (command === "unzip") {
    return "write";
  }
  if ((command === "echo" || command === "printf") && WRITE_REDIRECTION_PATTERN.test(segment)) {
    return "write";
  }
  if (FILE_METADATA_COMMANDS.has(command)) {
    return "read";
  }
  if (WRITE_REDIRECTION_PATTERN.test(segment)) {
    return "write";
  }
  return undefined;
}

function pickHigherPriority(
  current: FilesystemOperation | undefined,
  candidate: FilesystemOperation | undefined,
): FilesystemOperation | undefined {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  return OPERATION_PRIORITY[candidate] > OPERATION_PRIORITY[current] ? candidate : current;
}

export function inferShellFilesystemSemantic(
  commandText: string | undefined,
  resourcePaths: string[],
): ShellFilesystemSemantic | undefined {
  const normalizedCommandText = stripHeredocBodies(commandText ?? "");
  const segments = normalizedCommandText
    .split(SEGMENT_SPLITTER)
    .map((item) => item.trim())
    .filter(Boolean);

  let operation: FilesystemOperation | undefined;
  for (const segment of segments) {
    operation = pickHigherPriority(operation, classifySegment(segment));
  }

  if (!operation && resourcePaths.length > 0) {
    operation = "read";
  }
  if (!operation) {
    return undefined;
  }

  return {
    operation,
    toolName: `filesystem.${operation}`,
  };
}
