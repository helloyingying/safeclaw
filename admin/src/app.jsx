import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const REFRESH_INTERVAL_MS = 15000;
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

const RULE_TITLE = {
  "shell-block": "阻止高风险命令",
  "contractor-network-challenge": "外包账号访问外网需确认",
  "filesystem-list-challenge": "目录枚举需确认",
  "finance-write-warn": "财务范围写入操作提醒"
};

const RULE_GROUP_TITLE = {
  file: "文件相关",
  filesystem: "文件相关",
  email: "邮件相关",
  album: "相册相关",
  general: "通用规则"
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

function summarizeMatch(match) {
  const scopes = toArray(match?.scope);
  const tools = toArray(match?.tool);
  const identities = toArray(match?.identity);

  const parts = [];
  parts.push(`范围: ${scopes.length ? scopes.join(" | ") : "全部"}`);
  parts.push(`操作: ${tools.length ? tools.join(" | ") : "全部"}`);
  if (identities.length) {
    parts.push(`用户: ${identities.join(" | ")}`);
  }
  return parts.join(" · ");
}

function ruleDescription(policy) {
  const action = decisionLabel(policy?.decision);
  const match = summarizeMatch(policy?.match);
  return `命中条件时执行“${action}”。${match}。`;
}

function groupLabel(group) {
  if (!group) return "通用规则";
  return RULE_GROUP_TITLE[group] || group;
}

function formatPercent(value, total) {
  if (!total) return "0%";
  return `${Math.round((value / total) * 100)}%`;
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

  const hasPendingChanges = useMemo(
    () => JSON.stringify(policies) !== JSON.stringify(publishedPolicies),
    [policies, publishedPolicies]
  );
  const groupedPolicies = useMemo(() => {
    const groups = new Map();
    policies.forEach((policy, index) => {
      const key = policy?.group || "general";
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
              <div className="card-head">
                <h2>决策记录</h2>
                <div className="header-actions">
                  <button
                    className="ghost"
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
                      decisions.map((item, index) => (
                        <tr key={`${item.trace_id || "trace"}-${index}`}>
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
                      <h4 className="rule-group-title">{groupLabel(group)}</h4>
                      {entries.map(({ policy, index }) => (
                        <article key={policy.rule_id || String(index)} className="rule">
                          <div className="rule-head">
                            <div className="rule-title">{RULE_TITLE[policy.rule_id] || policy.rule_id || `规则 ${index + 1}`}</div>
                            <DecisionTag decision={policy.decision} />
                          </div>
                          <div className="rule-row">
                            <label className="rule-label" htmlFor={`decision-${index}`}>策略动作</label>
                            <select
                              id={`decision-${index}`}
                              className="rule-select"
                              value={policy.decision || "allow"}
                              onChange={(event) => onDecisionChange(index, event.target.value)}
                            >
                              {DECISION_OPTIONS.map((decision) => (
                                <option key={decision} value={decision}>
                                  {decisionLabel(decision)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="rule-desc">{ruleDescription(policy)}</div>
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
