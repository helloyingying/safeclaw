export function resolveInstallTarget(options = {}) {
  const archivePath = typeof options.archivePath === "string" ? options.archivePath.trim() : "";
  if (archivePath) {
    return archivePath;
  }

  const localPath = typeof options.localPath === "string" ? options.localPath.trim() : "";
  if (localPath) {
    return localPath;
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
  const link = options.link === true;
  const installArgs = [
    "plugins",
    "install",
    ...(link ? ["--link"] : []),
    installTarget,
  ];

  return [
    [openclawBin, ...installArgs],
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
    if (token === "--link") {
      options.link = true;
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
    if (token === "--path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --path");
      }
      options.localPath = value;
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

  const explicitTargets = ["archivePath", "localPath", "npmSpec"].filter((key) => {
    const value = options[key];
    return typeof value === "string" && value.trim();
  });

  if (explicitTargets.length > 1) {
    throw new Error("Choose only one of --archive, --path, or --npm-spec");
  }

  if (options.link) {
    if (!options.localPath) {
      throw new Error("--link requires --path");
    }
    if (options.archivePath || options.npmSpec) {
      throw new Error("--link only works with --path");
    }
  }

  return options;
}
