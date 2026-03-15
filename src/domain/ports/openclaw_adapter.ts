export interface OpenClawLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface OpenClawConfig {
  [key: string]: unknown;
}

export interface OpenClawAdapter {
  readonly logger: OpenClawLogger;
  readonly config: OpenClawConfig;
  
  sendTelegram(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }>;
  sendDiscord(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }>;
  sendSlack(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }>;
  sendSignal(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }>;
  sendIMessage(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }>;
  sendWhatsApp(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }>;
  sendLine(to: string, text: string, opts?: Record<string, unknown>): Promise<{ messageId?: string }>;
}
