# SafeClaw Runbook

## Verification Gate
- Treat `npm test` as the required completion check for code changes.
- `npm test` runs `npm run typecheck` before unit tests.
- Do not mark work complete while `npm test` is failing.

## Config Operations
- Edit the local YAML file and redeploy or call `plugin.config.reload()` from the host process.
- If reload validation fails, the plugin keeps `last_known_good`.

## Challenge Approvals
- Monitor challenge decisions from `SecurityDecisionEvent`.
- Approval routing source is dashboard account policies (`is_admin=true`).
- Auto-derived admin mapping is channel-agnostic for command approvals.
- Telegram approval notifications include quick action buttons; other channels use command replies.
- Approval delivery first uses built-in `api.runtime.channel` senders. For Feishu/Lark, if runtime senders are unavailable, SafeClaw falls back to direct OpenAPI delivery with configured `channels.feishu` credentials.
- If neither sender path is available for a channel, approvals can still be queried and handled from admin chat commands.
- If approval routing is available, administrators can review pending requests in chat with `/safeclaw-pending`.
- Add a temporary authorization with `/safeclaw-approve <approval_id>` and a long-lived authorization with `/safeclaw-approve <approval_id> long`.
- Reject a request with `/safeclaw-reject <approval_id>`.
- Approved requests grant the same subject access in the same `scope` until `expires_at`; they are not tied to one exact request replay anymore.
- Expired or rejected approvals cause challenged calls to return `block` and require a fresh authorization request.

## 审批未触发排查
- 先在 `~/.openclaw/logs/gateway.log` 中按时间窗口查 `safeclaw: before_tool_call`。如果没有该日志，说明本次没有发生工具调用。
- 再在会话 transcript（`~/.openclaw/agents/main/sessions/*.jsonl`）中确认是否存在 `toolCall` 事件。若只有 `final_answer` 文本，则本轮是“直接回答”路径。
- SafeClaw 仅在工具调用路径执行策略；无工具调用时不会进入 `before_tool_call`，因此不会产生 `challenge` 审批。
- 若需要强制高风险问题必须走工具链，需要在上层 agent/channel 策略增加“必须提供工具证据”的约束，不能只依赖 SafeClaw 的工具拦截钩子。

## Event Delivery
- If webhook delivery fails, inspect the host's telemetry around `plugin.events.getStats()`.
- A growing `queued` count indicates an unhealthy sink or network path.
- A non-zero `dropped` count means queue or retry limits are too small for the incident window.

## Incident Response
- Switch a hook to `enabled: false` to disable it quickly.
- Change a hook to `fail_mode: open` when host availability is more important than enforcement.
- Prefer reverting the policy rule that caused an incident instead of disabling all hooks.

## 使用新架构组件

### ContextInferenceService

推断上下文信息（路径、工具、标签等）：

```typescript
import { ContextInferenceService } from "./src/domain/services/context_inference_service.ts";

const service = new ContextInferenceService();

// 推断资源上下文
const resource = service.inferResourceContext(args, workspaceDir);
// => { resourceScope: "system", resourcePaths: [...] }

// 推断工具上下文
const tool = service.inferToolContext(toolName, args, scope, paths, workspace);
// => { toolGroup: "execution", operation: "execute", ... }

// 推断标签
const labels = service.inferLabels(toolGroup, paths, summary);
// => { assetLabels: [...], dataLabels: [...] }
```

### ApprovalService

处理审批业务逻辑：

```typescript
import { ApprovalService } from "./src/domain/services/approval_service.ts";

const service = new ApprovalService(repository, adapters, logger);

// 发送通知
const result = await service.sendNotifications(targets, record);

// 判断是否需要重发
if (service.shouldResendPendingApproval(record)) {
  await service.sendNotifications(targets, record);
}

// 格式化审批信息
const reason = service.formatApprovalBlockReason({ ... });
```

### NotificationAdapter

发送消息到不同渠道：

```typescript
import { NotificationAdapterFactory } from "./src/infrastructure/adapters/notification_adapter.ts";

const adapter = NotificationAdapterFactory.create("telegram", openclawAdapter);

const result = await adapter.send(
  { channel: "telegram", to: "user" },
  "message",
  { buttons: [...] }
);
```

### ApprovalCommands

处理审批命令：

```typescript
import { ApprovalCommands } from "./src/application/commands/approval_commands.ts";

const commands = new ApprovalCommands(repository, service, config);

// 处理命令
await commands.handleApprove(ctx);
await commands.handleReject(ctx);
await commands.handlePending(ctx);
```

## 测试新组件

```typescript
// 测试服务（无需 mock OpenClaw API）
const service = new ContextInferenceService();
expect(service.inferResourceContext(...)).toBe(...);

// 测试审批（只需 mock 接口）
const mockRepo: ApprovalRepository = { ... };
const service = new ApprovalService(mockRepo, adapters, logger);
```
