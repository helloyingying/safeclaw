import { AccountPolicyEngine } from "../domain/services/account_policy_engine.ts";
import { canAssignAdminForAccount } from "../domain/services/approval_channel.ts";
import type { SecurityClawLocale } from "../i18n/locale.ts";
import type { AccountPolicyRecord } from "../types.ts";
import type { OpenClawChatSession } from "./openclaw_session_catalog.ts";

export const DEFAULT_MAIN_ADMIN_SESSION_KEY = "agent:main:main";

export function createAccountPolicyDraftFromSession(
  session: OpenClawChatSession | undefined,
  subject: string,
): AccountPolicyRecord {
  if (!session) {
    return {
      subject,
      mode: "apply_rules",
      is_admin: false,
    };
  }
  return {
    subject: session.subject,
    mode: "apply_rules",
    is_admin: false,
    ...(session.label ? { label: session.label } : {}),
    ...(session.session_key ? { session_key: session.session_key } : {}),
    ...(session.session_id ? { session_id: session.session_id } : {}),
    ...(session.agent_id ? { agent_id: session.agent_id } : {}),
    ...(session.channel ? { channel: session.channel } : {}),
    ...(session.chat_type ? { chat_type: session.chat_type } : {}),
  };
}

function createAccountDisplayEntry(
  session: OpenClawChatSession | undefined,
  policy: AccountPolicyRecord | undefined,
): AccountPolicyRecord {
  const subject = policy?.subject ?? session?.subject ?? "";
  const merged: AccountPolicyRecord = {
    ...(session ? createAccountPolicyDraftFromSession(session, session.subject) : {
      subject,
      mode: policy?.mode === "default_allow" ? "default_allow" : "apply_rules",
      is_admin: policy?.is_admin === true,
    }),
    ...(policy ?? {}),
    subject,
    mode: policy?.mode === "default_allow" ? "default_allow" : "apply_rules",
    is_admin: policy?.is_admin === true,
  };
  const updatedAt = policy?.updated_at ?? session?.updated_at;
  if (updatedAt) {
    merged.updated_at = updatedAt;
  }
  return merged;
}

export function mergeAccountPoliciesWithSessions(
  policies: unknown,
  sessions: OpenClawChatSession[],
): AccountPolicyRecord[] {
  const normalizedPolicies = AccountPolicyEngine.sanitize(policies);
  const visibleSessions = sessions;
  const policyBySubject = new Map(normalizedPolicies.map((policy) => [policy.subject, policy]));
  const sessionOrder = new Map(visibleSessions.map((session, index) => [session.subject, index]));
  const merged: AccountPolicyRecord[] = [];

  for (const session of visibleSessions) {
    merged.push(createAccountDisplayEntry(session, policyBySubject.get(session.subject)));
    policyBySubject.delete(session.subject);
  }

  for (const policy of policyBySubject.values()) {
    merged.push(createAccountDisplayEntry(undefined, policy));
  }

  return merged.sort((left, right) => {
    const leftApprovalCapable = canAssignAdminForAccount(left);
    const rightApprovalCapable = canAssignAdminForAccount(right);
    if (leftApprovalCapable !== rightApprovalCapable) {
      return leftApprovalCapable ? -1 : 1;
    }

    const leftOrder = sessionOrder.get(left.subject) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = sessionOrder.get(right.subject) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return left.subject.localeCompare(right.subject);
  });
}

export function ensureDefaultAdminAccount(
  policies: unknown,
  _sessions: OpenClawChatSession[],
  _nowIso = new Date().toISOString(),
): AccountPolicyRecord[] {
  return AccountPolicyEngine.sanitize(policies);
}

export function materializeAdminApprovalLocale(
  policies: unknown,
  defaultAdminApprovalLocale: SecurityClawLocale,
): AccountPolicyRecord[] {
  return AccountPolicyEngine.sanitize(policies).map((policy) =>
    policy.is_admin && !policy.approval_locale
      ? {
          ...policy,
          approval_locale: defaultAdminApprovalLocale,
        }
      : policy,
  );
}

export function isAccountPolicyOverride(policy: AccountPolicyRecord): boolean {
  return policy.is_admin === true || policy.mode === "default_allow";
}

export function pruneAccountPolicyOverrides(input: unknown): AccountPolicyRecord[] {
  return AccountPolicyEngine.sanitize(input).filter(isAccountPolicyOverride);
}
