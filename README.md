# dsh-forgetting-memory

面向 DSH 的 QQ 聊天分层记忆插件，以强化与选择性遗忘为核心。记忆核心和 QQ 通道适配层分开；当前实现分支提供核心、DSH 设置页、官方 QQ 辅助适配和 OneBot v11/v12 适配器；官方 QQ 自动采集仍需 QQ 通道提供挂点。

## 当前功能

- 默认每 10 分钟整理一次。整理、索引和遗忘计算在本地运行，不主动调用模型。
- DSH 插件配置页提供整理间隔、静默间歇开关、静默时长、最长分段、离线暂存 TTL、遗忘阈值、关系圈容量和记忆预算等设置。
- 设置页里的“记忆管理”卡片可分页查看/处理遗忘记录、日记角落和日记，管理笔记任务与关系圈核心成员，并查看当前参数下的遗忘曲线估算。
- 笔记按 active、completed、cancelled 管理；已完成或取消的任务不进入普通检索。日记先检索短摘要，全文按需展开。日记角落和遗忘文件不会被普通检索选中。
- 遗忘文件保存一段整理时间的总体短摘要，不保存可供模型回看的完整聊天。转入日记角落也只保存这条短摘要。
- 默认每轮记忆预算为 800 个估算 token；宿主可注入 `countTokens(text)` 使用模型 tokenizer 计数。该预算只约束插件注入内容，普通聊天历史仍由 DSH 自己管理。
- 中文检索使用本地分词和双字组合索引，按相关度、层级、重要度和近期程度排序；只注入命中的少量摘要。
- 关系圈默认为 12。用户可在设置页自定义；超过 30 会提示留意上下文预算，不强行截断。
- 对明确承诺、边界、目标、偏好和传闻有可解释的本地规则；高置信条目可进入笔记本。群聊的复杂语义仍可由可选 `classify(message)` 回调补充，本地规则不会自动把模糊表达升格为长期事实。
- 可按群配置带别名的梗词典；相同梗的多种说法会合并为群级“梗候选”，统计跨时段使用情况。命中词典不会直接删除消息，也不会覆盖明确的承诺或边界。

## 整理方式

默认固定模式每 10 分钟处理当前队列。实验性的静默模式按群/私聊 scope 切分：出现达到设置时长的消息间歇后整理上一段；若一直没有间歇，则在“最长分段”到达时兜底整理。这个边界只看消息时间间隔，不代表插件理解了语义话题。

每次整理由本地规则和可选分类回调生成条目。段落短摘要由去重、按类别重要度排序后的代表性要点组成，最多保留 4 项；默认不调用模型。需要模型生成段落总结时，接入方可显式提供 `summarizePeriod({ scope, messages, fallback, maxChars })` 回调，未配置时不会产生模型调用。

## DSH 设置页与文件管理

在 DSH 插件设置页可以调节所有核心数值和开关。默认数据目录为：

- Windows：`%USERPROFILE%\.dsh\forgetting-memory`
- macOS/Linux：`~/.dsh/forgetting-memory`
- 若 DSH 设置了 `DSH_HOME`，则目录位于 `$DSH_HOME/forgetting-memory`
- 设置了 `dataDir` 时使用自定义目录

管理卡片会显示实际目录和 `forgotten.jsonl` 的位置。修改浏览器设置卡片源码后，运行 `npm run build:client` 更新随包发布的 DSH 客户端文件。遗忘文件不会自动删除；可在页面清空，或分页选中记录后删除/转入日记角落。角落和日记条目也能批量删除。遗忘文件不参与模型检索。

插件默认的 `ownerId` 是占位值 `owner:unconfigured`。使用前请填入实际操作者 ID（官方 QQ 使用对应 OpenID 命名空间，例如 `qqbot:<openid>`；OneBot 用其独立命名空间）。`sleepAuthorizedIdsJson` 可填入允许发出休眠整理指令的 ID JSON 数组；owner 始终保留权限，人数由使用者决定，例如 `["qqbot:亲近成员OpenID"]`。QQ 适配层触发休眠时把发起者 OpenID 作为 `actorId` 传入，核心会校验授权。修改 `ownerId` 或 `dataDir` 后需要重新加载插件。设置页的归档管理 API 由 DSH Connection 限制为 owner peer，并提供“现在休眠整理”按钮。

梗词典使用 JSON 字符串配置。数组形式兼容旧配置；对象形式可把多个说法归为一个群梗：

```json
{"*":["通用梗"],"group:群OpenID":{"只因":{"aliases":["鸡你太美","只因"]},"群内黑话":["缩写A","缩写B"]}}
```

scope 必须与适配器实际传入的值完全一致。表情包只有在 QQ/OneBot 适配器事件提供名称、类型或 ID 时才能保存为文本线索；记忆插件不会发送或替换表情包。

## 检索、预算与分层

`retrieve({ query, scope })` 默认只检索海马体、活动笔记和日记摘要，不读遗忘文件，也不自动检索日记角落。完整日记通过 `readDiary({ id, scope })` 按 ID 展开。检索先按群/私聊 scope 与可见范围过滤，再用本地倒排索引和中文双字词项做相关性排序，最后受字符上限和 token 预算双重约束。异步 `retrieveAsync()` 可合并接入方提供的语义候选；默认仍只做本地词项检索，不产生外部模型或向量服务调用。

800 token 是插件交给模型的记忆预算，不包含 DSH 原有会话历史或人设提示词。默认按字符估算；注入宿主的 `countTokens(text)` 后可按当前模型 tokenizer 计数。设置页展示按半衰期公式计算的角落/遗忘时间估算，不代表真实群聊中的确定预测。设置更大的预算只会让更多相关记忆有机会进入本轮，不会把整份笔记或日记塞进上下文。

`state.json` 保存活跃记忆和日记详情；`inbox.jsonl` 暂存待整理消息；`forgotten.jsonl` 保存已遗忘条目的总体短摘要。清理或转存归档时会保留数据目录中的其他文件。

## 与 DSH、人格和表情包插件共存

插件通过 `ctx.forgettingMemory` 发布独立服务；QQ 适配层只在实际触发 Agent 回合时，向当前用户消息附加少量相关记忆。它不会重写系统提示词，不替换人设，不改工具注册或其他插件的内容。注入段会说明旧记忆可能模糊或过期，供 Agent 按需参考。

表情包的发送和选择继续由原 QQ/OneBot 插件负责。记忆层不会拦截发送；它只会在适配器事件确实提供贴图名称、GIF 类型或 ID 时，保存类似“表情包：xxx”的索引线索。若接入事件只给出“图片”标记，就无法推断具体是哪张表情包。

## QQ 适配

官方 QQ 的消息转换、中间件和异步检索函数见 [官方 QQ 适配器](docs/adapters/official-qq.md)。OneBot v11/v12 的事件转换、异步检索和可选离线历史回调见 [OneBot 适配器](docs/adapters/onebot.md)。

记忆核心不会改写腾讯维护的 `dsh-qqbot`。当前官方通道没有向其他 DSH 插件公开原始入站消息挂点，因此要采集未 @ 机器人的普通群消息，仍需由官方通道维护分支接入适配中间件；单独安装核心无法绕过这个接口边界。官方 QQ 使用 OpenID，不是 QQ 号。

QQ WebSocket 恢复只能重放 SDK 可提供的漏收事件，不等于任意补拉长期群历史。可恢复的事件能进入离线候选区，默认 30 分钟后过期；使用者翻阅选中的内容后才会进入正常整理。

## 插件接口

`MemoryEngine` 可单独使用。通道适配器提供稳定的 channel ID、scope、author ID、message ID 和时间戳：

```js
import { MemoryEngine } from './src/engine.js'

const memory = new MemoryEngine({
  dataDir: './memory-data',
  ownerId: 'onebot:123456',
})
await memory.open()
await memory.ingest({
  id: 'message-1',
  channel: 'onebot',
  scope: 'group:7788',
  authorId: 'onebot:123456',
  text: '明年想学日语',
  at: Date.now(),
})
await memory.tick()
const context = memory.retrieve({
  query: '你有什么长期目标？',
  scope: 'group:7788',
})
```

可选 `classify(message)` 返回 `{ kind, key, summary, clue, importance, confidence }`。支持 `goal`、`commitment`、`boundary`、`preference`、`person`、`event`、`joke`、`rumor` 和 `unknown`。还可提供 `summarizePeriod`、`semanticRecall({ query, scope, limit })` 与 `countTokens(text)` 回调；三者均未配置时不会调用模型或外部检索服务。传闻只会标成待证线索；多人提及后仍显示“多人提及，仍待确认”，不会自动改写成确定事实。一个词条本身永远不足以自动删除或归档。

离线候选可用 `offlinePreview({ scope })` 查看，再将选中的消息 ID 交给 `reviewOffline(ids, { scope })`。笔记状态可用 `setNotebookStatus(id, status)` 更新。经授权的操作者可调用 `sleep({ actorId })`；休眠会强制整理当前未完成分段。遗忘文件可通过 `forgottenRecords({ limit, offset })` 分页读取，并用 `archiveAction('delete'|'corner', ids)` 批量处理或 `archiveAction('clear')` 清空。

## 记忆产品借鉴

- Mem0：按用户/会话等元数据过滤，取相关的 top-k，并支持按 ID 更新和删除。
- LlamaIndex：短期历史有 token 上限，旧内容进入长期记忆块；长期块再按相关度取回并服从总 token 预算。
- Letta：常驻上下文使用有大小限制的小块，档案内容在需要时单独搜索。
- Zep Graphiti：记录事实的时间与来源，用关键词、向量和关系检索组合处理变化中的事实。
- DSH 记忆插件：常见做法是订阅会话事件、压缩后写本地文件、在每回合前按相关度有限注入，并提供显式搜索/维护工具。本项目保留本地整理、可读存储和遗忘曲线，默认不增加后台模型调用。

参考：[Mem0 搜索文档](https://docs.mem0.ai/platform/quickstart)、[LlamaIndex memory](https://github.com/run-llama/llama_index/blob/main/docs/src/content/docs/framework/module_guides/deploying/agents/memory.mdx)、[Letta archival memory](https://docs.letta.com/api/typescript/resources/agents/subresources/passages)、[Graphiti temporal search](https://help.getzep.com/graphiti/getting-started/overview)。

## AI 协作与署名

项目的记忆哲学、需求方向与功能取舍由项目发起人 watch-if 提出。初始代码和文档由 watch-if 与 OpenAI Codex 协作编写；维护者负责审核、整合和发布。更完整的说明见 [AI_ASSISTANCE.md](AI_ASSISTANCE.md)。
