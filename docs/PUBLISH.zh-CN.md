# SecurityClaw 发布指南

## 默认发布标识

当前仓库默认使用无 scope 的 npm 包名 `securityclaw`。

因此终端用户安装命令变成：

```bash
npx securityclaw install
curl -fsSL https://raw.githubusercontent.com/znary/securityclaw/main/install.sh | bash
```

如果 npm 提示 `securityclaw` 这个名字不可用，发布前需要把下面几处一起改掉：

- `package.json` 里的 `name`
- `package-lock.json` 顶层 `name`
- `install.sh` 里的默认 `SECURITYCLAW_NPM_PACKAGE`
- `README.md`、`README.zh-CN.md`、`docs/OPENCLAW_INSTALL.md` 里的用户安装命令

## 发布前自检

首发前先在本地执行：

```bash
npm run release:check
npm run release:dry-run
```

`release:check` 会校验包名、安装脚本默认包名，以及生成 provenance 所需的仓库元数据。

## GitHub Actions 发布流程

仓库已经新增 `.github/workflows/publish-npm.yml`。
它支持两种触发方式：

- 推送符合 `v*` 的 tag
- 手动 `workflow_dispatch`

工作流会执行：

1. `npm ci`
2. `npm run release:check`
3. `npm test`
4. `npm publish --access public`

这个工作流开启了 `id-token: write`，用于 npm trusted publishing 的 GitHub OIDC 鉴权。
按照 npm 官方文档，公开仓库里的公开包在 trusted publishing 模式下会自动生成 provenance，因此不需要长期有效的 npm publish token。

## 你需要手动介入的事项

下面这些 npm / GitHub 平台动作仍然需要你自己完成：

1. 登录 npm，确认当前账号就是要发布 `securityclaw` 的那个账号。
2. 如果 `securityclaw` 不可用，就改成你自己可用的包名，并同步修改 `package.json`、`install.sh` 和安装文档里的包名。
3. 在 npm 后台为 GitHub 仓库 `znary/securityclaw` 和工作流文件 `.github/workflows/publish-npm.yml` 配置 trusted publishing。
4. 在 GitHub 上推送发布 tag，例如 `v0.1.0`，或者手动触发 Actions 的 `workflow_dispatch`。
5. trusted publishing 跑通后，如果你要更严格的安全配置，可以按 npm 官方建议启用“要求 2FA 且禁用 token”。

## 上传到 npm 你要做什么

如果你准备真正把包发到 npm，按这个顺序做：

1. 先在本地执行 `npm run release:check` 和 `npm run release:dry-run`。
2. 执行 `npm whoami`，确认当前 npm 登录账号就是要发布 `securityclaw` 的那个账号。
3. 如果你走 GitHub Actions 自动发布，就去 npm 后台配置 trusted publishing，然后推送 `v0.1.0` 这类 tag。
4. 如果你想先手工首发一次，就先执行 `npm login`，再执行 `npm publish --access public`。
5. 首发成功后，再切回 trusted publishing，后面就只需要推 tag，不需要长期 `NPM_TOKEN`。

如果你想先走一次本地手工发布，也可以执行：

```bash
npm publish --access public
```

这条路径要求你先 `npm login`，并且当前登录账号拥有目标包名的发布权限。

## 参考文档

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub Actions 发布 npm 包](https://docs.github.com/actions/automating-your-workflow-with-github-actions/publishing-nodejs-packages)
