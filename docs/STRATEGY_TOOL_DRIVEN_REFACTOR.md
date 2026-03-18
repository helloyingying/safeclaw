# SecurityClaw 策略规则模块重构提案

Last updated: 2026-03-18

## 1. 结论先行

可以改成以 tool 为中心的策略模型，但不应做成“纯 per-tool 开关”。

更准确的目标是：

- **OpenClaw 负责粗粒度 tool access**
  - 哪些 agent 能看到哪些工具。
  - 哪些 agent 在什么 sandbox 中运行。
- **SecurityClaw 负责细粒度 conditional policy**
  - 同一个 tool 在不同上下文下该 `allow` / `warn` / `challenge` / `block`。
  - 审批、目录例外、敏感路径、账号例外都属于条件化控制，而不是一级“规则列表”。

建议把现有“规则策略模块”重构为：

1. `Tool Policy`
2. `Resource Classifier`
3. `Exception Flow`

本轮明确 **不包含** `skill interception` 重构：

- `skill` 属于扩展画像与供应链治理层，不属于 tool access policy。
- 它保留独立数据模型、独立页面、独立处置动作。
- 本轮只做主策略链路的收敛，不碰 skill 评分与漂移模型。

本轮还有两个额外约束：

- **改造仅限于管理后台的 `策略` tab**
  - 不改 `Overview`、`Events`、`Accounts`、`Skills` 等其他 tab 的信息架构。
  - 只重构 `策略` tab 内部的对象模型、布局和交互。
- **按新产品处理，不考虑兼容和迁移包袱**
  - 不需要双写、双读、兼容旧策略结构。
  - 必要时可以清空本地策略库，甚至直接卸载重装插件。

坚持少即是多。用户应该先理解“这个 agent 现在能用什么工具”，再理解“这些工具在什么情境下会被拦截/审批”，最后才是“有哪些例外”。

## 2. 设计依据

这次重构建议直接沿用 OpenClaw / pi 的底层哲学，而不是继续在现有规则面板上叠功能。

### 2.1 来自 pi-mono coding-agent philosophy

核心原则很明确：

- 核心应保持最小，复杂能力通过扩展、技能、外部机制承载。
- 不要把所有工作流都内建进核心，因为那会反过来绑架用户心智模型。
- 不内建 plan mode / todo / permission popup 这类高耦合抽象，而是鼓励通过更贴近环境的机制实现。

对应到 SecurityClaw，含义是：

- 不要让“策略模块”成为一个包罗万象的超级配置中心。
- 不要把目录规则、标签推断、审批、账号例外、skill 风险全塞进同一种“规则”抽象里。
- 不要让用户去理解引擎内部的匹配字段组合，而要暴露贴近运行时真实边界的最小对象。

参考：

- [pi coding-agent README / Philosophy](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#philosophy)

### 2.2 来自 OpenClaw 的系统与安全模型

OpenClaw 本身已经明确给出了几个关键边界：

- agent 看到工具，依赖的是 **system prompt + tool schema** 双通道暴露。
- 真正的硬约束不靠 prompt，而靠 **tool policy、sandbox、allowlist、approval**。
- 多 agent 的安全模型天然就是 **per-agent sandbox + per-agent tool policy**。
- 工具策略支持按 group 收敛，如 `group:runtime`、`group:fs`、`group:ui`、`group:openclaw`。

对应到 SecurityClaw，含义是：

- tool 是真实边界，规则应该围绕 tool capability 组织。
- agent/profile/tool 三层权限继承，应该复用 OpenClaw 已有心智，而不是再造一套平行概念。
- SecurityClaw 最适合做的是“在已允许的 tool 内做上下文判定”，而不是重复定义“agent 有哪些工具”。

参考：

- [OpenClaw System Prompt](https://docs.openclaw.ai/concepts/system-prompt)
- [OpenClaw Tools](https://docs.openclaw.ai/tools/index)
- [OpenClaw Security](https://docs.openclaw.ai/gateway/security)
- [OpenClaw Multi-Agent Sandbox & Tools](https://docs.openclaw.ai/tools/multi-agent-sandbox-tools)

## 3. 当前问题不是规则不够，而是边界错位

### 3.1 一个“策略”概念里混了五种对象

当前后台和存储里，至少混杂了下面几类东西：

1. 决策规则
2. 文件目录例外
3. 敏感路径到标签的推断规则
4. 账号级例外
5. skill 风险拦截策略

它们属于不同层级，但现在被用户感知为一层。

其中第 5 类不应继续并入这次主策略重构，应单独冻结处理。

### 3.2 运行时边界和展示边界不一致

运行时真实顺序是：

1. tool call 进入
2. 推断资源路径/目标/标签
3. 匹配文件规则或策略规则
4. 得出决策
5. 走审批或账号例外

可见：

- `sensitivity.path_rules` 实际上是分类器，不是策略。
- `file_rules` 实际上是例外覆盖层，不是普通规则。
- `account_policies` 实际上是主体级 override，不是规则主体。

但在控制台里，它们被一起展示成“规则策略”。

### 3.3 规则模型过于自由，导致用户无法预测

当前 `RuleEngine` 支持大量 match 字段，并通过加权优先级排序来挑选结果。这个机制对引擎作者友好，但对策略用户不友好。

典型问题：

- 用户看不出“究竟是按 tool、tool_group、path、label 还是数据量在生效”。
- 规则之间的覆盖关系依赖隐藏的 precedence 计算，不是显式层级。
- 同一个行为可能同时涉及路径、标签、目标域名、记录数，用户很难 mentally simulate。

相关实现：

- [src/engine/rule_engine.ts](/Users/liuzhuangm4/develop/securityclaw/src/engine/rule_engine.ts#L125)
- [src/hooks/policy_guard.ts](/Users/liuzhuangm4/develop/securityclaw/src/hooks/policy_guard.ts#L89)

### 3.4 控制台把“编译结果”当成“编辑入口”

当前 rules 面板直接编辑 `policies` 数组，并把 `file_rules` 塞在同一页顶部：

- [admin/src/app.jsx](/Users/liuzhuangm4/develop/securityclaw/admin/src/app.jsx#L3032)

这相当于把引擎内部结构直接暴露给用户。问题不是页面不够漂亮，而是对象模型本身不应该直接暴露。

### 3.5 决策逻辑存在双轨实现，进一步放大理解成本

仓库里存在一套通用插件路径和一套 OpenClaw 集成路径，两边都在拼装策略决策：

- [src/hooks/policy_guard.ts](/Users/liuzhuangm4/develop/securityclaw/src/hooks/policy_guard.ts#L89)
- [index.ts](/Users/liuzhuangm4/develop/securityclaw/index.ts#L2253)

这会导致：

- 文档说的是一套。
- runtime 实际执行的是另一套细节。
- UI 再展示第三种抽象。

## 4. 目标状态：Tool-Driven，但不是 Tool-Only

### 4.1 新的三层模型

建议把策略模型明确拆成三层。

#### Layer A: Tool Policy

回答一个问题：

> 这个 agent 对这个 tool capability 的默认态度是什么？

这一层围绕 OpenClaw 的工具能力组织，而不是围绕规则条目组织。

建议一级对象是：

- `runtime`
- `filesystem`
- `network`
- `browser`
- `sessions`
- `memory`
- `messaging`
- `automation`
- `nodes`
- `media`
- `plugin:<provider>`

再向下到 tool 或 tool group。

#### Layer B: Resource Classifier

回答一个问题：

> 当前调用触达了什么类型的资源？

它不是策略，只负责把上下文归类成稳定的少量维度：

- 资源范围：`workspace_inside` / `workspace_outside` / `system`
- 资源敏感度：`normal` / `credential` / `personal` / `browser_secret` / `communication`
- 目标类型：`internal` / `public` / `personal_storage` / `paste_service`
- 变更类型：`read` / `write` / `delete` / `execute` / `export`
- 信任来源：`trusted` / `untrusted`
- 体量等级：`single` / `bulk`

现有 `sensitive_path_rules` 应该归入这一层。

#### Layer C: Exception Flow

回答一个问题：

> 在默认策略之外，有没有被显式授予的例外？

它只保留三种例外：

1. 目录例外
2. 账号例外
3. 审批例外

skill 风险拦截不应继续挂在“策略规则模块”里，它应保留为独立子系统，并在本轮不动。

### 4.2 用户心智模型应该变成这样

用户只需要理解三句话：

1. 这个 agent 默认能用哪些工具。
2. 这些工具碰到哪些资源/目标时会升级成提醒、审批或拦截。
3. 少量例外在哪里看、为什么生效、能覆盖到什么程度。

而不是让用户去理解：

- 这条规则匹配了哪个 path glob
- 为什么优先级 260 盖过了 240
- asset_label 是规则还是推断
- file rule 为什么又不是 rule

## 5. 推荐的目标架构

### 5.1 数据模型

建议废弃“把所有运行时可编辑内容都挂在 `RuntimeOverride` 顶层”的思路，改为更清晰的对象。

```ts
type StrategyV2 = {
  version: "v2";
  tool_policy: ToolPolicyConfig;
  classifiers: ClassifierConfig;
  exceptions: ExceptionConfig;
};

type ToolPolicyConfig = {
  profiles: ToolPolicyProfile[];
};

type ToolPolicyProfile = {
  subject: "agent" | "agent_group" | "global";
  subject_id: string;
  capabilities: CapabilityPolicy[];
};

type CapabilityPolicy = {
  capability_id: string; // e.g. filesystem, network, runtime, browser
  default_decision: "allow" | "warn" | "challenge" | "block";
  operation_matrix?: OperationMatrix;
};

type ClassifierConfig = {
  sensitive_paths: SensitivePathRule[];
  destination_classes: DestinationClassRule[];
  volume_thresholds: VolumeTierConfig;
};

type ExceptionConfig = {
  directory_overrides: DirectoryOverride[];
  account_overrides: AccountOverride[];
  approval_policies: ApprovalPolicy[];
};
```

这里的关键不是字段长什么样，而是对象边界要稳定：

- **工具策略** 只描述 capability 默认态度。
- **分类器** 只描述如何给调用打上下文标签。
- **例外** 只描述谁被豁免、豁免到什么程度。

由于这是新产品，这个高层模型应直接成为唯一可编辑模型，而不是与旧 `PolicyRule[]` 长期并存。

### 5.2 决策顺序

建议改成固定阶段，而不是让规则隐式竞争。

```text
tool call
  -> canonical tool resolve
  -> capability resolve
  -> resource/destination classification
  -> hard safety guard
  -> capability default policy
  -> contextual matrix
  -> explicit exception overlay
  -> approval flow
  -> decision + provenance
```

推荐的固定顺序：

1. `Hard Guard`
   - 永远不能被普通目录 allow 覆盖。
   - 例如 SecurityClaw 自身数据库、受保护控制面、浏览器 secret store。
2. `Capability Default`
   - 例如 `runtime.exec = challenge`
   - `filesystem.read = allow`
3. `Contextual Matrix`
   - 例如 `filesystem.read + credential = challenge`
   - `network.upload + public + secret = block`
4. `Exception Overlay`
   - 目录 allow/challenge
   - 账号 default_allow
5. `Approval Replay`

这样用户能直接解释“为什么是这个结果”，不需要猜 precedence。

### 5.3 编译式实现，而不是编辑运行时规则数组

推荐做法：

- UI 只编辑高层模型。
- 后端把高层模型 **编译** 成 `CompiledPolicy`.
- runtime 只消费 `CompiledPolicy`.

不要再让 UI 直接写 `policies: PolicyRule[]`。

因为当前 `PolicyRule[]` 是引擎执行格式，不是最小用户模型。

建议新增：

- `tool_catalog_service.ts`
- `strategy_compiler.ts`
- `compiled_policy_store.ts`
- `policy_pipeline.ts`

并把 `before_tool_call` 的真实决策逻辑统一收口到一个 pipeline，避免 `src/hooks/policy_guard.ts` 与根目录 `index.ts` 双轨演进。

## 6. 策略 Tab 信息架构重构建议

### 6.1 只重构策略 tab，不改全局导航

不建议借这次机会重排整个后台的顶层 tab。

建议保持顶层导航不变，只把当前 `策略` tab 内部改成三段式结构：

- `Access`
- `Exceptions`
- `Approvals`

- `Access` = 工具能力与上下文决策
- `Exceptions` = 目录/账号例外
- `Approvals` = 审批目标、TTL、break-glass

`Skills` 保持现状：

- 继续单独存在
- 继续使用自己的 score / drift / quarantine / trust override 语义
- 不进入主策略模型

换句话说，本轮是 **策略 tab 内部重构**，不是后台整体 IA 改版。

### 6.2 Access 页面

第一页只回答一个问题：

> 这个 agent 现在有哪些能力边界？

建议布局：

1. `Agent Baseline`
   - 当前 agent
   - OpenClaw tool profile
   - sandbox 状态
   - workspace access
2. `Capability Cards`
   - Runtime
   - Filesystem
   - Network
   - Browser
   - Sessions
   - Memory
   - UI
   - Messaging
   - Nodes
   - Automation
   - Media
   - Plugin Tools
3. `Capability Detail`
   - 不展示“规则列表”
   - 展示“上下文矩阵”

例子：

```text
Filesystem
  Read inside workspace       -> allow
  Read credential path        -> challenge
  Write outside workspace     -> block
  Change control files        -> challenge
```

这比展示 8 条规则卡片更稳定。

### 6.3 Exceptions 页面

把现在混进主策略页顶部的 `file_rules` 独立出去。

理由：

- 目录级 override 是典型例外，不是基线策略。
- 例外应该单独审计、单独回滚、单独提示风险。

建议页面只有三块：

1. `Directory Overrides`
2. `Account Overrides`
3. `Temporary Trust / Approval Grants`

每个例外都必须显示：

- 生效范围
- 覆盖哪一层
- 不能覆盖哪一层
- 创建时间 / 最近使用时间

### 6.4 去掉当前 rules 页里的“示例对话侧栏”

现在的示例对话对 onboarding 有帮助，但对策略操作是噪声。

建议替换为更直接的解释模块：

- `This capability affects`
- `Typical triggers`
- `Cannot be overridden by`
- `Recent hits`

简洁比讲故事更重要。

## 7. 哪些部分适合 tool-driven，哪些不适合

### 7.1 适合 tool-driven 的

- agent 默认 capability
- capability 分组
- sandbox / workspace access 联动表达
- 大部分一级策略入口
- 管理后台 IA
- 审计统计口径

### 7.2 不适合纯 tool-driven 的

- 敏感路径识别
- 域名/目标分类
- 数据标签判断
- bulk read / export 判断
- 审批 replay

这些仍然必须依赖上下文分类器。

所以推荐结论不是“rule -> tool 开关”，而是：

> 用 tool 取代“规则”成为用户看到的一级对象；  
> 用 classifier 取代“规则字段组合”成为引擎看到的上下文对象；  
> 用 exception 取代“高优先级特殊规则”成为覆盖对象。

## 8. 直接改造方案

既然这是新产品，就不建议做“兼容旧结构的渐进迁移”。更合理的是直接替换。

### 8.1 直接替换目标

1. `策略` tab 不再直接编辑 `PolicyRule[]`
2. `策略` tab 改为编辑唯一高层模型：
   - `tool_policy`
   - `classifiers`
   - `exceptions`
3. runtime 只消费新的 compiled policy / pipeline
4. `Skills` 页面与 skill store 完全不动

### 8.2 直接替换步骤

1. 重写 `策略` tab 的 view model 和交互
   - 把当前 rules list + file rules 顶部拼盘改成 `Access / Exceptions / Approvals`
2. 重写策略保存格式
   - SQLite 中直接保存新的策略对象
   - 不再要求与旧 `policies` 覆盖格式共存
3. 重写 runtime 决策入口
   - 收口为单一 `policy_pipeline.ts`
   - 删除或下沉旧的 rule-array 直出逻辑
4. 清理旧数据
   - 必要时直接删除本地 `securityclaw.db` 中的策略覆盖记录
   - 必要时直接卸载重装插件

### 8.3 可接受的破坏性变更

以下在本项目阶段都应视为可接受：

- 旧策略配置失效
- 本地 SQLite 策略数据清空
- 管理后台保存接口改 shape
- 需要手动恢复一小部分本地例外配置

不建议为了规避这些成本引入长期兼容层，因为那会把简单问题重新做复杂。

## 9. 必须坚持的简化原则

### 9.1 一级页面只允许出现三种对象

- capability
- classifier
- exception

其他都不要做一级概念。

### 9.2 不允许继续新增“高优先级特殊规则”

任何新增需求都必须先回答：

- 这是 capability 基线？
- 这是 classifier？
- 这是 exception？

答不出来就不应该进策略模块。

### 9.3 不把 OpenClaw 原生 tool policy 和 SecurityClaw 条件策略混在一起

建议直接在 UI 上显式区分：

- `OpenClaw Access Baseline`
- `SecurityClaw Conditional Guardrails`

否则用户永远分不清：

- 是工具没开
- 还是工具开了但被 challenge/block

### 9.4 不在主路径引入 score

现有主路径已经明确是 rule-first / no score fallback。这个原则应该保留。

tool-driven 不等于分数驱动。

score 只适合继续留在 skill interception 这类异步画像系统里，不应回流到主策略链路。

## 10. 推荐的最小落地版本

如果只做一轮最有价值的改造，我建议是这个组合：

1. 仅重写 `策略` tab
   - tab 内部改成 `Access / Exceptions / Approvals`
2. 引入 `StrategyViewModel`
   - 不再让前端直接围绕 `PolicyRule[]` 组织页面
3. 引入 `CapabilityPolicy` 概念
   - 先映射到现有 `tool_group`
4. 直接收口 runtime pipeline
   - 不再保留双轨拼装
5. 放弃兼容层
   - 必要时清空本地策略数据或卸载重装

这是投入最小、认知收益最大的一步。

## 11. 关于 Skill 的最终边界

结论很简单：

- `tool strategy` 决定 agent 在运行时如何使用能力。
- `skill interception` 决定安装到环境中的扩展内容是否值得信任。

两者都和安全有关，但不是同一个层级。

因此建议：

1. 本轮先不动 `skill`
2. 只保留导航分离和少量审计联动
3. 后续单独开 workstream 处理 skill 的策略语言、画像模型和治理动作

## 12. 一句话判断

**整体改为 tool-driven 是可行的，而且方向正确；但正确做法不是把复杂规则删成一堆工具开关，而是让 tool 成为一级对象、让 classifier 成为上下文中层、让 exception 成为单独覆盖层。**

这既符合 OpenClaw 的真实执行边界，也符合 pi 的最小核心哲学。
