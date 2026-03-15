import type { DecisionContext, PolicyRule, RuleMatch } from "../types.ts";

function intersects(targets: string[] | undefined, value: string | undefined): boolean {
  return !targets || targets.length === 0 || (value !== undefined && targets.includes(value));
}

function includesAny(targets: string[] | undefined, values: string[]): boolean {
  return !targets || targets.length === 0 || targets.some((target) => values.includes(target));
}

function matchesPathPrefixes(prefixes: string[] | undefined, paths: string[]): boolean {
  if (!prefixes || prefixes.length === 0) {
    return true;
  }
  if (paths.length === 0) {
    return false;
  }
  return prefixes.some((prefix) => paths.some((candidate) => candidate.startsWith(prefix)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function matchesPathGlobs(globs: string[] | undefined, paths: string[]): boolean {
  if (!globs || globs.length === 0) {
    return true;
  }
  if (paths.length === 0) {
    return false;
  }
  const regexes = globs.map((pattern) => globToRegExp(pattern));
  return regexes.some((regex) => paths.some((candidate) => regex.test(candidate)));
}

function matchesRegexList(patterns: string[] | undefined, value: string | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return true;
  }
  if (!value) {
    return false;
  }
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return false;
    }
  });
}

function matchesPathRegexes(patterns: string[] | undefined, paths: string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return true;
  }
  if (paths.length === 0) {
    return false;
  }
  return patterns.some((pattern) => {
    try {
      const regex = new RegExp(pattern, "i");
      return paths.some((candidate) => regex.test(candidate));
    } catch {
      return false;
    }
  });
}

function matchesDomains(patterns: string[] | undefined, value: string | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return true;
  }
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return patterns.some((pattern) => {
    const candidate = pattern.toLowerCase();
    if (candidate.startsWith("*.")) {
      const suffix = candidate.slice(1);
      return normalized.endsWith(suffix);
    }
    return normalized === candidate;
  });
}

function matchesSubstrings(patterns: string[] | undefined, value: string | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return true;
  }
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

function meetsMinimum(minimum: number | undefined, actual: number | undefined): boolean {
  return minimum === undefined || (actual !== undefined && actual >= minimum);
}

function precedence(rule: PolicyRule): number {
  let score = 1;
  const weights: Array<[unknown, number]> = [
    [rule.match.identity, 4],
    [rule.match.scope, 3],
    [rule.match.tool, 3],
    [rule.match.tool_group, 2],
    [rule.match.operation, 2],
    [rule.match.tags, 1],
    [rule.match.resource_scope, 1],
    [rule.match.path_prefix, 2],
    [rule.match.path_glob, 2],
    [rule.match.path_regex, 2],
    [rule.match.file_type, 1],
    [rule.match.asset_labels, 2],
    [rule.match.data_labels, 2],
    [rule.match.trust_level, 2],
    [rule.match.destination_type, 2],
    [rule.match.dest_domain, 2],
    [rule.match.dest_ip_class, 1],
    [rule.match.tool_args_summary, 1],
    [rule.match.tool_args_regex, 1],
    [rule.match.min_file_count, 1],
    [rule.match.min_bytes, 1],
    [rule.match.min_record_count, 1],
  ];

  for (const [value, weight] of weights) {
    if (Array.isArray(value) ? value.length > 0 : value !== undefined) {
      score += weight;
    }
  }
  return score;
}

export class RuleEngine {
  readonly rules: PolicyRule[];

  constructor(rules: PolicyRule[]) {
    this.rules = [...rules];
  }

  match(context: DecisionContext): RuleMatch[] {
    const matches = this.rules
      .filter((rule) => {
        if (!rule.enabled) {
          return false;
        }
        return (
          intersects(rule.match.identity, context.actor_id) &&
          intersects(rule.match.scope, context.scope) &&
          intersects(rule.match.tool, context.tool_name) &&
          intersects(rule.match.tool_group, context.tool_group) &&
          intersects(rule.match.operation, context.operation) &&
          includesAny(rule.match.tags, context.tags) &&
          intersects(rule.match.resource_scope, context.resource_scope) &&
          matchesPathPrefixes(rule.match.path_prefix, context.resource_paths) &&
          matchesPathGlobs(rule.match.path_glob, context.resource_paths) &&
          matchesPathRegexes(rule.match.path_regex, context.resource_paths) &&
          intersects(rule.match.file_type, context.file_type) &&
          includesAny(rule.match.asset_labels, context.asset_labels) &&
          includesAny(rule.match.data_labels, context.data_labels) &&
          intersects(rule.match.trust_level, context.trust_level) &&
          intersects(rule.match.destination_type, context.destination_type) &&
          matchesDomains(rule.match.dest_domain, context.dest_domain) &&
          intersects(rule.match.dest_ip_class, context.dest_ip_class) &&
          matchesSubstrings(rule.match.tool_args_summary, context.tool_args_summary) &&
          matchesRegexList(rule.match.tool_args_regex, context.tool_args_summary) &&
          meetsMinimum(rule.match.min_file_count, context.volume.file_count) &&
          meetsMinimum(rule.match.min_bytes, context.volume.bytes) &&
          meetsMinimum(rule.match.min_record_count, context.volume.record_count)
        );
      })
      .map((rule) => ({ rule, precedence: precedence(rule) }));

    matches.sort((left, right) => {
      if (right.precedence !== left.precedence) {
        return right.precedence - left.precedence;
      }
      return right.rule.priority - left.rule.priority;
    });
    return matches;
  }
}
