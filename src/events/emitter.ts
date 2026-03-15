import type { EventSink, SecurityDecisionEvent } from "../types.ts";

export class HttpEventSink implements EventSink {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async send(event: SecurityDecisionEvent): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Webhook sink failed with status ${response.status}.`);
    }
  }
}

type QueueItem = {
  event: SecurityDecisionEvent;
  attempts: number;
};

export class EventEmitter {
  #sink: EventSink | undefined;
  #maxBuffer: number;
  #retryLimit: number;
  #queue: QueueItem[] = [];
  #dropped = 0;

  constructor(sink: EventSink | undefined, maxBuffer: number, retryLimit: number) {
    this.#sink = sink;
    this.#maxBuffer = maxBuffer;
    this.#retryLimit = retryLimit;
  }

  async emitSecurityEvent(event: SecurityDecisionEvent): Promise<void> {
    if (!this.#sink) {
      return;
    }
    try {
      await this.#sink.send(event);
      await this.flush();
    } catch {
      this.enqueue(event, 1);
    }
  }

  async flush(): Promise<void> {
    if (!this.#sink) {
      this.#queue = [];
      return;
    }
    const pending = [...this.#queue];
    this.#queue = [];
    for (const item of pending) {
      try {
        await this.#sink.send(item.event);
      } catch {
        this.enqueue(item.event, item.attempts + 1);
      }
    }
  }

  getStats(): { queued: number; dropped: number } {
    return { queued: this.#queue.length, dropped: this.#dropped };
  }

  enqueue(event: SecurityDecisionEvent, attempts: number): void {
    if (attempts > this.#retryLimit) {
      this.#dropped += 1;
      return;
    }
    if (this.#queue.length >= this.#maxBuffer) {
      this.#queue.shift();
      this.#dropped += 1;
    }
    this.#queue.push({ event, attempts });
  }
}
