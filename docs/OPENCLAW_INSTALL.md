# SecurityClaw OpenClaw Install

## Confirmed Local Environment
- OpenClaw is installed globally at `/Users/liuzhuangm4/.nvm/versions/node/v22.17.0/lib/node_modules/openclaw`.
- A gateway process is running as `openclaw-gateway`.
- The active config file is `~/.openclaw/openclaw.json`.
- OpenClaw loads plugins from `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, and `plugins.load.paths`.
- Plugin config changes require a gateway restart.

## Recommended Install Path
Prefer a versioned plugin archive installed through `openclaw plugins install` over `plugins.load.paths`.
This keeps the installed plugin under `~/.openclaw/extensions/securityclaw/` instead of loading the live development workspace directly.

## One-Line Local Install
From the SecurityClaw repo root:

```bash
npm run openclaw:install
```

This command will:

1. Build a versioned archive at `dist/znary-securityclaw-<version>.tgz`
2. Install it with `openclaw plugins install`
3. Restart the gateway
4. Verify gateway status

Preview the exact commands without making changes:

```bash
npm run openclaw:install -- --dry-run
```

## End-User Install Entrypoints

### NPX

```bash
npx securityclaw install
```

### Curl | Bash

```bash
curl -fsSL https://raw.githubusercontent.com/znary/securityclaw/main/install.sh | bash
```

Optional environment overrides:

```bash
SECURITYCLAW_VERSION=0.1.0 curl -fsSL https://raw.githubusercontent.com/znary/securityclaw/main/install.sh | bash
SECURITYCLAW_NPM_PACKAGE=securityclaw curl -fsSL https://raw.githubusercontent.com/znary/securityclaw/main/install.sh | bash
```

`securityclaw` is already taken on npm, so the published package is expected to use a scoped name.
This repository defaults to `securityclaw`; if you publish under a different npm scope, update `package.json`, `install.sh`, and the commands above to match.

## Config Example
`openclaw plugins install` will copy the packaged plugin into `~/.openclaw/extensions/securityclaw/` and enable it in config.
If you need to inspect the resulting config manually, it should look like this:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["telegram", "securityclaw"],
    "entries": {
      "telegram": {
        "enabled": true
      },
      "securityclaw": {
        "enabled": true,
        "config": {
          "adminPort": 4780
        }
      }
    }
  }
}
```

In most cases, `securityclaw` does not need any explicit config block at all. Keep only `adminPort` when you want to override the default dashboard port.

## Install Steps
1. Run `npm run openclaw:install`.
2. Run `openclaw plugins list` and confirm `securityclaw` shows as `loaded`.
3. Open `http://127.0.0.1:4780` if you want the local dashboard.

## Operational Notes
- `config.configPath` is optional. If unset, SecurityClaw uses the packaged default policy file.
- SecurityClaw stores SQLite under OpenClaw state: `~/.openclaw/extensions/securityclaw/data/securityclaw.db`.
- `config.overridePath` is only a legacy migration input (read-once import into SQLite), not an active persistence target.
- Runtime status is written under OpenClaw state: `~/.openclaw/extensions/securityclaw/runtime/securityclaw-status.json`.
- `config.adminAutoStart` is optional and defaults to `true`, so dashboard starts automatically when plugin load happens inside a persistent gateway service/runtime.
- `config.adminPort` controls dashboard bind port (default `4780`).
- Relative `dbPath` / `statusPath` values are ignored to avoid writing back into the source tree's `runtime/` directory.
- Release archives ship with a prebuilt admin bundle, so the installed plugin does not need the development `admin/src` tree.
- Short-lived CLI commands that happen to load plugins (for example `openclaw gateway restart`) will skip dashboard auto-start; use `npm run admin` if you want a standalone local dashboard during debugging.
- If you want webhook audit delivery, set `plugins.entries.securityclaw.config.webhookUrl`.
- `before_tool_call` uses a pure rule-first model: matched rules decide `allow/warn/challenge/block`, otherwise default allow.
- `shell.exec` is semantically normalized for filesystem behaviors. When shell command text indicates file operations, SecurityClaw maps it to `filesystem.list/read/search/write/delete/archive` before rule matching, so filesystem rules can cover shell-based access paths.
- When at least one admin account is configured in the dashboard, `challenge` requests are written to SQLite, forwarded to admin chats, and can be approved with `/securityclaw-approve <approval_id>` (temporary) or `/securityclaw-approve <approval_id> long` (long-lived), or rejected with `/securityclaw-reject <approval_id>`.
- Admin accounts are configured only in dashboard account policies (`is_admin=true`). SecurityClaw no longer reads approval targets/approvers from `openclaw.json`.
- Any chat session can be selected as the admin account; command approvals are channel-agnostic.
- Telegram approval notifications include quick action buttons. Other channels use plain-text command replies (`/securityclaw-approve`, `/securityclaw-reject`, `/securityclaw-pending`).
- Approval notification delivery first uses `api.runtime.channel` senders. For Feishu/Lark, SecurityClaw also supports direct OpenAPI delivery using configured `channels.feishu` credentials when runtime senders are unavailable.
- If neither runtime sender nor channel-plugin outbound sender is available, approval requests remain pending and can still be processed via command queries (for example `/securityclaw-pending`).
- Approved requests become subject-level authorizations within the same `scope` until the authorization expires; users can retry after approval and subsequent challenged actions in that scope are also allowed while the authorization is active.
- If no admin account is configured in dashboard, `challenge` maps to a blocked call with an approval-required reason because OpenClaw does not expose a native pause-and-resume approval hook in this path.
- Blocked/challenged tool calls return a user-facing `blockReason` with `trace_id`, reason codes, and next action text.
- Decision observability is emitted to logger on every `before_tool_call` with `trace_id`, `tool`, `decision`, matched `rules`, and truncated tool `args`. Tune truncation with plugin config `decisionLogMaxLength`.
- Tool aliases are normalized in runtime (for example `exec` is treated as `shell.exec`) so shell execution policies can still take effect on hosts that use short tool names.
- SecurityClaw can only enforce policies on actual tool execution paths. If the model answers directly without any tool call, `before_tool_call` does not run and no approval can be triggered for that turn.
- `tool_result_persist` and `before_message_write` are kept synchronous to match OpenClaw's runtime contract.
