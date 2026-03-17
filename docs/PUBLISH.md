# SecurityClaw Publish Guide

## Default Publish Identity

This repository now defaults to the unscoped npm package name `securityclaw`.

End-user install commands are therefore:

```bash
npx securityclaw install
curl -fsSL https://raw.githubusercontent.com/znary/securityclaw/main/install.sh | bash
```

If npm rejects `securityclaw` because the name is unavailable for your account, change these files before publishing:

- `package.json` `name`
- `package-lock.json` top-level `name`
- `install.sh` default `SECURITYCLAW_NPM_PACKAGE`
- user-facing install commands in `README.md`, `README.zh-CN.md`, and `docs/OPENCLAW_INSTALL.md`

## Preflight Commands

Run the publish checks locally before your first release:

```bash
npm run release:check
npm run release:dry-run
```

`release:check` validates the package name, install script default package, and repository metadata required for provenance.

## GitHub Actions Publish Flow

The repository now includes `.github/workflows/publish-npm.yml`.
It publishes on either:

- a pushed tag matching `v*`
- manual `workflow_dispatch`

The workflow runs:

1. `npm ci`
2. `npm run release:check`
3. `npm test`
4. `npm publish --access public`

The workflow requests `id-token: write` so npm trusted publishing can authenticate via GitHub OIDC.
Per npm's trusted publishing docs, provenance is generated automatically for public packages published from public repositories, so no long-lived npm publish token is required when trusted publishing is configured.

## What You Need To Do Manually

You still need to handle these npm and GitHub platform steps yourself:

1. Sign in to npm and confirm the current account is the one that should publish `securityclaw`.
2. If `securityclaw` is unavailable, choose another package name you control and update `package.json`, `install.sh`, and the install docs together.
3. On npm, configure trusted publishing for GitHub repository `znary/securityclaw` and workflow file `.github/workflows/publish-npm.yml`.
4. Push a release tag such as `v0.1.0`, or trigger the workflow manually from GitHub Actions.
5. After trusted publishing works, enable the npm setting that requires 2FA and disallows tokens if you want the stricter setup recommended by npm.

## What You Need To Do To Upload To npm

If you want to actually publish the package to npm, use this order:

1. Run `npm run release:check` and `npm run release:dry-run` locally.
2. Run `npm whoami` and confirm the logged-in npm account is the one that should publish `securityclaw`.
3. If you want GitHub Actions to publish, configure trusted publishing on npm and then push a tag like `v0.1.0`.
4. If you want to do the first release manually, run `npm login` and then `npm publish --access public`.
5. After the first successful publish, switch back to trusted publishing so future releases only require pushing a tag instead of maintaining a long-lived token.

If you prefer a first manual publish instead of trusted publishing, you can run:

```bash
npm publish --access public
```

That path requires `npm login` first and an account with publish rights for the target package name.

## Reference

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub Actions npm publishing](https://docs.github.com/actions/automating-your-workflow-with-github-actions/publishing-nodejs-packages)
