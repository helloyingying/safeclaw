# SafeClaw Agent Notes

## Completion Gate
- Treat type and syntax validation as a required completion goal.
- Before marking any code change done, run `npm test`.
- `npm test` is the canonical verification command and must include `npm run typecheck`.
- Do not claim completion while `npm test` is red.

## Frontend Baseline
- For any user-facing frontend change, including the admin dashboard, treat internationalization and dark-mode support as default requirements rather than optional polish.
- New or changed UI copy must be wired through the existing locale path (`en` and `zh-CN`) instead of introducing single-language user-facing strings.
- New or changed UI surfaces must work in both light and dark themes. Prefer shared theme tokens / CSS variables and avoid hardcoded colors that only work in one theme.
- When touching charts, tables, badges, empty states, toolbars, forms, or status feedback, verify contrast, hover, focus, and active states in both themes.
- Unless the user explicitly scopes work to a single locale or single theme, do not ship frontend work that lacks both locale coverage and light/dark adaptation.

## OpenClaw Restart
- If a change requires OpenClaw gateway/plugin reload to take effect, perform the restart yourself instead of asking the user to do it manually.
- Use `openclaw gateway restart` as the default restart command unless the environment clearly requires another OpenClaw service command.
- After a required restart, verify the service with `openclaw gateway status` or an equally direct OpenClaw health check before marking the task done.
- Do not mark a restart-dependent task complete if the restart or verification step is still pending; report the concrete blocker instead.
