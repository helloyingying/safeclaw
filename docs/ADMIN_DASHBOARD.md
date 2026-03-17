# SecurityClaw Admin Dashboard

## Start
- Default behavior: when `securityclaw` is loaded inside a persistent OpenClaw gateway service/runtime, dashboard auto-starts at `http://127.0.0.1:4780`.
- Published release archives ship with a prebuilt admin frontend bundle, so installed plugins do not rebuild `admin/public/app.js` at install/startup time.
- Optional manual mode: run `npm run admin` when you want standalone startup or local debugging.
- `npm run admin` rebuilds the local frontend bundle first so repository checkouts stay in sync during development.
- Short-lived CLI commands such as `openclaw gateway restart` do not keep the dashboard process alive.
- `openclaw.json` usually does not need a `securityclaw.config` block at all; add `adminPort` only when you want a non-default port.
- You can still set `plugins.entries.securityclaw.config.adminAutoStart=false` to disable auto-start.

## Current UI Behavior
- Locale switch:
  - default language follows the host system locale.
  - supports `EN` and `中文` in the dashboard header.
  - preference is persisted in browser local storage.
  - API save calls include `x-securityclaw-locale` so backend status messages follow UI language.
- Theme switch:
  - supports `system`, `light`, and `dark` in the dashboard header.
  - preference is persisted in browser local storage.
  - first paint resolves theme before stylesheet render to avoid light-theme flash.
- UI contribution baseline:
  - dashboard UI work should ship with both `en` / `zh-CN` coverage and light / dark theme support by default.
  - new user-facing text should reuse the existing locale path instead of hardcoded single-language copy.
  - new visual states should be built on shared theme tokens so charts, tables, badges, toolbars, and status states remain readable in both themes.
- Metrics card: decision totals (`allow`, `warn/challenge`, `block`).
- Overview skill snapshot:
  - overview now includes a compact `Skill Interception` summary card.
  - the card shows discovered skills, high/critical counts, 24h `challenge/block`, undeclared-change alerts, quarantine counts, and top-priority skill highlights.
  - highlighted skills can jump directly into the dedicated skill panel.
- Recent decisions table: time, decision, source, resource scope, hook, tool, reasons.
- Rule panel:
  - rules are grouped by `group` (for example `filesystem`, `email`, `album`).
  - each rule exposes a strategy action selector (`allow`, `warn`, `challenge`, `block`).
  - the same panel now includes a sensitive-path registry section ahead of grouped rules.
  - sensitive paths are resolved into asset labels first, then the downstream rules decide `warn/challenge/block`.
  - built-in path mappings can be removed from UI, and removed built-ins can be restored later.
  - custom path mappings can be added with `prefix`, `glob`, or `regex` matching.
  - rule technical IDs are hidden behind readable names when available.
  - dashboard no longer exposes per-rule enable switches; rule editing is action-first.
- Unsaved-change protection: auto-refresh will not overwrite local edits.
- Accounts panel admin mapping:
  - setting an account policy with `is_admin=true` automatically enrolls that account as SecurityClaw approval notify target + command approver at runtime.
  - admin account selection is single-choice; at most one account can be admin at the same time.
  - this mapping does not write back to `~/.openclaw/openclaw.json`.
  - all channels can use command approvals; Telegram also shows quick action buttons in approval notifications.
- Skill interception panel:
  - dashboard discovers installed skills from local OpenClaw/Codex skill roots and stores scan results in SQLite.
  - list view supports filtering by risk tier, state, source, undeclared-change status, and recent intercept activity.
  - detail view shows risk score, findings, recent activity, install path, and current content hash.
  - admin actions include `rescan`, `quarantine`, and time-bound `trust override`.
  - policy section edits score thresholds, risk-by-severity matrix, and default handling for unscanned or changed-without-version-update skills.

## Strategy Configuration
- The panel writes overrides to SQLite (`~/.openclaw/extensions/securityclaw/data/securityclaw.db` by default) via `PUT /api/strategy`.
- Editable fields from UI:
  - full `policies` array, mainly `decision` per rule.
  - `sensitivity.custom_path_rules`
  - `sensitivity.disabled_builtin_ids`
- Save validation:
  - `policies` must be a JSON array.
  - each rule must have `rule_id`, `priority`, and a valid `decision`.
  - custom sensitive path rules must have `id`, `asset_label`, `match_type`, and `pattern`.

## Sensitive Path Registry
- Purpose:
  - centralize which filesystem paths are considered sensitive before policy rules evaluate asset labels.
- Built-in categories:
  - credential stores
  - personal content
  - download staging
  - browser profiles
  - browser secret stores
  - communication stores
- Runtime behavior:
  - base mappings come from config schema defaults / built-in registry.
  - dashboard changes are persisted in SQLite runtime overrides and hot-applied on next decision.
  - disabling a built-in mapping removes that path-to-label inference without rewriting policy definitions.

## Runtime Status
- Data source: `~/.openclaw/extensions/securityclaw/runtime/securityclaw-status.json` by default via `GET /api/status`.
- Shows totals and recent decisions with simplified labels.
- Skill interception status uses SQLite-backed APIs (`/api/skills/status`, `/api/skills`, `/api/skills/:skillId`, `/api/skills/policy`).

## Notes
- Override updates are validated against SecurityClaw config schema before saving.
- If your OpenClaw runtime does not hot-reload plugin config files, restart `openclaw-gateway` after saving strategy updates.

## Environment Variables
- `SECURITYCLAW_ADMIN_PORT` (default `4780`)
- `SECURITYCLAW_CONFIG_PATH` (default `config/policy.default.yaml`)
- `SECURITYCLAW_DB_PATH` (default `~/.openclaw/extensions/securityclaw/data/securityclaw.db`)
- `SECURITYCLAW_LEGACY_OVERRIDE_PATH` (default `config/policy.overrides.json`, read-once migration input)
- `SECURITYCLAW_STATUS_PATH` (default `~/.openclaw/extensions/securityclaw/runtime/securityclaw-status.json`)
