import type {
  NotificationPort,
  NotificationTarget,
  NotificationOptions,
  NotificationResult,
  ApprovalChannel
} from "../../domain/ports/notification_port.ts";
import type { OpenClawAdapter } from "../../domain/ports/openclaw_adapter.ts";

function normalizeThreadId(threadId: string | number | undefined): number | undefined {
  if (typeof threadId === "number" && Number.isInteger(threadId)) {
    return threadId;
  }
  if (typeof threadId === "string" && /^\d+$/.test(threadId.trim())) {
    return Number(threadId.trim());
  }
  return undefined;
}

function nowIsoString(): string {
  return new Date(Date.now()).toISOString();
}

function normalizeDiscordTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^(?:user|channel|discord):/i.test(trimmed) || /^<@!?\d+>$/.test(trimmed)) {
    return trimmed;
  }
  return /^\d+$/.test(trimmed) ? `user:${trimmed}` : trimmed;
}

abstract class BaseNotificationAdapter implements NotificationPort {
  constructor(protected adapter: OpenClawAdapter) {}

  abstract send(target: NotificationTarget, message: string, options?: NotificationOptions): Promise<NotificationResult>;

  protected createBaseResult(target: NotificationTarget): NotificationResult {
    const result: NotificationResult = {
      channel: target.channel,
      to: target.to,
      sentAt: nowIsoString()
    };
    if (target.accountId) {
      result.accountId = target.accountId;
    }
    const threadId = normalizeThreadId(target.threadId);
    if (threadId !== undefined) {
      result.threadId = threadId;
    }
    return result;
  }
}

class TelegramNotificationAdapter extends BaseNotificationAdapter {
  async send(target: NotificationTarget, message: string, options?: NotificationOptions): Promise<NotificationResult> {
    const result = await this.adapter.sendTelegram(target.to, message, {
      cfg: this.adapter.config,
      ...(target.accountId ? { accountId: target.accountId } : {}),
      ...(normalizeThreadId(target.threadId) !== undefined ? { messageThreadId: normalizeThreadId(target.threadId) } : {}),
      ...(options?.buttons ? { buttons: options.buttons } : {})
    });
    
    const notification = this.createBaseResult(target);
    if (result?.messageId) {
      notification.messageId = result.messageId;
    }
    return notification;
  }
}

class DiscordNotificationAdapter extends BaseNotificationAdapter {
  async send(target: NotificationTarget, message: string, _options?: NotificationOptions): Promise<NotificationResult> {
    const result = await this.adapter.sendDiscord(normalizeDiscordTarget(target.to), message, {
      cfg: this.adapter.config,
      ...(target.accountId ? { accountId: target.accountId } : {})
    });
    
    const notification = this.createBaseResult(target);
    if (result?.messageId) {
      notification.messageId = result.messageId;
    }
    return notification;
  }
}

class SlackNotificationAdapter extends BaseNotificationAdapter {
  async send(target: NotificationTarget, message: string, _options?: NotificationOptions): Promise<NotificationResult> {
    const result = await this.adapter.sendSlack(target.to, message, {
      cfg: this.adapter.config,
      ...(target.accountId ? { accountId: target.accountId } : {})
    });
    
    const notification = this.createBaseResult(target);
    if (result?.messageId) {
      notification.messageId = result.messageId;
    }
    return notification;
  }
}

class SignalNotificationAdapter extends BaseNotificationAdapter {
  async send(target: NotificationTarget, message: string, _options?: NotificationOptions): Promise<NotificationResult> {
    const result = await this.adapter.sendSignal(target.to, message, {
      cfg: this.adapter.config,
      ...(target.accountId ? { accountId: target.accountId } : {})
    });
    
    const notification = this.createBaseResult(target);
    if (result?.messageId) {
      notification.messageId = result.messageId;
    }
    return notification;
  }
}

class IMessageNotificationAdapter extends BaseNotificationAdapter {
  async send(target: NotificationTarget, message: string, _options?: NotificationOptions): Promise<NotificationResult> {
    const result = await this.adapter.sendIMessage(target.to, message, {
      cfg: this.adapter.config,
      ...(target.accountId ? { accountId: target.accountId } : {})
    });
    
    const notification = this.createBaseResult(target);
    if (result?.messageId) {
      notification.messageId = result.messageId;
    }
    return notification;
  }
}

class WhatsAppNotificationAdapter extends BaseNotificationAdapter {
  async send(target: NotificationTarget, message: string, _options?: NotificationOptions): Promise<NotificationResult> {
    const result = await this.adapter.sendWhatsApp(target.to, message, {
      cfg: this.adapter.config
    });
    
    const notification = this.createBaseResult(target);
    if (result?.messageId) {
      notification.messageId = result.messageId;
    }
    return notification;
  }
}

class LineNotificationAdapter extends BaseNotificationAdapter {
  async send(target: NotificationTarget, message: string, _options?: NotificationOptions): Promise<NotificationResult> {
    const result = await this.adapter.sendLine(target.to, message, {
      cfg: this.adapter.config,
      ...(target.accountId ? { accountId: target.accountId } : {})
    });
    
    const notification = this.createBaseResult(target);
    if (result?.messageId) {
      notification.messageId = result.messageId;
    }
    return notification;
  }
}

export class NotificationAdapterFactory {
  static create(channel: ApprovalChannel, adapter: OpenClawAdapter): NotificationPort {
    switch (channel) {
      case "telegram":
        return new TelegramNotificationAdapter(adapter);
      case "discord":
        return new DiscordNotificationAdapter(adapter);
      case "slack":
        return new SlackNotificationAdapter(adapter);
      case "signal":
        return new SignalNotificationAdapter(adapter);
      case "imessage":
        return new IMessageNotificationAdapter(adapter);
      case "whatsapp":
        return new WhatsAppNotificationAdapter(adapter);
      case "line":
        return new LineNotificationAdapter(adapter);
      default:
        throw new Error(`Unsupported notification channel: ${channel}`);
    }
  }
}
