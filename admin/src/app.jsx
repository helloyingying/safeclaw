import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const REFRESH_INTERVAL_MS = 15000;
const DECISIONS_PER_PAGE = 12;
const TAB_ITEMS = [
  {
    id: "overview",
    label: "概览"
  },
  {
    id: "events",
    label: "决策记录"
  },
  {
    id: "rules",
    label: "规则策略"
  }
];

const DECISION_TEXT = {
  allow: "放行",
  warn: "提醒",
  challenge: "需确认",
  block: "拦截"
};
const DECISION_OPTIONS = ["allow", "warn", "challenge", "block"];

const DECISION_SOURCE_TEXT = {
  rule: "规则命中",
  default: "默认放行",
  approval: "审批放行"
};

const CONTROL_DOMAIN_TEXT = {
  execution_control: "执行控制",
  data_access: "数据访问",
  data_egress: "数据外发",
  credential_protection: "凭据保护",
  change_control: "变更控制",
  approval_exception: "审批例外"
};

const SEVERITY_TEXT = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "严重"
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function decisionLabel(decision) {
  return DECISION_TEXT[decision] || String(decision || "-");
}

function decisionSourceLabel(source) {
  return DECISION_SOURCE_TEXT[source] || "-";
}

function resourceScopeLabel(scope) {
  if (!scope) return "-";
  if (scope === "workspace_inside") return "工作区内";
  if (scope === "workspace_outside") return "工作区外";
  if (scope === "system") return "系统目录";
  if (scope === "none") return "无路径";
  return scope;
}

function getJsonError(payload, fallback) {
  if (payload && typeof payload === "object" && payload.error) {
    return String(payload.error);
  }
  return fallback;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(getJsonError(payload, `请求失败: ${response.status}`));
  }
  return payload;
}

function extractPolicies(strategyPayload) {
  const list = strategyPayload?.strategy?.policies;
  return Array.isArray(list)
    ? clone(list).map((policy) => ({ ...policy, enabled: true }))
    : [];
}

function formatList(values) {
  return values.join(" | ");
}

function summarizeMatch(match) {
  const scopes = toArray(match?.scope);
  const tools = toArray(match?.tool);
  const toolGroups = toArray(match?.tool_group);
  const operations = toArray(match?.operation);
  const identities = toArray(match?.identity);
  const resourceScopes = toArray(match?.resource_scope);
  const fileTypes = toArray(match?.file_type);
  const assetLabels = toArray(match?.asset_labels);
  const dataLabels = toArray(match?.data_labels);
  const trustLevels = toArray(match?.trust_level);
  const destinationTypes = toArray(match?.destination_type);
  const destinationDomains = toArray(match?.dest_domain);
  const destinationIpClasses = toArray(match?.dest_ip_class);
  const pathMatchers = [
    ...toArray(match?.path_prefix),
    ...toArray(match?.path_glob),
    ...toArray(match?.path_regex)
  ];
  const argMatchers = [...toArray(match?.tool_args_summary), ...toArray(match?.tool_args_regex)];

  const parts = [];
  if (scopes.length) parts.push(`范围: ${formatList(scopes)}`);
  if (tools.length) parts.push(`工具: ${formatList(tools)}`);
  if (toolGroups.length) parts.push(`工具组: ${formatList(toolGroups)}`);
  if (operations.length) parts.push(`动作: ${formatList(operations)}`);
  if (identities.length) parts.push(`身份: ${formatList(identities)}`);
  if (resourceScopes.length) parts.push(`资源范围: ${formatList(resourceScopes.map(resourceScopeLabel))}`);
  if (fileTypes.length) parts.push(`文件类型: ${formatList(fileTypes)}`);
  if (assetLabels.length) parts.push(`资产标签: ${formatList(assetLabels)}`);
  if (dataLabels.length) parts.push(`数据标签: ${formatList(dataLabels)}`);
  if (trustLevels.length) parts.push(`信任级别: ${formatList(trustLevels)}`);
  if (destinationTypes.length) parts.push(`目的地类型: ${formatList(destinationTypes)}`);
  if (destinationDomains.length) parts.push(`目的地域名: ${formatList(destinationDomains)}`);
  if (destinationIpClasses.length) parts.push(`目标 IP: ${formatList(destinationIpClasses)}`);
  if (pathMatchers.length) parts.push(`路径条件: ${pathMatchers.length} 条`);
  if (argMatchers.length) parts.push(`参数特征: ${argMatchers.length} 条`);
  if (typeof match?.min_file_count === "number") parts.push(`文件数 >= ${match.min_file_count}`);
  if (typeof match?.min_bytes === "number") parts.push(`字节数 >= ${match.min_bytes}`);
  if (typeof match?.min_record_count === "number") parts.push(`记录数 >= ${match.min_record_count}`);
  return parts.join(" · ") || "无附加匹配条件";
}

function ruleDescription(policy) {
  if (policy?.description) {
    return policy.description;
  }
  const action = decisionLabel(policy?.decision);
  const match = summarizeMatch(policy?.match);
  return `命中条件时执行“${action}”。${match}。`;
}

function controlDomainLabel(domain) {
  if (!domain) return "未分类";
  return CONTROL_DOMAIN_TEXT[domain] || domain;
}

function severityLabel(severity) {
  return SEVERITY_TEXT[severity] || severity || "未分级";
}

function policyTitle(policy, index) {
  return policy?.title || policy?.rule_id || `规则 ${index + 1}`;
}

function approvalSummary(requirements) {
  if (!requirements) return "";
  const parts = [];
  if (requirements.ticket_required) parts.push("工单必填");
  if (toArray(requirements.approver_roles).length) parts.push(`审批角色: ${formatList(requirements.approver_roles)}`);
  if (requirements.single_use) parts.push("单次放行");
  if (requirements.trace_binding === "trace") parts.push("绑定当前 trace");
  if (typeof requirements.ttl_seconds === "number") parts.push(`有效期 ${requirements.ttl_seconds} 秒`);
  return parts.join(" · ");
}

function formatPercent(value, total) {
  if (!total) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function buildPageItems(currentPage, totalPages) {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, start + 4);
  const adjustedStart = Math.max(1, end - 4);
  return Array.from({ length: end - adjustedStart + 1 }, (_, index) => adjustedStart + index);
}

function DecisionTag({ decision }) {
  return <span className={`tag ${decision || "allow"}`}>{decisionLabel(decision)}</span>;
}

function App() {
  const [statusPayload, setStatusPayload] = useState(null);
  const [policies, setPolicies] = useState([]);
  const [publishedPolicies, setPublishedPolicies] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [decisionPage, setDecisionPage] = useState(1);

  const hasPendingChanges = useMemo(
    () => JSON.stringify(policies) !== JSON.stringify(publishedPolicies),
    [policies, publishedPolicies]
  );
  const groupedPolicies = useMemo(() => {
    const groups = new Map();
    policies.forEach((policy, index) => {
      const key = policy?.control_domain || policy?.group || "general";
      const list = groups.get(key) || [];
      list.push({ policy, index });
      groups.set(key, list);
    });
    return Array.from(groups.entries());
  }, [policies]);

  const loadData = useCallback(async (syncRules = true, silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    setError("");
    try {
      const [status, strategy] = await Promise.all([
        getJson("/api/status"),
        getJson("/api/strategy")
      ]);
      setStatusPayload(status);
      const nextPolicies = extractPolicies(strategy);
      setPublishedPolicies(nextPolicies);
      if (syncRules) {
        setPolicies(clone(nextPolicies));
      }
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData(true, false);
  }, [loadData]);

  useEffect(() => {
    if (hasPendingChanges || saving) {
      return undefined;
    }
    const timer = setInterval(() => {
      void loadData(true, true);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasPendingChanges, loadData, saving]);

  const totals = statusPayload?.totals || {};
  const decisions = toArray(statusPayload?.status?.recent_decisions);
  const latestDecision = decisions[0] || null;
  const totalDecisionPages = Math.max(1, Math.ceil(decisions.length / DECISIONS_PER_PAGE));
  const pagedDecisions = decisions.slice(
    (decisionPage - 1) * DECISIONS_PER_PAGE,
    decisionPage * DECISIONS_PER_PAGE
  );
  const pageItems = buildPageItems(decisionPage, totalDecisionPages);
  const firstDecisionIndex = decisions.length === 0 ? 0 : (decisionPage - 1) * DECISIONS_PER_PAGE + 1;
  const lastDecisionIndex = Math.min(decisionPage * DECISIONS_PER_PAGE, decisions.length);

  const stats = {
    total: Number(totals.total || 0),
    allow: Number(totals.allow || 0),
    watch: Number(totals.warn || 0) + Number(totals.challenge || 0),
    block: Number(totals.block || 0)
  };

  const savePolicies = useCallback(async (nextPolicies) => {
    const normalizedPolicies = nextPolicies.map((policy) => ({ ...policy, enabled: true }));
    setSaving(true);
    setError("");
    setMessage("规则自动保存中...");
    try {
      const response = await fetch("/api/strategy", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          policies: normalizedPolicies
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, "保存失败"));
      }
      const suffix = payload.restart_required ? " 需要重启 gateway 后完整生效。" : "";
      setMessage(`规则已自动保存。${payload.message || ""}${suffix}`.trim());
      setPublishedPolicies(clone(normalizedPolicies));
      await loadData(false, true);
    } catch (saveError) {
      setError(String(saveError));
      setMessage("");
    } finally {
      setSaving(false);
    }
  }, [loadData]);

  useEffect(() => {
    if (loading || saving || !hasPendingChanges) {
      return undefined;
    }
    setMessage("检测到规则变更，正在自动保存...");
    const timer = setTimeout(() => {
      void savePolicies(policies);
    }, 500);
    return () => clearTimeout(timer);
  }, [hasPendingChanges, loading, policies, savePolicies, saving]);

  useEffect(() => {
    setDecisionPage((current) => Math.min(current, totalDecisionPages));
  }, [totalDecisionPages]);

  function onDecisionChange(index, decision) {
    setPolicies((current) => {
      const next = clone(current);
      next[index].decision = decision;
      next[index].enabled = true;
      return next;
    });
  }

  const tabCounts = {
    overview: stats.total,
    events: decisions.length,
    rules: policies.length
  };
  const postureTitle = stats.block > 0
    ? "防护规则正在主动拦截风险操作"
    : stats.watch > 0
      ? "当前以提醒和确认为主的审慎策略"
      : "当前以放行为主，运行相对平稳";
  const postureDescription = latestDecision
    ? `${decisionLabel(latestDecision.decision)} · ${latestDecision.tool || "未知操作"} · ${resourceScopeLabel(latestDecision.resource_scope)}`
    : "等待新的运行数据进入控制台。";
  const statusTone = error ? "error" : hasPendingChanges || saving ? "warn" : "good";
  const statusMessage = error || message || (hasPendingChanges ? "检测到规则变更，正在自动保存..." : "");
  const shouldShowStatus = Boolean(statusMessage);

  return (
    <div className="app">
      <section className="workspace card">
        <div className="workspace-top">
          <div className="workspace-title">
            <div className="workspace-kicker">SafeClaw Admin</div>
            <h1>管理后台</h1>
          </div>
        </div>

        <div className="workspace-nav">
          <div className="tablist" role="tablist" aria-label="后台模块页签">
            {TAB_ITEMS.map((tab) => (
              <button
                key={tab.id}
                id={`tab-${tab.id}`}
                className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`panel-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="tab-label">{tab.label}</span>
                <span className="tab-count">{tabCounts[tab.id]}</span>
              </button>
            ))}
          </div>

          {shouldShowStatus ? (
            <div className={`status-inline ${statusTone}`}>
              <span className="status-dot" />
              <span>{statusMessage}</span>
            </div>
          ) : null}
        </div>

        {activeTab === "overview" ? (
          <section
            id="panel-overview"
            className="tab-panel overview-panel"
            role="tabpanel"
            aria-labelledby="tab-overview"
          >
            <div className="card-head">
              <h2>概览</h2>
            </div>
            <div className="overview-grid">
              <div className="panel-card">
                <div className="stats">
                  <div className="stat">
                    <b>总请求</b>
                    <span>{stats.total}</span>
                  </div>
                  <div className="stat good">
                    <b>放行</b>
                    <span>{stats.allow}</span>
                  </div>
                  <div className="stat warn">
                    <b>提醒 / 确认</b>
                    <span>{stats.watch}</span>
                  </div>
                  <div className="stat bad">
                    <b>拦截</b>
                    <span>{stats.block}</span>
                  </div>
                </div>
              </div>

              <aside className="panel-card insight-card">
                <div className="insight-head">
                  <span className="eyebrow">当前态势</span>
                  <h3>{postureTitle}</h3>
                  <p>{postureDescription}</p>
                </div>
                <div className="insight-list">
                  <div className="insight-item">
                    <span>提醒 / 确认占比</span>
                    <strong>{formatPercent(stats.watch, stats.total)}</strong>
                  </div>
                  <div className="insight-item">
                    <span>拦截占比</span>
                    <strong>{formatPercent(stats.block, stats.total)}</strong>
                  </div>
                  <div className="insight-item">
                    <span>规则分组</span>
                    <strong>{groupedPolicies.length}</strong>
                  </div>
                  <div className="insight-item">
                    <span>生效规则</span>
                    <strong>{policies.length}</strong>
                  </div>
                </div>
                <div className="latest-event">
                  <div className="latest-event-head">
                    <span>最新决策</span>
                    {latestDecision ? <DecisionTag decision={latestDecision.decision} /> : null}
                  </div>
                  <p>{latestDecision ? toArray(latestDecision.reasons).join("，") || "无附加原因" : "暂无决策记录"}</p>
                </div>
              </aside>
            </div>
          </section>
        ) : null}

        {activeTab === "events" ? (
          <section
            id="panel-events"
            className="tab-panel"
            role="tabpanel"
            aria-labelledby="tab-events"
          >
            <div className="panel-card">
              <div className="card-head card-head-compact">
                <h2>决策记录</h2>
                <div className="header-actions">
                  <button
                    className="ghost small"
                    type="button"
                    onClick={() => void loadData(!hasPendingChanges && !saving, false)}
                  >
                    刷新
                  </button>
                </div>
              </div>
                <div className="table-wrap">
                  <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>决策</th>
                      <th>来源</th>
                      <th>资源范围</th>
                      <th>环节</th>
                      <th>操作</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {decisions.length === 0 ? (
                      <tr>
                        <td colSpan={7}>{loading ? "加载中..." : "暂无决策记录"}</td>
                      </tr>
                    ) : (
                      pagedDecisions.map((item, index) => (
                        <tr key={`${item.trace_id || "trace"}-${firstDecisionIndex + index}`}>
                          <td>{formatTime(item.ts)}</td>
                          <td>
                            <DecisionTag decision={item.decision} />
                          </td>
                          <td>{decisionSourceLabel(item.decision_source)}</td>
                          <td>{resourceScopeLabel(item.resource_scope)}</td>
                          <td>{item.hook || "-"}</td>
                          <td>{item.tool || "-"}</td>
                          <td>{toArray(item.reasons).join("，") || "-"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {decisions.length > 0 ? (
                <div className="pagination">
                  <div className="pagination-summary">
                    显示 {firstDecisionIndex}-{lastDecisionIndex} / {decisions.length} · 第 {decisionPage} / {totalDecisionPages} 页
                  </div>
                  <div className="pagination-controls">
                    <button
                      className="ghost small"
                      type="button"
                      disabled={decisionPage === 1}
                      onClick={() => setDecisionPage((current) => Math.max(1, current - 1))}
                    >
                      上一页
                    </button>
                    {pageItems.map((page) => (
                      <button
                        key={page}
                        className={`page-button ${page === decisionPage ? "active" : ""}`}
                        type="button"
                        aria-current={page === decisionPage ? "page" : undefined}
                        onClick={() => setDecisionPage(page)}
                      >
                        {page}
                      </button>
                    ))}
                    <button
                      className="ghost small"
                      type="button"
                      disabled={decisionPage === totalDecisionPages}
                      onClick={() => setDecisionPage((current) => Math.min(totalDecisionPages, current + 1))}
                    >
                      下一页
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeTab === "rules" ? (
          <section
            id="panel-rules"
            className="tab-panel"
            role="tabpanel"
            aria-labelledby="tab-rules"
          >
            <div className="panel-card">
              <div className="card-head">
                <h2>规则策略</h2>
                <div className="rule-meta">
                  <span className="meta-pill">分组 {groupedPolicies.length}</span>
                  <span className="meta-pill">规则 {policies.length}</span>
                </div>
              </div>

              <div className="rules">
                {policies.length === 0 ? (
                  <div className="rule">暂无规则</div>
                ) : (
                  groupedPolicies.map(([group, entries]) => (
                    <section key={group} className="rule-group">
                      <h4 className="rule-group-title">{controlDomainLabel(group)}</h4>
                      {entries.map(({ policy, index }) => (
                        <article key={policy.rule_id || String(index)} className="rule">
                          <div className="rule-head">
                            <div className="rule-title">{policyTitle(policy, index)}</div>
                            <DecisionTag decision={policy.decision} />
                          </div>
                          <div className="rule-row rule-meta-row">
                            <span className="meta-pill">{controlDomainLabel(policy.control_domain || policy.group)}</span>
                            {policy.severity ? <span className={`meta-pill severity-${policy.severity}`}>{severityLabel(policy.severity)}</span> : null}
                            {policy.owner ? <span className="meta-pill">{policy.owner}</span> : null}
                            {policy.playbook_url ? (
                              <a className="meta-pill link-pill" href={policy.playbook_url} target="_blank" rel="noreferrer">
                                Playbook
                              </a>
                            ) : null}
                          </div>
                          <div className="rule-actions" role="group" aria-label={`规则 ${policy.rule_id || index + 1} 的策略动作`}>
                            {DECISION_OPTIONS.map((decision) => (
                              <button
                                key={decision}
                                className={`rule-action-button ${decision} ${policy.decision === decision ? "active" : ""}`}
                                type="button"
                                aria-pressed={policy.decision === decision}
                                onClick={() => onDecisionChange(index, decision)}
                              >
                                {decisionLabel(decision)}
                              </button>
                            ))}
                          </div>
                          <div className="rule-desc">{ruleDescription(policy)}</div>
                          <div className="rule-desc rule-match">{summarizeMatch(policy.match)}</div>
                          {policy.approval_requirements ? (
                            <div className="rule-desc rule-approval">{approvalSummary(policy.approval_requirements)}</div>
                          ) : null}
                        </article>
                      ))}
                    </section>
                  ))
                )}
              </div>
            </div>
          </section>
        ) : null}
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
