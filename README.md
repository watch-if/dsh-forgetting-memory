# dsh-forgetting-memory
面向 DSH 的 QQ 聊天分层记忆插件，以可配置的强化与选择性遗忘为核心；记忆核心与官方、第三方 QQ 接入适配器分离。

这是一个可接入 DSH、以后也可接入其他 QQ 通道的记忆核心。它不替换 QQ 通道，也不修改 DSH 的会话历史。通道适配器把消息交给核心，并在回复前取回有预算上限的记忆。

## 已实现的第一版

- 每十分钟整理增量消息；无新消息时不调用模型。语义判断由可选的 `classify` 回调提供，核心本身不调用 AI API。
- 每个会话的短期候选默认最多 1000 条，可通过 `maxActivePerScope` 调整；超出时低权重候选先流入遗忘文件。
- 同一人的短句短时间重复按玩梗候选处理；普通记忆按时间衰减。明确的长期目标、边界和用户钉住的信息可进入笔记本。
- 海马体、笔记本、日记、日记角落与完全不参与 AI 检索的遗忘文件分开。
- 人物按通道给出的稳定 ID 识别；使用者固定在核心，普通关系圈容量可调。容量超过 30 时仅提示，不强制截断。
- 离线消息先在临时区保留 30 分钟；只有明确翻阅的消息才进入记忆流程。
- 每次检索有硬性字符预算，按来源范围过滤；私聊记录不会进入群聊检索。字符上限不等于模型的精确 token 上限，最终接入时仍须按所用模型计数。
- 休眠时只整理当前仍活跃的记忆。遗忘文件逐条追加，保留事件发生时间和遗忘时间，允许一天有多条不同日期的遗忘记录。

## 尚需接入通道才能实现的事

DSH 的 QQ 插件并不统一提供消息事件和离线历史接口。核心提供 `ingest`、`stageOffline`、`reviewOffline`、`retrieve` 和 `sleep` 接口；具体通道适配器必须提供稳定身份、会话范围、消息 ID 及历史读取能力。若通道没有离线历史接口，不能补读关机时的消息。官方 dsh-qqbot 使用 OpenID，OneBot/NapCat 通常使用 QQ 号；适配器应把两者映射为带命名空间的稳定 ID，不得混用。

本版的默认语义判断保守：不能可靠判断的消息只进入短期海马体，不自动写成长期事实。玩笑、承诺和重要边界的高质量判断仍需设计分类器；可在正常模型回合提供结构化标签，或接入本地分类模型。

目前 DSH 入口只发布 `ctx.forgettingMemory` 服务并启动十分钟整理定时器。它尚未监听具体 QQ 插件的消息事件，也不会自行向模型注入记忆；选定 QQ 通道后，适配器需要调用服务的输入和检索接口。当前工作机上的 DSH 为 `0.1.5-rc.1`，还没有进行真实 QQ 群加载测试。

## 使用

```js
import { MemoryEngine } from './src/engine.js'

const memory = new MemoryEngine({ dataDir: './memory-data', ownerId: 'onebot:123456' })
await memory.open()
await memory.ingest({
  id: 'message-1', channel: 'onebot', scope: 'group:7788', authorId: 'onebot:123456',
  text: '明年想学日语', at: Date.now(),
})
await memory.tick()
const context = memory.retrieve({ query: '你有什么长期目标？', scope: 'group:7788' })
```

`classify(message)` 可返回 `{ kind, key, summary, clue, importance, confidence }`。`kind` 可用 `goal`、`boundary`、`preference`、`person`、`event`、`joke` 或 `unknown`。可见范围由消息来源决定，分类器不能把群内记录改成全局公开。未经可靠分类的消息不会成为笔记本事实。

离线候选区可用 `offlinePreview({ scope })` 查看当前会话的短预览，再把选中的消息 ID 交给 `reviewOffline(ids, { scope })`。有多个群出现相同消息 ID 时，应使用预览中的完整 `key` 选择。日记详细内容只有在得到条目 ID 后，调用 `readDiary({ id, scope })` 才会读取。

运行验证：`npm test`。

## 借鉴与边界

借鉴了 Mem0 的事实提取与按需检索、LlamaIndex 的短期/长期分层、Letta 的常驻小块与外部档案、Open WebUI 的上下文预算、dsh-companion 的可修订短记忆、dsh-silicon 的分层概况，以及 feiyuos-memory-graph 的衰减与按相关性召回。没有复制这些项目的代码。当前先验证记忆核心；DSH 与具体 QQ 通道的安装、界面和历史补读需在选定通道后接入。


## AI 协作与署名

项目的记忆哲学、需求方向与功能取舍由项目发起人 watch-if 提出。初始代码和文档由 watch-if 与 OpenAI Codex 协作编写；维护者负责审核、整合和发布。更完整的说明见 [AI_ASSISTANCE.md](AI_ASSISTANCE.md)。
