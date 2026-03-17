export type SecurityClawLocale = "zh-CN" | "en";

export const DEFAULT_SECURITYCLAW_LOCALE: SecurityClawLocale = "en";

function normalizeLocaleTag(value: string): string {
  return value.trim().replace(/_/g, "-").toLowerCase();
}

export function resolveSecurityClawLocale(
  value: string | undefined,
  fallback: SecurityClawLocale = DEFAULT_SECURITYCLAW_LOCALE,
): SecurityClawLocale {
  const normalized = value ? normalizeLocaleTag(value) : "";
  if (!normalized) {
    return fallback;
  }
  if (normalized === "zh" || normalized.startsWith("zh-")) {
    return "zh-CN";
  }
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }
  return fallback;
}

export function isChineseLocale(locale: SecurityClawLocale): boolean {
  return locale === "zh-CN";
}

export function localeForIntl(locale: SecurityClawLocale): string {
  return isChineseLocale(locale) ? "zh-CN" : "en-US";
}

export function pickLocalized(locale: SecurityClawLocale, zhText: string, enText: string): string {
  return isChineseLocale(locale) ? zhText : enText;
}
