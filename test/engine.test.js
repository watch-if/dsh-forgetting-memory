import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEngine } from '../src/engine.js'
import { apply } from '../index.js'

async function setup(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'forgetting-memory-'))
  const engine = new MemoryEngine({ dataDir, ownerId: 'onebot:owner', ...options })
  await engine.open()
  return { engine, dataDir }
}

const msg = (id, text, at = 0, extra = {}) => ({
  id, text, at, channel: 'onebot', scope: 'group:1', authorId: 'onebot:friend', ...extra,
})

test('offline messages enter memory only after review and expire after 30 minutes', async () => {
  const { engine } = await setup({ now: () => 0 })
  await engine.stageOffline([msg('a', '去了公园'), msg('b', '聊了电影')])
  assert.equal(engine.retrieve({ query: '公园', scope: 'group:1' }).length, 0)
  await engine.reviewOffline(['a'], { scope: 'group:1' })
  await engine.tick()
  assert.equal(engine.retrieve({ query: '公园', scope: 'group:1' }).length, 1)
  await engine.tick(30 * 60 * 1000 + 1)
  assert.equal(engine.offlineCount(), 0)
  assert.equal(engine.retrieve({ query: '电影', scope: 'group:1' }).length, 0)
})

test('short burst repetition does not become a durable fact', async () => {
  const { engine } = await setup({ now: () => 0 })
  await engine.ingest(msg('a', '笑死了'))
  await engine.ingest(msg('b', '笑死了', 1000))
  await engine.ingest(msg('c', '笑死了', 2000))
  await engine.tick()
  assert.equal(engine.list('notebook').length, 0)
  assert.equal(engine.list('hippocampus').length, 1)
  assert.equal(engine.list('hippocampus')[0].kind, 'joke')
})

test('classified long goal enters notebook and can be updated rather than duplicated', async () => {
  const classify = async m => ({ kind: 'goal', key: 'learn-japanese', summary: m.text, confidence: 0.95, importance: 0.9, visibility: 'group' })
  const { engine } = await setup({ now: () => 0, classify })
  await engine.ingest(msg('a', '明年学日语'))
  await engine.tick()
  await engine.ingest(msg('b', '明年先学日语口语', 24 * 60 * 60 * 1000))
  await engine.tick(24 * 60 * 60 * 1000)
  assert.equal(engine.list('notebook').length, 1)
  assert.equal(engine.list('notebook')[0].summary, '明年先学日语口语')
})

test('private diary memory cannot be recalled in a group', async () => {
  const classify = async m => ({ kind: 'event', key: m.id, summary: m.text, confidence: 0.9, importance: 0.5, visibility: 'private' })
  const { engine } = await setup({ now: () => 0, classify })
  await engine.ingest(msg('a', '我今天很难过', 0, { scope: 'private:owner' }))
  await engine.tick()
  assert.equal(engine.retrieve({ query: '难过', scope: 'group:1' }).length, 0)
  assert.equal(engine.retrieve({ query: '难过', scope: 'private:owner' }).length, 1)
})

test('forgotten records accumulate across ticks without returning to retrieval', async () => {
  const { engine, dataDir } = await setup({ now: () => 0, halfLifeMs: 1000, forgetThreshold: 0.15 })
  await engine.ingest(msg('a', '公园散步', 0))
  await engine.tick(0)
  await engine.tick(4000)
  await engine.ingest(msg('b', '看了电影', 4000))
  await engine.tick(4000)
  await engine.tick(8000)
  const lines = (await readFile(join(dataDir, 'forgotten.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(x => x.sourceId), ['a', 'b'])
  assert.deepEqual(lines.map(x => x.forgottenAt), [4000, 8000])
  assert.equal(engine.retrieve({ query: '公园 电影', scope: 'group:1' }).length, 0)
})

test('owner stays in the core and retrieval obeys a character budget', async () => {
  const classify = async m => ({ kind: 'person', key: m.authorId, summary: m.text, confidence: 0.9, importance: 0.8, visibility: 'group' })
  const { engine } = await setup({ now: () => 0, classify, relationCapacity: 1 })
  await engine.ingest(msg('a', '朋友一喜欢写诗', 0, { authorId: 'onebot:friend1' }))
  await engine.ingest(msg('b', '朋友二喜欢画画', 0, { authorId: 'onebot:friend2' }))
  await engine.tick()
  assert.equal(engine.relationships().find(x => x.id === 'onebot:owner').core, true)
  assert.equal(engine.relationships().filter(x => x.id !== 'onebot:owner' && x.core).length, 1)
  const result = engine.retrieve({ query: '朋友', scope: 'group:1', maxChars: 18 })
  assert.ok(result.join('\n').length <= 18)
})

test('ordinary relationships fade while the owner remains core', async () => {
  const { engine } = await setup({ now: () => 0, relationCapacity: 1, relationHalfLifeMs: 1000 })
  await engine.ingest(msg('a', '你好', 0, { authorId: 'onebot:old' }))
  await engine.tick(0)
  await engine.ingest(msg('b', '你好', 4000, { authorId: 'onebot:new' }))
  await engine.tick(4000)
  const people = engine.relationships(4000)
  assert.equal(people.find(x => x.id === 'onebot:owner').core, true)
  assert.equal(people.find(x => x.id === 'onebot:new').core, true)
  assert.equal(people.find(x => x.id === 'onebot:old').core, false)
})

test('sleep permission is configurable and survives restart', async () => {
  const { engine, dataDir } = await setup({ now: () => 0 })
  await engine.setSleepAuthorized(['onebot:partner'])
  await assert.rejects(engine.sleep({ actorId: 'onebot:stranger', at: 0 }), /not authorized/)
  const reopened = new MemoryEngine({ dataDir, ownerId: 'onebot:owner', now: () => 0 })
  await reopened.open()
  await reopened.sleep({ actorId: 'onebot:partner', at: 0 })
})

test('a group classifier cannot make a group diary globally visible', async () => {
  const classify = async m => ({ kind: 'event', key: m.id, summary: m.text, confidence: 1, importance: 0.8, visibility: 'public' })
  const { engine } = await setup({ now: () => 0, classify })
  await engine.ingest(msg('a', '这个群的秘密'))
  await engine.tick()
  assert.equal(engine.retrieve({ query: '秘密', scope: 'group:2' }).length, 0)
})

test('DSH entry publishes the core and runs periodic maintenance', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'forgetting-memory-plugin-'))
  let service
  let cleanup
  const ctx = {
    provide(name, value) { assert.equal(name, 'forgettingMemory'); service = value; return () => { service = null } },
    effect(factory) { cleanup = factory() },
  }
  await apply(ctx, { dataDir, ownerId: 'onebot:owner' })
  assert.ok(service instanceof MemoryEngine)
  assert.equal(typeof cleanup, 'function')
  cleanup()
})

test('diary exposes a short clue first and details only on an explicit read', async () => {
  const classify = async m => ({ kind: 'event', key: m.id, summary: '去公园，开心', clue: '公园 开心', confidence: 0.9, importance: 0.8 })
  const { engine } = await setup({ now: () => 0, classify })
  await engine.ingest(msg('a', '今天和小林去了公园，坐在湖边聊了很久，回来时觉得开心。'))
  await engine.sleep({ at: 0 })
  const entry = engine.list('diary')[0]
  assert.equal(entry.summary, '去公园，开心')
  assert.match(engine.readDiary({ id: entry.id, scope: 'group:1' }), /湖边聊了很久/)
  assert.equal(engine.readDiary({ id: entry.id, scope: 'group:2' }), null)
})

test('a person outside the relationship circle does not stay in permanent notebook', async () => {
  const classify = async m => ({ kind: 'person', key: m.authorId, summary: m.text, confidence: 0.95, importance: 0.8 })
  const { engine } = await setup({ now: () => 0, classify, relationCapacity: 1, relationHalfLifeMs: 1000 })
  await engine.ingest(msg('a', '老朋友喜欢写诗', 0, { authorId: 'onebot:old' }))
  await engine.tick(0)
  await engine.ingest(msg('b', '新朋友喜欢画画', 4000, { authorId: 'onebot:new' }))
  await engine.tick(4000)
  assert.equal(engine.list('notebook').some(x => x.authorId === 'onebot:old'), false)
})

test('an unprocessed message survives restart without rewriting the full state on ingest', async () => {
  const { engine, dataDir } = await setup({ now: () => 0 })
  await engine.ingest(msg('pending', '下次聊公园'))
  await assert.rejects(readFile(join(dataDir, 'state.json'), 'utf8'), { code: 'ENOENT' })
  const reopened = new MemoryEngine({ dataDir, ownerId: 'onebot:owner', now: () => 0 })
  await reopened.open()
  await reopened.tick()
  assert.equal(reopened.retrieve({ query: '公园', scope: 'group:1' }).length, 1)
  const again = new MemoryEngine({ dataDir, ownerId: 'onebot:owner', now: () => 0 })
  await again.open()
  await again.tick()
  assert.equal(again.retrieve({ query: '公园', scope: 'group:1' }).length, 1)
})

test('repetition across separate periods strengthens memory more than a burst', async () => {
  const { engine } = await setup({ now: () => 0, halfLifeMs: 1000, intervalMs: 1000 })
  await engine.ingest(msg('a', '喜欢去公园', 0))
  await engine.tick(0)
  await engine.ingest(msg('b', '喜欢去公园', 1500))
  await engine.tick(1500)
  assert.equal(engine.list()[0].reinforcements, 1)
  await engine.tick(2500)
  assert.ok(engine.list()[0].score > 0.2)
})

test('callers cannot override configured context and diary caps', async () => {
  const classify = async m => ({ kind: 'event', key: m.id, summary: '公园里的长谈' + '细节'.repeat(30), confidence: 0.9, importance: 0.8 })
  const { engine } = await setup({ now: () => 0, classify, maxRecallChars: 12, maxDiaryChars: 16 })
  await engine.ingest(msg('a', '今天在公园里聊了许多过去的事情' + '后来继续聊天'.repeat(20)))
  await engine.sleep({ at: 0 })
  assert.ok(engine.retrieve({ query: '公园', scope: 'group:1', maxChars: 9999 }).join('\n').length <= 12)
  assert.ok(engine.readDiary({ id: engine.list('diary')[0].id, scope: 'group:1', maxChars: 9999 }).length <= 16)
})

test('same message id in different groups remains two distinct events', async () => {
  const { engine } = await setup({ now: () => 0 })
  await engine.ingest(msg('42', '群一的公园', 0, { scope: 'group:1' }))
  await engine.ingest(msg('42', '群二的电影', 0, { scope: 'group:2' }))
  await engine.tick()
  assert.equal(engine.retrieve({ query: '公园', scope: 'group:1' }).length, 1)
  assert.equal(engine.retrieve({ query: '电影', scope: 'group:2' }).length, 1)
})

test('offline preview is scoped to the requesting conversation', async () => {
  const { engine } = await setup({ now: () => 0 })
  await engine.stageOffline([msg('a', '群一聊天'), msg('b', '群二聊天', 0, { scope: 'group:2' })])
  const preview = engine.offlinePreview({ scope: 'group:1' })
  assert.deepEqual(preview.map(x => x.id), ['a'])
})

test('large chat volume cannot grow short-term memory without a bound', async () => {
  const { engine, dataDir } = await setup({ now: () => 0, maxActivePerScope: 2 })
  await engine.ingest(msg('a', '公园'))
  await engine.ingest(msg('b', '电影', 1))
  await engine.ingest(msg('c', '咖啡', 2))
  await engine.tick(2)
  assert.equal(engine.list('hippocampus').length, 2)
  assert.equal((await readFile(join(dataDir, 'forgotten.jsonl'), 'utf8')).trim().split('\n').length, 1)
})
