import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAdminDashboardSearch,
  matchesAdminDecisionFilter,
  readAdminDashboardUrlState,
} from "../src/admin/dashboard_url_state.ts";

test("dashboard url state reads tab from query and falls back to hash", () => {
  assert.deepEqual(
    readAdminDashboardUrlState({
      search: "?tab=hardening&decision=block&page=3",
      hash: "#rules",
    }),
    {
      tab: "hardening",
      decisionFilter: "block",
      decisionPage: 3,
    },
  );

  assert.deepEqual(
    readAdminDashboardUrlState({
      search: "?decision=challenge",
      hash: "#events",
    }),
    {
      tab: "events",
      decisionFilter: "challenge",
      decisionPage: 1,
    },
  );

  assert.deepEqual(
    readAdminDashboardUrlState({
      search: "?tab=accounts",
    }),
    {
      tab: "overview",
      decisionFilter: "all",
      decisionPage: 1,
    },
  );
});

test("dashboard search builder keeps unrelated params and drops default view state", () => {
  assert.equal(
    buildAdminDashboardSearch({
      currentSearch: "?theme=dark&locale=zh-CN",
      tab: "overview",
      decisionFilter: "all",
      decisionPage: 1,
    }),
    "?theme=dark&locale=zh-CN",
  );

  assert.equal(
    buildAdminDashboardSearch({
      currentSearch: "?theme=dark&locale=zh-CN",
      tab: "hardening",
      decisionFilter: "challenge",
      decisionPage: 2,
    }),
    "?theme=dark&locale=zh-CN&tab=hardening&decision=challenge",
  );

  assert.equal(
    buildAdminDashboardSearch({
      currentSearch: "?theme=dark&locale=zh-CN&tab=hardening&decision=challenge",
      tab: "skills",
      decisionFilter: "challenge",
      decisionPage: 2,
    }),
    "?theme=dark&locale=zh-CN&tab=skills&decision=challenge",
  );
});

test("dashboard decision filter matcher supports exact decision state", () => {
  assert.equal(matchesAdminDecisionFilter("allow", "all"), true);
  assert.equal(matchesAdminDecisionFilter("warn", "warn"), true);
  assert.equal(matchesAdminDecisionFilter("challenge", "challenge"), true);
  assert.equal(matchesAdminDecisionFilter("block", "challenge"), false);
  assert.equal(matchesAdminDecisionFilter("block", "block"), true);
});
