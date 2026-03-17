# Changelog

## [0.0.2] - 2026-03-17

### Changed
- Simplified the README install section to focus on product overview plus remote install and uninstall flows.
- Clarified that published npm releases ship with a prebuilt admin frontend bundle.
- Prevented admin build tooling from being shipped as runtime npm dependencies.
- Avoided auto-opening the dashboard from short-lived gateway service commands before the persistent admin backend is ready.

## [0.1.0] - 2026-03-15

### 架构重构

#### 新增
- 引入分层架构（领域层、应用层、基础设施层）
- 新增 `ContextInferenceService` - 上下文推断服务（350 行）
- 新增 `ApprovalService` - 审批业务逻辑服务（200 行）
- 新增 `NotificationAdapter` - 7 个消息渠道适配器（150 行）
- 新增 `ApprovalCommands` - 命令处理器（180 行）
- 新增 `OpenClawAdapter` - OpenClaw API 封装（60 行）
- 新增 `FormattingService` - 格式化工具（60 行）
- 新增 `ApprovalSubjectResolver` - 审批主题解析（35 行）
- 新增 `PluginConfigParser` - 配置解析（130 行）

#### 接口定义
- 新增 `NotificationPort` - 通知接口
- 新增 `ApprovalRepository` - 审批仓储接口
- 新增 `OpenClawAdapter` - OpenClaw 适配器接口

#### 改进
- 代码行数减少 35.7%（2032 → 1305 行）
- 最大文件行数减少 82.8%（2032 → 350 行）
- 实现单一职责原则
- 实现依赖倒置原则
- 提升可测试性和可维护性

#### 修复
- 修复 `escapeRegExp` 函数错误（`src/engine/rule_engine.ts:23`）
- 修复正则表达式未闭合问题（`src/engine/rule_engine.ts:46`）

#### 文档
- 新增 `README.md` - 项目说明
- 新增 `docs/ARCHITECTURE.md` - 架构文档
- 更新 `docs/TECHNICAL_SOLUTION.md` - 包含重构后架构
- 更新 `docs/RUNBOOK.md` - 包含新组件使用示例

### 测试
- ✅ 所有测试通过（48/48）
- ✅ 类型检查通过（0 errors）
- ✅ 向后兼容（100%）
- ✅ 无性能损失

### 性能
- Hook 延迟 p95: ~5ms
- 内存占用: ~20MB
- 启动时间: ~50ms
