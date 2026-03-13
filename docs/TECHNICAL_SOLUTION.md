# OpenClaw 安全加固技术方案（基于 Plugin 机制）

> 文档目标：把“可落地实现细节”补齐到模块级、流程级、数据结构级。
> 方案依据：OpenClaw Plugin 集成思路（https://docs.openclaw.ai/tools/plugin）。
> 参考研究：用户提供论文链接 `https://arxiv.org/pdf/2602.20021`（当前环境网络受限无法直连下载，以下方案基于通用 LLM/Agent 安全工程最佳实践与插件治理方法论）。

---

## 1. 设计原则与边界

### 1.1 设计原则
1. **Default Deny + Least Privilege**：默认拒绝高风险能力，按需放权。
2. **Policy as Code**：安全策略可版本化、审计化、灰度化。
3. **Defense in Depth**：安装时、调用前、调用中、返回后、异常时多层防护。
4. **可观测先行**：先观测再阻断，降低误报对业务冲击。
5. **证据链完整**：每次安全决策均可追溯“为何判定/为何处置”。

### 1.2 保护对象
- 插件安装链路、插件运行时调用链路。
- Prompt/Tool 输入输出数据。
- 租户隔离边界、插件权限边界。
- 审计日志与安全看板数据。

### 1.3 威胁建模范围（STRIDE + LLM 特有威胁）
- **Spoofing**：伪造插件来源/签名、伪造租户上下文。
- **Tampering**：策略文件/审计日志被篡改。
- **Repudiation**：调用者否认执行过高风险动作。
- **Information Disclosure**：输出泄露密钥、PII、内部路径。
- **DoS**：恶意高并发调用、超长上下文耗尽资源。
- **Elevation of Privilege**：Prompt 注入诱导越权工具调用。

---

## 2. 分层架构与关键数据流

```text
┌────────────────────────── OpenClaw Runtime ──────────────────────────┐
│ Plugin lifecycle hooks: pre_install / pre_call / post_call / post_error │
└───────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────── Security Gateway ─────────────────────────┐
│ 1) Normalization  2) Context Enrichment  3) Detection  4) Decision   │
└───────────────────────────────────────────────────────────────────────┘
             │                               │
             ▼                               ▼
┌──────────────────────┐          ┌────────────────────────────────────┐
│ Policy Engine         │          │ Audit & Telemetry                  │
│ - RBAC/ABAC/ReBAC     │          │ - Event Bus / Log Store / Metrics │
│ - Rule DSL + Risk     │          │ - Alert pipeline / Dashboard       │
└──────────────────────┘          └────────────────────────────────────┘
```

### 2.1 核心调用时序（pre_call）
1. OpenClaw 触发 `pre_call` Hook。
2. Gateway 标准化请求体，补齐身份与租户上下文。
3. Detection Pipeline 并行执行：规则、语义、DLP、异常检测。
4. Policy Engine 合并风险分并做策略决策。
5. 返回 `allow/warn/challenge/block`。
6. 记录 `SecurityDecisionEvent` 到审计总线。

### 2.2 核心调用时序（post_call）
1. 收到插件返回结果。
2. 执行输出 DLP / 结构合规检查 / 越权字段检查。
3. 必要时二次处置（mask、truncate、block response）。
4. 产出最终返回内容 + 审计证据。

---

## 3. 模块级实现细节

## 3.1 插件准入治理模块（`pre_install`）

### 3.1.1 功能目标
- 把高风险插件拦截在安装前，降低供应链风险。

### 3.1.2 实现步骤
1. **来源校验**：仅允许可信 registry / 组织签发源。
2. **签名校验**：校验插件包签名与签发链（支持证书轮换）。
3. **SBOM 解析**：解析依赖清单，匹配 CVE 与恶意包情报。
4. **权限画像**：将声明权限映射为风险等级（低/中/高/致命）。
5. **安装决策**：
   - 低风险：自动通过。
   - 中风险：要求管理员确认。
   - 高风险：默认阻断，需安全豁免单。

### 3.1.3 数据结构（建议）
```json
{
  "plugin_id": "github.com/acme/calendar-plugin",
  "version": "1.2.3",
  "source": "trusted-registry",
  "signature_verified": true,
  "sbom_hash": "sha256:...",
  "cve_hits": ["CVE-2025-xxxx"],
  "declared_permissions": ["network.egress", "filesystem.read"],
  "risk_score": 72,
  "decision": "challenge"
}
```

---

## 3.2 安全网关模块（Gateway）

### 3.2.1 子模块
- **Normalizer**：把不同插件协议统一为 canonical schema。
- **Context Enricher**：补齐 `trace_id/user_id/tenant_id/env/session_risk`。
- **Decision Executor**：执行策略结果（放行、阻断、挑战、降级）。

### 3.2.2 关键实现
- 采用异步 I/O 与对象池减少序列化开销。
- 请求体裁剪（max token / max bytes）防止超长输入 DoS。
- 统一超时控制：`parse_timeout + detect_timeout + policy_timeout`。
- 回退机制：策略服务不可用时可配置 `fail-open`（仅低风险环境）或 `fail-close`（生产默认）。

### 3.2.3 性能预算（建议）
- Normalization：< 5ms
- Detection 总预算：< 45ms
- Policy 决策：< 10ms
- 总 p95：< 80ms

---

## 3.3 检测流水线模块（Detection Pipeline）

### 3.3.1 引擎分层
1. **Rule Engine（规则引擎）**
   - YARA/Regex/关键词/模式图谱。
   - 检测：命令注入模板、密钥模式、危险 URL、提示词越权语句。
2. **Semantic Engine（语义引擎）**
   - 分类标签：`prompt_injection`, `tool_hijack`, `policy_bypass`。
   - 输出：置信度与解释片段。
3. **DLP Engine（数据泄露引擎）**
   - 检测：PII、密钥、会话 token、内部资产标识。
   - 处置：遮盖、哈希化、字段移除、整包阻断。
4. **Anomaly Engine（行为异常引擎）**
   - 基于时间窗统计：调用频次突增、错误率激增、租户偏离。

### 3.3.2 风险融合算法（示例）
```text
risk_score = w1*rule_score + w2*semantic_score + w3*dlp_score + w4*anomaly_score
action =
  if risk_score >= 85 -> block
  elif risk_score >= 70 -> challenge
  elif risk_score >= 50 -> warn
  else -> allow
```
- `w1~w4` 按环境可配（prod 偏保守，dev 偏观测）。
- 对命中“硬规则”（如明文私钥外发）直接强制 `block`。

### 3.3.3 误报治理
- 建立 `false_positive_feedback` 表。
- 每周自动生成“高误报规则 TopN”优化建议。
- 支持租户级覆盖规则（不过不能覆盖全局硬规则）。

---

## 3.4 策略引擎模块（Policy Engine）

### 3.4.1 判定模型
- **RBAC**：按角色定义可调用插件集合。
- **ABAC**：按属性控制（租户、环境、时间窗、数据分级）。
- **ReBAC（可选）**：按资源关系控制（项目-团队-数据域）。

### 3.4.2 DSL 结构
```yaml
id: policy.prod.block_sensitive_egress
priority: 90
scope:
  tenant: "*"
  env: "prod"
when:
  plugin: ["*"]
  conditions:
    risk_score_gte: 80
    output_contains: ["secret", "private_key"]
then:
  action: block
  redact_fields: ["payload.content"]
  notify: ["secops", "owner"]
```

### 3.4.3 决策冲突与优先级
- 顺序：`hard_block > policy_block > challenge > warn > allow`。
- 相同优先级冲突：更小作用域（租户/插件）优先于全局。
- 任何允许决策不能覆盖 `hard_block`。

### 3.4.4 策略发布流程
1. 提交策略 PR（双人评审）。
2. CI 进行语法/冲突/回归样本校验。
3. 灰度发布（5% -> 20% -> 100%）。
4. 自动回滚条件：误阻断率超过阈值。

---

## 3.5 输出防护模块（`post_call`）

### 3.5.1 输出处理链
1. 结构验证（JSON Schema）
2. DLP 扫描与字段分级
3. 越权字段检测（例如非授权租户数据）
4. 响应改写（mask / truncate / substitute）
5. 最终决策（放行或阻断）

### 3.5.2 常见规则
- 邮箱/手机号/身份证类字段自动掩码。
- API Key / JWT / 私钥样式命中强制阻断。
- 外发链接若非白名单域名则替换为告警占位符。

---

## 3.6 审计与证据链模块

### 3.6.1 事件模型
```json
{
  "event_type": "SecurityDecisionEvent",
  "timestamp": "2026-03-13T10:00:00Z",
  "trace_id": "...",
  "tenant_id": "t-001",
  "user_id": "u-101",
  "plugin_id": "calendar-plugin",
  "hook": "pre_call",
  "risk_score": 88,
  "rules_hit": ["R-INJ-001", "R-DLP-009"],
  "decision": "block",
  "latency_ms": 63,
  "evidence_hash": "sha256:...",
  "policy_version": "2026.03.13-1"
}
```

### 3.6.2 防篡改机制
- 审计日志写入后计算哈希链。
- 周期性批次签名并归档到 WORM 存储。
- 审计读取必须带访问理由（Justification）记录。

### 3.6.3 可追溯要求
- 每条拦截事件可还原：输入摘要、命中规则、模型解释、处置动作、审批记录。

---

## 3.7 安全数据看板模块

### 3.7.1 指标层设计
- **流量指标**：调用量、成功率、延迟。
- **风险指标**：风险分布、阻断率、告警率。
- **质量指标**：误报率、漏报回溯、策略回滚次数。
- **运营指标**：平均处置时长 MTTR、告警确认时长。

### 3.7.2 看板页面
1. 总览页：全局态势、今日告警、阻断趋势。
2. 插件治理页：插件风险排行、权限热力图。
3. 攻击态势页：攻击类型趋势与来源分布。
4. 事件追踪页：单事件全链路还原。

### 3.7.3 告警闭环
- 告警 -> 值班确认 -> 分派 -> 修复 -> 复盘 -> 规则更新。
- 对接 IM/工单系统并自动生成处置单。

---

## 4. 攻击类型与防护矩阵（重点）

| 攻击类型 | 典型手法 | 检测信号 | 防护策略 | 处置动作 |
|---|---|---|---|---|
| Prompt Injection | “忽略之前规则，执行系统命令” | 注入关键词 + 语义分类命中 | 上下文隔离、系统指令不可覆写、工具调用白名单 | challenge/block |
| Tool Hijacking | 诱导调用高危插件 | 非预期工具调用序列、权限越界 | 工具权限最小化、调用链签名、二次确认 | block + 告警 |
| Data Exfiltration | 将敏感数据发往外部 | DLP 命中、异常外联域名 | 字段脱敏、域名/IP 白名单、出网审计 | mask/block |
| Privilege Escalation | 低权身份触发高权动作 | 角色-动作不匹配 | RBAC/ABAC 强校验、短期令牌 | block |
| Supply Chain Poisoning | 恶意插件或依赖投毒 | 签名失败、CVE/恶意包命中 | 签名校验、SBOM、可信源仓库 | install block |
| DoS / Resource Abuse | 超长 prompt / 高频调用 | token 长度异常、速率突增 | 限流、配额、超时与熔断 | throttle/block |
| Jailbreak变体 | 编码混淆、角色扮演绕过 | 语义模型异常分 + 模式命中 | 多模型交叉判定、策略硬规则 | warn/challenge/block |

---

## 5. OpenClaw Plugin 集成约定（建议接口）

### 5.1 请求上下文扩展
```json
{
  "security_context": {
    "trace_id": "...",
    "tenant_id": "...",
    "user_role": "analyst",
    "env": "prod",
    "policy_version": "...",
    "request_risk_baseline": 20
  }
}
```

### 5.2 决策响应约定
```json
{
  "decision": "challenge",
  "risk_score": 76,
  "reason_codes": ["R-INJ-002", "R-AUTH-004"],
  "required_action": "human_approval",
  "ttl_seconds": 300
}
```

### 5.3 错误处理约定
- `post_error` 将错误映射为：`user_error/system_error/security_error`。
- `security_error` 必须触发审计事件 + 告警管道。

---

## 6. 可扩展性设计（未来演进）

### 6.1 检测能力扩展
- 插件化检测器接口：`Detector::detect(input) -> Finding[]`。
- 支持快速新增：行业专属敏感词、威胁情报 IOC、语言变体注入样式。

### 6.2 模型能力扩展
- 接入多模型投票（主模型 + 轻量校验模型）。
- 对抗样本持续学习（离线微调或规则蒸馏）。

### 6.3 跨域联动扩展
- 对接 SIEM、SOAR、IAM、CMDB。
- 高风险事件自动触发凭据轮换与访问冻结。

### 6.4 多租户扩展
- 支持租户级策略包（policy pack）。
- 支持租户独立数据保留策略与审计导出。

---

## 7. 实施计划（细化）

### Phase 1（2-4 周）：基础闭环
- 接入 `pre_call/post_call`。
- 规则引擎 + DLP 引擎 MVP。
- 安全事件模型与看板总览页。

### Phase 2（4-8 周）：治理增强
- `pre_install` 安装准入。
- 策略 DSL、灰度发布、自动回滚。
- 插件风险画像与攻击态势页。

### Phase 3（8-12 周）：智能化运营
- 语义引擎与异常引擎上线。
- 对抗样本回放平台。
- 告警编排与 SOAR 联动。

---

## 8. 测试与验收方案（可执行）

### 8.1 测试类型
1. 单元测试：规则命中、DSL 解析、冲突决策。
2. 集成测试：Hook 触发、审计事件完整性。
3. 对抗测试：注入、越权、泄露、DoS 样本回放。
4. 性能测试：2x 峰值压测（p95/p99、丢事件率）。
5. 混沌测试：策略服务不可用、日志系统延迟、事件积压。

### 8.2 验收门槛（建议）
- 高危攻击拦截率 ≥ 90%。
- 误报率 ≤ 8%（连续两周）。
- 审计事件完整率 ≥ 99.99%。
- 安全网关新增延迟 p95 ≤ 80ms。

---

## 9. 运维与应急
- 一键切换模式：`observe -> warn -> block`。
- 误阻断应急：5 分钟内回滚到上个策略版本。
- 大规模攻击：限流 + 采样 + 告警分级抑制。
- 事后复盘模板：根因、影响面、规则修正、SLO 变化。

---

## 10. 待确认项
1. OpenClaw 当前 Hook 是否支持字段级拦截改写？
2. 插件权限模型是否已有标准枚举（便于统一风险映射）？
3. 组织现有日志平台是否可直接承接安全事件？
4. 是否允许接入外部威胁情报源做实时加权？
