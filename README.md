# dsh-forgetting-memory

面向 DSH 的 QQ 聊天分层记忆插件，以可配置的强化与选择性遗忘为核心。记忆核心与 QQ 通道适配层分开，先支持 DSH 与腾讯官方 QQ Bot，后续可增加 OneBot 等适配器。

## 当前实现

- 默认每 10 分钟整理一次增量消息；核心整理脚本不主动调用模型。语义判断由可选的 `classify` 回调提供。
- 海马体候选按时间衰减；长期目标、边界、偏好和人物等高置信条目可进入笔记本。
- 日记、日记角落、关系和遗忘记录分别保存；遗忘记录不会进入 AI 检索。
- 关系圈容量可配置，超过 30 时提示，不强制截断。
- 离线候选支持 30 分钟 TTL，使用者翻阅选中的消息后才会进入整理队列。
- 检索结果目前有字符上限，按群/私聊 scope 隔离。字符上限不是精确 token 上限。

## 当前检索与遗忘行为

现在的 `retrieve({ query, scope })` 会遍历内存中的所有活跃记忆摘要，用词项匹配并排序，最多返回 1200 个字符。它不会读取 `forgotten.jsonl`，但目前也没有按层过滤：笔记本、日记、日记角落的摘要都可能被普通检索选中。完整日记详情通过 `readDiary({ id, scope })` 按 ID 展开。

`state.json` 当前仍包含活跃条目的详情。检索只把少量匹配摘要交给模型，因此笔记条目增加不会等比例增加 token；本地搜索的扫描耗时仍会随条目数增长。后续需要加入索引、明确的层级过滤、笔记任务状态、日记角落删除接口和独立的 token 预算。

记忆低于遗忘阈值时，会从活跃列表移除并追加一条短记录到 `forgotten.jsonl`。文件本身不会自动删除，AI 也不会搜索它。当前没有清空或保留期设置，文件增长与最终删除策略仍待实现。

## 官方 QQ 适配

`official-qq-integration` 分支提供 `src/adapters/official-qq.js` 的消息转换、中间件和按需检索上下文函数，接入说明见 [官方 QQ 适配器](docs/adapters/official-qq.md)。

适配器需要在 `dsh-qqbot` 内部的访问控制之后、@ 门控之前注册消息采集中间件，才能看到会话中未 @ 机器人的消息。当前官方通道没有向其他 DSH 插件公开这个原始消息挂点，因此仍需要在通道插件中接入这层适配代码；单独安装记忆核心不会自动采集 QQ 群消息。

官方 QQ 使用 OpenID，不是 QQ 号。记忆键会使用 `qqbot:<openid>`；OneBot 使用独立命名空间，不能跨通道混并。

QQ WebSocket 断线恢复可以从上次 sequence 续接会话并重放部分漏收事件，但这不等于可任意拉取长时间群历史。适配器按 message ID 去重；若 SDK 能标记恢复消息，可把它们放进 30 分钟离线候选区等待翻阅。参考 [腾讯 QQ Bot SDK](https://github.com/tencent-connect/qqbot-nodejs) 与 [官方适配接入说明](docs/adapters/official-qq.md)。

## 插件接口

核心入口会发布 `ctx.forgettingMemory` 服务并启动整理定时器。通道适配器提供稳定的 channel ID、scope、author ID、message ID 和时间戳，并在当前 AI 回合按需请求检索结果。

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

`classify(message)` 可返回 `{ kind, key, summary, clue, importance, confidence }`。当前支持 `goal`、`boundary`、`preference`、`person`、`event`、`joke` 和 `unknown`。默认分类保守；不能可靠判定的内容不会直接写成长期事实。玩笑、承诺、传闻与重要边界仍需继续设计。

离线候选可用 `offlinePreview({ scope })` 查看，再将选中的消息 ID 交给 `reviewOffline(ids, { scope })`。日记详情目前需要先有 ID，再用 `readDiary({ id, scope })` 读取。

## 记忆产品借鉴

- Mem0：按用户/会话等元数据过滤，取相关的 top-k，并支持按 ID 更新和删除。
- LlamaIndex：短期历史有 token 上限，旧内容进入长期记忆块；长期块再按相关度取回并服从总 token 预算。
- Letta：常驻上下文使用有大小限制的小块，档案内容在需要时单独搜索。
- Zep Graphiti：记录事实的时间与来源，用关键词、向量和关系检索组合处理变化中的事实。
- DSH 记忆插件：常见做法是订阅会话事件、压缩后写本地文件、在每回合前按相关度有限注入，并提供显式搜索/维护工具。本项目保留本地整理、可读存储和遗忘曲线，默认不增加后台模型调用。

参考：[Mem0 搜索文档](https://docs.mem0.ai/platform/quickstart)、[LlamaIndex memory](https://github.com/run-llama/llama_index/blob/main/docs/src/content/docs/framework/module_guides/deploying/agents/memory.mdx)、[Letta archival memory](https://docs.letta.com/api/typescript/resources/agents/subresources/passages)、[Graphiti temporal search](https://help.getzep.com/graphiti/getting-started/overview)。

## AI 协作与署名

项目的记忆哲学、需求方向与功能取舍由项目发起人 watch-if 提出。初始代码和文档由 watch-if 与 OpenAI Codex 协作编写；维护者负责审核、整合和发布。更完整的说明见 [AI_ASSISTANCE.md](AI_ASSISTANCE.md)。