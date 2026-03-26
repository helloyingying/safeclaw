# SecurityClaw Agent Notes

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
- For local SecurityClaw development, run `npm run openclaw:dev:install` before any `openclaw gateway restart`, or use that command as the restart path directly. It dynamically refreshes `plugins.load.paths` to the current repo root so reloads do not keep using an older copied/npm-installed plugin snapshot.
- Do not assume an existing install under `~/.openclaw/extensions/securityclaw` is acceptable for development reloads; refresh the dev load path first.
- Use `openclaw gateway restart` as the default restart command only after the dev load-path requirement above is satisfied, unless the environment clearly requires another OpenClaw service command.
- After a required restart, verify the service with `openclaw gateway status` or an equally direct OpenClaw health check before marking the task done.
- Do not mark a restart-dependent task complete if the restart or verification step is still pending; report the concrete blocker instead.

## npm Release Workflow
- GitHub Actions publishing still uses the version in `package.json`. A release tag only triggers the workflow; it does not replace the package version.
- Before releasing a new npm version, update `package.json` and `package-lock.json` to the target version. Do not create or push a release tag for an old version number.
- When the user asks to publish a new version, commit the current release-ready changes first.
- If the current branch is not `main`, merge that branch into `main` before creating the release tag. Do not tag a side branch.
- Create the release tag from `main` using the format `v<version>`, where `<version>` matches `package.json`.
- Push `main` and the release tag to `origin` so `.github/workflows/publish-npm.yml` can publish the package.
- Run `npm test` before the release commit or tag, and do not claim the release is ready if `npm test` fails.
