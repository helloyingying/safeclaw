import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SafeClawConfig } from "../types.ts";
import { hydrateSensitivePathConfig } from "../domain/services/sensitive_path_registry.ts";
import { deepClone, deepFreeze, parseScalar, stripInlineComment } from "../utils.ts";
import { validateConfig } from "./validator.ts";

type Frame = {
  indent: number;
  container: Record<string, unknown> | unknown[];
  parent?: Record<string, unknown> | unknown[];
  key?: string | number;
};

function isArrayFrame(frame: Frame): frame is Frame & { container: unknown[] } {
  return Array.isArray(frame.container);
}

function attachChild(frame: Frame, child: Record<string, unknown> | unknown[]): void {
  if (frame.parent === undefined || frame.key === undefined) {
    return;
  }
  if (Array.isArray(frame.parent)) {
    frame.parent[Number(frame.key)] = child;
  } else {
    frame.parent[String(frame.key)] = child;
  }
  frame.container = child;
}

function parseYaml(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const frames: Frame[] = [{ indent: -1, container: root }];

  const lines = source.split(/\r?\n/);
  for (const originalLine of lines) {
    const withoutComment = stripInlineComment(originalLine);
    if (!withoutComment.trim()) {
      continue;
    }
    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const text = withoutComment.trim();
    while (frames.length > 1 && indent <= frames[frames.length - 1].indent) {
      frames.pop();
    }
    const current = frames[frames.length - 1];

    if (text.startsWith("- ")) {
      if (!isArrayFrame(current)) {
        const replacement: unknown[] = [];
        attachChild(current, replacement);
      }
      const arrayFrame = frames[frames.length - 1] as Frame & { container: unknown[] };
      const itemText = text.slice(2).trim();
      if (itemText === "") {
        const child: Record<string, unknown> = {};
        arrayFrame.container.push(child);
        frames.push({
          indent,
          container: child,
          parent: arrayFrame.container,
          key: arrayFrame.container.length - 1
        });
        continue;
      }
      if (itemText.includes(":")) {
        const colonIndex = itemText.indexOf(":");
        const key = itemText.slice(0, colonIndex).trim();
        const valueText = itemText.slice(colonIndex + 1).trim();
        const child: Record<string, unknown> = {};
        child[key] = valueText === "" ? {} : parseScalar(valueText);
        arrayFrame.container.push(child);
        frames.push({
          indent,
          container: child,
          parent: arrayFrame.container,
          key: arrayFrame.container.length - 1
        });
        if (valueText === "") {
          frames.push({
            indent: indent + 1,
            container: child[key] as Record<string, unknown>,
            parent: child,
            key
          });
        }
        continue;
      }
      arrayFrame.container.push(parseScalar(itemText));
      continue;
    }

    const colonIndex = text.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(`Invalid YAML line: ${text}`);
    }

    const key = text.slice(0, colonIndex).trim();
    const valueText = text.slice(colonIndex + 1).trim();
    if (Array.isArray(current.container)) {
      throw new Error(`Unexpected mapping under array without item context: ${text}`);
    }

    if (valueText === "") {
      current.container[key] = {};
      frames.push({
        indent,
        container: current.container[key] as Record<string, unknown>,
        parent: current.container,
        key
      });
      continue;
    }
    current.container[key] = parseScalar(valueText);
  }

  return root;
}

export class ConfigManager {
  #config: SafeClawConfig;
  #lastKnownGood: SafeClawConfig;
  #path: string | undefined;

  constructor(config: SafeClawConfig, path?: string) {
    const frozen = deepFreeze(deepClone(config));
    this.#config = frozen;
    this.#lastKnownGood = frozen;
    this.#path = path;
  }

  static fromFile(path: string): ConfigManager {
    const resolved = resolve(path);
    const source = readFileSync(resolved, "utf8");
    const raw = parseYaml(source);
    const config = hydrateConfig(validateConfig(raw));
    return new ConfigManager(config, resolved);
  }

  getConfig(): SafeClawConfig {
    return this.#config;
  }

  getLastKnownGood(): SafeClawConfig {
    return this.#lastKnownGood;
  }

  reload(nextSource?: string): SafeClawConfig {
    try {
      const raw = nextSource ? parseYaml(nextSource) : parseYaml(readFileSync(this.#path!, "utf8"));
      const validated = deepFreeze(deepClone(hydrateConfig(validateConfig(raw))));
      this.#config = validated;
      this.#lastKnownGood = validated;
      return this.#config;
    } catch {
      this.#config = this.#lastKnownGood;
      return this.#config;
    }
  }
}

function hydrateConfig(config: SafeClawConfig): SafeClawConfig {
  return {
    ...config,
    sensitivity: hydrateSensitivePathConfig(config.sensitivity)
  };
}
