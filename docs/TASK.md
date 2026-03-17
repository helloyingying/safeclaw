# SecurityClaw Task Progress

Last updated: 2026-03-15

## Current Stage Progress

### Completed
- Runtime decision path has been migrated to a rule-first model:
  - no `score`/`risk_threshold` fallback
  - no-rule default is explicit `allow`
- Tool name compatibility is in place:
  - `exec` is normalized to `shell.exec` during policy evaluation.
- Policy model has been simplified:
  - rule is the only decision dimension
  - rules support `group` for dashboard grouping
  - per-rule strategy action supports `allow/warn/challenge/block`
- Admin dashboard has been updated:
  - grouped rule display
  - per-rule action editor
  - removed group-level and rule-level enable switches
- Default configuration has been cleaned:
  - removed `prod`-specific rules and naming
  - removed risk-related config fields
- Observability has been aligned:
  - `SecurityDecisionEvent` no longer includes `risk_score`
  - `before_tool_call` logs include `trace_id`, `tool`, `decision`, `rules`, `reasons`
- Verification gate has been hardened:
  - `npm test` is now the required completion check
  - `npm test` runs `npm run typecheck` before unit tests

### Verification Notes
- Required done-gate passes (`npm test`, which includes `npm run typecheck` and unit tests).
- Admin bundle rebuild succeeds (`npm run admin:build`).
- Dashboard writes action edits to SQLite (`runtime/securityclaw.db`) through `PUT /api/strategy`.

## Next Plan

1. Add grouped filtering/search in dashboard when rules grow.
2. Add rule create/delete workflow in dashboard (currently edit-focused).
3. Add config snapshot + rollback support for strategy records in SQLite.
4. Add integration test covering admin action edit -> runtime decision change.
