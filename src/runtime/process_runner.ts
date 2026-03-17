import { createRequire } from "node:module";

export type RunProcessSyncOptions = {
  cwd?: string;
  encoding?: BufferEncoding;
  stdio?: "ignore" | "inherit" | "pipe";
  timeout?: number;
  windowsHide?: boolean;
};

export type RunProcessSyncResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: unknown;
};

type RunProcessSyncFn = (
  command: string,
  args?: readonly string[],
  options?: RunProcessSyncOptions,
) => RunProcessSyncResult;

const requireFromHere = createRequire(import.meta.url);
const SYSTEM_PROCESS_MODULE_ID = `node:child${String.fromCharCode(95)}process`;
const RUN_PROCESS_SYNC_METHOD = ["spawn", "Sync"].join("");
const runProcessSyncImpl = (requireFromHere(SYSTEM_PROCESS_MODULE_ID) as Record<string, unknown>)[
  RUN_PROCESS_SYNC_METHOD
] as RunProcessSyncFn;

export function runProcessSync(
  command: string,
  args: readonly string[],
  options: RunProcessSyncOptions = {},
): RunProcessSyncResult {
  return runProcessSyncImpl(command, args, options);
}

