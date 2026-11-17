import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MINUTE = 60_000
const DEFAULTS = Object.freeze({
  intervalMs: 10 * MINUTE,
  quietGapEnabled: false,
  quietGapMs: 3 * MINUTE,
  maxSegmentMs: 30 * MINUTE,
  memoryTokenBudget: 800,
  offlineTtlMs: 30 * MINUTE,
  halfLifeMs: 7 * 24 * 60 * MINUTE,
  relationHalfLifeMs: 30 * 24 * 60 * MINUTE,
  forgetThreshold: 0.15,
  cornerThreshold: 0.32,
  diaryThreshold: 0.55,
  relationCapacity: 12,
  maxRecallChars: 4000,
  archiveSummaryChars: 180,
  memeLexicon: {},
  maxDiaryChars: 4000,
  maxActivePerScope: 1000,
})
const DURABLE = new Set(['goal', 'commitment', 'boundary', 'preference', 'person'])
const KINDS = new Set([...DURABLE, 'event', 'joke', 'rumor', 'unknown'])

function normalized(text) {
  return String(text || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}


function estimateTokens(text) {
  const value = String(text || '')
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const rest = value.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, '')
  return cjk + Math.ceil(rest.length / 4)
}

function searchTerms(value) {
  const text = normalized(value)
  const terms = new Set()
  for (const match of text.matchAll(/[a-z0-9_]+/g)) {
    if (match[0].length > 1) terms.add(match[0])
  }
  const hanRuns = text.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) || []
  let segmenter
  try { segmenter = new Intl.Segmenter('zh', { granularity: 'word' }) } catch {}
  for (const run of hanRuns) {
    if (segmenter) {
      for (const part of segmenter.segment(run)) if (part.isWordLike && part.segment.length > 1) terms.add(part.segment)
    }
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2))
  }
  return [...terms]
}

function memePhrase(text, scope, lexicon) {
  const candidates = []
  const add = source => {
    if (Array.isArray(source)) {
      for (const value of source) {
        if (typeof value === 'string' && value.trim()) candidates.push({ canonical: value.trim(), aliases: [value.trim()] })
      }
      return
    }
    if (!source || typeof source !== 'object') return
    for (const [canonical, definition] of Object.entries(source)) {
      const aliases = typeof definition === 'string'
        ? [definition]
        : Array.isArray(definition)
          ? definition
          : Array.isArray(definition?.aliases)
            ? definition.aliases
            : []
      const clean = aliases.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
      const label = typeof definition?.label === 'string' && definition.label.trim() ? definition.label.trim() : canonical.trim()
      if (label && clean.length) candidates.push({ canonical: label, aliases: [...new Set([label, ...clean])], description: typeof definition?.description === 'string' ? definition.description.trim().slice(0, 100) : '', sensitive: Boolean(definition?.sensitive) })
    }
  }
  add(lexicon?.['*'])
  add(lexicon?.[scope])
  candidates.sort((a, b) => Math.max(...b.aliases.map(x => x.length)) - Math.max(...a.aliases.map(x => x.length)))
  const body = normalized(text)
  for (const candidate of candidates) {
    const phrase = candidate.aliases.find(alias => body.includes(normalized(alias)))
    if (phrase) return { canonical: candidate.canonical, phrase, description: candidate.description || '', sensitive: candidate.sensitive }
  }
  return null
}

function localClassification(text, recentMessages = []) {
  const value = String(text || '').trim()
  if (!value) return null
  if (/(听说|据说|传闻|小道消息|有人说|网传)/.test(value)) return { kind: 'rumor', confidence: 0.72, importance: 0.3 }
  if (/(我的底线是|请不要|别再|不允许|不要再对我|我不接受|未经同意不要)/.test(value)) return { kind: 'boundary', confidence: 0.9, importance: 0.9 }
  if (/(我保证|我答应你|我承诺|我一定会|说好了我|答应你|我会负责)/.test(value)) return { kind: 'commitment', confidence: 0.88, importance: 0.82 }
  if (/(我的长期目标是|长期目标是|我计划长期|我打算长期|我一直想要|我的目标是)/.test(value)) return { kind: 'goal', confidence: 0.84, importance: 0.8 }
  if (/(以后请|以后别|我更喜欢|我比较喜欢|我不喜欢|我喜欢)/.test(value)) return { kind: 'preference', confidence: 0.82, importance: 0.72 }
  if (/(开个玩笑|开玩笑的|逗你玩|逗你呢|纯属玩笑|整活|玩梗|这个梗|笑死|哈哈{2,}|呵呵{2,}|xswl|233{2,}|😂|🤣)/i.test(value)) {
    return { kind: 'joke', confidence: 0.68, importance: 0.12 }
  }
  if (/^(哈哈+|呵呵+|hhh+|xswl|笑死|233+|😂+|🤣+)$/i.test(value)) {
    return { kind: 'joke', confidence: 0.62, importance: 0.1 }
  }
  const key = normalized(value)
  const repeated = recentMessages.filter(message => normalized(message.text) === key)
  const authors = new Set(repeated.map(message => message.authorId))
  if (key.length > 0 && key.length <= 18 && repeated.length >= 2 && authors.size >= 2) {
    return { kind: 'joke', confidence: 0.56, importance: 0.14 }
  }
  return null
}

function periodSummary(records, maxChars) {
  const weight = { boundary: 6, commitment: 5.8, goal: 5.5, preference: 5.2, person: 4.8, event: 3.5, rumor: 2.5, unknown: 1.5, joke: 1 }
  const unique = new Map()
  for (const record of records) {
    const summary = String(record.summary || '').trim()
    const key = normalized(summary)
    if (!key) continue
    const priority = weight[record.kind] || 1
    const old = unique.get(key)
    if (!old || priority > old.priority) unique.set(key, { summary, kind: record.kind, priority, importance: Number(record.importance) || 0 })
  }
  const selected = [...unique.values()]
    .sort((a, b) => (b.priority + b.importance) - (a.priority + a.importance) || b.summary.length - a.summary.length)
    .slice(0, 4)
    .map(record => record.kind === 'joke' ? '群梗候选：' + record.summary : record.summary)
  const result = records.length + ' 条消息' + (selected.length ? '，本段提要：' + selected.join('；') : '（没有可压缩的摘要）')
  return result.slice(0, Math.max(32, maxChars))
}

function messageKey(item) {
  return `${item.channel}\u0000${item.scope}\u0000${item.id}`
}

function validateMessage(message) {
  if (!message || typeof message !== 'object') throw new TypeError('message is required')
  for (const field of ['id', 'channel', 'scope', 'authorId', 'text']) {
    if (typeof message[field] !== 'string' || !message[field].trim()) throw new TypeError(`${field} is required`)
  }
  if (!message.authorId.startsWith(`${message.channel}:`)) throw new TypeError('authorId must include the channel namespace')
  if (!Number.isFinite(message.at)) throw new TypeError('at must be a timestamp in milliseconds')
  return { ...message, text: message.text.trim() }
}

function freshState(ownerId) {
  return {
    version: 1,
    pending: [], offline: [], memories: [], processedIds: [],
    relations: [{ id: ownerId, interactions: 0, lastAt: 0, pinned: true }],
    sleepAuthorized: [ownerId],
  }
}

export class MemoryEngine {
  constructor({ dataDir, ownerId, classify, summarizePeriod, semanticRecall, countTokens, now = Date.now, configProvider, ...config }) {
    if (!dataDir || typeof dataDir !== 'string') throw new TypeError('dataDir is required')
    if (!ownerId || typeof ownerId !== 'string') throw new TypeError('ownerId is required')
    this.dataDir = dataDir
    this.ownerId = ownerId
    this.classify = classify || (async () => ({ kind: 'unknown' }))
    this.summarizePeriod = typeof summarizePeriod === 'function' ? summarizePeriod : null
    this.semanticRecall = typeof semanticRecall === 'function' ? semanticRecall : null
    this.countTokens = typeof countTokens === 'function' ? countTokens : null
    this.now = now
    this.configProvider = configProvider
    const baseConfig = { ...DEFAULTS, ...config }
    this.config = new Proxy(baseConfig, {
      get: (target, key) => {
        const live = this.configProvider?.()
        return live && Object.hasOwn(live, key) ? live[key] : Reflect.get(target, key)
      },
    })
    for (const key of ['intervalMs', 'offlineTtlMs', 'halfLifeMs', 'relationHalfLifeMs', 'quietGapMs', 'maxSegmentMs', 'memoryTokenBudget', 'maxRecallChars', 'maxDiaryChars', 'archiveSummaryChars']) {
      if (!Number.isFinite(this.config[key]) || this.config[key] <= 0) throw new RangeError(`${key} must be positive`)
    }
    if (!Number.isInteger(this.config.relationCapacity) || this.config.relationCapacity < 0) throw new RangeError('relationCapacity must be a nonnegative integer')
    if (!Number.isInteger(this.config.memoryTokenBudget) || this.config.memoryTokenBudget < 1) throw new RangeError('memoryTokenBudget must be a positive integer')
    if (!Number.isInteger(this.config.maxActivePerScope) || this.config.maxActivePerScope < 1) throw new RangeError('maxActivePerScope must be a positive integer')
    for (const key of ['forgetThreshold', 'cornerThreshold', 'diaryThreshold']) {
      if (!Number.isFinite(this.config[key]) || this.config[key] < 0 || this.config[key] > 1) throw new RangeError(key + ' must be between 0 and 1')
    }
    this.state = freshState(ownerId)
    this.opened = false
    this.mutation = Promise.resolve()
  }

  async open() {
    await mkdir(this.dataDir, { recursive: true })
    try {
      const saved = JSON.parse(await readFile(join(this.dataDir, 'state.json'), 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.memories)) throw new Error('unsupported memory state')
      this.state = saved
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!this.state.relations.some(x => x.id === this.ownerId)) {
      this.state.relations.push({ id: this.ownerId, interactions: 0, lastAt: 0, pinned: true })
    }
    try {
      const lines = (await readFile(join(this.dataDir, 'inbox.jsonl'), 'utf8')).split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        let item
        try { item = validateMessage(JSON.parse(line)) } catch { continue }
        if (!this.state.processedIds.includes(messageKey(item)) && !this.state.pending.some(x => messageKey(x) === messageKey(item))) this.state.pending.push(item)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    this.opened = true
    this.#rebuildSearchIndex()
    return this
  }

  async save() {
    this.#assertOpen()
    const target = join(this.dataDir, 'state.json')
    const temp = `${target}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(this.state), 'utf8')
    await rename(temp, target)
  }

  #rebuildSearchIndex() {
    this.scopedSearchIndex = new Map()
    this.scopeMemoryCount = new Map()
    this.indexedMemories = new Map()
    for (const memory of this.state.memories) {
      this.indexedMemories.set(memory.id, memory)
      this.scopeMemoryCount.set(memory.scope, (this.scopeMemoryCount.get(memory.scope) || 0) + 1)
      if (!this.scopedSearchIndex.has(memory.scope)) this.scopedSearchIndex.set(memory.scope, new Map())
      const index = this.scopedSearchIndex.get(memory.scope)
      const terms = searchTerms(String(memory.summary || '') + ' ' + String(memory.clue || ''))
      for (const term of terms) {
        if (!index.has(term)) index.set(term, new Set())
        index.get(term).add(memory.id)
      }
    }
  }

  #assertOpen() {
    if (!this.opened) throw new Error('call open() first')
  }

  #exclusive(task) {
    const job = this.mutation.then(task)
    this.mutation = job.catch(() => {})
    return job
  }

  async ingest(message) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      const item = validateMessage(message)
      if (this.state.processedIds.includes(messageKey(item)) || this.state.pending.some(x => messageKey(x) === messageKey(item))) return false
      await appendFile(join(this.dataDir, 'inbox.jsonl'), JSON.stringify(item) + '\n', 'utf8')
      this.state.pending.push(item)
      return true
    })
  }

  async stageOffline(messages, at = this.now()) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      for (const raw of messages) {
        const item = validateMessage(raw)
        if (this.state.processedIds.includes(messageKey(item)) || this.state.pending.some(x => messageKey(x) === messageKey(item))) continue
        if (!this.state.offline.some(x => messageKey(x.message) === messageKey(item))) this.state.offline.push({ message: item, expiresAt: at + this.config.offlineTtlMs })
      }
      await this.save()
    })
  }

  offlineCount() {
    this.#assertOpen()
    return this.state.offline.length
  }

  offlinePreview({ scope, maxChars = 60 }) {
    this.#assertOpen()
    if (!scope || typeof scope !== 'string') throw new TypeError('scope is required')
    const cap = Math.max(0, Math.min(60, Math.floor(maxChars)))
    return this.state.offline.filter(x => x.message.scope === scope).map(x => ({ key: messageKey(x.message), id: x.message.id, scope: x.message.scope, at: x.message.at, preview: x.message.text.slice(0, cap) }))
  }

  async reviewOffline(ids, { scope, at = this.now() }) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      if (!scope || typeof scope !== 'string') throw new TypeError('scope is required')
      const chosen = new Set(ids)
      let moved = 0
      this.state.offline = this.state.offline.filter(entry => {
        if (entry.expiresAt <= at) return false
        if (entry.message.scope !== scope) return true
        const key = messageKey(entry.message)
        const uniqueRawId = this.state.offline.filter(x => x.message.id === entry.message.id).length === 1
        if (!chosen.has(key) && !(uniqueRawId && chosen.has(entry.message.id))) return true
        if (!this.state.pending.some(x => messageKey(x) === key) && !this.state.processedIds.includes(key)) {
          this.state.pending.push(entry.message)
          moved++
        }
        return false
      })
      await this.save()
      return moved
    })
  }

  #trackRelation(item) {
    let relation = this.state.relations.find(x => x.id === item.authorId)
    if (!relation) {
      relation = { id: item.authorId, name: item.authorName || '', interactions: 0, lastAt: item.at, pinned: item.authorId === this.ownerId }
      this.state.relations.push(relation)
    }
    if (typeof item.authorName === 'string' && item.authorName.trim()) relation.name = item.authorName.trim().slice(0, 80)
    // A dense burst counts once; repeated activity across time strengthens the relation.
    if (item.at - relation.lastAt >= this.config.intervalMs || relation.interactions === 0) relation.interactions++
    relation.lastAt = Math.max(relation.lastAt, item.at)
  }

  #decay(memory, at) {
    if (memory.pinned || memory.layer === 'notebook') return
    const elapsed = Math.max(0, at - memory.lastDecayAt)
    const reinforcedHalfLife = this.config.halfLifeMs * (1 + 2 * Math.min(6, memory.reinforcements || 0))
    memory.score *= 2 ** (-elapsed / reinforcedHalfLife)
    memory.lastDecayAt = at
    if (memory.score < this.config.cornerThreshold && memory.layer !== 'corner') {
      memory.layer = 'corner'
      memory.summary = (memory.clue || memory.summary).slice(0, 48)
    }
  }

  async #archive(memory, at) {
    const record = {
      id: memory.id, sourceId: memory.sourceId, occurredAt: memory.occurredAt,
      forgottenAt: at, summary: String(memory.periodSummary || memory.summary || memory.clue || '').slice(0, this.config.archiveSummaryChars), scope: memory.scope,
    }
    await appendFile(join(this.dataDir, 'forgotten.jsonl'), JSON.stringify(record) + '\n', 'utf8')
  }

  async #forgetExpired(at) {
    const kept = []
    for (const memory of this.state.memories) {
      this.#decay(memory, at)
      if (memory.score < this.config.forgetThreshold && !memory.pinned) await this.#archive(memory, at)
      else kept.push(memory)
    }
    this.state.memories = kept
  }

  async #limitActive(at) {
    const byScope = new Map()
    for (const memory of this.state.memories) {
      if (memory.layer !== 'hippocampus') continue
      if (!byScope.has(memory.scope)) byScope.set(memory.scope, [])
      byScope.get(memory.scope).push(memory)
    }
    const remove = new Set()
    for (const memories of byScope.values()) {
      memories.sort((a, b) => a.score - b.score || a.lastAt - b.lastAt)
      for (const memory of memories.slice(0, Math.max(0, memories.length - this.config.maxActivePerScope))) {
        await this.#archive(memory, at)
        remove.add(memory.id)
      }
    }
    this.state.memories = this.state.memories.filter(x => !remove.has(x.id))
  }

  async tick(at = this.now()) {
    return this.#exclusive(() => this.#tick(at))
  }

  #takeReadyPending(at, force = false) {
    const pending = this.state.pending
    if (force || !this.config.quietGapEnabled) return { ready: pending, rest: [] }
    const groups = new Map()
    for (const item of pending) {
      const key = item.channel + '\u0000' + item.scope
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    const ready = []
    const rest = []
    for (const items of groups.values()) {
      items.sort((a, b) => a.at - b.at)
      let segment = []
      const flushAtGap = () => {
        if (segment.length) ready.push(...segment)
        segment = []
      }
      for (const item of items) {
        if (segment.length && item.at - segment[segment.length - 1].at >= this.config.quietGapMs) flushAtGap()
        segment.push(item)
        while (segment.length > 0 && item.at - segment[0].at >= this.config.maxSegmentMs) {
          let cut = 1
          while (cut < segment.length && segment[cut].at - segment[0].at <= this.config.maxSegmentMs) cut++
          ready.push(...segment.splice(0, cut))
        }
      }
      if (!segment.length) continue
      const last = segment[segment.length - 1]
      const first = segment[0]
      if (at - last.at >= this.config.quietGapMs || at - first.at >= this.config.maxSegmentMs) ready.push(...segment)
      else rest.push(...segment)
    }
    ready.sort((a, b) => a.at - b.at)
    rest.sort((a, b) => a.at - b.at)
    return { ready, rest }
  }

  async #tick(at, { force = false } = {}) {
    this.#assertOpen()
    this.state.offline = this.state.offline.filter(x => x.expiresAt > at)
    await this.#forgetExpired(at)
    const { ready, rest } = this.#takeReadyPending(at, force)
    this.state.pending = rest
    const processed = []
    const recentByScope = new Map()
    for (let i = 0; i < ready.length; i++) {
      const item = ready[i]
      try {
        const periodKey = item.channel + '\u0000' + item.scope
        const recentMessages = recentByScope.get(periodKey) || []
        const memory = await this.#process(item, { recentMessages: recentMessages.slice(-8) })
        recentMessages.push({ authorId: item.authorId, at: item.at, text: item.text })
        recentByScope.set(periodKey, recentMessages)
        processed.push({ item, memory, summary: memory.summary, kind: memory.kind })
        this.state.processedIds.push(messageKey(item))
      } catch (error) {
        this.state.pending.push(...ready.slice(i))
        await this.save()
        throw error
      }
    }
    const periods = new Map()
    for (const entry of processed) {
      const key = entry.item.channel + '\u0000' + entry.item.scope
      if (!periods.has(key)) periods.set(key, [])
      periods.get(key).push(entry)
    }
    for (const entries of periods.values()) {
      const messages = entries.map(({ item, memory }) => ({
        text: item.text, summary: memory.summary, kind: memory.kind, importance: memory.importance || 0,
      }))
      const fallback = periodSummary(messages, this.config.archiveSummaryChars)
      let text = fallback
      if (this.summarizePeriod) {
        try {
          const result = await this.summarizePeriod({
            scope: entries[0].item.scope, messages, fallback,
            maxChars: this.config.archiveSummaryChars,
          })
          if (typeof result === 'string' && result.trim()) text = result.trim().slice(0, this.config.archiveSummaryChars)
        } catch {}
      }
      for (const { memory } of entries) memory.periodSummary = text
    }
    const coreIds = new Set(this.relationships(at).filter(x => x.core).map(x => x.id))
    for (const memory of this.state.memories) {
      if (memory.kind === 'person' && memory.layer === 'notebook' && !coreIds.has(memory.authorId)) {
        memory.layer = memory.score >= this.config.diaryThreshold ? 'diary' : 'corner'
      }
    }
    await this.#limitActive(at)
    this.state.processedIds = this.state.processedIds.slice(-100_000)
    await this.save()
    await writeFile(join(this.dataDir, 'inbox.jsonl'), '', 'utf8')
    this.#rebuildSearchIndex()
    return { processed: ready.length, deferred: rest.length, memories: this.state.memories.length }
  }

  async #process(item, { recentMessages = [] } = {}) {
    this.#trackRelation(item)
    const raw = await this.classify(item, { recentMessages })
    const supplied = raw && typeof raw === 'object' ? raw : {}
    const local = localClassification(item.text, recentMessages)
    const meme = memePhrase(item.text, item.scope, this.config.memeLexicon)
    let kind = KINDS.has(supplied.kind) ? supplied.kind : 'unknown'
    if (local && DURABLE.has(local.kind)) kind = local.kind
    else if (kind === 'unknown' && local) kind = local.kind
    const textKey = normalized(item.text)
    const nearby = this.state.memories.find(x => x.scope === item.scope && x.authorId === item.authorId && x.textKey === textKey && item.at - x.lastAt <= this.config.intervalMs)
    if (nearby && textKey.length <= 12 && !DURABLE.has(kind)) kind = 'joke'
    if (meme && !meme.sensitive && !DURABLE.has(kind) && kind !== 'rumor') kind = 'joke'
    const key = String(supplied.key || (meme ? 'meme:' + normalized(meme.canonical) : textKey)).slice(0, 120)
    const communal = kind === 'joke' || kind === 'rumor'
    const scopedKey = communal
      ? item.scope + '\u0000' + kind + '\u0000' + key
      : item.scope + '\u0000' + item.authorId + '\u0000' + kind + '\u0000' + key
    const existing = this.state.memories.find(x => x.scopedKey === scopedKey) || (nearby && kind === 'joke' ? nearby : null)
    const confidence = Number.isFinite(supplied.confidence)
      ? Math.max(0, Math.min(1, supplied.confidence))
      : (local && local.kind === kind ? local.confidence : (meme && kind === 'joke' ? 0.55 : 0))
    const durable = DURABLE.has(kind) && confidence >= 0.8
    const visibility = item.scope.startsWith('private:') ? 'private' : 'group'
    const fallbackSummary = meme && kind === 'joke' ? '群梗候选「' + meme.canonical + '」' + (meme.description ? '：' + meme.description : '') : item.text
    const summary = String(supplied.summary || fallbackSummary).trim().slice(0, durable ? 240 : 180)
    const importance = Number.isFinite(supplied.importance) ? Math.max(0, Math.min(1, supplied.importance)) : (local?.importance ?? 0.5)
    if (existing) {
      if (kind === 'joke') {
        existing.jokeUses = (existing.jokeUses || 1) + 1
        existing.jokeAuthors ||= []
        if (!existing.jokeAuthors.includes(item.authorId)) existing.jokeAuthors.push(item.authorId)
        existing.jokeAuthors = existing.jokeAuthors.slice(-20)
        existing.score = Math.min(0.9, existing.score + (existing.jokeAuthors.length > 1 ? 0.04 : 0.01))
        existing.memeKey ||= meme?.canonical
        existing.memeHint ||= meme?.description
      } else if (kind === 'rumor') {
        existing.rumorSources ||= []
        if (!existing.rumorSources.includes(item.authorId)) existing.rumorSources.push(item.authorId)
        existing.rumorSources = existing.rumorSources.slice(-20)
        existing.corroboratedByMultiple = existing.rumorSources.length >= 2
        existing.score = Math.min(0.75, existing.score + 0.03)
      } else if (item.at - existing.lastReinforcedAt >= this.config.intervalMs) {
        existing.reinforcements = Math.min(6, (existing.reinforcements || 0) + 1)
        existing.lastReinforcedAt = item.at
      }
      existing.lastAt = Math.max(existing.lastAt, item.at)
      existing.summary = kind === 'joke' && (meme?.canonical || existing.memeKey)
        ? '群梗候选「' + (meme?.canonical || existing.memeKey) + '」' + ((meme?.description || existing.memeHint) ? '：' + (meme?.description || existing.memeHint) : '') + (existing.jokeUses > 1 ? '（' + existing.jokeUses + ' 次，' + (existing.jokeAuthors?.length || 1) + ' 人）' : '')
        : summary
      existing.importance = Math.max(Number(existing.importance) || 0, importance)
      const oldDetail = String(existing.detail || '')
      existing.detail = (oldDetail ? oldDetail + '\n' : '') .concat(item.text).slice(-this.config.maxDiaryChars)
      existing.clue = String(supplied.clue || (meme ? '群梗 ' + meme.canonical : existing.clue || summary)).slice(0, 80)
      existing.textKey = textKey
      existing.kind = kind
      existing.visibility = visibility
      if (kind !== 'joke' && kind !== 'rumor') existing.score = Math.min(1, existing.score + 0.12 * importance)
      if (durable) {
        existing.layer = 'notebook'
        existing.status ||= 'active'
      }
      return existing
    }
    const memory = {
      id: randomUUID(), sourceId: item.id, occurredAt: item.at, lastAt: item.at,
      lastDecayAt: item.at, authorId: kind === 'joke' || kind === 'rumor' ? null : item.authorId,
      scope: item.scope, visibility, textKey, scopedKey, kind, summary, importance,
      memeKey: meme?.canonical,
      memeHint: meme?.description,
      score: kind === 'joke' ? 0.35 : kind === 'rumor' ? 0.3 : 0.45 + 0.25 * importance,
      detail: item.text.slice(-this.config.maxDiaryChars),
      clue: String(supplied.clue || summary).slice(0, 80),
      layer: durable ? 'notebook' : 'hippocampus', pinned: false,
      reinforcements: 0, lastReinforcedAt: item.at, status: durable ? 'active' : undefined,
      jokeUses: kind === 'joke' ? 1 : undefined,
      jokeAuthors: kind === 'joke' ? [item.authorId] : undefined,
      rumorSources: kind === 'rumor' ? [item.authorId] : undefined,
      corroboratedByMultiple: false,
    }
    this.state.memories.push(memory)
    return memory
  }

  async sleep({ actorId = this.ownerId, at = this.now() } = {}) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      if (!this.state.sleepAuthorized.includes(actorId)) throw new Error('not authorized to put the agent to sleep')
      const result = await this.#tick(at, { force: true })
      for (const memory of this.state.memories) {
        if (memory.layer === 'hippocampus' && memory.kind === 'event' && memory.score >= this.config.diaryThreshold) memory.layer = 'diary'
      }
      await this.save()
      return result
    })
  }

  async setSleepAuthorized(ids, actorId = this.ownerId) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      if (actorId !== this.ownerId) throw new Error('only the owner can change permissions')
      this.state.sleepAuthorized = [...new Set([this.ownerId, ...ids])]
      await this.save()
    })
  }

  async pinRelation(id, pinned = true, actorId = this.ownerId) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      if (actorId !== this.ownerId) throw new Error('only the owner can pin relations')
      let relation = this.state.relations.find(x => x.id === id)
      if (!relation) {
        relation = { id, interactions: 0, lastAt: 0, pinned }
        this.state.relations.push(relation)
      } else relation.pinned = id === this.ownerId || pinned
      await this.save()
    })
  }

  relationships(at = this.now()) {
    this.#assertOpen()
    const strength = x => x.interactions * 2 ** (-Math.max(0, at - x.lastAt) / this.config.relationHalfLifeMs)
    const regular = this.state.relations.filter(x => !x.pinned).sort((a, b) => strength(b) - strength(a) || b.lastAt - a.lastAt)
    const chosen = new Set(regular.slice(0, this.config.relationCapacity).map(x => x.id))
    return this.state.relations.map(x => ({ ...x, strength: strength(x), core: x.pinned || chosen.has(x.id) }))
  }

  list(layer) {
    this.#assertOpen()
    return this.state.memories.filter(x => !layer || x.layer === layer).map(x => ({ ...x }))
  }

  readDiary({ id, scope, maxChars = 4000 }) {
    this.#assertOpen()
    if (!scope || !Number.isFinite(maxChars) || maxChars < 0) throw new TypeError('valid scope and maxChars are required')
    const memory = this.state.memories.find(x => x.id === id && (x.layer === 'diary' || x.layer === 'corner'))
    if (!memory || memory.scope !== scope) return null
    return String(memory.detail || memory.summary).slice(0, Math.floor(Math.min(maxChars, this.config.maxDiaryChars)))
  }

  retrieve({ query, scope, maxChars = this.config.maxRecallChars, maxTokens = this.config.memoryTokenBudget, layers, semanticIds = [] } = {}) {
    this.#assertOpen()
    if (!scope || typeof scope !== 'string') throw new TypeError('scope is required')
    if (!Number.isFinite(maxChars) || maxChars < 0) throw new RangeError('maxChars must be nonnegative')
    if (!Number.isFinite(maxTokens) || maxTokens < 0) throw new RangeError('maxTokens must be nonnegative')
    const terms = [...new Set(searchTerms(query))]
    if (terms.length === 0 || maxChars === 0 || maxTokens === 0) return []
    const allowedLayers = new Set(layers || ['hippocampus', 'notebook', 'diary'])
    const scopeIndex = this.scopedSearchIndex?.get(scope) || new Map()
    const candidateIds = new Set(Array.isArray(semanticIds) ? semanticIds.filter(id => typeof id === 'string') : [])
    const semanticSet = new Set(candidateIds)
    for (const term of terms) {
      for (const id of scopeIndex.get(term) || []) candidateIds.add(id)
    }
    const count = Math.max(1, this.scopeMemoryCount?.get(scope) || 0)
    const now = this.now()
    const scored = [...candidateIds].map(id => {
      const memory = this.indexedMemories.get(id)
      if (!memory || memory.scope !== scope || !allowedLayers.has(memory.layer)) return null
      if (memory.layer === 'notebook' && memory.status && memory.status !== 'active') return null
      if (memory.visibility === 'private' && !scope.startsWith('private:')) return null
      let relevance = 0
      for (const term of terms) {
        const posting = scopeIndex.get(term)
        if (!posting?.has(id)) continue
        const df = posting.size
        relevance += Math.log(1 + (count - df + 0.5) / (df + 0.5))
      }
      const ageDays = Math.max(0, now - memory.lastAt) / (24 * 60 * MINUTE)
      const recency = 1 / (1 + ageDays / 30)
      const layerBonus = memory.layer === 'notebook' ? 1.2 : memory.layer === 'hippocampus' ? 0.6 : 0
      const uncertaintyPenalty = memory.kind === 'rumor' && !memory.corroboratedByMultiple ? 0.45 : 0
      const semanticBonus = semanticSet.has(id) ? 0.75 : 0
      const score = relevance * (0.6 + Math.min(0.4, memory.score * 0.4)) + recency * 0.3 + layerBonus + semanticBonus - uncertaintyPenalty
      return { memory, score }
    }).filter(Boolean).sort((a, b) => b.score - a.score || b.memory.lastAt - a.memory.lastAt)
    const result = []
    let charsLeft = Math.floor(Math.min(maxChars, this.config.maxRecallChars))
    let tokensLeft = Math.floor(Math.min(maxTokens, this.config.memoryTokenBudget))
    for (const { memory } of scored) {
      if (charsLeft <= 0 || tokensLeft <= 0) break
      let prefix = memory.layer === 'corner' ? '模糊记忆' : memory.layer === 'notebook' ? '笔记' : memory.layer === 'diary' ? '日记摘要' : '近期记忆'
      if (memory.kind === 'joke') prefix = '群梗'
      if (memory.kind === 'rumor') prefix = memory.corroboratedByMultiple ? '多人提及，仍待确认' : '未证实传闻'
      const line = prefix + '：' + memory.summary
      const allowedByChars = line.slice(0, charsLeft)
      const tokenCost = this.#tokenCost(allowedByChars)
      if (tokenCost > tokensLeft) {
        const ratio = tokensLeft / Math.max(1, tokenCost)
        let clipped = allowedByChars.slice(0, Math.max(1, Math.floor(allowedByChars.length * ratio)))
        while (clipped && this.#tokenCost(clipped) > tokensLeft) clipped = clipped.slice(0, -1)
        if (clipped) result.push(clipped)
        break
      }
      if (allowedByChars) result.push(allowedByChars)
      charsLeft -= allowedByChars.length + 1
      tokensLeft -= tokenCost
    }
    return result
  }

  #tokenCost(text) {
    try {
      const exact = this.countTokens?.(text)
      if (Number.isFinite(exact) && exact >= 0) return Math.ceil(exact)
    } catch {}
    return estimateTokens(text)
  }

  async retrieveAsync(options = {}) {
    if (!this.semanticRecall) return this.retrieve(options)
    try {
      const result = await this.semanticRecall({
        query: options.query, scope: options.scope,
        limit: Math.max(1, Math.min(50, Number(options.semanticLimit) || 12)),
      })
      const ids = Array.isArray(result)
        ? result.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string')
        : []
      return this.retrieve({ ...options, semanticIds: ids })
    } catch {
      return this.retrieve(options)
    }
  }

  async forgottenRecords({ limit = 100, offset = 0 } = {}) {
    this.#assertOpen()
    const file = join(this.dataDir, 'forgotten.jsonl')
    let lines
    try { lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean) } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const line of lines) {
      try { records.push(JSON.parse(line)) } catch {}
    }
    const end = Math.max(0, records.length - Math.max(0, Math.floor(offset)))
    const start = Math.max(0, end - Math.max(0, Math.floor(limit)))
    return records.slice(start, end).reverse()
  }

  async archiveAction(action, ids = []) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      const file = join(this.dataDir, 'forgotten.jsonl')
      let lines
      try { lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean) } catch (error) {
        if (error.code === 'ENOENT') lines = []
        else throw error
      }
      const records = []
      for (const line of lines) {
        try { records.push(JSON.parse(line)) } catch {}
      }
      if (action === 'clear') {
        await writeFile(file, '', 'utf8')
        return { changed: records.length, remaining: 0 }
      }
      if (!['delete', 'corner'].includes(action)) throw new TypeError('action must be clear, delete, or corner')
      const chosen = new Set(Array.isArray(ids) ? ids : [])
      const selected = records.filter(record => chosen.has(record.id))
      if (action === 'corner') {
        for (const record of selected) {
          const exists = this.state.memories.some(memory => memory.sourceId === record.sourceId && memory.scope === record.scope && memory.layer === 'corner')
          if (exists) continue
          this.state.memories.push({
            id: randomUUID(), sourceId: record.sourceId, occurredAt: record.occurredAt,
            lastAt: record.forgottenAt, lastDecayAt: record.forgottenAt,
            authorId: null, scope: record.scope, visibility: record.scope.startsWith('private:') ? 'private' : 'group',
            textKey: normalized(record.summary), scopedKey: record.scope + '\u0000corner\u0000' + record.id,
            kind: 'event', summary: String(record.summary || '').slice(0, this.config.archiveSummaryChars),
            periodSummary: String(record.summary || '').slice(0, this.config.archiveSummaryChars),
            detail: String(record.summary || '').slice(0, this.config.archiveSummaryChars),
            clue: String(record.summary || '').slice(0, 80), score: this.config.cornerThreshold,
            layer: 'corner', pinned: false, reinforcements: 0, status: 'archived',
          })
        }
      }
      const selectedIds = new Set(selected.map(record => record.id))
      const remaining = records.filter(record => !selectedIds.has(record.id))
      await this.save()
      const temp = file + '.' + randomUUID() + '.tmp'
      await writeFile(temp, remaining.map(record => JSON.stringify(record)).join('\n') + (remaining.length ? '\n' : ''), 'utf8')
      await rename(temp, file)
      this.#rebuildSearchIndex()
      return { changed: selected.length, remaining: remaining.length }
    })
  }

  async deleteMemories(ids, { layers = ['diary', 'corner'] } = {}) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      const chosen = new Set(ids)
      const before = this.state.memories.length
      this.state.memories = this.state.memories.filter(memory => !(chosen.has(memory.id) && layers.includes(memory.layer)))
      const deleted = before - this.state.memories.length
      await this.save()
      this.#rebuildSearchIndex()
      return deleted
    })
  }

  async setNotebookStatus(id, status, actorId = this.ownerId) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      if (actorId !== this.ownerId) throw new Error('only the owner can update notebook tasks')
      if (!['active', 'completed', 'cancelled'].includes(status)) throw new TypeError('invalid notebook status')
      const memory = this.state.memories.find(item => item.id === id && item.layer === 'notebook')
      if (!memory) return false
      memory.status = status
      await this.save()
      this.#rebuildSearchIndex()
      return true
    })
  }

  forgettingProjection({ score = 0.7, reinforcements = 0 } = {}) {
    const initial = Math.max(0, Math.min(1, Number(score) || 0))
    const count = Math.max(0, Math.min(6, Math.floor(Number(reinforcements) || 0)))
    const halfLifeMs = this.config.halfLifeMs * (1 + 2 * count)
    const daysUntil = threshold => {
      if (initial <= threshold || threshold <= 0) return 0
      return halfLifeMs * Math.log2(initial / threshold) / (24 * 60 * MINUTE)
    }
    return {
      formula: 'score(t) = score0 × 2^(-t / (halfLife × (1 + 2 × min(6, reinforcements))))',
      initialScore: initial,
      reinforcements: count,
      effectiveHalfLifeDays: halfLifeMs / (24 * 60 * MINUTE),
      daysToCorner: daysUntil(this.config.cornerThreshold),
      daysToForget: daysUntil(this.config.forgetThreshold),
      configuredHalfLifeDays: this.config.halfLifeMs / (24 * 60 * MINUTE),
      cornerThreshold: this.config.cornerThreshold,
      forgetThreshold: this.config.forgetThreshold,
    }
  }

  warnings() {
    const warnings = []
    if (this.config.relationCapacity > 30) warnings.push('关系圈容量超过 30；请留意每轮上下文预算。')
    if (this.config.memoryTokenBudget > 2000) warnings.push('单轮记忆预算超过 2000 token；请留意长期上下文增长。')
    if (!(this.config.forgetThreshold < this.config.cornerThreshold && this.config.cornerThreshold < this.config.diaryThreshold)) warnings.push('遗忘、日记角落和日记阈值建议保持从低到高排列。')
    return warnings
  }
}
