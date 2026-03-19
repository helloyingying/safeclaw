import type { Decision, FileRule } from "../../src/types.ts";
import {
  DECISION_OPTIONS,
  capabilityLabel,
  decisionLabel,
  ui
} from "./dashboard_core.ts";
import { FileRuleOperationSelector } from "./dashboard_primitives.tsx";

type FileRuleRecord = FileRule;

type DirectoryEntry = {
  name: string;
  path: string;
};

export type FilesystemOverridesSectionProps = {
  inline?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  normalizedFileRules: FileRuleRecord[];
  selectedFileDirectory: string;
  newFileRuleDecision: Decision;
  newFileRuleOperations: unknown;
  selectedDirectoryRuleExists: boolean;
  openDirectoryPicker: () => void;
  setNewFileRuleDecision: (value: string) => void;
  toggleDraftFileRuleOperation: (operation: string) => void;
  applySelectedFileRule: () => void;
  setDirectoryFileRuleDecision: (ruleId: string, decision: string) => void;
  toggleDirectoryFileRuleOperation: (ruleId: string, operation: string) => void;
  requestRemoveFileRule: (rule: FileRuleRecord) => void;
  fileRuleOperationsSummary: (rule: Partial<FileRule> | null | undefined) => string;
  filePickerOpen: boolean;
  closeDirectoryPicker: () => void;
  filePickerParentPath: string;
  filePickerLoading: boolean;
  loadDirectoryPicker: (targetPath?: string) => void | Promise<void>;
  filePickerCurrentPath: string;
  chooseCurrentDirectory: () => void;
  filePickerRoots: string[];
  filePickerError: string;
  filePickerDirectories: DirectoryEntry[];
  fileRuleDeleteTarget: FileRuleRecord | null;
  cancelRemoveFileRule: () => void;
  confirmRemoveFileRule: () => void;
};

export function FilesystemOverridesSection({
  inline = true,
  disabled = false,
  disabledReason,
  normalizedFileRules,
  selectedFileDirectory,
  newFileRuleDecision,
  newFileRuleOperations,
  selectedDirectoryRuleExists,
  openDirectoryPicker,
  setNewFileRuleDecision,
  toggleDraftFileRuleOperation,
  applySelectedFileRule,
  setDirectoryFileRuleDecision,
  toggleDirectoryFileRuleOperation,
  requestRemoveFileRule,
  fileRuleOperationsSummary,
  filePickerOpen,
  closeDirectoryPicker,
  filePickerParentPath,
  filePickerLoading,
  loadDirectoryPicker,
  filePickerCurrentPath,
  chooseCurrentDirectory,
  filePickerRoots,
  filePickerError,
  filePickerDirectories,
  fileRuleDeleteTarget,
  cancelRemoveFileRule,
  confirmRemoveFileRule
}: FilesystemOverridesSectionProps) {
  return (
    <>
      <section
        className={[
          inline ? "sensitive-path-panel sensitive-path-panel-inline" : "sensitive-path-panel",
          disabled ? "sensitive-path-panel-disabled" : "",
        ].filter(Boolean).join(" ")}
        aria-label={ui("设置例外目录", "Exception directories")}
      >
        <div className="sensitive-path-head">
          <div>
            <h3>{ui("设置例外目录", "Exception Directories")}</h3>
            <p className="sensitive-path-intro">
              {ui(
                "设置例外目录是文件系统域内的覆盖层，不属于某一个具体文件动作。你可以把它收窄到读、枚举、搜索、写入、删除、归档或执行；不选操作时，默认覆盖这个目录下的全部文件类操作。",
                "Exception directories are a filesystem-scoped overlay rather than a child of one specific file action. You can narrow them to read, list, search, write, delete, archive, or execute. Leaving the scope empty applies the override to all filesystem-related operations in that directory."
              )}
            </p>
            {disabled && disabledReason ? <div className="sensitive-path-disabled-note">{disabledReason}</div> : null}
          </div>
          <div className="rule-meta">
            <span className="meta-pill">{ui("设置例外目录", "Exception Directories")} {normalizedFileRules.length}</span>
            <span className="meta-pill">{selectedFileDirectory ? ui("已选择目录", "Directory Selected") : ui("未选择目录", "No Directory Selected")}</span>
          </div>
        </div>

        <div className="sensitive-path-toolbar">
          <button className="ghost" type="button" disabled={disabled} onClick={openDirectoryPicker}>
            {ui("选择目录", "Choose Directory")}
          </button>

          <div className="sensitive-path-selected" title={selectedFileDirectory || undefined}>
            {selectedFileDirectory || ui("尚未选择目录", "No directory selected yet")}
          </div>

          <label className="sensitive-path-field file-rule-action-field">
            <span>{ui("处理方式", "Action")}</span>
            <select
              value={newFileRuleDecision}
              disabled={disabled}
              onChange={(event) => setNewFileRuleDecision(event.target.value)}
            >
              {DECISION_OPTIONS.map((decisionOption) => (
                <option key={decisionOption} value={decisionOption}>{decisionLabel(decisionOption)}</option>
              ))}
            </select>
          </label>

          <label className="sensitive-path-field sensitive-path-field-wide">
            <span>{ui("适用操作", "Applies to operations")}</span>
            <FileRuleOperationSelector
              operations={newFileRuleOperations}
              disabled={disabled}
              onToggle={toggleDraftFileRuleOperation}
            />
          </label>

          <button
            className="primary"
            type="button"
            disabled={disabled || !selectedFileDirectory || selectedDirectoryRuleExists}
            onClick={applySelectedFileRule}
          >
            {ui("添加", "Add")}
          </button>
        </div>

        {selectedDirectoryRuleExists ? (
          <div className="sensitive-path-validation">
            {ui(
              "当前目录和操作范围已存在例外。若需调整，请在下方已配置的设置例外目录列表中修改。",
              "An exception directory already exists for the same directory and operation scope. Edit it in the configured list below."
            )}
          </div>
        ) : null}

        <div className="sensitive-path-note">
          {ui(
            `设置例外目录只影响文件系统相关操作，不会改动 ${capabilityLabel("network")}、${capabilityLabel("runtime")} 等其他能力。若命中这里的目录设置，当前目录会优先按这里的处理方式执行；删掉后再回落到默认策略和附加限制。`,
            `Exception directories only affect filesystem-related operations and do not change other capabilities such as ${capabilityLabel("network")} or ${capabilityLabel("runtime")}. When one of these directories matches, it takes precedence for that directory; deleting it falls back to the baseline policy and additional restrictions.`
          )}
        </div>

        {normalizedFileRules.length === 0 ? (
          <div className="chart-empty">{ui("当前还没有设置例外目录。", "No exception directories configured yet.")}</div>
        ) : (
          <div className="sensitive-path-list">
            {normalizedFileRules.map((rule) => (
              <article key={rule.id} className="sensitive-path-item configured">
                <div className="sensitive-path-item-main">
                  <div className="sensitive-path-item-pattern">{rule.directory}</div>
                  <div className="sensitive-path-item-tags">
                    <span className={`tag ${rule.decision}`}>{decisionLabel(rule.decision)}</span>
                    <span className="tag meta-tag">{fileRuleOperationsSummary(rule)}</span>
                  </div>
                </div>
                <div className="file-rule-item-actions">
                  <label className="sensitive-path-field file-rule-action-field">
                    <span>{ui("处理方式", "Action")}</span>
                    <select
                      value={rule.decision}
                      disabled={disabled}
                      onChange={(event) => setDirectoryFileRuleDecision(rule.id, event.target.value)}
                    >
                      {DECISION_OPTIONS.map((decisionOption) => (
                        <option key={decisionOption} value={decisionOption}>{decisionLabel(decisionOption)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="sensitive-path-field sensitive-path-field-wide">
                    <span>{ui("适用操作", "Applies to operations")}</span>
                    <FileRuleOperationSelector
                      operations={rule.operations}
                      disabled={disabled}
                      onToggle={(operation) => toggleDirectoryFileRuleOperation(rule.id, operation)}
                    />
                  </label>
                  <button className="ghost small" type="button" disabled={disabled} onClick={() => requestRemoveFileRule(rule)}>
                    {ui("删除", "Remove")}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {filePickerOpen ? (
        <div className="directory-picker-backdrop" role="dialog" aria-modal="true" aria-label={ui("目录选择器", "Directory picker")} onClick={closeDirectoryPicker}>
          <div className="directory-picker-card" onClick={(event) => event.stopPropagation()}>
            <div className="directory-picker-head">
              <h4>{ui("选择目录", "Choose Directory")}</h4>
              <button className="ghost small" type="button" disabled={disabled} onClick={closeDirectoryPicker}>
                {ui("关闭", "Close")}
              </button>
            </div>
            <div className="directory-picker-toolbar">
              <button
                className="ghost small"
                type="button"
                disabled={disabled || !filePickerParentPath || filePickerLoading}
                onClick={() => void loadDirectoryPicker(filePickerParentPath)}
              >
                {ui("上级目录", "Up")}
              </button>
              <div className="directory-picker-current">{filePickerCurrentPath || "-"}</div>
              <button className="primary small" type="button" disabled={disabled || !filePickerCurrentPath} onClick={chooseCurrentDirectory}>
                {ui("选择当前目录", "Select Current Directory")}
              </button>
            </div>

            {filePickerRoots.length > 0 ? (
              <div className="directory-picker-roots">
                {filePickerRoots.map((root) => (
                  <button
                    key={root}
                    className="ghost small"
                    type="button"
                    onClick={() => void loadDirectoryPicker(root)}
                    disabled={disabled || filePickerLoading}
                  >
                    {root}
                  </button>
                ))}
              </div>
            ) : null}

            {filePickerError ? <div className="sensitive-path-validation">{filePickerError}</div> : null}

            <div className="directory-picker-list">
              {filePickerLoading ? (
                <div className="chart-empty">{ui("目录加载中...", "Loading directories...")}</div>
              ) : filePickerDirectories.length === 0 ? (
                <div className="chart-empty">{ui("当前目录没有可进入的子目录。", "No child directories in current path.")}</div>
              ) : (
                filePickerDirectories.map((entry) => (
                  <button
                    key={entry.path}
                    className="directory-picker-item"
                    type="button"
                    disabled={disabled}
                    onClick={() => void loadDirectoryPicker(entry.path)}
                  >
                    <span className="directory-picker-item-name">{entry.name}</span>
                    <span className="directory-picker-item-path">{entry.path}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      {fileRuleDeleteTarget ? (
        <div
          className="confirm-dialog-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={ui("删除确认", "Delete confirmation")}
          onClick={cancelRemoveFileRule}
        >
          <div className="confirm-dialog-card" onClick={(event) => event.stopPropagation()}>
            <h4>{ui("确认删除这条例外目录？", "Delete this exception directory?")}</h4>
            <p className="confirm-dialog-text">
              {ui(
                "删除后，这个目录会回落到文件系统默认策略和附加限制继续判断。",
                "After deletion, this directory falls back to the filesystem baseline and additional restrictions."
              )}
            </p>
            <div className="confirm-dialog-path">{fileRuleDeleteTarget.directory}</div>
            <div className="confirm-dialog-text">{fileRuleOperationsSummary(fileRuleDeleteTarget)}</div>
            <div className="confirm-dialog-actions">
              <button className="ghost small" type="button" disabled={disabled} onClick={cancelRemoveFileRule}>
                {ui("取消", "Cancel")}
              </button>
              <button className="primary small" type="button" disabled={disabled} onClick={confirmRemoveFileRule}>
                {ui("确认删除", "Delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
