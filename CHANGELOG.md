# Changelog

## 0.3.0 — 2026-09-14

新功能：**高级配置面板支持模型级配置项**（此前只有 route 级字段 + `modelOverrides.*.compat`）。

- **模型配置分组**：按模型 id 一行，覆盖 `dsh-llm-pi-ai` schema 的 `modelFields` 全集 ——
  `name` / `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` / `compat`。
- **输入类型 `input`**：`text` / `image` 多选，即该模型**支持的请求模态**；都不勾 = 不声明 =
  继承目录。声明 `image` 是让自建视觉模型可用的关键，只声明 `text` 可修正目录记录与网关
  实际能力不符的模型。
- **`reasoningEfforts` 三态**：继承目录 / `false`（声明非推理模型）/ 自定义「等级 → wire 拼写」
  映射（每行 `等级: wire`，wire 留空写 `null`；等级限 off/minimal/low/medium/high/xhigh/max）。
- **route 级 `defaultInput`**：模型自己没声明 `input` 时的兜底输入类型。
- **不再丢字段（修 bug）**：此前该分组把 `modelOverrides` 整字段重写成只剩 `{ compat }`，
  于是用户在 `settings.yaml` 里手写的模型级配置会在面板保存时被抹掉。现在面板读写的正是
  schema 的 `modelFields` 全集，整字段重写是**无损**的。
- **互斥提示**：route 上已声明 `models` 列表时 `modelOverrides` 会被服务端拒绝，面板就地提示，
  而不是等保存报错。
- 校验收敛为**一行只报一条错**（此前同一行可能同时报子字段与「整行没配任何字段」）。
- **修交互 bug**：模型行的 React key 原为 `` `${idx}:${row.id}` ``，改一个字符 id 就换 key，
  整行重挂载、输入框当场失焦（模型 id 几乎没法输入）。改用行下标做 key——行值全部来自
  受控的 form state，不需要靠 key 触发重挂载。
- `scripts/check-form.mjs` 新增 8 条用例：模型级全字段写入、空 `input` 不写空数组、
  `reasoningEfforts` 两种形态、非法等级、空行、`defaultInput`，以及 **round-trip 无损断言**
  （toForm → formToOps 必须零 op）。

## 0.2.0 — 2026-09-14

新功能：**新上下文（New context）** —— 在同一个会话里对历史做逻辑切分，
等价于 Cherry Studio 的「新建话题」，但历史不删、不分叉、不换会话。

- **触发**：输入框工具行左侧新增「⧉ 新上下文」按钮；同时注册了斜杠命令
  `/newcontext`，两者走同一条路（按钮内部就是 `ISession.command("/newcontext")`）。
- **效果**：点击后，模型请求只剩「系统提示 + 一条 notice + 此后新增的消息」，
  之前的历史不再发送；会话记录（人看到的 transcript）完全保留。
- **累积**：可以连续切分，每次都从当时的表面重新切，等效于"只保留最新一段"。
- **落地方式**：宿主半边（`lib/index.js`，此前是空实现）把会话**可见面 surface** 上
  除系统提示外的全部节点，用一条 replace 操作替换成一条 `plugin: dsh-btw / form: notice`
  的 user 消息 —— 与 `/compact` 同一条原生机制，区别只是不生成摘要。
  分割点就是那条替换事件本身，因此**重启 / 恢复 / fork 后依然生效**，不需要额外存储。
- **契约测试**：`scripts/check-newcontext.mjs` 用部署里真实的 `@deepseek-ai/dsh-session`
  `foldSurface` 逐条验证该 replace 事件（含四个反向用例：覆盖系统提示、漏遮蔽节点、
  引用未来 seq、沿用被遮蔽的旧 seq）。

实现约束（已在代码注释中逐条写明）：客户端插件碰不到发给模型的 messages，所以这个能力
必须落在宿主侧；replace 的 startSeq/endSeq 必须是**当前**表面上的节点且需覆盖全部被遮蔽
节点；node 0 若是系统提示则受保护，故一律从 `nodes[1]` 开始。

## 0.1.1 — 2026-09-14

适配 dsh 0.1.5-rc.2（此前按 0.1.1-rc.2 编写）。四处真实断点：

- **`inject` 用了包名而非服务 key**：`["slots","sessions","workspaces","@deepseek-ai/dsh-api-remotes","@deepseek-ai/dsh-client-locale"]`
  → `["slots","sessions","workspaces","locale","remote","remote.settings"]`。
  Cordis 的 `inject` 是硬依赖的服务名，包名永远等不到服务，`apply()` 一次都不会执行。
- **Provider 高级配置面板座位从 list 变 keyed**：`settings.models.provider-card` 现在按
  `entryKey = settingsNs` 分发，注册需要 `key`（原来是 `id`）。旧写法整块面板静默不出现。
  现注册为 `{ name, key: "llm-pi-ai", locale }`。
- **`settings.describe()` 改签名**：不再接受命名空间参数，一次返回全部；
  可写性在信封顶层 `writable`（`SettingsNamespaceView` 上已无该字段）。
- **fork 锚点取法失效**：`SessionSnapshot` 不再有 `chat`，聊天节点改由 ui-chat 的
  `ChatSnapshot.nodes`（`ChatNodeStore`）暴露，且只能从 session 作用域的 standard kit
  `useChat` 取得。改为由会话桥把「节点 key → anchorSeq」解析器提升到 root 作用域的浮层；
  旧宿主缺 `useChat` 时降级为 fork 的缺省边界（功能可用，锚点不精确）。

其余随版本漂移的核对结果（均无需改动）：`shell.overlay` /
`conversation.session.header.utilities` 座位、`sessions.list/.binding/.fork/.open`、
`InputActions.setDraft`、`InputState.draft`、`workspaces.archiveSession`、
`RemoteResult{ok,value|error}` 与 `settings/conflict`、DOM 锚点
`data-conversation-scroll` / `data-chat-anchor-key` / `data-composer-seat`。
`data-input-mirror` 已在新版消失（选择器保留，匹配不到任何元素，无副作用）。

自检相应加固：`scripts/check.mjs` 现在断言 keyed 注册、`remote.settings` 服务注入、
`useChat` 节点面，并拒绝 `inject` 里出现 `@` 开头的包名。

## 0.1.0 — 2026-09-02

首个公开版本（内部代号 drill，发布定名 btw）。

- 划选会话消息区文本 → 浮层操作条（引用提问 / btw / 关闭）
- 引用提问：引用块 + 来源头预填当前会话输入框草稿（不发送）
- btw：从选中消息 `fork` 一次性临时会话并自动切换，输入框预填 btw 引用块；
  会话改名「🔍 btw · <源标题>」
- 离开 btw 会话时自动归档（running 时顺延；可在设置关闭）
- 中英双语文案（随 dsh 语言切换；缺失时降级中文）
