# 官方 QQ 适配器接入

此适配器把腾讯官方 QQ Bot 的消息结构转换为记忆核心格式。官方 `dsh-qqbot` 当前不会自动调用本插件；需要在该通道插件的中间件和回合提示上下文里加上下面的两个挂点。

## 依赖关系

记忆核心提供 `ctx.forgettingMemory` 服务。官方 QQ 通道负责提供：

- 原始私聊或群聊消息；
- 稳定的会话范围和发送者 ID；
- 当前 Agent 回合的消息，供按需检索；
- 能识别为网关重放的离线事件（如果 SDK/桥接层有此标记）。

官方 QQ 通道返回的是 OpenID，必须存成带命名空间的 `qqbot:<openid>`。它不是 QQ 号，不要拿昵称或 QQ 号替代 OpenID。

## 接入原始消息

在 `dsh-qqbot` 的 `bootstrapGateway` 中取出核心服务并传给中间件装配函数：

```js
let forgettingMemory
try {
  forgettingMemory = ctx.get('forgettingMemory')
} catch {
  forgettingMemory = undefined
}
setupMiddlewares(bot, config, manager, logger, forgettingMemory)
```

在 `setupMiddlewares` 参数中增加可选的 `forgettingMemory`。把采集中间件放在访问控制之后、群聊历史缓冲和 @ 门控之前：

```js
import { createOfficialQqMemoryMiddleware } from 'dsh-forgetting-memory/adapters/official-qq'

// accessPolicy 已通过 bot.use(...) 注册
if (forgettingMemory) {
  bot.use(createOfficialQqMemoryMiddleware(forgettingMemory))
}
// historyBuffer、mentionGate 等后续中间件
```

这样只会保存通过通道访问控制的消息，同时能在 @ 门控丢弃非 @ 消息前完成本地采集。采集不调用模型。用户必须在 QQ 开放平台和通道配置中启用并获得相应的群消息事件权限；如果平台只推送 @ 机器人的消息，海马体也只能看到这些消息。

私聊消息范围为 `private:<user_openid>`，群聊范围为 `group:<group_openid>`。核心的可见范围过滤会按这个 scope 隔离数据。

## 接入按需检索

只有准备创建 Agent 回合时才检索，并把摘要并入这条用户消息。调用位置在 `handleInbound` 通过门控、完成正文组装之后，创建 `UserMessage` 之前：

```ts
import { composeOfficialQqTurnText } from 'dsh-forgetting-memory/adapters/official-qq'

const turnBody = composeOfficialQqTurnText(forgettingMemory, msg, agentBody, {
  maxChars: 1200,
})
const message = createUserMessage({
  content: [{ type: 'text', text: turnBody }],
  source: { kind: 'user' },
})
record.agent.followup(message)
```

不要为每轮检索结果额外注册一条 DSH `systemPrompt.context()`。DSH 会把动态 context 的完整快照写入会话历史；卸载注册项不会删除已经记录的快照。合并到当前入站消息可以避免每轮另造一条动态快照，但检索出的文字仍属于该轮历史，可能被 DSH 的会话压缩摘要吸收。`maxChars` 是字符上限，不是精确 token 上限。

检索只匹配当前 scope 内的摘要，完整日记正文仍需后续通过日记 ID 显式读取。当前核心的检索索引仍需完善，见项目 README 中的待办。

## 离线恢复

官方 QQ WebSocket SDK 支持使用 session ID 和 sequence 续接网关会话。SDK 能确认某条消息是重放时，可调用 `stageOfficialQqOfflineMessages(memory, messages)`，让核心按配置的 30 分钟默认 TTL 暂存，等待使用者翻阅。不能把任意启动后的新消息都视为离线消息。恢复失败或会话过期时，不能假设能从 QQ 官方接口补拉任意长时间的群历史。

重放事件可能重复投递。核心按 `channel + scope + message ID` 去重；桥接层仍应保留平台消息 ID，避免重复副作用。

## 当前边界

这份适配器代码已经在本项目的 `official-qq-integration` 分支中提供。它不是对 `@tencent-connect/dsh-qqbot` 的自动补丁；完成实际加载还需要在通道插件中接入上述中间件和当前回合的 prompt context。官方 QQ 接口使用 OpenID，OneBot 适配器则会使用独立的 `onebot:<id>` 命名空间，不得跨通道合并身份。
