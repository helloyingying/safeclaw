# SafeClaw Security Plugin PRD v1.0（Plugin 开发者视角）

## 1. 我们的真实目标
我们不是 OpenClaw 平台研发方；我们要交付的是 **可安装的 SafeClaw Security Plugin**，在不改 OpenClaw 核心代码前提下，给使用方提供：
1. 运行时风险拦截（主路径）
2. 输出脱敏与落盘前净化
3. 审计事件与看板数据
4. 可配置策略与审批能力

## 2. 目标用户
- 插件使用方（企业管理员）
- 安全运营人员（SOC/SecOps）
- 插件集成开发者

## 3. 产品范围（只做 Plugin 能做的）
### 3.1 In Scope
- 基于已公开 Hook 的运行时防护：`before_prompt_build`、`before_tool_call`、`after_tool_call`、`tool_result_persist`、`message_sending`
- 插件内策略引擎（allow/warn/challenge/block）
- 插件事件模型与外部日志/看板对接
- 插件配置中心（规则、阈值、风险等级）

### 3.2 Out of Scope
- 不承诺实现 OpenClaw 平台级多租户隔离
- 不直接改 OpenClaw 核心安装流程（pre_install 非插件强保证）
- 不覆盖所有插件旁路能力（HTTP/RPC/service）除非对方显式接入我们的 SDK/中间件

## 4. 核心价值
- **低侵入**：安装插件即可获得主路径安全能力
- **可观测**：每次决策产生日志事件，接入看板
- **可运营**：支持灰度、降级、回滚策略

## 5. 核心功能需求

## 5.1 模块 A：Hook Guardrails（P0）
### 功能
- `before_prompt_build`：外部内容打标（untrusted）+ security context 注入
- `before_tool_call`：策略判断（allow/warn/challenge/block）
- `after_tool_call`：响应结构校验 + DLP 扫描
- `tool_result_persist`：落盘前净化（mask/remove）
- `message_sending`：最终回复脱敏

### 验收
- 主路径每个 Hook 均可独立开关
- Hook 失败不导致主流程崩溃（fail-open/fail-close 可配置）

## 5.2 模块 B：策略与审批（P0）
### 功能
- 策略优先级：identity > scope > risk
- 通用 challenge 审批（不限 exec）
- 策略灰度发布（observe -> warn -> block）

### 验收
- 单策略可回滚
- 挑战审批有 TTL 与审计记录

## 5.3 模块 C：审计事件（P0）
### 功能
- 输出 `SecurityDecisionEvent`
- 对接外部 sink：HTTP webhook / Kafka（至少一种）
- 事件字段版本化（schema_version）

### 验收
- 事件完整率 >= 99.9%
- 关键字段（trace_id/decision/reason_code）不缺失

## 5.4 模块 D：插件配置（P1）
### 功能
- 静态配置文件 + 热更新轮询（可选）
- 敏感词、规则、阈值、白名单配置
- 环境分级（dev/stage/prod）

### 验收
- 配置错误时回退到最后可用版本
- 配置变更有审计日志

## 5.5 模块 E：安装准入辅助工具（P1）
> 注意：这是插件附带的 CLI/CI 工具，不是 OpenClaw 核心 hook。

### 功能
- 对插件来源、签名、SBOM、权限声明做离线检查
- 输出 `admission-report.json`

### 验收
- 报告可在 CI 阶段阻断发布

## 6. 成功指标
- 高危调用拦截率 >= 85%
- 落盘前敏感字段净化覆盖率 >= 99%
- 常规路径新增延迟 p95 < 80ms
- 误报率（人工复核驳回）<= 10%

## 7. 里程碑（12周）
- W1-2：Plugin 框架与统一事件模型
- W3-5：五个 Hook Guardrails MVP
- W6-8：策略引擎 + 审批状态机
- W9-10：配置热更新 + 事件 sink
- W11-12：压测、演练、灰度发布

## 8. 风险与边界说明
1. 插件无法兜住未接入 Hook 的旁路流量。
2. 平台升级可能导致 Hook 行为变化，需版本兼容策略。
3. 语义检测过重会影响延迟，需要分级触发。

## 9. 交付物
- `safeclaw-security-plugin` 可安装包
- `safeclaw-admission-cli`（可选）
- 配置模板、策略模板、事件 schema 文档
- 最小接入指南与运维 runbook
