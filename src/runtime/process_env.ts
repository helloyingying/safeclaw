type SecurityClawAdminServerEnv = {
  adminPort?: number | undefined;
  locale?: string | undefined;
  configPath?: string | undefined;
  legacyOverridePath?: string | undefined;
  statusPath?: string | undefined;
  dbPath?: string | undefined;
};

function readTextEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readNumericEnv(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = readTextEnv(name, env);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readProcessEnvValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readTextEnv(name, env);
}

export function resolveSecurityClawAdminPort(defaultPort = 4780, env: NodeJS.ProcessEnv = process.env): number {
  return readNumericEnv("SECURITYCLAW_ADMIN_PORT", env) ?? defaultPort;
}

export function readSecurityClawAdminServerEnv(
  env: NodeJS.ProcessEnv = process.env,
): SecurityClawAdminServerEnv {
  return {
    adminPort: readNumericEnv("SECURITYCLAW_ADMIN_PORT", env),
    locale: readTextEnv("SECURITYCLAW_LOCALE", env),
    configPath: readTextEnv("SECURITYCLAW_CONFIG_PATH", env),
    legacyOverridePath: readTextEnv("SECURITYCLAW_LEGACY_OVERRIDE_PATH", env),
    statusPath: readTextEnv("SECURITYCLAW_STATUS_PATH", env),
    dbPath: readTextEnv("SECURITYCLAW_DB_PATH", env),
  };
}
