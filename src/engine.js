import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MINUTE = 60_000
const DEFAULTS = Object.freeze({
  intervalMs: 10 * MINUTE,
  offlineTtlMs: 30 * MINUTE,
  halfLifeMs: 7 * 24 * 60 * MINUTE,
  relationHalfLifeMs: 30 * 24 * 60 * MINUTE,
  forgetThreshold: 0.15,
  cornerThreshold: 0.32,
  diaryThreshold: 0.55,
  relationCapacity: 12,
  maxRecallChars: 1200,
  maxDiaryChars: 4000,
  maxActivePerScope: 1000,
})
const DURABLE = new Set(['goal', 'boundary', 'preference', 'person'])
const KINDS = new Set([...DURABLE, 'event', 'joke', 'unknown'])

function normalized(text) {
  return String(text || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
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
  constructor({ dataDir, ownerId, classify, now = Date.now, ...config }) {
    if (!dataDir || typeof dataDir !== 'string') throw new TypeError('dataDir is required')
    if (!ownerId || typeof ownerId !== 'string') throw new TypeError('ownerId is required')
    this.dataDir = dataDir
    this.ownerId = ownerId
    this.classify = classify || (async () => ({ kind: 'unknown' }))
    this.now = now
    this.config = { ...DEFAULTS, ...config }
    for (const key of ['intervalMs', 'offlineTtlMs', 'halfLifeMs', 'relationHalfLifeMs', 'maxRecallChars', 'maxDiaryChars']) {
      if (!Number.isFinite(this.config[key]) || this.config[key] <= 0) throw new RangeError(`${key} must be positive`)
    }
    if (!Number.isInteger(this.config.relationCapacity) || this.config.relationCapacity < 0) throw new RangeError('relationCapacity must be a nonnegative integer')
    if (!Number.isInteger(this.config.maxActivePerScope) || this.config.maxActivePerScope < 1) throw new RangeError('maxActivePerScope must be a positive integer')
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
    return this
  }

  async save() {
    this.#assertOpen()
    const target = join(this.dataDir, 'state.json')
    const temp = `${target}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(this.state), 'utf8')
    await rename(temp, target)
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
      relation = { id: item.authorId, interactions: 0, lastAt: item.at, pinned: item.authorId === this.ownerId }
      this.state.relations.push(relation)
    }
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
      forgottenAt: at, summary: (memory.clue || memory.summary).slice(0, 48), scope: memory.scope,
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

  async #tick(at) {
    this.#assertOpen()
    this.state.offline = this.state.offline.filter(x => x.expiresAt > at)
    await this.#forgetExpired(at)
    const pending = this.state.pending
    this.state.pending = []
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i]
      try {
        await this.#process(item)
        this.state.processedIds.push(messageKey(item))
      } catch (error) {
        this.state.pending.push(...pending.slice(i))
        await this.save()
        throw error
      }
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
    return { processed: pending.length, memories: this.state.memories.length }
  }

  async #process(item) {
    this.#trackRelation(item)
    const raw = await this.classify(item)
    const c = raw && typeof raw === 'object' ? raw : {}
    let kind = KINDS.has(c.kind) ? c.kind : 'unknown'
    const textKey = normalized(item.text)
    const nearby = this.state.memories.find(x => x.scope === item.scope && x.authorId === item.authorId && x.textKey === textKey && item.at - x.lastAt <= this.config.intervalMs)
    if (nearby && textKey.length <= 12 && !DURABLE.has(kind)) kind = 'joke'
    const key = String(c.key || textKey).slice(0, 120)
    const scopedKey = `${item.scope}\u0000${item.authorId}\u0000${kind}\u0000${key}`
    const existing = this.state.memories.find(x => x.scopedKey === scopedKey) || (nearby && kind === 'joke' ? nearby : null)
    const confidence = Number.isFinite(c.confidence) ? Math.max(0, Math.min(1, c.confidence)) : 0
    const durable = DURABLE.has(kind) && confidence >= 0.8
    // A model-supplied label must never widen the source audience.
    const visibility = item.scope.startsWith('private:') ? 'private' : 'group'
    const summary = String(c.summary || item.text).trim().slice(0, durable ? 240 : 160)
    const importance = Number.isFinite(c.importance) ? Math.max(0, Math.min(1, c.importance)) : 0.5
    if (existing) {
      if (kind !== 'joke' && item.at - existing.lastReinforcedAt >= this.config.intervalMs) {
        existing.reinforcements = Math.min(6, (existing.reinforcements || 0) + 1)
        existing.lastReinforcedAt = item.at
      }
      existing.lastAt = Math.max(existing.lastAt, item.at)
      existing.summary = summary
      existing.detail = item.text
      existing.clue = String(c.clue || existing.clue || summary).slice(0, 80)
      existing.textKey = textKey
      existing.kind = kind
      existing.visibility = visibility
      existing.score = kind === 'joke' ? Math.min(existing.score, 0.5) : Math.min(1, existing.score + 0.12 * importance)
      if (durable) existing.layer = 'notebook'
      return
    }
    this.state.memories.push({
      id: randomUUID(), sourceId: item.id, occurredAt: item.at, lastAt: item.at,
      lastDecayAt: item.at, authorId: item.authorId, scope: item.scope, visibility,
      textKey, scopedKey, kind, summary, score: kind === 'joke' ? 0.35 : 0.45 + 0.25 * importance,
      detail: item.text, clue: String(c.clue || summary).slice(0, 80),
      layer: durable ? 'notebook' : 'hippocampus', pinned: false,
      reinforcements: 0, lastReinforcedAt: item.at,
    })
  }

  async sleep({ actorId = this.ownerId, at = this.now() } = {}) {
    return this.#exclusive(async () => {
      this.#assertOpen()
      if (!this.state.sleepAuthorized.includes(actorId)) throw new Error('not authorized to put the agent to sleep')
      await this.#tick(at)
      for (const memory of this.state.memories) {
        if (memory.layer === 'hippocampus' && memory.kind === 'event' && memory.score >= this.config.diaryThreshold) memory.layer = 'diary'
      }
      await this.save()
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

  retrieve({ query, scope, maxChars = this.config.maxRecallChars }) {
    this.#assertOpen()
    if (!scope || typeof scope !== 'string') throw new TypeError('scope is required')
    if (!Number.isFinite(maxChars) || maxChars < 0) throw new RangeError('maxChars must be nonnegative')
    const q = normalized(query)
    if (!q || maxChars === 0) return []
    const terms = q.split(/\s+/).filter(Boolean)
    const scored = this.state.memories.filter(x => {
      if (x.visibility === 'private') return x.scope === scope && scope.startsWith('private:')
      if (x.visibility === 'group') return x.scope === scope
      return true
    }).map(x => ({ memory: x, relevance: terms.filter(t => normalized(x.summary).includes(t)).length }))
      .filter(x => x.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || b.memory.score - a.memory.score)
    const result = []
    let remaining = Math.floor(Math.min(maxChars, this.config.maxRecallChars))
    for (const { memory } of scored) {
      if (remaining <= 0) break
      const line = `${memory.layer === 'corner' ? '模糊记忆' : memory.layer}：${memory.summary}`
      const piece = line.slice(0, remaining)
      if (piece) result.push(piece)
      remaining -= piece.length + 1
    }
    return result
  }

  warnings() {
    return this.config.relationCapacity > 30 ? ['关系圈容量超过 30；请留意每轮上下文预算。'] : []
  }
}
