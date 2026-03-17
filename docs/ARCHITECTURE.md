# SafeClaw 架构文档

## 架构概览

SafeClaw 采用分层架构，将业务逻辑、应用编排和基础设施清晰分离。

```
┌─────────────────────────────────────────┐
│         Application Layer               │
│  (Commands, Hook Handlers)              │
├─────────────────────────────────────────┤
│         Domain Layer                    │
│  (Services, Models, Ports)              │
├─────────────────────────────────────────┤
│      Infrastructure Layer               │
│  (Adapters, Config, Storage)            │
└─────────────────────────────────────────┘
```

## 核心组件

### 领域层 (Domain Layer)

**ContextInferenceService** - 上下文推断
- 路径分类（系统/工作区内/工作区外）
- 工具组和操作推断
- URL 分类和目标推断
- 标签和数据量推断

**SensitivePathRegistry** - 敏感路径注册表
- 管理内置敏感路径模式
- 合并 SQLite 运行时覆写（删除内置项、自定义项）
- 在标签推断前统一把路径映射成资产标签

**ApprovalService** - 审批业务逻辑
- 发送审批通知（支持重试）
- 判断是否需要重发
- 格式化审批信息
- 计算授权过期时间

**FormattingService** - 格式化工具
- 日志摘要格式化
- 工具名称标准化
- 规则 ID 匹配

### 应用层 (Application Layer)

**ApprovalCommands** - 命令处理器
- `/safeclaw-approve` - 批准审批
- `/safeclaw-reject` - 拒绝审批
- `/safeclaw-pending` - 查询待审批

### 基础设施层 (Infrastructure Layer)

**NotificationAdapter** - 通知适配器
- 支持 7 个消息渠道（Telegram, Discord, Slack, Signal, iMessage, WhatsApp, Line）
- 工厂模式创建适配器
- 统一的通知接口

**OpenClawAdapter** - 平台适配器
- 封装 OpenClaw API 调用
- 提供统一的接口

**PluginConfigParser** - 配置解析
- 解析插件配置
- 路径解析和标准化

**StrategyStore** - 运行时策略存储
- 持久化规则动作、账号策略、敏感路径覆写
- 从 legacy override 文件一次性迁移到 SQLite

## 接口定义 (Ports)

通过接口实现依赖倒置：

- **NotificationPort** - 通知接口
- **ApprovalRepository** - 审批仓储接口
- **OpenClawAdapter** - OpenClaw 适配器接口

## 架构优势

### 重构前问题
- ❌ index.ts 单文件 2032 行（上帝对象）
- ❌ 职责不清，难以维护
- ❌ 紧耦合，难以测试
- ❌ 代码复用性差

### 重构后改进
- ✅ 清晰的分层架构
- ✅ 单一职责原则
- ✅ 依赖倒置（通过接口解耦）
- ✅ 易于测试（可独立测试）
- ✅ 代码减少 35.7%（2032 → 1305 行）

## 测试策略

### 单元测试

```typescript
// 测试领域服务（无需 mock OpenClaw API）
const service = new ContextInferenceService();
expect(service.inferResourceContext(...)).toBe(...);
```

### 集成测试

```typescript
// 测试审批流程（只需 mock 接口）
const mockRepo: ApprovalRepository = { ... };
const service = new ApprovalService(mockRepo, adapters, logger);
```

## 扩展指南

### 新增消息渠道

1. 创建新适配器：
```typescript
class NewChannelAdapter extends BaseNotificationAdapter {
  async send(target, message, options) {
    // 实现逻辑
  }
}
```

2. 在工厂中注册：
```typescript
NotificationAdapterFactory.create("new_channel", adapter);
```

### 新增审批后端

实现 `ApprovalRepository` 接口：

```typescript
class RedisApprovalStore implements ApprovalRepository {
  create(...) { /* ... */ }
  getById(...) { /* ... */ }
  // ... 其他方法
}
```

## 性能指标

| 指标 | 目标 | 实际 |
|------|------|------|
| Hook 延迟 p95 | < 80ms | ~5ms |
| 内存占用 | < 30MB | ~20MB |
| 启动时间 | < 100ms | ~50ms |
| 测试通过率 | 100% | 48/48 |

## Bug 修复记录

### 1. escapeRegExp 函数错误
- **位置**: `src/engine/rule_engine.ts:23`
- **问题**: 将特殊字符替换为 UUID 而非转义字符
- **修复**: 使用 `\\$&` 正确转义
- **影响**: 修复了路径 glob 匹配功能

### 2. 正则表达式未闭合
- **位置**: `src/engine/rule_engine.ts:46`
- **问题**: 正则表达式缺少结束符 `$`
- **修复**: 添加结束符
- **影响**: 修复了路径匹配的边界判断
