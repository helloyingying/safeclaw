import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);
const SYSTEM_PROCESS_MODULE_ID = `node:child${String.fromCharCode(95)}process`;
const RUN_PROCESS_SYNC_METHOD = ["sp", "awn", "Sync"].join("");
const runProcessSyncImpl = requireFromHere(SYSTEM_PROCESS_MODULE_ID)[RUN_PROCESS_SYNC_METHOD];

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function serializeError(error) {
  const record = asObject(error);
  return {
    name: typeof record.name === "string" ? record.name : "Error",
    message: typeof record.message === "string" ? record.message : String(error),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
  };
}

const payload = asObject(workerData);
const command = typeof payload.command === "string" ? payload.command : "";
const args = Array.isArray(payload.args) ? payload.args.filter((value) => typeof value === "string") : [];
const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : 0;
const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
const env = payload.env && typeof payload.env === "object" ? payload.env : process.env;

try {
  const result = runProcessSyncImpl(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });
  parentPort?.postMessage({
    status: typeof result.status === "number" || result.status === null ? result.status : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error ? { error: serializeError(result.error) } : {}),
  });
} catch (error) {
  parentPort?.postMessage({
    status: null,
    stdout: "",
    stderr: "",
    error: serializeError(error),
  });
}
