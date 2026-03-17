# SafeClaw Security Plugin 技术方案 v1.1

## 1. 方案定位
本方案实现的是 **Plugin**，不是 OpenClaw 核心平台改造。
- 只依赖公开 Hook 和插件能力。
- 平台侧不可控能力，通过“边界声明 + 辅助工具”处理。

## 2. 架构

```text
OpenClaw Runtime Hooks
   ├─ before_prompt_build  -> ContextGuard
   ├─ before_tool_call     -> PolicyGuard
   ├─ after_tool_call      -> ResultGuard
   ├─ tool_result_persist  -> PersistGuard
   └─ message_sending      -> OutputGuard

SafeClaw Plugin Core
   ├─ Rule Engine
   ├─ Decision Engine (rule/default/approval)
   ├─ Approval State Machine
   ├─ DLP Engine
   ├─ Event Emitter (schema_versioned)
   └─ Config Manager

External Integrations (optional)
   ├─ Webhook sink
   ├─ Dashboard backend
   └─ Admission CLI in CI
```

## 3. 模块实现

## 3.1 ContextGuard（before_prompt_build）
### 输入
- 原始 prompt 构建上下文
- 来源信息（external/internal）

### 处理
- 给 external content 打 `untrusted=true`
- 注入 `security_context`：`trace_id`, `actor_id`, `workspace`, `policy_version`

### 输出
- 增强上下文对象

## 3.2 PolicyGuard（before_tool_call）
### 输入
- tool name/group
- actor、scope、resource_scope、resource_paths

### 处理
1. 规则匹配（identity/scope/tool/tags/resource_scope/path_prefix）
2. 敏感路径注册表推断：
   - 先把路径按内置/运行时覆写的 registry 映射为 asset labels
   - 支持 `prefix` / `glob` / `regex`
   - 支持删除内置项和补充自定义项
2. 决策选择：
   - 命中规则：按优先级和匹配精度选择规则动作
   - 无命中：默认放行（`NO_MATCH_DEFAULT_ALLOW`）
3. challenge 进入审批状态机

### 输出
- `allow/warn/challenge/block`
- reason codes
- decision source（`rule/default/approval`）

### 审批状态机（challenge）
- `pending -> approved/rejected/expired`
- 字段：`approval_id`, `requested_at`, `ttl`, `approver`, `decision`

## 3.3 ResultGuard（after_tool_call）
### 处理
- JSON schema 校验
- DLP（PII/secret/token pattern）
- 高风险字段处理：mask/remove

### 策略
- `on_dlp_hit: warn|block|sanitize`

## 3.4 PersistGuard（tool_result_persist）
### 目标
防止敏感内容落盘到 session transcript。

### 处理
- 对命中字段执行不可逆净化
- 失败策略：
  - strict: block persist
  - compat: persist redacted

## 3.5 OutputGuard（message_sending）
### 目标
最终回复防泄露。

### 处理
- 二次 DLP
- 越权内容裁剪
- 输出最终 `sanitization_actions`

## 3.6 Event Emitter
### 事件结构
```json
{
  "schema_version": "1.0",
  "event_type": "SecurityDecisionEvent",
  "trace_id": "...",
  "hook": "before_tool_call",
  "decision": "challenge",
  "reason_codes": ["FILE_ENUMERATION_REQUIRES_APPROVAL"],
  "latency_ms": 14,
  "ts": "2026-03-13T10:00:00Z"
}
```

### 投递
- 至少一次（at-least-once）
- sink 失败时本地缓冲重试（有上限）

## 3.7 Config Manager
### 配置源
- 本地 YAML（必选）
- SQLite 运行时策略覆盖（可选）

### 可热更新内容
- 规则动作 (`policies`)
- 账号策略 (`account_policies`)
- 敏感路径注册表覆写 (`sensitivity.disabled_builtin_ids`, `sensitivity.custom_path_rules`)

### 热更新
- 拉取 -> 校验 -> 原子替换
- 失败回滚到 last known good

## 4. 攻击覆盖（Plugin 能力边界内）
- Prompt Injection（主路径）
- Tool Hijacking（主路径）
- Data Exfiltration（返回/落盘/消息）
- Control-plane tool abuse（通过规则封禁）

## 5. 非目标（再次确认）
- 不承诺拦截所有 HTTP/RPC/service 旁路调用（除非接入额外网关）
- 不承诺平台级多租户硬隔离

## 6. 性能与可靠性
- 常规请求路径 p95 < 80ms
- 决策路径超时保护（超时后走降级策略）
- 所有 guard 模块支持独立开关与熔断

## 7. 代码结构（重构后）

### 分层架构

```text
safeclaw-plugin/
  src/
    domain/                          # 领域层（核心业务逻辑）
      models/
        resource_context.ts          # 领域模型
      ports/                         # 接口定义（依赖倒置）
        notification_port.ts
        approval_repository.ts
        openclaw_adapter.ts
      services/                      # 领域服务
        context_inference_service.ts # 上下文推断（350 行）
        approval_service.ts          # 审批业务逻辑（200 行）
        approval_subject_resolver.ts
        formatting_service.ts
    
    application/                     # 应用层（编排业务逻辑）
      commands/
        approval_commands.ts         # 命令处理器
    
    infrastructure/                  # 基础设施层（外部依赖）
      adapters/
        notification_adapter.ts      # 7 个渠道适配器
        openclaw_adapter_impl.ts     # OpenClaw API 封装
      config/
        plugin_config_parser.ts
    
    hooks/                           # Hook 处理器
      context_guard.ts
      policy_guard.ts
      result_guard.ts
      persist_guard.ts
      output_guard.ts
    
    engine/                          # 决策引擎
      rule_engine.ts
      decision_engine.ts
      approval_fsm.ts
      dlp_engine.ts
    
    approvals/                       # 审批存储
      chat_approval_store.ts         # 实现 ApprovalRepository
    
    events/
      schema.ts
      emitter.ts
    
    config/
      loader.ts
      validator.ts
      live_config.ts
      runtime_override.ts
      strategy_store.ts
  
  config/
    policy.default.yaml
  
  docs/
    schema.security_event.json
```

### 架构优势

**重构前问题**:
- ❌ index.ts 单文件 2032 行（上帝对象）
- ❌ 职责不清，难以维护
- ❌ 紧耦合，难以测试
- ❌ 代码复用性差

**重构后改进**:
- ✅ 清晰的分层架构（领域层、应用层、基础设施层）
- ✅ 单一职责原则（每个类只做一件事）
- ✅ 依赖倒置（通过接口解耦）
- ✅ 易于测试（可独立测试每个组件）
- ✅ 代码减少 35.7%（2032 → 1305 行）

### 核心组件

**ContextInferenceService** (350 行)
- 路径推断和分类（系统/工作区内/工作区外）
- 工具组和操作推断
- URL 分类（公网/内网/个人存储）
- 标签推断（资产标签/数据标签）

**ApprovalService** (200 行)
- 发送审批通知（支持重试）
- 判断是否需要重发
- 格式化审批信息

**NotificationAdapter** (150 行)
- 7 个消息渠道适配器（Telegram, Discord, Slack, Signal, iMessage, WhatsApp, Line）
- 工厂模式创建适配器

**ApprovalCommands** (180 行)
- 处理 approve/reject/pending 命令

## 8. 开发顺序
1. `before_tool_call + decision_engine + event_emitter`
2. `tool_result_persist + message_sending` 双保险脱敏
3. `approval_fsm + sqlite strategy workflow + dashboard`

## 9. 测试计划
- 单测：规则匹配、审批状态机、DLP 命中
- 集成：五 hook 串联行为
- 回放：注入样本、泄露样本
- 性能：常规与高风险路径 p95/p99
