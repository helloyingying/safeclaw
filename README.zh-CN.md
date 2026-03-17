# SafeClaw 安全插件

[English](./README.md)

SafeClaw 是面向 [OpenClaw](https://github.com/openclaw/openclaw) 的运行时安全插件。它在工具调用链路上执行安全策略，支持审批流程、敏感信息净化与审计级决策记录。

## SafeClaw 解决什么问题

LLM Agent 具备高权限工具调用能力。SafeClaw 在运行时提供策略护栏，将高风险操作按规则执行为拦截、审批确认、提醒或放行，并保留可追溯审计信息。

## 核心能力

- 基于 OpenClaw Hook 的运行时策略执行（`before_tool_call` 等）
- 规则优先决策模型（`allow` / `warn` / `challenge` / `block`）
- Challenge 审批流程与管理员命令处理
- 动态敏感路径注册表，在规则判断前先把路径映射成资产标签
- DLP 扫描与敏感输出净化
- 管理后台（策略与账号策略配置）
- 决策事件与状态观测
- 中英文国际化（`en` / `zh-CN`）

## 架构说明

分层结构如下：

- `domain`：策略、审批、上下文推断、格式化
- `domain/services/sensitive_path_registry.ts`：内置 + 运行时覆写的敏感路径映射
- `engine`：规则匹配、决策引擎、DLP
- `config`：YAML 基线配置 + SQLite 运行时覆盖
- `admin`：管理后台前后端
- `monitoring`：运行状态与决策快照

详见 [架构文档](./docs/ARCHITECTURE.md) 与 [技术方案](./docs/TECHNICAL_SOLUTION.md)。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 执行验证

```bash
npm test
```

### 3. 启动管理后台（独立模式）

```bash
npm run admin
```

默认地址：`http://127.0.0.1:4780`

## OpenClaw 集成示例

在 `~/.openclaw/openclaw.json` 增加插件配置：

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["safeclaw"],
    "load": {
      "paths": ["/absolute/path/to/safeclaw"]
    },
    "entries": {
      "safeclaw": {
        "enabled": true,
        "config": {
          "configPath": "./config/policy.default.yaml",
          "dbPath": "./runtime/safeclaw.db",
          "statusPath": "./runtime/safeclaw-status.json",
          "adminAutoStart": true,
          "adminPort": 4780
        }
      }
    }
  }
}
```

## 审批命令

当账号策略中配置 `is_admin=true` 后，管理员可在聊天渠道执行：

- `/safeclaw-approve <approval_id>`
- `/safeclaw-approve <approval_id> long`
- `/safeclaw-reject <approval_id>`
- `/safeclaw-pending`

## 管理后台

管理后台支持中英文切换，并将语言偏好保存在本地存储。
默认跟随系统语言。

核心模块：

- 概览：总体态势与趋势
- 决策记录：最近决策事件与原因
- 规则策略：按分组编辑规则动作，并维护敏感路径注册表
- 账号策略：管理员审批账号与模式配置

敏感路径注册表说明：

- 内置覆盖凭据目录、个人内容目录、下载暂存区、浏览器资料目录、浏览器密钥库和通信存储。
- 路径注册表与规则动作一起持久化到 SQLite 运行时策略覆盖中。
- 可在后台删除内置项，也可直接添加自定义路径，无需手改基线 YAML。

## 文档导航

- [文档索引](./docs/README.zh-CN.md)
- [OpenClaw 安装指南](./docs/OPENCLAW_INSTALL.md)
- [管理后台说明](./docs/ADMIN_DASHBOARD.md)
- [运行手册](./docs/RUNBOOK.md)
- [集成指南](./docs/INTEGRATION_GUIDE.md)

## 开发命令

```bash
npm run typecheck
npm run test:unit
npm test
npm run admin:build
```

## 项目状态

当前仓库仍配置为私有包（`package.json` 中 `"private": true`）。

## 许可证

暂未声明。
