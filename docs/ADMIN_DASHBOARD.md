# SafeClaw Admin Dashboard

## Start
- Default behavior: once OpenClaw loads `safeclaw`, dashboard auto-starts at `http://127.0.0.1:4780`.
- Optional manual mode: run `npm run admin` when you want standalone startup or local debugging.
- You can set `plugins.entries.safeclaw.config.adminAutoStart=false` to disable auto-start.

## UI Focus (Novice Friendly)
- Health summary card with plain-language guidance (`stable / cautious / too strict`).
- Decision metrics shown as readable cards (`allow`, `warn/challenge`, `block`).
- One-click strategy presets:
  - `轻防护（误伤少）`
  - `平衡（默认）`
  - `严格（拦截更多）`
- Rule-level strategy switches:
  - each `policy` can be enabled/disabled directly from UI
  - supports `全部开启 / 全部关闭`
  - technical fields (`rule_id`, `priority`, `reason_codes`) are hidden from default cards
  - each card explains user impact in plain language and includes a concrete example
  - toggle changes sync into advanced JSON automatically
- Unsaved-change protection: auto-refresh will not overwrite local edits.
- Optional advanced mode for full `policies` JSON editing.

## Strategy Configuration
- The panel writes overrides to `config/policy.overrides.json` via `PUT /api/strategy`.
- Editable fields:
  - `environment`
  - risk thresholds (`base_score`, `warn/challenge/block_threshold`)
  - full `policies` array (JSON)
- Save validation rules:
  - all thresholds must be numbers
  - must satisfy `base_score <= warn_threshold <= challenge_threshold <= block_threshold`
  - `policies` must be a JSON array
- Advanced JSON and toggle panel stay in sync:
  - toggling rules updates JSON text
  - JSON can be synced back to toggle panel via `从 JSON 更新上面的策略开关`

## Runtime Status
- Data source: `runtime/safeclaw-status.json` via `GET /api/status`.
- Shows totals and recent decisions with simplified labels.
- Technical paths (config/override/status) are moved into collapsible details.

## Notes
- Override updates are validated against SafeClaw config schema before saving.
- If your OpenClaw runtime does not hot-reload plugin config files, restart `openclaw-gateway` after saving strategy updates.

## Environment Variables
- `SAFECLAW_ADMIN_PORT` (default `4780`)
- `SAFECLAW_CONFIG_PATH` (default `config/policy.default.yaml`)
- `SAFECLAW_OVERRIDE_PATH` (default `config/policy.overrides.json`)
- `SAFECLAW_STATUS_PATH` (default `runtime/safeclaw-status.json`)
