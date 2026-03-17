import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveSecurityClawStateDir } from "../infrastructure/config/plugin_config_parser.ts";
import type { SecurityClawLocale } from "../i18n/locale.ts";
import { pickLocalized } from "../i18n/locale.ts";
import { runProcessSync } from "../runtime/process_runner.ts";

export type AdminConsoleState = "started" | "already-running" | "service-command";

export type AdminConsoleLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type BrowserOpenResult = {
  ok: boolean;
  command?: string;
  error?: string;
};

export type BrowserOpener = (url: string) => BrowserOpenResult;

export type AnnounceAdminConsoleOptions = {
  locale: SecurityClawLocale;
  logger: AdminConsoleLogger;
  url: string;
  state: AdminConsoleState;
  stateDir?: string;
  opener?: BrowserOpener;
};

export type AnnounceAdminConsoleResult = {
  firstRun: boolean;
  openedAutomatically: boolean;
  markerPath?: string;
};

const MARKER_FILE_NAME = "admin-dashboard-opened-v1.json";
const BANNER_BORDER = "=".repeat(72);
const GATEWAY_COMMANDS_WITH_ADMIN_BANNER = new Set(["run", "start", "restart", "status"]);

function emitLog(logger: AdminConsoleLogger, message: string): void {
  logger.info?.(message);
}

function emitWarn(logger: AdminConsoleLogger, message: string): void {
  logger.warn?.(message);
}

function localize(locale: SecurityClawLocale, zhText: string, enText: string): string {
  return pickLocalized(locale, zhText, enText);
}

export function resolveAdminConsoleMarkerPath(stateDir: string): string {
  return path.join(resolveSecurityClawStateDir(stateDir), MARKER_FILE_NAME);
}

export function buildAdminConsoleBanner(params: {
  locale: SecurityClawLocale;
  url: string;
  state: AdminConsoleState;
  openedAutomatically: boolean;
}): string[] {
  const { locale, url, state, openedAutomatically } = params;
  const title =
    state === "already-running"
      ? localize(locale, "SecurityClaw 管理后台已在运行", "SecurityClaw admin dashboard is already running")
      : state === "service-command"
        ? localize(locale, "SecurityClaw 管理后台入口", "SecurityClaw admin dashboard entry")
        : localize(locale, "SecurityClaw 管理后台已启动", "SecurityClaw admin dashboard is ready");
  const openHint = openedAutomatically
    ? localize(
        locale,
        "首次启动已自动在默认浏览器中打开。",
        "Opened automatically in your default browser on first startup.",
      )
    : state === "service-command"
      ? localize(
          locale,
          "后台由 OpenClaw gateway 服务托管；如未自动打开，请手动访问下面的链接。",
          "The background OpenClaw gateway service hosts this dashboard; if your browser did not open automatically, open the URL below manually.",
        )
      : localize(
          locale,
          "如未自动打开，请手动访问下面的链接。",
          "If your browser did not open automatically, open the URL below manually.",
        );

  return [BANNER_BORDER, title, `URL: ${url}`, openHint, BANNER_BORDER];
}

export function shouldAnnounceAdminConsoleForArgv(argv: readonly string[] = process.argv): boolean {
  const gatewayIndex = argv.findIndex((value) => value === "gateway");
  if (gatewayIndex < 0) {
    return false;
  }

  for (const token of argv.slice(gatewayIndex + 1)) {
    if (GATEWAY_COMMANDS_WITH_ADMIN_BANNER.has(token)) {
      return true;
    }
  }
  return false;
}

function writeAdminConsoleMarker(markerPath: string, url: string): void {
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        opened_at: new Date().toISOString(),
        url,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function openAdminConsoleInBrowser(url: string): BrowserOpenResult {
  if (process.platform === "darwin") {
    const result = runProcessSync("open", [url], { stdio: "ignore", timeout: 5_000 });
    if (result.error) {
      return { ok: false, command: "open", error: String(result.error) };
    }
    if (result.status !== 0) {
      return { ok: false, command: "open", error: `exit code ${result.status}` };
    }
    return { ok: true, command: "open" };
  }

  if (process.platform === "win32") {
    const result = runProcessSync("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.error) {
      return { ok: false, command: "cmd /c start", error: String(result.error) };
    }
    if (result.status !== 0) {
      return { ok: false, command: "cmd /c start", error: `exit code ${result.status}` };
    }
    return { ok: true, command: "cmd /c start" };
  }

  if (process.platform === "linux") {
    const result = runProcessSync("xdg-open", [url], { stdio: "ignore", timeout: 5_000 });
    if (result.error) {
      return { ok: false, command: "xdg-open", error: String(result.error) };
    }
    if (result.status !== 0) {
      return { ok: false, command: "xdg-open", error: `exit code ${result.status}` };
    }
    return { ok: true, command: "xdg-open" };
  }

  return {
    ok: false,
    error: `unsupported platform ${process.platform}`,
  };
}

export function announceAdminConsole(options: AnnounceAdminConsoleOptions): AnnounceAdminConsoleResult {
  const { locale, logger, url, state, stateDir, opener = openAdminConsoleInBrowser } = options;
  const markerPath = stateDir ? resolveAdminConsoleMarkerPath(stateDir) : undefined;
  const firstRun = markerPath !== undefined && !existsSync(markerPath);
  const shouldAutoOpen = firstRun && state !== "service-command";

  let openedAutomatically = false;
  if (shouldAutoOpen) {
    const result = opener(url);
    if (result.ok) {
      openedAutomatically = true;
      if (markerPath) {
        writeAdminConsoleMarker(markerPath, url);
      }
    } else {
      const via = result.command ? ` via ${result.command}` : "";
      emitWarn(logger, `securityclaw: failed to auto-open admin dashboard${via} (${result.error ?? "unknown error"})`);
    }
  }

  for (const line of buildAdminConsoleBanner({ locale, url, state, openedAutomatically })) {
    emitLog(logger, line);
  }

  return {
    firstRun,
    openedAutomatically,
    ...(markerPath !== undefined ? { markerPath } : {}),
  };
}
