# SafeClaw Security Plugin 技术方案 v1.0

## 1. 方案定位
本方案实现的是 **Plugin**，不是 OpenClaw 核心平台改造。
- 我们只依赖公开 Hook 和插件能力。
- 平台侧不可控能力，通过“边界声明 + 辅助工具”解决。

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
   ├─ Risk Scorer
   ├─ Decision Engine (allow/warn/challenge/block)
   ├─ Approval State Machine
   ├─ DLP Engine
   ├─ Event Emitter (schema_versioned)
   └─ Config Manager

External Integrations (optional)
   ├─ Webhook / Kafka sink
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
- actor、scope、context risk

### 处理
1. identity check
2. scope check
3. risk check
4. decision merge

### 输出
- `allow/warn/challenge/block`
- reason codes

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
  "reason_codes": ["SCOPE_DENY"],
  "risk_score": 73,
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
- 远程配置（可选）

### 热更新
- 拉取 -> 校验 -> 原子替换
- 失败回滚到 last known good

## 4. 攻击覆盖（Plugin 能力边界内）
- Prompt Injection（主路径）
- Tool Hijacking（主路径）
- Data Exfiltration（返回/落盘/消息）
- Control-plane tool abuse（通过策略封禁）

## 5. 非目标（再次确认）
- 不承诺拦截所有 HTTP/RPC/service 旁路调用（除非接入额外网关）
- 不承诺平台级多租户硬隔离

## 6. 性能与可靠性
- 常规请求路径 p95 < 80ms
- 决策路径超时保护（超时后走降级策略）
- 所有 guard 模块支持独立开关与熔断

## 7. 代码结构建议
```text
safeclaw-plugin/
  src/
    hooks/
      context_guard.ts
      policy_guard.ts
      result_guard.ts
      persist_guard.ts
      output_guard.ts
    engine/
      rule_engine.ts
      risk_scorer.ts
      decision_engine.ts
      approval_fsm.ts
      dlp_engine.ts
    events/
      schema.ts
      emitter.ts
    config/
      loader.ts
      validator.ts
      hot_reload.ts
  config/
    policy.default.yaml
  docs/
    schema.security_event.json
```

## 8. 开发计划（可编码）
1. 先实现 `before_tool_call + decision_engine + event_emitter`
2. 再实现 `tool_result_persist + message_sending` 双保险脱敏
3. 最后实现 `approval_fsm + hot_reload + sink`

## 9. 测试计划
- 单测：规则匹配、审批状态机、DLP 命中
- 集成：五 hook 串联行为
- 回放：注入样本、泄露样本
- 性能：常规与高风险路径 p95/p99
