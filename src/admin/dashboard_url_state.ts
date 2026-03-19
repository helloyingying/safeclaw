export const ADMIN_TAB_IDS = ["overview", "hardening", "accounts", "rules", "skills", "plugins", "events"] as const;
export const ADMIN_DECISION_FILTER_IDS = ["all", "allow", "warn", "challenge", "block"] as const;

export type AdminTabId = (typeof ADMIN_TAB_IDS)[number];
export type AdminDecisionFilterId = (typeof ADMIN_DECISION_FILTER_IDS)[number];

export type AdminDashboardUrlState = {
  tab: AdminTabId;
  decisionFilter: AdminDecisionFilterId;
  decisionPage: number;
};

const ADMIN_TAB_ID_SET = new Set<string>(ADMIN_TAB_IDS);
const ADMIN_DECISION_FILTER_ID_SET = new Set<string>(ADMIN_DECISION_FILTER_IDS);

function readPositivePage(value: string | null | undefined): number {
  const page = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

export function normalizeAdminTabId(value: string | null | undefined): AdminTabId {
  return ADMIN_TAB_ID_SET.has(String(value || "")) ? (value as AdminTabId) : "overview";
}

export function normalizeAdminDecisionFilterId(value: string | null | undefined): AdminDecisionFilterId {
  return ADMIN_DECISION_FILTER_ID_SET.has(String(value || "")) ? (value as AdminDecisionFilterId) : "all";
}

export function matchesAdminDecisionFilter(
  decision: string | null | undefined,
  filter: AdminDecisionFilterId
): boolean {
  if (filter === "all") {
    return true;
  }
  return decision === filter;
}

export function readAdminDashboardUrlState(input: {
  search?: string;
  hash?: string;
} = {}): AdminDashboardUrlState {
  const searchParams = new URLSearchParams(input.search || "");
  const hashTab = (input.hash || "").replace(/^#/, "");
  return {
    tab: normalizeAdminTabId(searchParams.get("tab") || hashTab),
    decisionFilter: normalizeAdminDecisionFilterId(searchParams.get("decision")),
    decisionPage: readPositivePage(searchParams.get("page"))
  };
}

export function buildAdminDashboardSearch(input: {
  currentSearch?: string;
  tab: AdminTabId;
  decisionFilter: AdminDecisionFilterId;
  decisionPage: number;
}): string {
  const searchParams = new URLSearchParams(input.currentSearch || "");

  if (input.tab === "overview") {
    searchParams.delete("tab");
  } else {
    searchParams.set("tab", input.tab);
  }

  if (input.decisionFilter === "all") {
    searchParams.delete("decision");
  } else {
    searchParams.set("decision", input.decisionFilter);
  }

  if (input.tab !== "events" || input.decisionPage <= 1) {
    searchParams.delete("page");
  } else {
    searchParams.set("page", String(input.decisionPage));
  }

  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : "";
}
