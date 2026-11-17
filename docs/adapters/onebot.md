# OneBot v11/v12 适配器

本适配器把 OneBot 风格的 v11/v12 消息事件转换成 `MemoryEngine` 的统一格式。核心库不绑定 NoneBot、NapCat 或其他 OneBot SDK；接入程序需要在自己的消息事件钩子里调用这些函数。

## 采集消息

请在权限过滤之后、@ 机器人门控之前采集消息。这样普通群聊可以进入本地整理队列，但不会因此触发 Agent 回合：

```js
import { createOneBotMemoryMiddleware } from 'dsh-forgetting-memory/adapters/onebot'

const collectMemory = createOneBotMemoryMiddleware(ctx.forgettingMemory, { logger })
// 在 OneBot 消息事件处理器中：权限检查通过后调用
await collectMemory(event, next)
```

也可以直接调用 `captureOneBotMessage(memory, event)`。适配器识别 OneBot v11 的 `message_type`、`group_id`、`user_id`，以及 v12 常见的 `detail_type` 事件字段。群和私聊分别使用 `group:<id>`、`private:<id>` scope；成员 ID 使用 `onebot:<id>`。不同 QQ 通道的 ID 不会自动合并。

## Agent 回合检索

只在消息确实要交给 Agent 时调用；异步版本会使用已配置的可选语义检索器：

```js
import { composeOneBotTurnTextAsync } from 'dsh-forgetting-memory/adapters/onebot'

const turnText = await composeOneBotTurnTextAsync(
  ctx.forgettingMemory,
  event,
  agentBody,
)
```

把返回值作为本轮用户消息文本即可。不会改写 DSH 人设、系统提示词或其他插件注册的工具。旧记忆会标注可能模糊或过期。

## 休眠整理命令

接入方可在自己的命令权限检查后调用核心服务；核心仍会核对配置的授权 ID：

```js
await ctx.forgettingMemory.sleep({
  actorId: `onebot:${event.user_id}`,
})
```

DSH 插件卸载时会尽力整理剩余队列。电脑突然断电或进程被强制终止时，不能保证异步整理完成；原始队列会保存在本地 inbox 文件中，下一次启动后可继续处理。

## 离线消息恢复

OneBot 的不同实现对历史消息 API 的支持不一致。需要由接入方提供读取函数；核心不会假定所有服务端都能补拉历史：

```js
import { recoverOneBotOfflineHistory } from 'dsh-forgetting-memory/adapters/onebot'

await recoverOneBotOfflineHistory(ctx.forgettingMemory, fetchHistory, {
  scopes: ['group:123456'],
  since: lastSeenTimestamp,
  limit: 100,
})
```

`fetchHistory(scope, { since, limit })` 应返回该 scope 的 OneBot 原始事件数组。适配器会把它们放入离线候选区，仍需显式翻阅后才会进入正常记忆整理；离线 TTL 默认为 30 分钟。

## 表情包和媒体

文本、CQ 图片、OneBot 的 face/mface/emoji/sticker、语音、视频和文件会转换为短标记。可识别的表情名称或 ID 会作为检索线索；发送表情仍由原来的 QQ 插件负责。适配器不会下载附件，也不会把图片 URL 或文件路径写入记忆。

## 框架差异

`createOneBotMemoryMiddleware` 是一个轻量事件函数，不会自行注册 NoneBot 或其他框架的 handler。请按当前通道插件的事件 API 绑定它，并确保每条消息只采集一次。保留平台消息 ID 可让核心按 channel、scope、message ID 去重。
