export function resolveInstallTarget(options = {}) {
  const archivePath = typeof options.archivePath === "string" ? options.archivePath.trim() : "";
  if (archivePath) {
    return archivePath;
  }

  const npmSpec = typeof options.npmSpec === "string" ? options.npmSpec.trim() : "";
  if (npmSpec) {
    return npmSpec;
  }

  const packageName = typeof options.packageName === "string" ? options.packageName.trim() : "";
  if (!packageName) {
    throw new Error("SecurityClaw installer requires a package name or archive path.");
  }

  const packageVersion = typeof options.packageVersion === "string" ? options.packageVersion.trim() : "";
  return packageVersion ? `${packageName}@${packageVersion}` : packageName;
}

export function buildInstallPlan(options = {}) {
  const openclawBin = typeof options.openclawBin === "string" && options.openclawBin.trim()
    ? options.openclawBin.trim()
    : "openclaw";
  const installTarget = resolveInstallTarget(options);
  const restart = options.restart !== false;
  const verify = options.verify !== false;

  return [
    [openclawBin, "plugins", "install", installTarget],
    ...(restart ? [[openclawBin, "gateway", "restart"]] : []),
    ...(verify ? [[openclawBin, "gateway", "status"]] : []),
  ];
}

export function parseInstallArgs(argv = []) {
  const options = {
    restart: true,
    verify: true,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--no-restart") {
      options.restart = false;
      continue;
    }
    if (token === "--no-status") {
      options.verify = false;
      continue;
    }
    if (token === "--archive") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --archive");
      }
      options.archivePath = value;
      index += 1;
      continue;
    }
    if (token === "--npm-spec") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --npm-spec");
      }
      options.npmSpec = value;
      index += 1;
      continue;
    }
    if (token === "--openclaw-bin") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --openclaw-bin");
      }
      options.openclawBin = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown install option: ${token}`);
  }

  return options;
}
