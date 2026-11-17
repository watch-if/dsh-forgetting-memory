# 官方 QQ 适配器接入

本适配器把腾讯官方 QQ Bot 的消息结构转换为记忆核心格式。核心插件本身不依赖某个 QQ 通道；但官方 `dsh-qqbot` 当前没有向其他 DSH 插件公开原始入站消息事件，因此需要在通道插件里加下面三个挂点。单独安装记忆核心不会自动监听 QQ。

以下代码按 `tencent-connect/dsh-qqbot` 当前的 `bootstrapGateway`、`setupMiddlewares`、`handleInbound` 结构编写。它是接入补丁说明，不会自动修改腾讯维护的仓库。

## 依赖与身份

通道依赖需要能导入本项目的包，并在 DSH 配置中同时启用记忆插件。若从 GitHub 分支安装，可在通道插件依赖中指向：

```json
{
  "dsh-forgetting-memory": "github:watch-if/dsh-forgetting-memory#official-qq-integration"
}
```

核心配置中的 `ownerId` 使用机器人的操作者 OpenID，并保存为 `qqbot:<openid>`。消息作者也使用 `qqbot:<openid>`；群和私聊分别隔离在 `group:<group_openid>` 与 `private:<user_openid>`。官方 QQ 返回的是 OpenID，不是 QQ 号，不能用昵称或 QQ 号替代。

## 1. bootstrapGateway 传递服务

在 `src/gateway/bootstrap.ts` 取得可选服务，然后传给中间件装配和入站处理器。没安装记忆核心时，QQ 插件仍照常启动：

```ts
import type { MemoryEngine } from 'dsh-forgetting-memory'

let forgettingMemory: MemoryEngine | undefined
try { forgettingMemory = ctx.get('forgettingMemory') as MemoryEngine } catch {
  forgettingMemory = undefined
}

setupMiddlewares(bot, config, manager, logger, forgettingMemory)

// bot.on('message', ...) 内
await handleInbound(mCtx, manager, config, logger, qqInputs, forgettingMemory)
```

若 TypeScript 的 Cordis 服务类型没有声明 `forgettingMemory`，可在本地类型扩展中补上服务类型；运行时仍以可选服务处理。

## 2. 访问控制后采集所有消息

在 `src/gateway/middleware-setup.ts` 给 `setupMiddlewares` 增加可选参数，并在访问控制中间件之后、`historyBuffer` 和 `mentionGate` 之前装入采集器：

```ts
import { createOfficialQqMemoryMiddleware } from 'dsh-forgetting-memory/adapters/official-qq'
import type { MemoryEngine } from 'dsh-forgetting-memory'

export function setupMiddlewares(
  bot: QQBot, config: ImQQBotConfig, manager: SessionManager, logger: Logger,
  forgettingMemory?: MemoryEngine,
): void {
  // ...现有 errorHandler、messageFilter、邀请认领和 accessPolicy

  if (forgettingMemory) {
    bot.use(createOfficialQqMemoryMiddleware(forgettingMemory, { logger }))
  }

  // ...现有 historyBuffer、mentionGate 和其余中间件
}
```

这个位置只采集通过访问控制的消息，并且早于 @ 门控，因此群里没有 @ 机器人的普通消息也能进入本地待整理队列。采集不调用模型。QQ 开放平台必须向机器人推送相应的群消息事件；如果平台只推送 @ 机器人的消息，插件也只能看到这些消息。

## 3. 只在 Agent 回合检索

在 `src/transport/inbound.ts` 给 `handleInbound` 增加可选的 `forgettingMemory` 参数。完成现有门控和 `agentBody` 组装后、创建 `UserMessage` 前检索并合并摘要：

```ts
import { composeOfficialQqTurnTextAsync } from 'dsh-forgetting-memory/adapters/official-qq'
import type { MemoryEngine } from 'dsh-forgetting-memory'

export async function handleInbound(
  ctx: MiddlewareContext, manager: SessionManager, config: ImQQBotConfig,
  logger: Logger, inputs: QqInputRegistry, forgettingMemory?: MemoryEngine,
): Promise<void> {
  // ...现有门控、会话获取和 agentBody 组装
  const turnBody = forgettingMemory
    ? await composeOfficialQqTurnTextAsync(forgettingMemory, msg, agentBody)
    : agentBody

  const content: ContentBlock[] = [{ type: 'text', text: turnBody }]
  const message = createUserMessage({ content, source: { kind: 'user' } })
  // ...现有 inputs.register() 与 record.agent.followup(message)
}
```

只在确实创建 Agent 回合时检索；未 @ 的群消息只被本地采集，不会触发记忆检索或模型调用。检索摘要并入当前用户消息，不额外注册 DSH 动态 `systemPrompt.context()`：DSH 会将动态 context 快照写入会话历史，卸载注册项不会删掉已记录的快照。默认记忆预算为 800 个估算 token，并受设置页字符上限约束；这是插件注入记忆的上限，不包括 DSH 原有会话历史。默认使用本地估算；若宿主提供 `countTokens(text)` 回调，则预算按该模型 tokenizer 计数。普通检索不读取日记角落和 `forgotten.jsonl`。

当前默认检索使用按 scope 构建的本地倒排索引和中文双字匹配，不调用模型；可由接入方提供 `semanticRecall({ query, scope, limit })` 异步回调追加语义候选。只搜索海马体、活动笔记和日记摘要，并受设置页的 token 与字符预算约束。日记全文按日记 ID 显式读取，遗忘文件与日记角落不进入普通检索。

## 在 QQ 通道中触发休眠

若通道插件提供“休眠/整理”命令，在它完成指令权限和发起者身份转换后调用核心服务：

```ts
await forgettingMemory.sleep({ actorId: `qqbot:${senderOpenId}` })
```

owner 始终有权限；其他允许者在记忆插件设置中的 `sleepAuthorizedIdsJson` JSON 数组配置。核心会再次校验发起者，不能只依赖通道侧的命令门控。设置页也有仅限 DSH owner 使用的“现在休眠整理”按钮。休眠会强制处理静默模式里尚未闭合的分段，再运行一次记忆整理。

## 离线恢复

官方 QQ WebSocket SDK 支持通过 session ID 和 sequence 续接网关会话并重放部分漏收事件；这不等于可以任意补拉长时间的群历史。只有 SDK/桥接层能确认事件属于网关重放时，才调用 `stageOfficialQqOfflineMessages(memory, messages)`，按默认 30 分钟 TTL 暂存并等待使用者翻阅。恢复失败或会话过期时，不假设能从 QQ 接口补拉任意历史。

重放事件可能重复投递。核心按 `channel + scope + message ID` 去重；桥接层应保留平台消息 ID，避免重复副作用。

## 当前边界

若上游事件字段包含贴图/GIF 类型、名称或 ID，适配器会把可用标签作为文本线索保存；如果只提供普通图片附件，就只能记作 `[图片]`。它不会调用或发送表情包，发送仍由原 QQ 插件负责。

本仓库的 `official-qq-integration` 分支包含消息转换、中间件、按需检索和离线候选适配代码。要让它在官方通道中工作，仍需把上述挂点合入 `dsh-qqbot` 的自有分支或补丁；当前没有向腾讯维护的官方仓库提交修改。OneBot 适配器将使用独立的 `onebot:<id>` 命名空间，不得跨通道合并身份。
