import { useEffect, useMemo, useState } from "react";

import type {
  ClawGuardFinding,
  ClawGuardFindingGroup,
  ClawGuardPreviewPayload,
  ClawGuardStatusPayload,
} from "../../src/admin/claw_guard_types.ts";
import { getActiveAdminLocale, readLocalized, SEVERITY_TEXT, ui } from "./dashboard_core.ts";
import { OverviewStatCard } from "./dashboard_primitives.tsx";

type HardeningDisplayGroup = {
  id: string;
  kind: ClawGuardFindingGroup["kind"];
  title: string;
  subtitle: string;
  summary: string;
  relationHint: string;
  findings: ClawGuardFinding[];
  severity: ClawGuardFinding["severity"];
  exemptedCount: number;
};

type HardeningPanelProps = {
  loading: boolean;
  status: ClawGuardStatusPayload | null;
  selectedFinding: ClawGuardFinding | null;
  selectedFindingId: string;
  preview: ClawGuardPreviewPayload | null;
  previewLoading: boolean;
  applyLoading: boolean;
  actionLoading: boolean;
  onRefresh: () => void | Promise<void>;
  onOpenFinding: (findingId: string, options?: Record<string, unknown>) => void;
  onClosePreview: () => void;
  onSelectRepairChoice: (findingId: string, choiceId: string) => void;
  onApplyPreview: () => void | Promise<void>;
  onExemptFindings: (findingIds: string[]) => void;
  onRestoreFinding: (findingId: string) => void;
  formatTime: (value: string | null | undefined) => string;
};

function severityLabel(value: string | null | undefined): string {
  return readLocalized(SEVERITY_TEXT, value, value || "-");
}

function configSourceLabel(value: string | null | undefined): string {
  if (value === "gateway-rpc") {
    return ui("运行时配置接口", "Runtime config RPC");
  }
  if (value === "local-file") {
    return ui("本地配置文件", "Local config file");
  }
  return ui("未知来源", "Unknown source");
}

function isMeaningfulText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() !== "-";
}

function pickText(fallback: string, ...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (isMeaningfulText(value)) {
      return value.trim();
    }
  }
  return fallback;
}

function pickStringList(...values: Array<readonly string[] | string[] | null | undefined>): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    const items = value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

function hardeningSeverityRank(severity: ClawGuardFinding["severity"]): number {
  if (severity === "critical") return 0;
  if (severity === "high") return 1;
  if (severity === "medium") return 2;
  return 3;
}

function compareHardeningFindings(left: ClawGuardFinding, right: ClawGuardFinding): number {
  const severityDelta = hardeningSeverityRank(left.severity) - hardeningSeverityRank(right.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  return left.title.localeCompare(right.title, getActiveAdminLocale() === "zh-CN" ? "zh-CN" : "en-US");
}

function inferHardeningGroupKind(finding: ClawGuardFinding): ClawGuardFindingGroup["kind"] {
  if (finding.groupId === "gateway" || finding.ruleId.startsWith("gateway_")) {
    return "gateway";
  }
  if (finding.groupId === "sandbox" || finding.ruleId.startsWith("sandbox_") || finding.ruleId.startsWith("browser_")) {
    return "sandbox";
  }
  return "channel";
}

function inferHardeningScopeId(groupId: string, finding?: ClawGuardFinding | null): string {
  if (typeof finding?.scopeId === "string" && finding.scopeId.trim().length > 0) {
    return finding.scopeId.trim();
  }
  const parts = groupId.split("::");
  return parts.length > 1 ? parts.slice(1).join("::") : "";
}

function hardeningRelationHint(finding: ClawGuardFinding, siblingCount: number): string {
  const relations = finding.relations;
  const relatedTargets = relations.filter((relation) => relation.type === "related").length;
  const resolvingChoices = relations.filter((relation) => relation.type === "choice_resolves").length;
  if (resolvingChoices > 0) {
    return ui(
      "这个风险点和别的项有联动，点开详情能看到对应的修复选项。",
      "This finding is linked with other items. Open the drawer to see the matching repair choices.",
    );
  }
  if (relatedTargets > 0) {
    return ui(
      "这个风险点和同组或相邻配置项有关，通常需要一起改。",
      "This finding is related to other items in the same or nearby scope, and they usually change together.",
    );
  }
  if (siblingCount > 0) {
    return ui(
      "这项和同组的其他风险点共享同一个配置范围。",
      "This item shares the same configuration scope with the rest of its group.",
    );
  }
  return ui("这是单项检查。", "This is a single-item check.");
}

function hardeningGroupTitle(kind: ClawGuardFindingGroup["kind"], scopeId: string): string {
  if (kind === "gateway") {
    return ui("gateway 配置", "Gateway settings");
  }
  if (kind === "sandbox") {
    return ui("沙箱配置", "Sandbox settings");
  }
  return `${ui("渠道", "Channel")} · ${scopeId || ui("未命名", "Unnamed")}`;
}

function hardeningGroupSubtitle(kind: ClawGuardFindingGroup["kind"], scopeId: string, count: number): string {
  const base =
    kind === "gateway"
      ? ui("gateway 入口和鉴权", "Gateway entry and auth")
      : kind === "channel"
        ? `${ui("同一渠道", "Same channel")} · ${scopeId || ui("未命名", "Unnamed")}`
        : ui("执行沙箱", "Execution sandbox");
  return count > 1 ? ui(`${base}，共 ${count} 项`, `${base}, ${count} findings`) : base;
}

function defaultHardeningGroupSummary(kind: ClawGuardFindingGroup["kind"]): string {
  if (kind === "gateway") {
    return ui(
      "这组项都在 gateway 入口层，通常会一起检查。",
      "These items all sit at the gateway entry layer and are usually checked together.",
    );
  }
  if (kind === "channel") {
    return ui(
      "同一渠道里的私信、群入口和群内限制会互相影响。",
      "DM access, group access, and in-group limits on the same channel affect each other.",
    );
  }
  return ui(
    "这组项一起决定执行是否被关进沙箱。",
    "These items together decide how tightly execution is sandboxed.",
  );
}

function hardeningGroupSummary(
  kind: ClawGuardFindingGroup["kind"],
  activeCount: number,
  exemptedCount: number,
  baseSummary?: string,
): string {
  const base = pickText(defaultHardeningGroupSummary(kind), baseSummary);
  const activeSuffix = activeCount > 1 ? ui(`当前有 ${activeCount} 个未豁免风险点。`, `${activeCount} active findings.`) : "";
  const exemptedSuffix = exemptedCount > 0 ? ui(`其中 ${exemptedCount} 项已豁免。`, `${exemptedCount} are exempted.`) : "";
  return [base, activeSuffix, exemptedSuffix].filter(Boolean).join(" ");
}

function buildFallbackGroup(finding: ClawGuardFinding): HardeningDisplayGroup {
  const kind = inferHardeningGroupKind(finding);
  const scopeId = inferHardeningScopeId(finding.groupId, finding);
  return {
    id: finding.groupId,
    kind,
    title: hardeningGroupTitle(kind, scopeId),
    subtitle: hardeningGroupSubtitle(kind, scopeId, 1),
    summary: hardeningGroupSummary(kind, 1, 0),
    relationHint: hardeningRelationHint(finding, 0),
    findings: [finding],
    severity: finding.severity,
    exemptedCount: 0,
  };
}

function buildDisplayGroups(status: ClawGuardStatusPayload | null): HardeningDisplayGroup[] {
  const findings = Array.isArray(status?.findings) ? status.findings : [];
  const exemptedFindings = Array.isArray(status?.exempted) ? status.exempted : [];
  const activeFindingById = new Map(findings.map((finding) => [finding.id, finding] as const));
  const groups: HardeningDisplayGroup[] = [];
  const coveredFindingIds = new Set<string>();

  for (const group of Array.isArray(status?.groups) ? status.groups : []) {
    const groupFindings = group.childFindingIds
      .map((findingId) => activeFindingById.get(findingId))
      .filter((finding): finding is ClawGuardFinding => Boolean(finding))
      .sort(compareHardeningFindings);
    if (groupFindings.length === 0) {
      continue;
    }
    groupFindings.forEach((finding) => coveredFindingIds.add(finding.id));
    const leadFinding = groupFindings.find((finding) => finding.id === group.recommendedFindingId) || groupFindings[0];
    const scopeId = inferHardeningScopeId(group.id, leadFinding);
    const exemptedCount = exemptedFindings.filter((finding) => finding.groupId === group.id).length;
    groups.push({
      id: group.id,
      kind: group.kind,
      title: pickText(hardeningGroupTitle(group.kind, scopeId), group.title),
      subtitle: hardeningGroupSubtitle(group.kind, scopeId, groupFindings.length),
      summary: hardeningGroupSummary(group.kind, groupFindings.length, exemptedCount, group.summary),
      relationHint: hardeningRelationHint(leadFinding, Math.max(0, groupFindings.length - 1)),
      findings: groupFindings,
      severity: group.severity,
      exemptedCount,
    });
  }

  for (const finding of findings) {
    if (!coveredFindingIds.has(finding.id)) {
      groups.push(buildFallbackGroup(finding));
    }
  }

  return groups.sort((left, right) => (
    hardeningSeverityRank(left.severity) - hardeningSeverityRank(right.severity)
      || left.title.localeCompare(right.title, getActiveAdminLocale() === "zh-CN" ? "zh-CN" : "en-US")
  ));
}

function renderFindingPaths(configPaths: string[]): React.ReactNode {
  if (configPaths.length === 0) {
    return <span>{ui("当前没有可展示的配置路径。", "No config paths are available for this item.")}</span>;
  }
  return configPaths.map((configPath) => (
    <span key={configPath} className="tag meta-tag">
      {configPath}
    </span>
  ));
}

type ReadOnlyCause = {
  title: string;
  detail: string;
  raw: string;
};

function normalizeReasonText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function resolveReadOnlyCause(status: ClawGuardStatusPayload | null): ReadOnlyCause {
  const raw = normalizeReasonText(pickText("", status?.write_reason, status?.error));
  if (!raw) {
    if (status?.config_source === "local-file" && status?.gateway_online === false) {
      return {
        title: ui("当前读到的是本地回退结果，不是已确认的权限错误", "This is a local fallback result, not a confirmed permission error"),
        detail: ui(
          "这次扫描是从本地配置文件生成的，说明页面没有拿到 gateway 返回的可写配置。更像是 gateway RPC 不可用、返回超时，或者运行中的页面状态还没更新；仅凭这次返回，不能直接判定成文件权限问题。",
          "This scan was built from the local config file, which means the page did not get a writable config from the gateway. This points more to an unavailable or slow gateway RPC, or stale page state. It is not enough to conclude that this is a file-permission problem.",
        ),
        raw: "",
      };
    }

    if (status?.config_source === "gateway-rpc" && status?.read_only) {
      return {
        title: ui("gateway 返回了只读状态，但没有附带具体报错", "The gateway returned a read-only state without a detailed error"),
        detail: ui(
          "当前页面已经连上了 gateway，但这次返回里没有附带写回失败的原始原因。按现有字段看，这更像 gateway 没给出可写校验信息，或者页面还停留在旧状态，不像是已确认的文件权限错误。",
          "The page is connected to the gateway, but this response did not include the raw writeback failure. Based on the fields that did return, this looks more like missing writeback validation from the gateway or stale page state, not a confirmed file-permission error.",
        ),
        raw: "",
      };
    }

    return {
      title: ui("当前没有拿到更具体的只读原因", "No detailed read-only cause was returned"),
      detail: ui(
        "这次扫描没有返回可写失败的具体信息，所以当前只能按风险详情手动处理。",
        "This scan did not return a detailed writeback failure, so use the finding details to repair the config manually.",
      ),
      raw: "",
    };
  }

  if (/eacces|eperm|permission denied/i.test(raw)) {
    return {
      title: ui("当前进程没有配置读写权限", "The current process does not have config permissions"),
      detail: ui(
        "读取或写入当前生效配置时遇到了权限错误，所以页面只能保留只读分析。",
        "A permission error occurred while reading or writing the active config, so the page stays in read-only analysis mode.",
      ),
      raw,
    };
  }

  if (/enoent|no such file/i.test(raw)) {
    return {
      title: ui("当前配置文件路径不可用", "The active config path is unavailable"),
      detail: ui(
        "当前生效配置文件不存在，或者 OpenClaw 指向的配置路径不可读。",
        "The active config file does not exist, or the config path used by OpenClaw is unreadable.",
      ),
      raw,
    };
  }

  if (/config hash is unavailable/i.test(raw)) {
    return {
      title: ui("gateway 没有返回可写 hash", "The gateway did not return a writable hash"),
      detail: ui(
        "gateway 返回了配置内容，但没有返回 patch 写回需要的 base hash，所以页面不能安全写回。",
        "The gateway returned config content, but it did not return the base hash required for patch writes, so the page cannot write back safely.",
      ),
      raw,
    };
  }

  if (/gateway rpc is unavailable|gateway timeout|refused|unreachable|unauthorized|rpc/i.test(raw)) {
    return {
      title: ui("当前没有连上可写的 gateway RPC", "A writable gateway RPC connection is unavailable"),
      detail: ui(
        "这次系统页读到的是本地配置快照，不是 gateway 返回的可写配置，所以现在只能查看，不能直接写回。",
        "This system scan is using a local config snapshot instead of a writable config returned by the gateway, so it can only inspect and cannot write back.",
      ),
      raw,
    };
  }

  return {
    title: ui("当前写回条件不满足", "Writeback prerequisites are not met"),
    detail: ui(
      "OpenClaw 返回了一个阻止自动写回的具体原因，见下方原始返回。",
      "OpenClaw returned a specific reason that blocks automatic writeback. See the raw response below.",
    ),
    raw,
  };
}

function LoadingSpinner() {
  return <span className="hardening-loading-spinner" aria-hidden="true" />;
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v5" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}

export function HardeningPanel({
  loading,
  status,
  selectedFinding,
  selectedFindingId,
  preview,
  previewLoading,
  applyLoading,
  actionLoading,
  onRefresh,
  onOpenFinding,
  onClosePreview,
  onSelectRepairChoice,
  onApplyPreview,
  onExemptFindings,
  onRestoreFinding,
  formatTime,
}: HardeningPanelProps) {
  const [readOnlyInfoOpen, setReadOnlyInfoOpen] = useState(false);
  const findingGroups = useMemo(() => buildDisplayGroups(status), [status]);
  const exemptedFindings = useMemo(
    () => (Array.isArray(status?.exempted) ? status.exempted : []),
    [status],
  );
  const groupById = useMemo(() => new Map(findingGroups.map((group) => [group.id, group] as const)), [findingGroups]);
  const findingById = useMemo(() => {
    const table = new Map<string, ClawGuardFinding>();
    findingGroups.forEach((group) => {
      group.findings.forEach((finding) => {
        table.set(finding.id, finding);
      });
    });
    exemptedFindings.forEach((finding) => {
      table.set(finding.id, finding);
    });
    return table;
  }, [exemptedFindings, findingGroups]);
  const passed = Array.isArray(status?.passed) ? status.passed : [];
  const drawerVisible = Boolean(selectedFindingId);
  const metricValue = (value: number | undefined): string | number => (status ? value ?? 0 : "...");
  const selectedChoiceId =
    preview?.selected_choice_id
    || (typeof selectedFinding?.defaultOptions?.choice === "string" ? selectedFinding.defaultOptions.choice : "");
  const repairChoices =
    Array.isArray(preview?.repair_choices) && preview.repair_choices.length > 0
      ? preview.repair_choices
      : Array.isArray(selectedFinding?.repairChoices)
        ? selectedFinding.repairChoices
        : [];
  const currentValue = pickText("-", preview?.current_value, selectedFinding?.currentSummary);
  const recommendedValue = pickText("-", preview?.recommended_value, selectedFinding?.recommendationSummary);
  const restartRequired = preview?.restart_required ?? selectedFinding?.restartRequired ?? false;
  const impact = pickText(
    restartRequired
      ? ui("修改完成后需要重启 gateway，再重新扫描确认结果。", "Restart the gateway after editing, then rescan to confirm the result.")
      : ui("修改完成后请重新扫描确认结果。", "Rescan after editing to confirm the result."),
    preview?.impact,
  );
  const configPaths = pickStringList(preview?.config_paths, selectedFinding?.configPaths);
  const patchPreview = pickText("", preview?.patch_preview);
  const applyDisabledReason = pickText(
    "",
    preview?.apply_disabled_reason,
    status?.read_only ? ui("当前是只读模式，不能直接写回 OpenClaw 配置。", "This page is read-only and cannot write back to OpenClaw config.") : undefined,
  );
  const selectedChoice = repairChoices.find((choice) => choice.id === selectedChoiceId)
    || repairChoices.find((choice) => choice.recommended)
    || repairChoices[0]
    || null;
  const drawerTitle = pickText(
    ui("系统项", "System Finding"),
    selectedFinding?.title,
    preview?.title,
  );
  const drawerSummary = pickText(
    ui("当前没有可用的风险说明。", "No risk summary is available."),
    selectedFinding?.summary,
    preview?.summary,
  );
  const relatedResolutionHints: Array<{
    relation: ClawGuardFinding["relations"][number];
    target: ClawGuardFinding;
    choiceLabel: string;
  }> = (selectedFinding?.relations || [])
    .map((relation) => {
      const target = findingById.get(relation.targetFindingId);
      if (!target) {
        return null;
      }
      const choiceLabel = relation.choiceId
        ? repairChoices.find((choice) => choice.id === relation.choiceId)?.label || relation.choiceId
        : "";
      return { relation, target, choiceLabel };
    })
    .filter((item): item is {
      relation: ClawGuardFinding["relations"][number];
      target: ClawGuardFinding;
      choiceLabel: string;
    } => Boolean(item));
  const readOnlyCause = resolveReadOnlyCause(status);
  const hasExemptedFindings = exemptedFindings.length > 0;
  const readOnlyStateTitle =
    status?.config_source === "local-file"
      ? ui("当前结果来自本地配置回退", "This result comes from the local config fallback")
      : ui("当前结果来自 gateway 返回", "This result comes directly from the gateway");
  const readOnlyStateDetail =
    status?.config_source === "local-file"
      ? ui(
          "从这次返回看，更接近 gateway RPC 不可用、响应超时，或者页面还保留着旧状态；这不是已经确认的文件权限错误。",
          "From this response, this looks more like an unavailable or slow gateway RPC, or stale page state. This is not a confirmed file-permission error.",
        )
      : ui(
          "如果这里还显示只读，但又没有原始报错，通常说明这次返回缺少写回校验信息，或者页面状态已经过期；请以重新扫描后的结果为准。",
          "If this still shows read-only without a raw error, the response is usually missing writeback validation details or the page state is stale. Use the result from a fresh rescan.",
        );
  const patchPreviewText = patchPreview || (
    previewLoading
      ? ui("正在生成这项修复的变更预览...", "Generating the patch preview for this repair...")
      : status?.read_only
        ? ui("当前不能自动写回，但可以按当前风险详情手动修改这些配置项。", "Automatic writeback is unavailable right now. Use the current finding details to edit the config manually.")
        : ui("当前没有可预览的配置改动。", "No config patch is available for preview.")
  );
  const applyDisabled = previewLoading || applyLoading || status?.read_only === true || preview?.can_apply === false;
  const applyButtonLabel = applyLoading
    ? ui("应用中...", "Applying...")
    : status?.read_only
      ? ui("只读模式无法写入", "Read-only: cannot apply")
      : ui("确认应用", "Apply Repair");

  useEffect(() => {
    if (!readOnlyInfoOpen) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setReadOnlyInfoOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readOnlyInfoOpen]);

  useEffect(() => {
    if (!status?.read_only) {
      setReadOnlyInfoOpen(false);
    }
  }, [status?.read_only]);

  return (
    <>
      <section
        id="panel-hardening"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="tab-hardening"
        aria-busy={loading}
      >
        <div className="panel-card hardening-panel dashboard-panel">
          <div className="card-head">
            <div>
              <h2>{ui("系统", "System")}</h2>
              <p className="skills-intro">
                {ui(
                  "这里专门检查 OpenClaw 基础配置里的高价值风险项，并给出单项修复入口。",
                  "This page checks high-value risks in the base OpenClaw config and provides a per-item repair entry."
                )}
              </p>
            </div>
            <div className="header-actions">
              {status?.read_only ? (
                <button
                  className="hardening-read-only-pill"
                  type="button"
                  onClick={() => setReadOnlyInfoOpen(true)}
                  aria-label={ui("查看只读模式原因", "View why this page is read-only")}
                  title={ui("查看只读模式原因", "View why this page is read-only")}
                >
                  <span className="hardening-read-only-pill-label">{ui("只读", "Read Only")}</span>
                  <span className="hardening-read-only-pill-icon" aria-hidden="true">
                    <InfoIcon />
                  </span>
                </button>
              ) : null}
              <button className="ghost small" type="button" disabled={loading} onClick={() => void onRefresh()}>
                {loading ? ui("扫描中...", "Scanning...") : ui("重新扫描", "Rescan")}
              </button>
            </div>
          </div>

          <div className="hardening-metrics">
            <OverviewStatCard label={ui("风险总数", "Risk Findings")} value={metricValue(status?.summary?.risk_count)} tone="bad" />
            <OverviewStatCard label={ui("可直接修复", "Direct Fixes")} value={metricValue(status?.summary?.direct_fix_count)} tone="warn" />
            <OverviewStatCard label={ui("需要重启", "Needs Restart")} value={metricValue(status?.summary?.restart_required_count)} tone="warn" />
            <OverviewStatCard label={ui("已通过项", "Passed Checks")} value={metricValue(status?.summary?.passed_count)} tone="good" />
          </div>

          <div className={`hardening-status-card ${status?.error ? "error" : status?.read_only ? "warn" : "good"}`}>
            <div className="hardening-status-grid">
              <span>{ui("最近扫描", "Last Scan")}: {formatTime(status?.scanned_at)}</span>
              <span>{ui("配置来源", "Config Source")}: {configSourceLabel(status?.config_source)}</span>
              <span>{ui("gateway 状态", "Gateway Status")}: {status?.gateway_online ? ui("在线", "Online") : ui("离线", "Offline")}</span>
            </div>
            {status?.config_path ? <div className="hardening-status-path">{status.config_path}</div> : null}
            {status?.write_reason ? <div className="confirm-dialog-text">{status.write_reason}</div> : null}
            {status?.error ? <div className="confirm-dialog-text">{status.error}</div> : null}
          </div>

          {loading && status ? (
            <div className="hardening-inline-note hardening-inline-note-loading" role="status" aria-live="polite">
              <LoadingSpinner />
              <span>
                {ui(
                  "正在重新读取系统状态，列表会在扫描完成后更新。",
                  "Refreshing system status. The list updates as soon as the scan finishes.",
                )}
              </span>
            </div>
          ) : null}

          {loading && !status ? (
            <div className="hardening-loading-card" role="status" aria-live="polite">
              <div className="hardening-loading-head">
                <LoadingSpinner />
                <strong>{ui("正在读取系统状态", "Loading system status")}</strong>
              </div>
              <p>
                {ui(
                  "系统扫描需要读取当前 OpenClaw 配置，请稍等片刻。",
                  "The system scan needs to read the current OpenClaw config. Please wait a moment.",
                )}
              </p>
              <div className="hardening-loading-skeleton" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : status?.error && findingGroups.length === 0 && exemptedFindings.length === 0 ? (
            <div className="chart-empty">{status.error}</div>
          ) : findingGroups.length === 0 && exemptedFindings.length === 0 ? (
            <div className="chart-empty">
              {ui(
                "当前配置没有发现可识别的高价值风险项。",
                "No recognizable high-value hardening risks were found in the current config."
              )}
            </div>
          ) : (
            <>
              <div className="hardening-list">
                {findingGroups.map((group) => (
                  <article key={group.id} className={`hardening-item hardening-group-card severity-${group.severity}`}>
                    <div className="hardening-item-head hardening-group-head">
                      <div className="hardening-group-copy">
                        <div className="hardening-item-title-row">
                          <span className={`tag meta-tag severity-${group.severity}`}>{severityLabel(group.severity)}</span>
                          <span className="tag meta-tag">{ui(`${group.findings.length} 个子项`, `${group.findings.length} child findings`)}</span>
                          {group.exemptedCount > 0 ? (
                            <span className="tag allow">{ui(`${group.exemptedCount} 项已豁免`, `${group.exemptedCount} exempted`)}</span>
                          ) : null}
                        </div>
                        <h3>{group.title}</h3>
                        <p>{group.summary}</p>
                        <p className="hardening-group-subtitle">{group.subtitle}</p>
                        {group.relationHint ? (
                          <div className="hardening-relation-card">
                            <strong>{ui("关联提示", "Related hint")}</strong>
                            <p>{group.relationHint}</p>
                          </div>
                        ) : null}
                      </div>
                      <div className="hardening-group-actions">
                        <button
                          className="ghost small"
                          type="button"
                          disabled={actionLoading}
                          onClick={() => void onExemptFindings(group.findings.map((finding) => finding.id))}
                        >
                          {actionLoading
                            ? ui("处理中...", "Working...")
                            : group.findings.length > 1
                              ? ui("豁免整组", "Exempt group")
                              : ui("豁免", "Exempt")}
                        </button>
                      </div>
                    </div>

                    <div className="hardening-group-children">
                      {group.findings.map((finding, index) => (
                        <article key={finding.id} className={`hardening-item hardening-child-card severity-${finding.severity}`}>
                          <div className="hardening-item-head">
                            <div className="hardening-item-title-row">
                              <span className={`tag meta-tag severity-${finding.severity}`}>{severityLabel(finding.severity)}</span>
                              <span className="tag meta-tag">{ui(`子项 ${index + 1}`, `Child ${index + 1}`)}</span>
                              {finding.restartRequired ? <span className="tag meta-tag">{ui("需要重启 gateway", "Gateway Restart Required")}</span> : null}
                            </div>
                            <div className="hardening-item-actions">
                              <button className="ghost small" type="button" disabled={actionLoading} onClick={() => void onOpenFinding(finding.id, finding.defaultOptions)}>
                                {ui("查看详情", "View Details")}
                              </button>
                              <button className="primary small" type="button" disabled={actionLoading} onClick={() => void onOpenFinding(finding.id, finding.defaultOptions)}>
                                {ui("修复", "Repair")}
                              </button>
                              <button className="ghost small" type="button" disabled={actionLoading} onClick={() => onExemptFindings([finding.id])}>
                                {actionLoading ? ui("处理中...", "Working...") : ui("豁免", "Exempt")}
                              </button>
                            </div>
                          </div>

                          <div className="hardening-item-main">
                            <div className="hardening-child-copy">
                              <h3>{finding.title}</h3>
                              <p>{finding.summary}</p>
                              <div className="hardening-child-hint">
                                <strong>{ui("关联说明", "Relation note")}</strong>
                                <p>{hardeningRelationHint(finding, group.findings.length - 1)}</p>
                              </div>
                            </div>
                            <div className="hardening-item-grid">
                              <div className="hardening-item-block">
                                <span>{ui("当前状态", "Current State")}</span>
                                <strong>{finding.currentSummary}</strong>
                              </div>
                              <div className="hardening-item-block">
                                <span>{ui("推荐做法", "Recommended Fix")}</span>
                                <strong>{finding.recommendationSummary}</strong>
                              </div>
                            </div>
                          </div>

                          <div className="hardening-paths">
                            {renderFindingPaths(finding.configPaths)}
                          </div>
                        </article>
                      ))}
                    </div>
                  </article>
                ))}
              </div>

              {hasExemptedFindings ? (
                <details className="hardening-passed-panel hardening-exempted-panel" open>
                  <summary>
                    {ui("豁免分类", "Exempted")} ({exemptedFindings.length})
                  </summary>
                  <p className="hardening-exempted-summary">
                    {ui("这里显示已经被手动豁免的风险点。", "This section shows findings that were manually exempted.")}
                  </p>
                  <div className="hardening-passed-list hardening-exempted-list">
                    {exemptedFindings.map((finding) => {
                      const group = groupById.get(finding.groupId) || buildFallbackGroup(finding);
                      const exemption = finding.exemption;
                      return (
                      <article key={finding.id} className="hardening-item hardening-exempted-card">
                        <div className="hardening-item-head">
                          <div className="hardening-item-title-row">
                            <span className={`tag meta-tag severity-${finding.severity}`}>{severityLabel(finding.severity)}</span>
                            <span className="tag allow">{ui("已豁免", "Exempted")}</span>
                          </div>
                          <div className="hardening-item-actions">
                            <button className="ghost small" type="button" disabled={actionLoading} onClick={() => void onOpenFinding(finding.id, finding.defaultOptions)}>
                              {ui("查看详情", "View Details")}
                            </button>
                            <button className="primary small" type="button" disabled={actionLoading} onClick={() => onRestoreFinding(finding.id)}>
                              {actionLoading ? ui("处理中...", "Working...") : ui("恢复", "Restore")}
                            </button>
                          </div>
                        </div>

                        <div className="hardening-item-main">
                          <div>
                            <h3>{finding.title}</h3>
                            <p>{finding.summary}</p>
                            <p className="hardening-exempted-meta">
                              {ui(
                                `已分类到 ${group.title} · ${formatTime(exemption.updatedAt)}`,
                                `Filed under ${group.title} · ${formatTime(exemption.updatedAt)}`,
                              )}
                            </p>
                            {isMeaningfulText(exemption.reason) ? (
                              <p className="hardening-exempted-meta">{exemption.reason}</p>
                            ) : null}
                          </div>
                          <div className="hardening-item-grid">
                            <div className="hardening-item-block">
                              <span>{ui("豁免来源", "Exemption Source")}</span>
                              <strong>{group.subtitle}</strong>
                            </div>
                            <div className="hardening-item-block">
                              <span>{ui("当前状态", "Current State")}</span>
                              <strong>{finding.currentSummary}</strong>
                            </div>
                          </div>
                        </div>

                        <div className="hardening-paths">
                          {renderFindingPaths(finding.configPaths)}
                        </div>
                      </article>
                      );
                    })}
                  </div>
                </details>
              ) : null}
            </>
          )}

          <details className="hardening-passed-panel" open>
            <summary>
              {ui("已通过项", "Passed Checks")} ({passed.length})
            </summary>
            {passed.length === 0 ? (
              <div className="chart-empty">{ui("当前没有可展示的已通过项。", "No passed checks to show right now.")}</div>
            ) : (
              <div className="hardening-passed-list">
                {passed.map((item) => (
                  <article key={item.id} className="hardening-passed-item">
                    <div className="hardening-passed-head">
                      <strong>{item.title}</strong>
                      <span className="tag allow">{ui("已通过", "Passed")}</span>
                    </div>
                    <p>{item.summary}</p>
                    <div className="hardening-paths">
                      {item.configPaths.map((configPath) => (
                        <span key={configPath} className="tag meta-tag">{configPath}</span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </details>
        </div>
      </section>

      {drawerVisible ? (
        <div
          className="hardening-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={ui("风险修复详情", "Hardening repair details")}
          onClick={onClosePreview}
        >
          <div className="hardening-drawer" onClick={(event) => event.stopPropagation()} aria-busy={previewLoading || applyLoading}>
            <div className="hardening-modal-sticky">
              <div className="hardening-drawer-head">
                <div className="hardening-modal-header-copy">
                  <span className="eyebrow">{ui("风险详情", "Risk Details")}</span>
                  <h3>{drawerTitle}</h3>
                  <p className="hardening-modal-subtitle">{drawerSummary}</p>
                </div>
                <div className="hardening-modal-head-actions">
                  {previewLoading ? (
                    <span className="hardening-loading-pill" role="status" aria-live="polite">
                      <LoadingSpinner />
                      <span>{ui("详情加载中", "Loading details")}</span>
                    </span>
                  ) : null}
                  <button className="ghost small" type="button" onClick={onClosePreview}>
                    {ui("关闭", "Close")}
                  </button>
                </div>
              </div>
            </div>

            <div className="hardening-drawer-content">
              {relatedResolutionHints.length > 0 ? (
                <div className="hardening-relation-card">
                  <strong>{ui("关联修复提示", "Related resolution hints")}</strong>
                  <div className="hardening-relation-list">
                    {relatedResolutionHints.map(({ relation, target, choiceLabel }) => (
                      <div key={`${relation.type}:${target.id}:${relation.choiceId || ""}`} className="hardening-relation-item">
                        <span className="tag meta-tag">
                          {relation.type === "choice_resolves" ? ui("选项联动", "Choice-linked") : ui("关联项", "Related")}
                        </span>
                        <span>
                          {choiceLabel ? `${choiceLabel} · ` : ""}
                          {ui(
                            `查看修复时会顺带影响 ${target.title}`,
                            `The repair flow also affects ${target.title}`,
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {previewLoading ? (
                <div className="hardening-inline-note hardening-inline-note-loading" role="status" aria-live="polite">
                  <LoadingSpinner />
                  <span>
                    {ui(
                      "正在读取完整详情，下面先显示本次扫描已经拿到的结果。",
                      "Loading the complete details. Showing the scan result that is already available.",
                    )}
                  </span>
                </div>
              ) : null}

              <div className="hardening-modal-body">
                {repairChoices.length > 0 ? (
                  <div className="hardening-choice-list">
                    {repairChoices.map((choice) => (
                      <button
                        key={choice.id}
                        className={`hardening-choice ${selectedChoiceId === choice.id ? "active" : ""}`}
                        type="button"
                        disabled={choice.disabled || previewLoading}
                        onClick={() => onSelectRepairChoice(selectedFindingId, choice.id)}
                      >
                        <strong>{choice.label}</strong>
                        <span>{choice.description}</span>
                        {choice.recommended ? <em>{ui("推荐", "Recommended")}</em> : null}
                        {choice.disabledReason ? <small>{choice.disabledReason}</small> : null}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="hardening-preview-grid">
                  <div className="hardening-preview-field">
                    <span>{ui("当前值", "Current Value")}</span>
                    <div>{currentValue}</div>
                  </div>
                  <div className="hardening-preview-field">
                    <span>{ui("推荐值", "Recommended Value")}</span>
                    <div>{recommendedValue}</div>
                  </div>
                  <div className="hardening-preview-field">
                    <span>{ui("预估影响", "Expected Impact")}</span>
                    <div>{impact}</div>
                  </div>
                  <div className="hardening-preview-field">
                    <span>{ui("配置路径", "Config Paths")}</span>
                    <div className="hardening-paths">
                      {configPaths.length > 0 ? (
                        configPaths.map((configPath) => (
                          <span key={configPath} className="tag meta-tag">{configPath}</span>
                        ))
                      ) : (
                        <span>{ui("当前没有可展示的配置路径。", "No config paths are available for this item.")}</span>
                      )}
                    </div>
                  </div>
                </div>

                {status?.read_only ? (
                  <div className="hardening-manual-card">
                    <div className="hardening-manual-head">
                      <strong>{ui("手动处理建议", "Manual Repair Steps")}</strong>
                      <span className="tag meta-tag">{ui("只读模式", "Read-only")}</span>
                    </div>
                    <p className="hardening-manual-intro">
                      {ui(
                        "当前还能查看风险分析，但需要你手动修改 OpenClaw 配置。",
                        "Risk details are still available, but you need to edit the OpenClaw config manually.",
                      )}
                    </p>
                    <ol className="hardening-manual-list">
                      <li>
                        <strong>{ui("打开当前生效配置", "Open the active config file")}</strong>
                        <p>{ui("先修改当前 OpenClaw 使用的配置文件。", "Edit the config file currently used by OpenClaw.")}</p>
                        {status?.config_path ? <div className="hardening-status-path">{status.config_path}</div> : null}
                      </li>
                      <li>
                        <strong>{ui("定位配置项", "Find the config keys")}</strong>
                        <p>{ui("按下面这些路径逐项检查。", "Check the following paths one by one.")}</p>
                        <div className="hardening-paths">
                          {configPaths.length > 0 ? (
                            configPaths.map((configPath) => (
                              <span key={configPath} className="tag meta-tag">{configPath}</span>
                            ))
                          ) : (
                            <span>{ui("当前没有可展示的配置路径。", "No config paths are available for this item.")}</span>
                          )}
                        </div>
                      </li>
                      <li>
                        <strong>{ui("按建议值修改", "Update the values")}</strong>
                        <p>
                          {ui("把当前值改成推荐值。", "Change the current value to the recommended value.")}
                          {" "}
                          {currentValue}
                          {" -> "}
                          {recommendedValue}
                        </p>
                        {selectedChoice ? (
                          <p className="hardening-manual-note">
                            {ui("当前建议方案：", "Current recommended choice: ")}
                            {selectedChoice.label}
                          </p>
                        ) : null}
                      </li>
                      <li>
                        <strong>{restartRequired ? ui("重启并重新扫描", "Restart and rescan") : ui("保存后重新扫描", "Save and rescan")}</strong>
                        <p>
                          {restartRequired
                            ? ui("保存配置后重启 gateway，再回到这里重新扫描。", "Restart the gateway after saving the config, then rescan here.")
                            : ui("保存配置后回到这里重新扫描，确认风险已经消失。", "Rescan here after saving the config to confirm the risk is gone.")}
                        </p>
                      </li>
                    </ol>
                  </div>
                ) : null}

                <div className="hardening-patch-card">
                  <div className="hardening-patch-head">
                    <strong>{ui("变更预览", "Patch Preview")}</strong>
                    {restartRequired ? <span className="tag meta-tag">{ui("需要重启 gateway", "Gateway Restart Required")}</span> : null}
                  </div>
                  <pre className="hardening-patch-preview">{patchPreviewText}</pre>
                </div>

                {applyDisabledReason ? (
                  <div className="hardening-preview-warning">{applyDisabledReason}</div>
                ) : null}

                <div className="confirm-dialog-actions">
                  <button className="ghost small" type="button" onClick={onClosePreview}>
                    {ui("取消", "Cancel")}
                  </button>
                  <button
                    className="primary small"
                    type="button"
                    disabled={applyDisabled}
                    onClick={() => void onApplyPreview()}
                  >
                    {applyButtonLabel}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {status?.read_only && readOnlyInfoOpen ? (
        <div
          className="hardening-info-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={ui("只读模式说明", "Read-only details")}
          onClick={() => setReadOnlyInfoOpen(false)}
        >
          <div className="hardening-info-card" onClick={(event) => event.stopPropagation()}>
            <div className="hardening-drawer-head">
              <div className="hardening-modal-header-copy">
                <span className="eyebrow">{ui("只读说明", "Read-only details")}</span>
                <h3>{ui("当前不能直接写回配置", "Direct writeback is unavailable right now")}</h3>
                <p className="hardening-modal-subtitle">
                  {ui(
                    "这个状态只影响自动修复。风险扫描、详情查看和手动修复指引仍然可用。",
                    "This only affects automatic repair. Risk scans, detail views, and manual repair guidance are still available.",
                  )}
                </p>
              </div>
              <button className="ghost small" type="button" onClick={() => setReadOnlyInfoOpen(false)}>
                {ui("关闭", "Close")}
              </button>
            </div>

            <div className="hardening-preview-grid">
              <div className="hardening-preview-field">
                <span>{ui("实际原因", "Actual Cause")}</span>
                <div className="hardening-cause-detail">
                  <strong>{readOnlyCause.title}</strong>
                  <p>{readOnlyCause.detail}</p>
                </div>
              </div>
              <div className="hardening-preview-field">
                <span>{ui("当前确认状态", "Current Confirmed State")}</span>
                <div className="hardening-cause-detail">
                  <strong>{readOnlyStateTitle}</strong>
                  <p>{readOnlyStateDetail}</p>
                </div>
              </div>
            </div>

            {isMeaningfulText(readOnlyCause.raw) ? (
              <div className="hardening-patch-card">
                <div className="hardening-patch-head">
                  <strong>{ui("原始返回", "Raw Response")}</strong>
                </div>
                <pre className="hardening-patch-preview">{readOnlyCause.raw}</pre>
              </div>
            ) : null}

            <div className="confirm-dialog-actions">
              <button className="primary small" type="button" onClick={() => setReadOnlyInfoOpen(false)}>
                {ui("知道了", "Understood")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
