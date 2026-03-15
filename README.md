# SafeClaw Security Plugin

SafeClaw 是一个用于 OpenClaw 平台的安全插件，提供运行时策略执行、数据脱敏和审计事件功能。

## 特性

- 🛡️ **运行时防护** - 基于规则的工具调用拦截
- 🔒 **数据脱敏** - DLP 引擎自动检测和脱敏敏感数据
- 📊 **审计事件** - 完整的安全决策事件记录
- ✅ **审批流程** - 支持 challenge 审批和多渠道通知
- 🔧 **可配置** - 灵活的规则配置和运行时策略覆盖

## 快速开始

### 安装

```bash
npm install
```

### 测试

```bash
npm test
```

### 配置

编辑 `config/policy.default.yaml` 来配置安全策略。

## 架构

SafeClaw 采用分层架构：

```
src/
├── domain/          # 领域层（核心业务逻辑）
├── application/     # 应用层（命令处理）
├── infrastructure/  # 基础设施层（适配器）
├── hooks/           # Hook 处理器
├── engine/          # 决策引擎
└── config/          # 配置管理
```

详见 [架构文档](docs/ARCHITECTURE.md)。

## 核心组件

- **ContextInferenceService** - 上下文推断（路径、工具、标签）
- **ApprovalService** - 审批业务逻辑
- **NotificationAdapter** - 多渠道通知（Telegram, Discord, Slack 等）
- **RuleEngine** - 规则匹配引擎
- **DecisionEngine** - 决策引擎
- **DlpEngine** - 数据泄露防护

## 使用示例

### 推断上下文

```typescript
import { ContextInferenceService } from "./src/domain/services/context_inference_service.ts";

const service = new ContextInferenceService();
const context = service.inferResourceContext(args, workspaceDir);
```

### 处理审批

```typescript
import { ApprovalService } from "./src/domain/services/approval_service.ts";

const service = new ApprovalService(repository, adapters, logger);
await service.sendNotifications(targets, record);
```

详见 [运维手册](docs/RUNBOOK.md)。

## 审批命令

在配置了审批桥接后，管理员可以使用以下命令：

- `/safeclaw-approve <approval_id>` - 批准审批（临时授权）
- `/safeclaw-approve <approval_id> long` - 批准审批（长期授权）
- `/safeclaw-reject <approval_id>` - 拒绝审批
- `/safeclaw-pending` - 查询待审批请求

## 文档

- [产品需求文档](docs/PRD.md)
- [技术方案](docs/TECHNICAL_SOLUTION.md)
- [架构文档](docs/ARCHITECTURE.md)
- [运维手册](docs/RUNBOOK.md)
- [集成指南](docs/INTEGRATION_GUIDE.md)

## 开发

### 运行测试

```bash
npm test                # 运行所有测试
npm run typecheck       # 类型检查
npm run test:unit       # 单元测试
```

### 启动管理面板

```bash
npm run admin
```

## 性能

- Hook 延迟 p95: ~5ms
- 内存占用: ~20MB
- 测试覆盖: 48/48 通过

## 许可证

Private
