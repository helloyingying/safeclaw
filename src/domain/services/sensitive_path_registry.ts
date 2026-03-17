import type {
  SensitivePathConfig,
  SensitivePathMatchType,
  SensitivePathRule,
  SensitivePathSource,
  SensitivePathStrategyOverride,
} from "../../types.ts";

const VALID_MATCH_TYPES = new Set<SensitivePathMatchType>(["prefix", "glob", "regex"]);

function builtinRule(
  id: string,
  assetLabel: string,
  matchType: SensitivePathMatchType,
  pattern: string,
): SensitivePathRule {
  return {
    id,
    asset_label: assetLabel,
    match_type: matchType,
    pattern,
    source: "builtin",
  };
}

const BUILTIN_SENSITIVE_PATH_RULES: SensitivePathRule[] = [
  builtinRule("credential-env-files", "credential", "regex", "(?:^|/)\\.env(?:\\.[^/\\s]+)?(?:$|/)"),
  builtinRule("credential-package-config-npmrc", "credential", "regex", "(?:^|/)\\.npmrc(?:$|/)"),
  builtinRule("credential-package-config-pypirc", "credential", "regex", "(?:^|/)\\.pypirc(?:$|/)"),
  builtinRule("credential-netrc", "credential", "regex", "(?:^|/)\\.netrc(?:$|/)"),
  builtinRule("credential-ssh-directory", "credential", "regex", "(?:^|/)\\.ssh(?:/|$)"),
  builtinRule("credential-gnupg-directory", "credential", "regex", "(?:^|/)\\.gnupg(?:/|$)"),
  builtinRule("credential-kube-directory", "credential", "regex", "(?:^|/)(?:\\.kube|kubeconfig)(?:$|/)"),
  builtinRule("credential-cloud-aws-directory", "credential", "regex", "(?:^|/)\\.aws(?:/|$)"),
  builtinRule("credential-cloud-azure-directory", "credential", "regex", "(?:^|/)\\.azure(?:/|$)"),
  builtinRule("credential-docker-directory", "credential", "regex", "(?:^|/)\\.docker(?:/|$)"),
  builtinRule("credential-gcloud-directory", "credential", "regex", "(?:^|/)\\.config/gcloud(?:/|$)"),
  builtinRule("credential-gh-directory", "credential", "regex", "(?:^|/)\\.config/gh(?:/|$)"),
  builtinRule("credential-aws-file", "credential", "regex", "(?:^|/)aws/credentials(?:$|/)"),
  builtinRule("credential-ssh-key-files", "credential", "regex", "(?:^|/)id_(?:rsa|ed25519|ecdsa|dsa)(?:\\.pub)?(?:$|/)"),
  builtinRule("credential-known-host-files", "credential", "regex", "(?:^|/)(?:authorized_keys|known_hosts)(?:$|/)"),
  builtinRule("credential-key-material-files", "credential", "regex", "(?:^|/)[^/\\s]+\\.(?:pem|p12|pfx|key)(?:$|/)"),
  builtinRule("credential-client-secret-json", "credential", "regex", "(?:^|/)client_secret[^/\\s]*\\.json(?:$|/)"),

  builtinRule("download-staging-downloads-directory", "download_staging", "regex", "(?:^|/)downloads(?:/|$)"),

  builtinRule(
    "personal-content-home-folders",
    "personal_content",
    "regex",
    "(?:^|/)(?:users|home)/[^/]+/(?:desktop|documents|downloads|music|pictures|movies|videos|public)(?:/|$)",
  ),
  builtinRule(
    "personal-content-mounted-home-folders",
    "personal_content",
    "regex",
    "(?:^|/)mnt/[a-z]/users/[^/]+/(?:desktop|documents|downloads|music|pictures|videos|public)(?:/|$)",
  ),
  builtinRule(
    "personal-content-icloud-mobile-documents",
    "personal_content",
    "regex",
    "(?:^|/)library/mobile documents(?:/|$)",
  ),
  builtinRule(
    "personal-content-cloudstorage",
    "personal_content",
    "regex",
    "(?:^|/)library/cloudstorage(?:/|$)",
  ),

  builtinRule(
    "browser-profile-macos-chromium-family",
    "browser_profile",
    "regex",
    "(?:^|/)library/application support/(?:google/chrome|chromium|bravesoftware/brave-browser|microsoft edge|vivaldi|arc/user data)(?:/|$)",
  ),
  builtinRule(
    "browser-profile-linux-chromium-family",
    "browser_profile",
    "regex",
    "(?:^|/)\\.config/(?:google-chrome|chromium|bravesoftware/brave-browser|microsoft-edge|vivaldi)(?:/|$)",
  ),
  builtinRule("browser-profile-firefox-linux", "browser_profile", "regex", "(?:^|/)\\.mozilla/firefox(?:/|$)"),
  builtinRule("browser-profile-firefox-macos", "browser_profile", "regex", "(?:^|/)library/application support/firefox(?:/|$)"),
  builtinRule("browser-profile-safari", "browser_profile", "regex", "(?:^|/)library/safari(?:/|$)"),
  builtinRule(
    "browser-profile-safari-container",
    "browser_profile",
    "regex",
    "(?:^|/)library/containers/com\\.apple\\.safari(?:/|$)",
  ),

  builtinRule(
    "browser-secret-store-files",
    "browser_secret_store",
    "regex",
    "(?:^|/)(?:cookies(?:-journal)?|login data(?: for account)?|web data|history(?:-journal)?|top sites|shortcuts|visited links|favicons|places\\.sqlite|cookies\\.sqlite|formhistory\\.sqlite|key4\\.db|key3\\.db|logins\\.json|cookies\\.binarycookies|webpageicons\\.db)(?:$|/)",
  ),

  builtinRule("communication-store-messages", "communication_store", "regex", "(?:^|/)library/messages(?:/|$)"),
  builtinRule("communication-store-mail", "communication_store", "regex", "(?:^|/)library/mail(?:/|$)"),
  builtinRule("communication-store-thunderbird", "communication_store", "regex", "(?:^|/)\\.thunderbird(?:/|$)"),
  builtinRule("communication-store-linux-mail", "communication_store", "regex", "(?:^|/)\\.local/share/(?:evolution|mail)(?:/|$)"),
];

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function sortRules(rules: SensitivePathRule[]): SensitivePathRule[] {
  return [...rules].sort((left, right) => {
    const bySource = String(left.source ?? "custom").localeCompare(String(right.source ?? "custom"));
    if (bySource !== 0) {
      return bySource;
    }
    const byLabel = left.asset_label.localeCompare(right.asset_label);
    if (byLabel !== 0) {
      return byLabel;
    }
    const byType = left.match_type.localeCompare(right.match_type);
    if (byType !== 0) {
      return byType;
    }
    return left.id.localeCompare(right.id);
  });
}

function dedupeRules(rules: SensitivePathRule[]): SensitivePathRule[] {
  const map = new Map<string, SensitivePathRule>();
  rules.forEach((rule) => {
    map.set(rule.id, rule);
  });
  return sortRules(Array.from(map.values()));
}

export function cloneSensitivePathRule(rule: SensitivePathRule): SensitivePathRule {
  return { ...rule };
}

export function cloneSensitivePathRules(rules: SensitivePathRule[]): SensitivePathRule[] {
  return rules.map((rule) => cloneSensitivePathRule(rule));
}

export function normalizeSensitivePathRule(
  value: unknown,
  fallbackSource: SensitivePathSource,
): SensitivePathRule | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = trimmedString(record.id);
  const assetLabel = trimmedString(record.asset_label);
  const matchType = trimmedString(record.match_type) as SensitivePathMatchType | undefined;
  const pattern = trimmedString(record.pattern);
  const source = trimmedString(record.source) as SensitivePathSource | undefined;

  if (!id || !assetLabel || !matchType || !pattern || !VALID_MATCH_TYPES.has(matchType)) {
    return undefined;
  }

  return {
    id,
    asset_label: assetLabel,
    match_type: matchType,
    pattern,
    source: source === "builtin" || source === "custom" ? source : fallbackSource,
  };
}

export function normalizeSensitivePathRules(
  value: unknown,
  fallbackSource: SensitivePathSource,
): SensitivePathRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return dedupeRules(
    value
      .map((entry) => normalizeSensitivePathRule(entry, fallbackSource))
      .filter((entry): entry is SensitivePathRule => Boolean(entry)),
  );
}

export function getBuiltinSensitivePathRules(): SensitivePathRule[] {
  return cloneSensitivePathRules(BUILTIN_SENSITIVE_PATH_RULES);
}

export function hydrateSensitivePathConfig(config?: SensitivePathConfig): SensitivePathConfig {
  const builtinRules = getBuiltinSensitivePathRules();
  const existingRules = normalizeSensitivePathRules(config?.path_rules, "builtin");
  return {
    path_rules: dedupeRules([...builtinRules, ...existingRules]),
  };
}

export function normalizeSensitivePathStrategyOverride(value: unknown): SensitivePathStrategyOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const disabledBuiltinIds = Array.isArray(record.disabled_builtin_ids)
    ? Array.from(
        new Set(
          record.disabled_builtin_ids
            .map((entry) => trimmedString(entry))
            .filter((entry): entry is string => Boolean(entry)),
        ),
      ).sort((left, right) => left.localeCompare(right))
    : undefined;
  const customPathRules = normalizeSensitivePathRules(record.custom_path_rules, "custom");

  if (!disabledBuiltinIds?.length && customPathRules.length === 0) {
    return undefined;
  }

  return {
    ...(disabledBuiltinIds?.length ? { disabled_builtin_ids: disabledBuiltinIds } : {}),
    ...(customPathRules.length ? { custom_path_rules: customPathRules } : {}),
  };
}

export function applySensitivePathStrategyOverride(
  base: SensitivePathConfig | undefined,
  override: SensitivePathStrategyOverride | undefined,
): SensitivePathConfig {
  const hydrated = hydrateSensitivePathConfig(base);
  const normalizedOverride = normalizeSensitivePathStrategyOverride(override);
  if (!normalizedOverride) {
    return hydrated;
  }

  const disabledBuiltinIds = new Set(normalizedOverride.disabled_builtin_ids ?? []);
  const filteredBaseRules = hydrated.path_rules.filter((rule) => {
    return !(rule.source === "builtin" && disabledBuiltinIds.has(rule.id));
  });

  return {
    path_rules: dedupeRules([
      ...filteredBaseRules,
      ...normalizeSensitivePathRules(normalizedOverride.custom_path_rules, "custom"),
    ]),
  };
}

export function listRemovedBuiltinSensitivePathRules(
  base: SensitivePathConfig | undefined,
  override: SensitivePathStrategyOverride | undefined,
): SensitivePathRule[] {
  const hydrated = hydrateSensitivePathConfig(base);
  const normalizedOverride = normalizeSensitivePathStrategyOverride(override);
  if (!normalizedOverride?.disabled_builtin_ids?.length) {
    return [];
  }

  const disabledBuiltinIds = new Set(normalizedOverride.disabled_builtin_ids);
  return hydrated.path_rules
    .filter((rule) => rule.source === "builtin" && disabledBuiltinIds.has(rule.id))
    .map((rule) => cloneSensitivePathRule(rule));
}
