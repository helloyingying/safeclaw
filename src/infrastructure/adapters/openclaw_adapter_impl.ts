import type { OpenClawAdapter, OpenClawLogger, OpenClawConfig } from "../../domain/ports/openclaw_adapter.ts";

// This is a type from openclaw package that we need to reference
type OpenClawPluginApi = {
  logger: OpenClawLogger;
  config: OpenClawConfig;
  pluginConfig?: unknown;
  runtime: {
    channel: {
      telegram: { sendMessageTelegram: (to: string, text: string, opts?: Record<string, unknown>) => Promise<{ messageId?: string }> };
      discord: { sendMessageDiscord: (to: string, text: string, opts?: Record<string, unknown>) => Promise<{ messageId?: string }> };
      slack: { sendMessageSlack: (to: string, text: string, opts?: Record<string, unknown>) => Promise<{ messageId?: string }> };
      signal: { sendMessageSignal: (to: string, text: string, opts?: Record<string, unknown>) => Promise<{ messageId?: string }> };
      imessage: { sendMessageIMessage: (to: string, text: string, opts?: Record<string, unknown>) => Promise<{ messageId?: string }> };
      whatsapp: { sendMessageWhatsApp: (to: string, text: string, opts?: Record<string, unknown>) => Promise<{ messageId?: string }> };
      line: { pushMessageLine: (to: string, text: string, opts?: Record<string, unknown>) => Promise<{ messageId?: string }> };
    };
  };
};

export class OpenClawAdapterImpl implements OpenClawAdapter {
  readonly logger: OpenClawLogger;
  readonly config: OpenClawConfig;
  private api: OpenClawPluginApi;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.logger = api.logger;
    this.config = api.config;
  }

  async sendTelegram(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }> {
    return this.api.runtime.channel.telegram.sendMessageTelegram(to, text, opts);
  }

  async sendDiscord(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }> {
    return this.api.runtime.channel.discord.sendMessageDiscord(to, text, opts);
  }

  async sendSlack(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }> {
    return this.api.runtime.channel.slack.sendMessageSlack(to, text, opts);
  }

  async sendSignal(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }> {
    return this.api.runtime.channel.signal.sendMessageSignal(to, text, opts);
  }

  async sendIMessage(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }> {
    return this.api.runtime.channel.imessage.sendMessageIMessage(to, text, opts);
  }

  async sendWhatsApp(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }> {
    return this.api.runtime.channel.whatsapp.sendMessageWhatsApp(to, text, opts);
  }

  async sendLine(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }> {
    return this.api.runtime.channel.line.pushMessageLine(to, text, opts);
  }
}
