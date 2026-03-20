import type { AccountPolicyMode, AccountPolicyRecord } from "../../types.ts";
import type { SecurityClawLocale } from "../../i18n/locale.ts";
import { resolveSecurityClawLocale } from "../../i18n/locale.ts";
import { isManageableAccountRecord } from "./account_subject_classifier.ts";

export type AccountDecisionOverride = {
  decision: "allow";
  decision_source: "account";
  reason_codes: string[];
  policy: AccountPolicyRecord;
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMode(value: unknown): AccountPolicyMode {
  return value === "default_allow" ? "default_allow" : "apply_rules";
}

function normalizeApprovalLocale(value: unknown): SecurityClawLocale | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return resolveSecurityClawLocale(value, "en");
}

function enforceSingleAdmin(policies: AccountPolicyRecord[]): AccountPolicyRecord[] {
  let selectedAdminSubject: string | undefined;
  for (const policy of policies) {
    if (policy.is_admin) {
      selectedAdminSubject = policy.subject;
    }
  }
  if (!selectedAdminSubject) {
    return policies;
  }
  return policies.map((policy) =>
    policy.is_admin && policy.subject !== selectedAdminSubject
      ? {
          ...policy,
          is_admin: false,
        }
      : policy,
  );
}

function normalizePolicyEntry(
  value: unknown,
  options: {
    defaultAdminApprovalLocale?: SecurityClawLocale;
  } = {},
): AccountPolicyRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const subject = normalizeString((value as { subject?: unknown }).subject);
  if (!subject) {
    return undefined;
  }

  const isAdmin = (value as { is_admin?: unknown }).is_admin === true;
  const record: AccountPolicyRecord = {
    subject,
    mode: normalizeMode((value as { mode?: unknown }).mode),
    is_admin: isAdmin,
  };

  const approvalLocale =
    normalizeApprovalLocale((value as { approval_locale?: unknown }).approval_locale) ??
    (isAdmin ? options.defaultAdminApprovalLocale : undefined);
  if (approvalLocale) {
    record.approval_locale = approvalLocale;
  }

  const optionalFields = [
    "label",
    "session_key",
    "session_id",
    "agent_id",
    "channel",
    "chat_type",
    "updated_at",
  ] as const;

  for (const field of optionalFields) {
    const normalized = normalizeString((value as Record<string, unknown>)[field]);
    if (normalized) {
      record[field] = normalized;
    }
  }

  return record;
}

export function sanitizeAccountPolicies(input: unknown): AccountPolicyRecord[] {
  return sanitizeAccountPoliciesWithOptions(input);
}

export function sanitizeAccountPoliciesWithOptions(
  input: unknown,
  options: {
    defaultAdminApprovalLocale?: SecurityClawLocale;
  } = {},
): AccountPolicyRecord[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const deduped = new Map<string, AccountPolicyRecord>();
  for (const entry of input) {
    const normalized = normalizePolicyEntry(entry, options);
    if (!normalized || !isManageableAccountRecord(normalized)) {
      continue;
    }
    deduped.set(normalized.subject, normalized);
  }
  return enforceSingleAdmin(Array.from(deduped.values()));
}

export function hasConfiguredAdminAccount(input: unknown): boolean {
  return sanitizeAccountPolicies(input).some((policy) => policy.is_admin);
}

export function getConfiguredAdminAccount(input: unknown): AccountPolicyRecord | undefined {
  return sanitizeAccountPolicies(input).find((policy) => policy.is_admin);
}

export function canonicalizeAccountPolicies(input: unknown): AccountPolicyRecord[] {
  return canonicalizeAccountPoliciesWithOptions(input);
}

export function canonicalizeAccountPoliciesWithOptions(
  input: unknown,
  options: {
    defaultAdminApprovalLocale?: SecurityClawLocale;
  } = {},
): AccountPolicyRecord[] {
  return sanitizeAccountPoliciesWithOptions(input, options)
    .map((policy) => {
      const canonical: AccountPolicyRecord = {
        subject: policy.subject,
        mode: policy.mode,
        is_admin: policy.is_admin,
      };

      if (policy.approval_locale) {
        canonical.approval_locale = policy.approval_locale;
      }

      const optionalFields = [
        "label",
        "session_key",
        "session_id",
        "agent_id",
        "channel",
        "chat_type",
        "updated_at",
      ] as const;

      for (const field of optionalFields) {
        if (policy[field]) {
          canonical[field] = policy[field];
        }
      }

      return canonical;
    })
    .sort((left, right) => left.subject.localeCompare(right.subject));
}

export class AccountPolicyEngine {
  #policiesBySubject: Map<string, AccountPolicyRecord>;
  #adminConfigured: boolean;

  constructor(policies: unknown) {
    const normalizedPolicies = sanitizeAccountPolicies(policies);
    this.#policiesBySubject = new Map(
      normalizedPolicies.map((policy) => [policy.subject, policy]),
    );
    this.#adminConfigured = normalizedPolicies.some((policy) => policy.is_admin);
  }

  getPolicy(subject: string | undefined): AccountPolicyRecord | undefined {
    if (!subject) {
      return undefined;
    }
    return this.#policiesBySubject.get(subject);
  }

  listPolicies(): AccountPolicyRecord[] {
    return Array.from(this.#policiesBySubject.values());
  }

  evaluate(subject: string | undefined): AccountDecisionOverride | undefined {
    if (!this.#adminConfigured) {
      return undefined;
    }
    const policy = this.getPolicy(subject);
    if (!policy) {
      return undefined;
    }
    if (policy.mode === "default_allow") {
      return {
        decision: "allow",
        decision_source: "account",
        reason_codes: ["ACCOUNT_DEFAULT_ALLOW"],
        policy
      };
    }
    return undefined;
  }

  static sanitize(input: unknown): AccountPolicyRecord[] {
    return sanitizeAccountPolicies(input);
  }

  static canonicalize(input: unknown): AccountPolicyRecord[] {
    return canonicalizeAccountPolicies(input);
  }
}
