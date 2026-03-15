import os from "node:os";
import { isIP } from "node:net";
import path from "node:path";

import type { ResourceScope } from "../../types.ts";
import type {
  ResourceContext,
  ToolContext,
  DestinationContext,
  LabelContext,
  VolumeContext
} from "../models/resource_context.ts";

const HOME_DIR = os.homedir();
const PATH_KEY_PATTERN = /(path|paths|file|files|dir|cwd|target|output|input|source|destination|dest|root)/i;
const COMMAND_KEY_PATTERN = /(command|cmd|script|query|sql)/i;
const URL_KEY_PATTERN = /(url|uri|endpoint|host|domain|upload|webhook|callback|proxy|origin|destination|dest)/i;
const SYSTEM_PATH_PREFIXES = ["/etc", "/usr", "/bin", "/sbin", "/var", "/private/etc", "/System", "/Library"];
const DEFAULT_MESSAGES_DB_PATH = path.join(HOME_DIR, "Library/Messages/chat.db");
const MESSAGE_DB_PATH_PATTERN = /(?:~\/Library\/Messages\/chat\.db|\/Users\/[^/\s"'`;]+\/Library\/Messages\/chat\.db)/i;
const OTP_PATTERN = /otp|one[- ]time|verification code|验证码|passcode|login (?:code|notification|alert)|登录提醒/i;
const PERSONAL_STORAGE_DOMAINS = [
  "dropbox.com",
  "drive.google.com",
  "docs.google.com",
  "onedrive.live.com",
  "1drv.ms",
  "notion.so",
  "notion.site",
];
const PASTE_SERVICE_DOMAINS = [
  "pastebin.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "hastebin.com",
  "transfer.sh",
];

export class ContextInferenceService {
  inferResourceContext(args: unknown, workspaceDir?: string): ResourceContext {
    const candidates = this.collectPathCandidates(args);
    const resolved = Array.from(
      new Set(
        candidates
          .map((candidate) => this.resolvePathCandidate(candidate, workspaceDir))
          .filter((value): value is string => Boolean(value)),
      ),
    ).slice(0, 12);
    return this.classifyResolvedResourcePaths(resolved, workspaceDir);
  }

  inferToolContext(
    normalizedToolName: string | undefined,
    args: unknown,
    resourceScope: ResourceScope,
    resourcePaths: string[],
    workspaceDir?: string,
  ): ToolContext {
    let nextResourcePaths = [...resourcePaths];
    let nextResourceScope = resourceScope;
    let toolGroup = normalizedToolName ? this.inferToolGroup(normalizedToolName) : undefined;
    let operation = normalizedToolName ? this.inferOperation(normalizedToolName) : undefined;
    const tags: string[] = [];

    if (normalizedToolName === "shell.exec") {
      const commandText = this.extractShellCommandText(args);
      if (this.isMessagesShellAccess(commandText, nextResourcePaths)) {
        toolGroup = "sms";
        operation = this.inferMessagesOperation(commandText);
        if (!nextResourcePaths.some((candidate) => this.isMessagesDbPath(candidate))) {
          nextResourcePaths = [...nextResourcePaths, DEFAULT_MESSAGES_DB_PATH];
        }
        const classified = this.classifyResolvedResourcePaths(nextResourcePaths, workspaceDir);
        nextResourcePaths = classified.resourcePaths;
        nextResourceScope = classified.resourceScope;
        tags.push("messages_shell_access");
      }
    }

    return {
      ...(toolGroup !== undefined ? { toolGroup } : {}),
      ...(operation !== undefined ? { operation } : {}),
      resourceScope: nextResourceScope,
      resourcePaths: nextResourcePaths,
      tags,
    };
  }

  inferDestinationContext(args: unknown): DestinationContext {
    const urls = this.collectUrlCandidates(args);
    return this.classifyDestination(urls);
  }

  inferLabels(
    toolGroup: string | undefined,
    resourcePaths: string[],
    toolArgsSummary: string | undefined,
  ): LabelContext {
    const corpus = [...resourcePaths, toolArgsSummary ?? ""].join(" ").toLowerCase();
    const assetLabels = new Set<string>();
    const dataLabels = new Set<string>();

    this.addLabel(assetLabels, /finance|invoice|billing|payroll|ledger/.test(corpus), "financial");
    this.addLabel(dataLabels, /finance|invoice|billing|payroll|ledger/.test(corpus), "financial");
    this.addLabel(assetLabels, /customer|client|crm|contact/.test(corpus), "customer_data");
    this.addLabel(dataLabels, /customer|client|crm|contact/.test(corpus), "customer_data");
    this.addLabel(assetLabels, /hr|personnel|resume|employee|salary/.test(corpus), "hr");
    this.addLabel(dataLabels, /hr|personnel|resume|employee|salary/.test(corpus), "pii");
    this.addLabel(assetLabels, /\.env\b|\.npmrc\b|\.pypirc\b|\.ssh\b|id_rsa\b|kubeconfig\b|aws\/credentials\b/.test(corpus), "credential");
    this.addLabel(dataLabels, /token|secret|password|bearer|cookie|session|jwt|private key|id_rsa/.test(corpus), "secret");
    this.addLabel(dataLabels, OTP_PATTERN.test(corpus), "otp");
    this.addLabel(assetLabels, /\.github\/workflows\/|dockerfile\b|terraform|\.tf\b|k8s|kubernetes|deployment\.ya?ml|secret\.ya?ml|iam/.test(corpus), "control_plane");
    this.addLabel(dataLabels, toolGroup === "email" || toolGroup === "sms", "communications");
    this.addLabel(dataLabels, toolGroup === "album", "media");
    this.addLabel(dataLabels, toolGroup === "browser", "browser_secret");

    return {
      assetLabels: [...assetLabels],
      dataLabels: [...dataLabels],
    };
  }

  inferVolume(args: unknown, resourcePaths: string[]): VolumeContext {
    const metrics: VolumeContext = {};
    if (resourcePaths.length > 0) {
      metrics.fileCount = resourcePaths.length;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return metrics;
    }

    const record = args as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      const lower = key.toLowerCase();
      if (Array.isArray(value)) {
        if (/(files|paths|attachments|items|results|records|messages)/.test(lower)) {
          if ((metrics.fileCount ?? 0) < value.length) {
            metrics.fileCount = value.length;
          }
          if (/(results|records|messages)/.test(lower) && (metrics.recordCount ?? 0) < value.length) {
            metrics.recordCount = value.length;
          }
        }
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        continue;
      }
      if (/(bytes|size|length)/.test(lower)) {
        metrics.bytes = value;
      }
      if (/(count|limit|total|records)/.test(lower)) {
        metrics.recordCount = value;
      }
    }

    return metrics;
  }

  inferFileType(resourcePaths: string[]): string | undefined {
    for (const candidate of resourcePaths) {
      const basename = path.basename(candidate);
      if (basename === "Dockerfile") {
        return "dockerfile";
      }
      const extension = path.extname(basename).toLowerCase().replace(/^\./, "");
      if (extension) {
        return extension;
      }
    }
    return undefined;
  }

  private collectPathCandidates(value: unknown, keyHint = "", depth = 0, output: string[] = []): string[] {
    if (depth > 4 || output.length >= 24) {
      return output;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed && this.isPathLike(trimmed, keyHint)) {
        output.push(trimmed);
      } else if (trimmed && (COMMAND_KEY_PATTERN.test(keyHint) || trimmed.includes("~/") || trimmed.includes("/"))) {
        for (const candidate of this.extractEmbeddedPathCandidates(trimmed)) {
          output.push(candidate);
          if (output.length >= 24) {
            break;
          }
        }
      }
      return output;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectPathCandidates(item, keyHint, depth + 1, output);
        if (output.length >= 24) {
          break;
        }
      }
      return output;
    }

    if (!value || typeof value !== "object") {
      return output;
    }

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      this.collectPathCandidates(item, key, depth + 1, output);
      if (output.length >= 24) {
        break;
      }
    }
    return output;
  }

  private isPathLike(value: string, keyHint: string): boolean {
    if (PATH_KEY_PATTERN.test(keyHint)) {
      return true;
    }
    return (
      value.startsWith("/") ||
      value.startsWith("~/") ||
      value.startsWith("./") ||
      value.startsWith("../")
    );
  }

  private extractEmbeddedPathCandidates(value: string): string[] {
    const matches = value.match(/(?:^|[\s"'=])((?:~\/|\/|\.\/|\.\.\/)[^\s"'`;|&<>]+)/g) ?? [];
    return matches
      .map((match) => match.trim().replace(/^["'=]+/, ""))
      .map((match) => {
        const pathMatch = match.match(/(?:~\/|\/|\.\/|\.\.\/)[^\s"'`;|&<>]+/);
        return pathMatch ? pathMatch[0] : "";
      })
      .filter(Boolean);
  }

  private resolvePathCandidate(candidate: string, workspaceDir?: string): string | undefined {
    if (!candidate) {
      return undefined;
    }

    let normalized = candidate;
    if (normalized.startsWith("~/")) {
      normalized = path.join(HOME_DIR, normalized.slice(2));
    } else if (normalized === "~") {
      normalized = HOME_DIR;
    }

    if (path.isAbsolute(normalized)) {
      return path.normalize(normalized);
    }
    if (!workspaceDir) {
      return undefined;
    }
    return path.normalize(path.resolve(workspaceDir, normalized));
  }

  private classifyResolvedResourcePaths(
    resolved: string[],
    workspaceDir?: string,
  ): ResourceContext {
    if (resolved.length === 0) {
      return { resourceScope: "none", resourcePaths: [] };
    }

    let hasInside = false;
    let hasOutside = false;
    let hasSystem = false;
    const normalizedWorkspace = workspaceDir ? path.normalize(workspaceDir) : undefined;

    for (const candidate of resolved) {
      if (this.isSystemPath(candidate)) {
        hasSystem = true;
      }
      if (normalizedWorkspace && this.isPathInside(normalizedWorkspace, candidate)) {
        hasInside = true;
      } else {
        hasOutside = true;
      }
    }

    if (hasSystem) {
      return { resourceScope: "system", resourcePaths: resolved };
    }
    if (hasOutside) {
      return { resourceScope: "workspace_outside", resourcePaths: resolved };
    }
    if (hasInside) {
      return { resourceScope: "workspace_inside", resourcePaths: resolved };
    }
    return { resourceScope: "none", resourcePaths: resolved };
  }

  private isPathInside(rootDir: string, candidate: string): boolean {
    const relative = path.relative(rootDir, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private isSystemPath(candidate: string): boolean {
    return SYSTEM_PATH_PREFIXES.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
  }

  private collectUrlCandidates(value: unknown, keyHint = "", depth = 0, output: string[] = []): string[] {
    if (depth > 4 || output.length >= 12) {
      return output;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed && this.isUrlLike(trimmed, keyHint)) {
        output.push(trimmed);
      }
      return output;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectUrlCandidates(item, keyHint, depth + 1, output);
        if (output.length >= 12) {
          break;
        }
      }
      return output;
    }

    if (!value || typeof value !== "object") {
      return output;
    }

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      this.collectUrlCandidates(item, key, depth + 1, output);
      if (output.length >= 12) {
        break;
      }
    }
    return output;
  }

  private isUrlLike(value: string, keyHint: string): boolean {
    return URL_KEY_PATTERN.test(keyHint) || value.startsWith("http://") || value.startsWith("https://");
  }

  private classifyDestination(urls: string[]): DestinationContext {
    for (const candidate of urls) {
      try {
        const parsed = new URL(candidate);
        const host = parsed.hostname.toLowerCase();
        const ipVersion = isIP(host);
        const isInternalHost =
          host === "localhost" ||
          host.endsWith(".internal") ||
          host.endsWith(".corp") ||
          host.endsWith(".local") ||
          host.endsWith(".lan") ||
          this.isPrivateIp(host);

        const destinationType =
          PERSONAL_STORAGE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
            ? "personal_storage"
            : PASTE_SERVICE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
              ? "paste_service"
              : isInternalHost
                ? "internal"
                : "public";

        const destIpClass =
          ipVersion === 0
            ? destinationType === "internal"
              ? "private"
              : "unknown"
            : this.isLoopbackIp(host)
              ? "loopback"
              : this.isPrivateIp(host)
                ? "private"
                : "public";

        return {
          destinationType,
          destDomain: host,
          destIpClass,
        };
      } catch {
        continue;
      }
    }

    return {};
  }

  private isPrivateIp(host: string): boolean {
    if (isIP(host) !== 4) {
      return false;
    }
    const octets = host.split(".").map((value) => Number(value));
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }

  private isLoopbackIp(host: string): boolean {
    if (isIP(host) === 4) {
      return host.startsWith("127.");
    }
    return host === "::1";
  }

  private inferToolGroup(toolName: string): string | undefined {
    const normalized = toolName.trim().toLowerCase();
    if (normalized.startsWith("shell.")) {
      return "execution";
    }
    if (normalized.startsWith("filesystem.")) {
      return "filesystem";
    }
    if (normalized.startsWith("network.") || normalized.startsWith("http.")) {
      return "network";
    }
    if (normalized.startsWith("email.") || normalized.startsWith("mail.")) {
      return "email";
    }
    if (
      normalized.startsWith("sms.") ||
      normalized.startsWith("message.") ||
      normalized.startsWith("messages.")
    ) {
      return "sms";
    }
    if (normalized.startsWith("album.") || normalized.startsWith("photo.") || normalized.startsWith("media.")) {
      return "album";
    }
    if (normalized.startsWith("browser.")) {
      return "browser";
    }
    if (
      normalized.startsWith("archive.") ||
      normalized.startsWith("compress.") ||
      normalized.includes(".archive") ||
      normalized.includes(".compress") ||
      normalized.includes(".zip")
    ) {
      return "archive";
    }
    if (
      normalized.startsWith("crm.") ||
      normalized.startsWith("erp.") ||
      normalized.startsWith("hr.") ||
      normalized.startsWith("finance.") ||
      normalized.startsWith("jira.") ||
      normalized.startsWith("servicenow.") ||
      normalized.startsWith("zendesk.")
    ) {
      return "business";
    }
    return undefined;
  }

  private inferOperation(toolName: string): string | undefined {
    const normalized = toolName.trim().toLowerCase();
    if (normalized.startsWith("network.") || normalized.startsWith("http.")) {
      return "request";
    }
    if (/(exec|run|spawn)$/.test(normalized) || normalized.endsWith(".exec")) {
      return "execute";
    }
    if (/(delete|remove|unlink|destroy)$/.test(normalized) || normalized.endsWith(".rm")) {
      return "delete";
    }
    if (/(write|save|create|update|append|put)$/.test(normalized)) {
      return "write";
    }
    if (/(list|ls|enumerate)$/.test(normalized)) {
      return "list";
    }
    if (/(search|query|find)$/.test(normalized)) {
      return "search";
    }
    if (/(read|get|open|cat|fetch|download)$/.test(normalized)) {
      return "read";
    }
    if (/(upload|send|post|reply)$/.test(normalized)) {
      return "upload";
    }
    if (/(export|dump)$/.test(normalized)) {
      return "export";
    }
    if (/(archive|compress|zip|tar|bundle)$/.test(normalized)) {
      return "archive";
    }
    if (/(deploy|apply|terraform|kubectl)$/.test(normalized)) {
      return "modify";
    }
    return undefined;
  }

  private extractShellCommandText(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const record = args as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  private isMessagesDbPath(candidate: string): boolean {
    return /\/Library\/Messages\/chat\.db$/i.test(candidate);
  }

  private isMessagesShellAccess(commandText: string | undefined, resourcePaths: string[]): boolean {
    if (resourcePaths.some((candidate) => this.isMessagesDbPath(candidate))) {
      return true;
    }
    const corpus = [commandText ?? "", ...resourcePaths].join(" ");
    return /\bimsg\b/i.test(corpus) || (/\bsqlite3\b/i.test(corpus) && MESSAGE_DB_PATH_PATTERN.test(corpus));
  }

  private inferMessagesOperation(commandText: string | undefined): string {
    const normalized = (commandText ?? "").toLowerCase();
    if (/\b(export|dump)\b/.test(normalized)) {
      return "export";
    }
    if (/\b(search|find|query)\b/.test(normalized)) {
      return "search";
    }
    return "read";
  }

  private addLabel(labels: Set<string>, condition: boolean, label: string): void {
    if (condition) {
      labels.add(label);
    }
  }
}
