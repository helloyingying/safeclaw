# SafeClaw Agent Notes

## Completion Gate
- Treat type and syntax validation as a required completion goal.
- Before marking any code change done, run `npm test`.
- `npm test` is the canonical verification command and must include `npm run typecheck`.
- Do not claim completion while `npm test` is red.

## OpenClaw Restart
- If a change requires OpenClaw gateway/plugin reload to take effect, perform the restart yourself instead of asking the user to do it manually.
- Use `openclaw gateway restart` as the default restart command unless the environment clearly requires another OpenClaw service command.
- After a required restart, verify the service with `openclaw gateway status` or an equally direct OpenClaw health check before marking the task done.
- Do not mark a restart-dependent task complete if the restart or verification step is still pending; report the concrete blocker instead.
