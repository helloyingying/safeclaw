# SecurityClaw Integration Guide

## Install Shape
- Provide the plugin package to an OpenClaw-compatible host.
- Load a local YAML file such as `config/policy.default.yaml`.
- Wire the returned `hooks` object into the host's five public hook points.

## Minimal Usage
```ts
import { createSecurityClawPlugin } from "../src/index.ts";

const plugin = createSecurityClawPlugin({
  config_path: "./config/policy.default.yaml"
});

const result = await plugin.hooks.before_tool_call({
  actor_id: "contractor",
  workspace: "payments",
  scope: "default",
  tool_name: "network.http"
});
```

## Rule-First Decision Model
- `before_tool_call` only depends on matched rules.
- Decision sources are:
  - `rule`: at least one matching rule provides a decision.
  - `default`: no rule matched, fallback is allow.
  - `approval`: previously approved challenge replay.
- There is no risk scoring or threshold fallback in the decision path.

## Approval Flow
- `before_tool_call` returns `decision: "challenge"` and an `approval` record when approval is required.
- An external control plane stores `approval.approval_id`.
- The approver resolves the request through `plugin.approvals.resolveApproval(approvalId, approver, "approved")`.
- The host replays the tool call with `approval_id` set to the approved record.

## Event Sink
- Set `event_sink.webhook_url` in YAML to enable webhook delivery.
- The plugin emits at-least-once and buffers transient sink failures in memory.
- If the queue exceeds `max_buffer` or retry attempts exceed `retry_limit`, events are dropped and counted internally.

## Failure Policy
- Each hook has its own `enabled`, `timeout_ms`, and `fail_mode`.
- `fail_mode: open` preserves the original payload and returns `allow`.
- `fail_mode: close` preserves the original payload and returns `block`.
