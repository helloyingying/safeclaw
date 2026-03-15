import path from "node:path";

export interface HookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  channelId?: string;
}

export class ApprovalSubjectResolver {
  static resolve(ctx: HookContext): string {
    const sessionKey = ctx.sessionKey?.trim();
    if (sessionKey) {
      const directOrSlash = sessionKey.match(/^agent:[^:]+:([^:]+):(direct|slash):(.+)$/);
      if (directOrSlash) {
        return `${directOrSlash[1]}:${directOrSlash[3]}`;
      }
      const compactDirectOrSlash = sessionKey.match(/^([^:]+):(direct|slash):(.+)$/);
      if (compactDirectOrSlash) {
        return `${compactDirectOrSlash[1]}:${compactDirectOrSlash[3]}`;
      }
      return sessionKey;
    }
    if (ctx.channelId?.trim() && ctx.sessionId?.trim()) {
      return `${ctx.channelId.trim()}:${ctx.sessionId.trim()}`;
    }
    if (ctx.sessionId?.trim()) {
      return `session:${ctx.sessionId.trim()}`;
    }
    const actor = ctx.agentId?.trim() || "unknown-agent";
    const channel = ctx.channelId?.trim() || "default-channel";
    const workspace = ctx.workspaceDir ? path.normalize(ctx.workspaceDir) : "unknown-workspace";
    return `fallback:${actor}:${channel}:${workspace}`;
  }
}
