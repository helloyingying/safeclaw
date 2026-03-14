import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const REFRESH_INTERVAL_MS = 15000;

const DECISION_TEXT = {
  allow: "放行",
  warn: "提醒",
  challenge: "需确认",
  block: "拦截"
};

const RULE_TITLE = {
  "prod-shell-block": "阻止生产环境高风险命令",
  "contractor-network-challenge": "外包账号访问外网需确认",
  "prod-filesystem-list-challenge": "生产目录枚举需确认",
  "finance-write-warn": "财务范围写入操作提醒"
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
  return Array.isArray(list) ? clone(list) : [];
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
  const [lastRefreshAt, setLastRefreshAt] = useState("");

  const hasPendingChanges = useMemo(
    () => JSON.stringify(policies) !== JSON.stringify(publishedPolicies),
    [policies, publishedPolicies]
  );

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
      setLastRefreshAt(new Date().toISOString());
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

  const stats = {
    total: Number(totals.total || 0),
    allow: Number(totals.allow || 0),
    watch: Number(totals.warn || 0) + Number(totals.challenge || 0),
    block: Number(totals.block || 0)
  };

  const savePolicies = useCallback(async (nextPolicies) => {
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
          policies: nextPolicies
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(getJsonError(payload, "保存失败"));
      }
      const suffix = payload.restart_required ? " 需要重启 gateway 后完整生效。" : "";
      setMessage(`规则已自动保存。${payload.message || ""}${suffix}`.trim());
      setPublishedPolicies(clone(nextPolicies));
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

  function onToggle(index, checked) {
    setPolicies((current) => {
      const next = clone(current);
      next[index].enabled = checked;
      return next;
    });
  }

  function onSetAll(enabled) {
    setPolicies((current) => current.map((rule) => ({ ...rule, enabled })));
  }

  return (
    <div className="app">
      <section className="header">
        <div className="title">
          <h1>SafeClaw 安全控制台</h1>
        </div>
        <div className="header-actions">
          <div className="status-note">最近刷新: {formatTime(lastRefreshAt)}</div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>1. 数据看板</h2>
            <p>按实际决策结果统计，不展示风险分和阈值。</p>
          </div>
        </div>
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
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>2. 决策记录</h2>
            <p>展示最近安全决策，帮助回看发生了什么。</p>
          </div>
          <div className="header-actions">
            <button className="ghost" type="button" onClick={() => void loadData(!hasPendingChanges && !saving, false)}>
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
                <th>环节</th>
                <th>操作</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {decisions.length === 0 ? (
                <tr>
                  <td colSpan={5}>{loading ? "加载中..." : "暂无决策记录"}</td>
                </tr>
              ) : (
                decisions.map((item, index) => (
                  <tr key={`${item.trace_id || "trace"}-${index}`}>
                    <td>{formatTime(item.ts)}</td>
                    <td>
                      <DecisionTag decision={item.decision} />
                    </td>
                    <td>{item.hook || "-"}</td>
                    <td>{item.tool || "-"}</td>
                    <td>{toArray(item.reasons).join("，") || "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>3. 规则列表</h2>
            <p>只保留规则开关和通俗描述，不展示优先级、风险分等内部细节。</p>
          </div>
          <div className="header-actions">
            <button className="ghost" type="button" onClick={() => onSetAll(true)}>
              全部开启
            </button>
            <button className="ghost" type="button" onClick={() => onSetAll(false)}>
              全部关闭
            </button>
          </div>
        </div>

        <div className="rules">
          {policies.length === 0 ? (
            <div className="rule">暂无规则</div>
          ) : (
            policies.map((policy, index) => (
              <article key={policy.rule_id || String(index)} className="rule">
                <div className="rule-head">
                  <div className="rule-title">{RULE_TITLE[policy.rule_id] || policy.rule_id || `规则 ${index + 1}`}</div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={policy.enabled !== false}
                      onChange={(event) => onToggle(index, event.target.checked)}
                    />
                    <span className="slider" />
                  </label>
                </div>
                <div>
                  <span className="rule-chip">状态: {policy.enabled === false ? "已关闭" : "已开启"}</span>
                  <span className="rule-chip">动作: {decisionLabel(policy.decision)}</span>
                </div>
                <div className="rule-desc">{ruleDescription(policy)}</div>
              </article>
            ))
          )}
        </div>
      </section>

      <div className={`msg ${error ? "error" : ""}`}>
        {error || message || (hasPendingChanges ? "检测到规则变更，正在自动保存..." : "")}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
