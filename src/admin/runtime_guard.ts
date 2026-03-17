const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const SUPERVISOR_HINT_KEYS = [
  "OPENCLAW_LAUNCHD_LABEL",
  "LAUNCH_JOB_LABEL",
  "LAUNCH_JOB_NAME",
  "XPC_SERVICE_NAME",
  "OPENCLAW_SYSTEMD_UNIT",
  "INVOCATION_ID",
  "SYSTEMD_EXEC_PID",
  "JOURNAL_STREAM",
  "OPENCLAW_WINDOWS_TASK_NAME"
] as const;

type AutoStartDecision = {
  enabled: boolean;
  reason:
    | "forced"
    | "gateway-service"
    | "gateway-supervisor"
    | "non-persistent-runtime";
};

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isTruthy(value: string | undefined): boolean {
  return hasText(value) && TRUTHY_VALUES.has(value!.trim().toLowerCase());
}

function hasSupervisorHints(env: NodeJS.ProcessEnv): boolean {
  return SUPERVISOR_HINT_KEYS.some((key) => hasText(env[key]));
}

export function shouldAutoStartAdminServer(env: NodeJS.ProcessEnv = process.env): AutoStartDecision {
  if (isTruthy(env.SECURITYCLAW_ADMIN_AUTOSTART_FORCE)) {
    return { enabled: true, reason: "forced" };
  }

  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim().toLowerCase();
  const serviceMarker = env.OPENCLAW_SERVICE_MARKER?.trim();
  if (serviceMarker && serviceKind === "gateway") {
    return { enabled: true, reason: "gateway-service" };
  }

  if (serviceKind === "gateway" && hasSupervisorHints(env)) {
    return { enabled: true, reason: "gateway-supervisor" };
  }

  return { enabled: false, reason: "non-persistent-runtime" };
}
