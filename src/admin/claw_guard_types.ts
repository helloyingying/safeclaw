export type ClawGuardSeverity = "critical" | "high" | "medium" | "low";
export type ClawGuardRepairKind = "direct" | "guided" | "read_only";
export type ClawGuardConfigSource = "gateway-rpc" | "local-file";
export type ClawGuardFindingRelationType = "related" | "choice_resolves";
export type ClawGuardFindingGroupKind = "gateway" | "channel" | "sandbox";
export type ClawGuardFindingScopeType = "global" | "channel";

export type ClawGuardFinding = {
  id: string;
  ruleId: string;
  scopeType: ClawGuardFindingScopeType;
  scopeId?: string;
  severity: ClawGuardSeverity;
  title: string;
  summary: string;
  currentSummary: string;
  recommendationSummary: string;
  configPaths: string[];
  repairKind: ClawGuardRepairKind;
  repairChoices: ClawGuardRepairChoice[];
  defaultOptions?: Record<string, unknown>;
  restartRequired: boolean;
  groupId: string;
  relations: ClawGuardFindingRelation[];
};

export type ClawGuardFindingRelation = {
  type: ClawGuardFindingRelationType;
  targetFindingId: string;
  choiceId?: string;
};

export type ClawGuardFindingGroup = {
  id: string;
  kind: ClawGuardFindingGroupKind;
  scopeType: ClawGuardFindingScopeType;
  scopeId?: string;
  title: string;
  summary: string;
  severity: ClawGuardSeverity;
  configPaths: string[];
  childFindingIds: string[];
  recommendedFindingId?: string;
};

export type ClawGuardExemptionRecord = {
  findingId: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClawGuardExemptedFinding = ClawGuardFinding & {
  exemption: ClawGuardExemptionRecord;
};

export type ClawGuardRepairChoice = {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
  disabled?: boolean;
  disabledReason?: string;
};

export type ClawGuardPassedItem = {
  id: string;
  title: string;
  summary: string;
  configPaths: string[];
};

export type ClawGuardSummary = {
  risk_count: number;
  direct_fix_count: number;
  restart_required_count: number;
  passed_count: number;
  exempted_count: number;
};

export type ClawGuardStatusPayload = {
  scanned_at: string;
  config_source?: ClawGuardConfigSource;
  config_path?: string;
  gateway_online: boolean;
  read_only: boolean;
  write_reason?: string;
  error?: string;
  summary: ClawGuardSummary;
  groups: ClawGuardFindingGroup[];
  findings: ClawGuardFinding[];
  exempted: ClawGuardExemptedFinding[];
  passed: ClawGuardPassedItem[];
};

export type ClawGuardPreviewPayload = {
  finding_id: string;
  title: string;
  summary: string;
  current_value: string;
  recommended_value: string;
  impact: string;
  patch_preview: string;
  restart_required: boolean;
  can_apply: boolean;
  apply_disabled_reason?: string;
  config_paths: string[];
  repair_choices: ClawGuardRepairChoice[];
  selected_choice_id?: string;
};

export type ClawGuardApplyPayload = {
  ok: boolean;
  message: string;
  restart_required: boolean;
  finding_id: string;
};

export type ClawGuardExemptionPayload = {
  ok: boolean;
  message: string;
  finding_id: string;
  exempted: boolean;
};

export type ClawGuardConfigSnapshot = {
  config: Record<string, unknown>;
  configPath?: string;
  source: ClawGuardConfigSource;
  gatewayOnline: boolean;
  writeSupported: boolean;
  writeReason?: string;
  baseHash?: string;
};

export type ClawGuardFixPlan = {
  findingId: string;
  title: string;
  summary: string;
  currentValue: string;
  recommendedValue: string;
  impact: string;
  configPaths: string[];
  repairChoices: ClawGuardRepairChoice[];
  selectedChoiceId?: string;
  patch: Record<string, unknown> | null;
  previewPatch: Record<string, unknown> | null;
  restartRequired: boolean;
  canApply: boolean;
  applyDisabledReason?: string;
};
