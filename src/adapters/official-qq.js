const CHANNEL = 'qqbot'

function messageTimestamp(value, fallback) {
  if (Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function attachmentMarkers(attachments) {
  if (!Array.isArray(attachments)) return []
  return attachments.map(item => {
    const type = String(item?.content_type ?? item?.contentType ?? item?.type ?? 'attachment')
    if (/image|photo/i.test(type)) return '[图片]'
    if (/video/i.test(type)) return '[视频]'
    if (/audio|voice/i.test(type)) return '[语音]'
    if (/file/i.test(type)) return '[文件]'
    return '[附件]'
  })
}

export function officialQqScope(message) {
  const isGroup = message?.kind === 'group' || message?.scope === 'group'
  const peerId = isGroup
    ? (message.groupOpenid ?? message.group_openid)
    : (message.senderId ?? message.sender_id)
  if (typeof peerId !== 'string' || !peerId.trim()) return null
  return `${isGroup ? 'group' : 'private'}:${peerId}`
}

export function normalizeOfficialQqMessage(message, { now = Date.now() } = {}) {
  if (!message || typeof message !== 'object') return null

  const id = message.messageId ?? message.message_id ?? message.id
  const senderId = message.senderId ?? message.sender_id ?? message.author?.id
  const scope = officialQqScope(message)
  if (typeof id !== 'string' || !id.trim()) return null
  if (typeof senderId !== 'string' || !senderId.trim() || !scope) return null

  const body = typeof message.content === 'string' ? message.content.trim() : ''
  const text = [body, ...attachmentMarkers(message.attachments)].filter(Boolean).join(' ')
  if (!text) return null

  return {
    id,
    channel: CHANNEL,
    scope,
    authorId: `${CHANNEL}:${senderId}`,
    text,
    at: messageTimestamp(message.timestamp ?? message.at, now()),
  }
}

export async function captureOfficialQqMessage(memory, message, {
  now = Date.now,
  ignoreSlashCommands = true,
} = {}) {
  if (!memory || typeof memory.ingest !== 'function') {
    throw new TypeError('a MemoryEngine-compatible service is required')
  }

  const rawText = typeof message?.content === 'string' ? message.content.trim() : ''
  if (ignoreSlashCommands && rawText.startsWith('/')) return false

  const normalized = normalizeOfficialQqMessage(message, { now })
  if (!normalized) return false
  return memory.ingest(normalized)
}

/**
 * Mount this middleware in dsh-qqbot after access control and before
 * historyBuffer/mentionGate. At that point it receives every authorized
 * inbound message, including group messages that will not trigger an Agent turn.
 */
export function createOfficialQqMemoryMiddleware(memory, {
  logger = console,
  now = Date.now,
  ignoreSlashCommands = true,
} = {}) {
  return async function forgettingMemoryMiddleware(ctx, next) {
    try {
      await captureOfficialQqMessage(memory, ctx?.message, { now, ignoreSlashCommands })
    } catch (error) {
      logger.warn?.('[forgetting-memory] QQ message capture failed:', error)
    }
    await next()
  }
}

/**
 * Build a compact, scope-filtered context snapshot for the current QQ turn.
 * The bridge should call this only for messages that actually trigger an Agent.
 */
export function renderOfficialQqMemoryContext(memory, message, { maxChars } = {}) {
  const scope = officialQqScope(message)
  const query = typeof message?.content === 'string' ? message.content.trim() : ''
  if (!scope || !query || !memory || typeof memory.retrieve !== 'function') return ''

  const matches = memory.retrieve({
    query,
    scope,
    ...(Number.isFinite(maxChars) ? { maxChars } : {}),
  })
  if (!Array.isArray(matches) || matches.length === 0) return ''

  return [
    '[相关记忆开始]',
    '以下是按当前消息检索出的少量旧记忆。它们可能已经模糊或过期；只在相关时使用，不确定时说明记不清。',
    ...matches,
    '[相关记忆结束]',
  ].join('\n')
}

/**
 * Stage messages known by a QQ bridge to have been replayed after a disconnect.
 * The MemoryEngine applies its configured offline TTL; user review is still
 * required before these messages enter the regular memory pipeline.
 */
export async function stageOfficialQqOfflineMessages(memory, messages, { at = Date.now() } = {}) {
  if (!memory || typeof memory.stageOffline !== 'function') {
    throw new TypeError('a MemoryEngine-compatible service is required')
  }

  const normalized = (Array.isArray(messages) ? messages : [])
    .map(message => normalizeOfficialQqMessage(message, { now: () => at }))
    .filter(Boolean)

  if (normalized.length > 0) await memory.stageOffline(normalized, at)
  return normalized.length
}
