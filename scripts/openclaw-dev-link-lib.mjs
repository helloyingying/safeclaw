export function buildOpenClawDevPluginConfig(config = {}, options = {}) {
  const pluginId = typeof options.pluginId === "string" ? options.pluginId.trim() : "";
  const pluginPath = typeof options.pluginPath === "string" ? options.pluginPath.trim() : "";
  const version = typeof options.version === "string" ? options.version.trim() : "";
  const installedAt = typeof options.installedAt === "string" ? options.installedAt.trim() : "";

  if (!pluginId) {
    throw new Error("pluginId is required");
  }
  if (!pluginPath) {
    throw new Error("pluginPath is required");
  }

  const plugins = config.plugins ?? {};
  const allow = Array.from(new Set([...(Array.isArray(plugins.allow) ? plugins.allow : []), pluginId]));
  const existingEntry = plugins.entries?.[pluginId] ?? {};
  const existingLoadPaths = Array.isArray(plugins.load?.paths) ? plugins.load.paths : [];
  const loadPaths = [pluginPath, ...existingLoadPaths.filter((candidate) => candidate !== pluginPath)];

  return {
    ...config,
    plugins: {
      ...plugins,
      allow,
      entries: {
        ...(plugins.entries ?? {}),
        [pluginId]: {
          ...existingEntry,
          enabled: true,
        },
      },
      load: {
        ...(plugins.load ?? {}),
        paths: loadPaths,
      },
      installs: {
        ...(plugins.installs ?? {}),
        [pluginId]: {
          source: "path",
          sourcePath: pluginPath,
          installPath: pluginPath,
          ...(version ? { version } : {}),
          ...(installedAt ? { installedAt } : {}),
        },
      },
    },
  };
}
