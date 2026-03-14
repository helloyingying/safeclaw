# SafeClaw OpenClaw Install

## Confirmed Local Environment
- OpenClaw is installed globally at `/Users/liuzhuangm4/.nvm/versions/node/v22.17.0/lib/node_modules/openclaw`.
- A gateway process is running as `openclaw-gateway`.
- The active config file is `~/.openclaw/openclaw.json`.
- OpenClaw loads plugins from `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, and `plugins.load.paths`.
- Plugin config changes require a gateway restart.

## Recommended Install Path
Use the current SafeClaw workspace directly through `plugins.load.paths` so you do not need to publish a package first.

## Config Example
Add this to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["telegram", "safeclaw"],
    "load": {
      "paths": ["/Users/liuzhuangm4/develop/safeclaw"]
    },
    "entries": {
      "telegram": {
        "enabled": true
      },
      "safeclaw": {
        "enabled": true,
        "config": {
          "configPath": "./config/policy.default.yaml",
          "overridePath": "./config/policy.overrides.json",
          "statusPath": "./runtime/safeclaw-status.json",
          "adminAutoStart": true,
          "adminPort": 4780
        }
      }
    }
  }
}
```

## Install Steps
1. Stop the gateway if it is managed manually.
2. Update `~/.openclaw/openclaw.json` with the `plugins.load.paths`, `plugins.allow`, and `plugins.entries.safeclaw` fields above.
3. Keep the SafeClaw repo at `/Users/liuzhuangm4/develop/safeclaw` so OpenClaw can load `index.ts` and `openclaw.plugin.json`.
4. Restart the gateway.
5. Run `openclaw plugins list` and confirm `safeclaw` shows as `loaded`.

## Operational Notes
- `config.configPath` is resolved relative to the plugin root, so `./config/policy.default.yaml` points to this repo's default policy.
- `config.overridePath` stores dashboard-updated strategy overrides (JSON). Keep this file under versioned backup if needed.
- `config.statusPath` is written continuously by SafeClaw and powers runtime status in the admin panel.
- `config.adminAutoStart` defaults to `true`, so dashboard starts automatically after plugin load.
- `config.adminPort` controls dashboard bind port (default `4780`).
- If you want webhook audit delivery, set `plugins.entries.safeclaw.config.webhookUrl`.
- `before_tool_call` policy matching uses plugin `environment` as default `scope` (default is `prod`). Keep this value aligned with your target environment so sensitive tools can be blocked by scope rules.
- `before_tool_call` maps `challenge` to a blocked call with an approval-required reason because OpenClaw does not expose a native pause-and-resume approval hook in this path.
- Blocked/challenged tool calls return a user-facing `blockReason` with `trace_id`, reason codes, and next action text.
- Default policy includes `prod + filesystem.list => challenge` (in OpenClaw it appears as blocked with approval hint), which covers top-level file enumeration attempts.
- Decision observability is emitted to logger on every `before_tool_call` with `trace_id`, `tool`, `risk`, `decision`, matched `rules`, and truncated tool `args`. Tune truncation with plugin config `decisionLogMaxLength`.
- Tool aliases are normalized in runtime (for example `exec` is treated as `shell.exec`) so shell execution policies can still take effect on hosts that use short tool names.
- `tool_result_persist` and `before_message_write` are kept synchronous to match OpenClaw's runtime contract.
