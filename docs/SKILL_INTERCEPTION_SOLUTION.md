# SecurityClaw Skill 拦截方案（零安装门槛）

## 1. 背景与目标

本方案用于应对 `skill` 下毒（恶意或被劫持 skill）的运行时风险，重点覆盖：

- 恶意 skill 在执行阶段触发高危工具调用（执行、外发、越界读写）。
- skill 更新后被植入恶意内容（版本漂移、供应链污染）。
- skill 名称伪装/相似名误导安装后执行高危行为。

约束条件（按产品要求）：

- 不做安装前硬准入，不增加用户安装门槛。
- 检测与拦截以运行时为主，安装后自动后台审计。
- 低风险 skill 默认无感，摩擦集中在高风险行为。

## 2. 方案原则

- 零门槛：安装流程不变，防护在后台完成。
- 分层防护：静态检测 + 运行时行为检测 + 拦截联动。
- 最小惊扰：仅对高风险/异常行为触发 `challenge/block`。
- 可运营：所有结论可审计、可回放、可手工 override。
- 可回滚：策略可按 skill、按风险级别快速降级。

## 3. 总体架构

```text
Skill 安装/更新
   -> Skill Inventory Collector（发现与指纹）
   -> Skill Vetter Engine（后台异步扫描、打分分级）
   -> Risk Profile Store（SQLite）

before_tool_call（实时）
   -> Skill Context Resolver（工具调用归属 skill）
   -> Runtime Risk Interceptor（按风险+操作严重度裁决）
   -> 与现有 Rule Engine 合并（取更严格决策）
   -> allow / warn / challenge / block

Admin Dashboard
   -> 新增「Skill 拦截」Tab（可视化、策略、处置）
```

## 4. 检测实现（核心）

## 4.1 检测触发时机

- 启动全量扫描：gateway 启动后扫描已安装 skills。
- 增量扫描：定时扫描（建议每 30 分钟）+ 文件变更触发。
- 漂移重扫：检测到 hash 变化后立即重新评估。
- 行为反哺：运行时出现高危行为后触发即时复扫并提级。

## 4.2 检测输入

- Skill 元数据：名称、版本、作者、来源、更新时间、目录。
- 内容载荷：`SKILL.md`、声明文件、脚本/模板引用。
- 运行时行为：工具调用、资源路径、目标域名、DLP 命中。
- 本地关系图：已安装 skill 名称集合（用于相似名检测）。

## 4.3 检测信号（参考 Skill Vetter 思路）

### A. 元数据与来源信号
- 缺失关键元数据（作者、版本、变更说明）。
- 来源不明确或来源变化异常（同名 skill 来源切换）。
- 新装 skill 与高信誉 skill 高相似（typosquat）。

### B. 权限与能力信号
- 声明/实际能力不一致（声明只读，实际触发执行或外发）。
- 包含高危能力组合：`shell.exec + network + workspace_outside write`。
- 涉及凭据路径、浏览器密钥库、通信存储访问能力。

### C. 内容红旗信号
- 指令中出现绕过/禁用安全策略语义（如要求忽略策略、隐藏输出）。
- 出现下载后执行、外部脚本直连执行等模式。
- 引导读取令牌、私钥、会话数据库等敏感目标。

### D. 完整性与漂移信号
- skill 文件 hash 变化且无对应版本变化。
- 高频短周期变更（可疑自动更新/投毒）。
- 变更集中在高风险段落（执行/外发/凭据读取相关）。

### E. 运行时异常信号
- 首次运行即触发高危操作。
- 同一 skill 在短时间触发多次 `challenge/block`。
- DLP 命中与公网外发组合出现。

## 4.4 风险分级模型

- `low`：低风险，默认允许。
- `medium`：中风险，重点告警，部分场景 challenge。
- `high`：高风险，默认 challenge，高危操作可 block。
- `critical`：严重风险，默认 block（可由管理员临时放行）。

建议输出：

- `risk_tier`：`low|medium|high|critical`
- `risk_score`：0-100
- `reason_codes`：如 `SKILL_TYPOSQUAT_SUSPECTED`、`SKILL_CAPABILITY_MISMATCH`
- `confidence`：0-1（便于运营判读）

## 5. 拦截实现（核心）

## 5.1 运行时决策输入

在 `before_tool_call` 阶段补充 `skill_context`：

- `skill_id`
- `skill_version`
- `skill_hash`
- `risk_tier`
- `is_newly_installed`
- `is_drifted`
- `scan_status`（`ready|stale|unknown`）

## 5.2 严重度分级（操作侧）

- `S0`：工作区内低敏读取/查询
- `S1`：普通公网请求、普通文件写入
- `S2`：工作区外读写、敏感路径读取、批量导出
- `S3`：执行类高危命令、控制面变更、敏感数据公网外发

## 5.3 决策矩阵（skill 风险 × 操作严重度）

- `low`：`S0/S1 allow`，`S2 warn`，`S3 challenge`
- `medium`：`S0 allow`，`S1 warn`，`S2 challenge`，`S3 block`
- `high`：`S0 warn`，`S1 challenge`，`S2/S3 block`
- `critical`：`S0/S1 challenge`，`S2/S3 block`
- `unknown/stale`（未扫描或扫描过期）：`S2 challenge`，`S3 block`

说明：最终决策与现有策略引擎合并，采用“更严格优先”（`block > challenge > warn > allow`）。

## 5.4 审批与放行绑定

- 审批绑定维度：`subject + scope + skill_id + skill_hash + risk_tier`。
- 漂移失效：`skill_hash` 变化后，历史审批自动失效。
- 一次性放行：对 `high/critical` 风险建议默认 `single_use=true`。

## 5.5 处置动作

- `quarantine`：将 skill 标记为隔离，直接阻断其全部高危调用。
- `trust override`：管理员可将指定 skill 临时降级（保留审计）。
- `force rescan`：发现误报/漏报时一键重扫并刷新风险级别。

## 6. 管理后台新增「Skill 拦截」Tab

## 6.1 Tab 定位

- 新增一级 Tab：`Skill 拦截`（与 Overview / Decisions / Policies / Accounts 同级）。
- 目标：统一查看 skill 风险、拦截效果、以及人工处置入口。

## 6.2 页面结构

### 区块 A：风险总览
- 已发现 skill 数
- `high/critical` 数
- 24h `challenge/block` 次数
- 漂移告警数
- 隔离 skill 数

### 区块 B：Skill 列表
- 字段：名称、版本、来源、风险级别、最近扫描时间、最近拦截时间、状态（正常/隔离/信任覆盖）。
- 过滤：风险级别、状态、来源、是否漂移、最近 24h 是否触发拦截。

### 区块 C：Skill 详情抽屉
- 检测结论：`risk_score`、`reason_codes`、置信度。
- 行为轨迹：最近工具调用与拦截记录。
- 漂移详情：hash 变化、变化时间、受影响审批。
- 操作按钮：`重扫`、`隔离`、`解除隔离`、`设为受信(限时)`。

### 区块 D：拦截策略设置
- 风险分级阈值（score -> tier）
- 决策矩阵（tier × severity）
- 未扫描 skill 默认动作
- 漂移后默认动作

## 6.3 交互与可用性要求

- 国际化：所有新增文案必须提供 `en` / `zh-CN`。
- 主题：完整支持 `light` / `dark`，状态色满足对比度要求。
- 安全确认：`隔离`、`放行` 操作要求二次确认并记录操作者。
- 可追溯：每次人工 override 写入审计事件并可在 Decisions 关联查看。

## 6.4 后端 API（草案）

- `GET /api/skills/status`：聚合统计。
- `GET /api/skills`：技能列表与过滤。
- `GET /api/skills/:skillId`：技能详情（结论、轨迹、漂移）。
- `POST /api/skills/:skillId/rescan`：触发重扫。
- `POST /api/skills/:skillId/quarantine`：隔离/解除隔离。
- `POST /api/skills/:skillId/trust-override`：设置/撤销受信覆盖。
- `PUT /api/skills/policy`：更新 skill 拦截策略。

## 7. 数据模型（SQLite 草案）

- `skill_inventory`
  - `skill_id`, `name`, `version`, `source`, `install_path`, `current_hash`, `last_seen_at`
- `skill_scan_results`
  - `id`, `skill_id`, `scan_ts`, `risk_score`, `risk_tier`, `confidence`, `reason_codes_json`, `raw_findings_json`
- `skill_runtime_events`
  - `id`, `ts`, `skill_id`, `tool`, `severity`, `decision`, `reason_codes_json`, `trace_id`
- `skill_overrides`
  - `skill_id`, `quarantined`, `trust_override`, `expires_at`, `updated_by`, `updated_at`
- `skill_policy_config`
  - 单行配置，保存阈值、矩阵和默认动作。

## 8. 事件与可观测性

新增 reason code（示例）：

- `SKILL_UNSCANNED_HIGH_RISK_CHALLENGE`
- `SKILL_DRIFT_DETECTED`
- `SKILL_CAPABILITY_MISMATCH`
- `SKILL_TYPOSQUAT_SUSPECTED`
- `SKILL_QUARANTINED_BLOCK`
- `SKILL_TRUST_OVERRIDE_APPLIED`

新增指标（建议）：

- `skill_scan_total`, `skill_scan_failed_total`
- `skill_risk_high_total`, `skill_risk_critical_total`
- `skill_intercept_challenge_total`, `skill_intercept_block_total`
- `skill_drift_detected_total`

## 9. 分阶段落地

### 阶段 1（观察模式）
- 上线 inventory + 扫描 + 风险展示。
- 不额外 block，只打 `warn` 和审计事件。

### 阶段 2（软拦截）
- 对 `high/critical` + `S2/S3` 启用 `challenge/block`。
- 启用漂移后审批失效。

### 阶段 3（强化处置）
- 启用 quarantine 流程。
- 支持按来源/租户/环境分层策略。

## 10. 验收标准

- 检测覆盖：对预置恶意样本识别率 >= 85%。
- 拦截有效：`high/critical` skill 的 `S3` 行为拦截率 >= 95%。
- 性能影响：`before_tool_call` 额外时延 p95 < 10ms（仅读缓存风险画像）。
- 误报可运营：误报修复平均时长（MTTR）< 1 工作日。

## 11. 非目标与边界

- 本方案不在安装前阻断 skill（不做 pre-install hard gate）。
- 无法保证 100% 识别所有新型恶意模式，依赖持续更新规则与样本。
- 若无法解析 skill 归属，则按 `unknown` 风险路径执行保守策略。

## 12. 参考

- [Skill Vetter](https://useclaw.pro/skills/skill-vetter/)
- [OpenClaw Skills Security Repo](https://github.com/UseAI-pro/openclaw-skills-security)
- [Verifier](https://useclaw.pro/verifier/)
