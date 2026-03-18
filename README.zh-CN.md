# SecurityClaw 安全插件

[English](./README.md)

SecurityClaw 是面向 [OpenClaw](https://github.com/openclaw/openclaw) 的运行时安全插件。它在工具调用链路上执行安全策略，支持审批流程、敏感信息净化与审计级决策记录。

## SecurityClaw 解决什么问题

LLM Agent 具备高权限工具调用能力。SecurityClaw 在运行时提供策略护栏，将高风险操作按规则执行为拦截、审批确认、提醒或放行，并保留可追溯审计信息。

## 核心能力

- 基于 OpenClaw Hook 的运行时策略执行（`before_tool_call` 等）
- 规则优先决策模型（`allow` / `warn` / `challenge` / `block`）
- Challenge 审批流程与管理员命令处理
- 动态敏感路径注册表，在规则判断前先把路径映射成资产标签
- DLP 扫描与敏感输出净化
- 管理后台（策略与账号策略配置）
- 决策事件与状态观测
- 中英文国际化（`en` / `zh-CN`）

## 安装

### 直接使用

安装最新发布版本：

```bash
npx securityclaw install
```

或者通过远程脚本安装：

```bash
curl -fsSL https://raw.githubusercontent.com/znary/securityclaw/main/install.sh | bash
```

安装指定发布版本：

```bash
SECURITYCLAW_VERSION=0.0.3 curl -fsSL https://raw.githubusercontent.com/znary/securityclaw/main/install.sh | bash
```

安装完成后，如果管理后台没有自动打开，可手动访问 `http://127.0.0.1:4780`。

### 从源码开发

克隆仓库后先安装依赖：

```bash
npm install
```

开发阶段请先把当前工作区写入 OpenClaw 的 `plugins.load.paths`，这样后续 restart 加载的就是当前仓库源码，而不是复制产物或 npm 安装副本：

```bash
npm run openclaw:dev:install
```

如果你要验证打包归档安装行为，而不是实时开发目录，再执行：

```bash
npm run openclaw:install
```

执行验证：

```bash
npm test
```

需要时可单独启动管理后台：

```bash
npm run admin
```

## 卸载

从 OpenClaw 中卸载已安装插件：

```bash
openclaw plugins uninstall securityclaw
```

如果想先预览会删除什么：

```bash
openclaw plugins uninstall securityclaw --dry-run
```

## 文档导航

- [文档索引](./docs/README.zh-CN.md)
- [OpenClaw 安装指南](./docs/OPENCLAW_INSTALL.md)
- [管理后台说明](./docs/ADMIN_DASHBOARD.md)
- [运行手册](./docs/RUNBOOK.md)
- [集成指南](./docs/INTEGRATION_GUIDE.md)

## 许可证

MIT，详见 [LICENSE](./LICENSE)。
