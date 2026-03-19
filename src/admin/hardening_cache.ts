import crypto from "node:crypto";

import type {
  ClawGuardConfigSnapshot,
  ClawGuardPreviewPayload,
} from "./claw_guard_types.ts";

const LOCAL_SNAPSHOT_TTL_MS = 5000;
const RPC_SNAPSHOT_TTL_MS = 30000;
const PREVIEW_TTL_MS = 30000;

type SnapshotEntry = {
  snapshot: ClawGuardConfigSnapshot;
  cachedAt: number;
};

type PreviewEntry = {
  payload: ClawGuardPreviewPayload;
  cachedAt: number;
};

function normalizeOptions(options: Record<string, unknown> | undefined): string {
  if (!options) {
    return "";
  }
  try {
    return JSON.stringify(options);
  } catch {
    return String(options);
  }
}

function hashConfig(config: Record<string, unknown>): string {
  return crypto.createHash("sha1").update(JSON.stringify(config)).digest("hex");
}

function snapshotKey(snapshot: ClawGuardConfigSnapshot): string {
  return snapshot.baseHash || `${snapshot.source}:${snapshot.configPath || "unknown"}:${hashConfig(snapshot.config)}`;
}

function isFresh(entry: SnapshotEntry | null | undefined, ttlMs: number): boolean {
  if (!entry) {
    return false;
  }
  return Date.now() - entry.cachedAt <= ttlMs;
}

export class HardeningCache {
  #localSnapshot: SnapshotEntry | null = null;
  #rpcSnapshot: SnapshotEntry | null = null;
  #pendingRpcRefresh: Promise<void> | null = null;
  #previewCache = new Map<string, PreviewEntry>();

  getLocalSnapshot(): ClawGuardConfigSnapshot | null {
    return isFresh(this.#localSnapshot, LOCAL_SNAPSHOT_TTL_MS) ? this.#localSnapshot?.snapshot ?? null : null;
  }

  getRpcSnapshot(): ClawGuardConfigSnapshot | null {
    return isFresh(this.#rpcSnapshot, RPC_SNAPSHOT_TTL_MS) ? this.#rpcSnapshot?.snapshot ?? null : null;
  }

  getFastSnapshot(): ClawGuardConfigSnapshot | null {
    return this.getRpcSnapshot() || this.getLocalSnapshot();
  }

  rememberSnapshot(snapshot: ClawGuardConfigSnapshot): void {
    const entry = {
      snapshot,
      cachedAt: Date.now(),
    };
    if (snapshot.source === "gateway-rpc") {
      this.#rpcSnapshot = entry;
      return;
    }
    this.#localSnapshot = entry;
  }

  scheduleRpcRefresh(loader: () => Promise<ClawGuardConfigSnapshot>): void {
    if (this.#pendingRpcRefresh) {
      return;
    }
    this.#pendingRpcRefresh = loader()
      .then((snapshot) => {
        this.rememberSnapshot(snapshot);
      })
      .catch(() => {
        // Background refresh failures are expected in read-only or offline mode.
      })
      .finally(() => {
        this.#pendingRpcRefresh = null;
      });
  }

  getPreview(snapshot: ClawGuardConfigSnapshot, findingId: string, options?: Record<string, unknown>): ClawGuardPreviewPayload | null {
    const key = this.previewKey(snapshot, findingId, options);
    const entry = this.#previewCache.get(key);
    if (!entry || Date.now() - entry.cachedAt > PREVIEW_TTL_MS) {
      return null;
    }
    return entry.payload;
  }

  rememberPreview(
    snapshot: ClawGuardConfigSnapshot,
    findingId: string,
    options: Record<string, unknown> | undefined,
    payload: ClawGuardPreviewPayload,
  ): void {
    this.#previewCache.set(this.previewKey(snapshot, findingId, options), {
      payload,
      cachedAt: Date.now(),
    });
  }

  clearPreview(findingId: string): void {
    for (const key of this.#previewCache.keys()) {
      if (key.includes(`::${findingId}::`)) {
        this.#previewCache.delete(key);
      }
    }
  }

  clearAll(): void {
    this.#localSnapshot = null;
    this.#rpcSnapshot = null;
    this.#previewCache.clear();
  }

  private previewKey(snapshot: ClawGuardConfigSnapshot, findingId: string, options?: Record<string, unknown>): string {
    return `${snapshotKey(snapshot)}::${findingId}::${normalizeOptions(options)}`;
  }
}
