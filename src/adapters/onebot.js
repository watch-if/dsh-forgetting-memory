const CHANNEL = 'onebot'

function timestampMs(value, fallback) {
  if (Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric
  }
  return fallback()
}

function segmentText(segment) {
  const type = String(segment?.type || '').toLowerCase()
  const data = segment?.data && typeof segment.data === 'object' ? segment.data : {}
  if (type === 'text') return String(data.text || '')
  if (['face', 'mface', 'emoji', 'sticker'].includes(type)) {
    const label = data.name || data.id || data.face_id || data.emoji_id
    return label ? '[表情包：' + String(label).slice(0, 48) + ']' : '[表情包]'
  }
  if (type === 'image') {
    const label = data.summary || data.name || data.alt
    return label ? '[图片：' + String(label).slice(0, 48) + ']' : '[图片]'
  }
  if (type === 'video') return '[视频]'
  if (['record', 'audio', 'voice'].includes(type)) return '[语音]'
  if (type === 'file') return '[文件]'
  if (type === 'json') return '[JSON消息]'
  return ''
}

function messageText(event) {
  const message = event.message
  if (typeof message === 'string') {
    const raw = message.replace(/\[CQ:(face|mface|emoji|image|video|record|file)[^\]]*\]/gi, token => {
      const type = token.slice(4).split(',')[0].toLowerCase()
      if (['face', 'mface', 'emoji'].includes(type)) {
        const id = token.match(/(?:id|emoji_id)=([^,\]]+)/)?.[1]
        return id ? '[表情包：' + id.slice(0, 48) + ']' : '[表情包]'
      }
      return type === 'image' ? '[图片]' : type === 'video' ? '[视频]' : type === 'file' ? '[文件]' : '[语音]'
    })
    return raw.trim()
  }
  if (!Array.isArray(message)) return ''
  return message.map(segmentText).filter(Boolean).join(' ').trim()
}

/** Normalize OneBot v11/v12-style message events into the memory core format. */
export function normalizeOneBotMessage(event, { now = Date.now } = {}) {
  if (!event || typeof event !== 'object') return null
  if (event.post_type && event.post_type !== 'message') return null
  if (event.type && event.type !== 'message') return null

  const detail = String(event.detail_type || event.message_type || '').toLowerCase()
  const groupId = event.group_id ?? event.groupId
  const isGroup = detail === 'group' || groupId !== undefined && groupId !== null
  const userId = event.user_id ?? event.userId ?? event.sender?.user_id ?? event.sender?.id
  const peerId = isGroup ? groupId : userId
  const messageId = event.message_id ?? event.messageId ?? event.id
  if (peerId === undefined || peerId === null || userId === undefined || userId === null || messageId === undefined || messageId === null) return null

  const text = messageText(event)
  if (!text) return null
  const id = String(messageId).trim()
  const author = String(userId).trim()
  const peer = String(peerId).trim()
  if (!id || !author || !peer) return null

  return {
    id,
    channel: CHANNEL,
    scope: (isGroup ? 'group:' : 'private:') + peer,
    authorId: CHANNEL + ':' + author,
    authorName: String(event.user_name ?? event.sender?.card ?? event.sender?.nickname ?? event.sender?.name ?? '').trim().slice(0, 80),
    text,
    at: timestampMs(event.time ?? event.timestamp ?? event.at, now),
  }
}

export async function captureOneBotMessage(memory, event, {
  now = Date.now,
  ignoreCommands = true,
} = {}) {
  if (!memory || typeof memory.ingest !== 'function') throw new TypeError('a MemoryEngine-compatible service is required')
  const raw = typeof event?.raw_message === 'string' ? event.raw_message.trim() : typeof event?.message === 'string' ? event.message.trim() : ''
  if (ignoreCommands && /^\s*[/!！.]/.test(raw)) return false
  const normalized = normalizeOneBotMessage(event, { now })
  if (!normalized) return false
  return memory.ingest(normalized)
}

/** Use this as a small bridge in a OneBot event handler after access filtering. */
export function createOneBotMemoryMiddleware(memory, options = {}) {
  return async function oneBotMemoryMiddleware(event, next) {
    try { await captureOneBotMessage(memory, event, options) }
    catch (error) { options.logger?.warn?.('[forgetting-memory] OneBot capture failed:', error) }
    if (typeof next === 'function') return next()
  }
}

function memoryContext(memory, event, userText, options = {}) {
  const normalized = normalizeOneBotMessage({ ...event, message: userText ?? event?.message })
  if (!normalized || typeof memory?.retrieve !== 'function') return ''
  const matches = memory.retrieve({
    query: normalized.text,
    scope: normalized.scope,
    ...(Number.isFinite(options.maxChars) ? { maxChars: options.maxChars } : {}),
    ...(Number.isFinite(options.maxTokens) ? { maxTokens: options.maxTokens } : {}),
  })
  if (!Array.isArray(matches) || matches.length === 0) return ''
  return [
    '[相关记忆开始]',
    '以下是按当前消息检索出的少量旧记忆。它们可能已经模糊或过期；只在相关时使用，不确定时说明记不清。',
    ...matches,
    '[相关记忆结束]',
  ].join('\n')
}

export function renderOneBotMemoryContext(memory, event, options = {}) {
  return memoryContext(memory, event, event?.message, options)
}

export function composeOneBotTurnText(memory, event, userText, options = {}) {
  const body = typeof userText === 'string' ? userText : ''
  const context = memoryContext(memory, event, body, options)
  return context ? context + '\n\n[本轮 OneBot 消息]\n' + body : body
}

export async function renderOneBotMemoryContextAsync(memory, event, options = {}) {
  const normalized = normalizeOneBotMessage(event)
  if (!normalized) return ''
  if (typeof memory?.retrieveAsync !== 'function') return renderOneBotMemoryContext(memory, event, options)
  const matches = await memory.retrieveAsync({
    query: normalized.text,
    scope: normalized.scope,
    ...(Number.isFinite(options.maxChars) ? { maxChars: options.maxChars } : {}),
    ...(Number.isFinite(options.maxTokens) ? { maxTokens: options.maxTokens } : {}),
  })
  return matches.length ? [
    '[相关记忆开始]',
    '以下是按当前消息检索出的少量旧记忆。它们可能已经模糊或过期；只在相关时使用，不确定时说明记不清。',
    ...matches,
    '[相关记忆结束]',
  ].join('\n') : ''
}

export async function composeOneBotTurnTextAsync(memory, event, userText, options = {}) {
  const body = typeof userText === 'string' ? userText : ''
  const context = await renderOneBotMemoryContextAsync(memory, { ...event, message: userText ?? event?.message }, options)
  return context ? context + '\n\n[本轮 OneBot 消息]\n' + body : body
}

export async function stageOneBotOfflineMessages(memory, events, { at = Date.now() } = {}) {
  if (!memory || typeof memory.stageOffline !== 'function') throw new TypeError('a MemoryEngine-compatible service is required')
  const normalized = (Array.isArray(events) ? events : []).map(event => normalizeOneBotMessage(event, { now: () => at })).filter(Boolean)
  if (normalized.length) await memory.stageOffline(normalized, at)
  return normalized.length
}

/**
 * Optional provider-specific history recovery. fetchHistory(scope, { since, limit })
 * must be supplied by the OneBot implementation; the core never assumes every
 * OneBot server supports history APIs.
 */
export async function recoverOneBotOfflineHistory(memory, fetchHistory, {
  scopes = [],
  since = 0,
  limit = 100,
  at = Date.now(),
} = {}) {
  if (typeof fetchHistory !== 'function') throw new TypeError('fetchHistory is required')
  const events = []
  for (const scope of scopes) {
    const result = await fetchHistory(scope, { since, limit })
    if (Array.isArray(result)) events.push(...result)
  }
  return stageOneBotOfflineMessages(memory, events, { at })
}

export function createOneBotMemoryAdapter(memory, options = {}) {
  return Object.freeze({
    capture: event => captureOneBotMessage(memory, event, options),
    context: (event, userText, contextOptions) => composeOneBotTurnText(memory, event, userText, { ...options, ...contextOptions }),
    contextAsync: (event, userText, contextOptions) => composeOneBotTurnTextAsync(memory, event, userText, { ...options, ...contextOptions }),
    stageOffline: (events, at) => stageOneBotOfflineMessages(memory, events, { at }),
    recoverOffline: (fetchHistory, recoveryOptions) => recoverOneBotOfflineHistory(memory, fetchHistory, recoveryOptions),
  })
}
