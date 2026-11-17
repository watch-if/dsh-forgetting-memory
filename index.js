import { join } from 'node:path'
import { homedir } from 'node:os'
import { MemoryEngine } from './src/engine.js'
import { Config } from './src/config.js'

export const name = 'forgetting-memory'
export { Config, MemoryEngine }

const MINUTE = 60_000
const ADMIN_PATH = '/api/forgetting-memory/admin'
const ADMIN_PAGE_SIZE = 200

function readValue(value, fallback) {
  const result = value && typeof value.get === 'function' ? value.get() : value
  return result === undefined || result === null ? fallback : result
}

function parseMemeLexicon(config) {
  const raw = readValue(config.memeLexiconJson, '{}')
  if (config.memeLexicon && typeof config.memeLexicon === 'object') return config.memeLexicon
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean = {}
    for (const [scope, phrases] of Object.entries(parsed)) {
      if (Array.isArray(phrases)) clean[scope] = phrases.filter(x => typeof x === 'string' && x.trim()).slice(0, 500)
    }
    return clean
  } catch {
    return {}
  }
}

function parseAuthorizedIds(config) {
  const raw = readValue(config.sleepAuthorizedIdsJson, '[]')
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
  } catch {
    return []
  }
}

function memorySettings(config) {
  const value = (key, fallback) => readValue(config[key], fallback)
  const days = 24 * 60 * MINUTE
  return {
    intervalMs: value('intervalMs', Number(value('intervalMinutes', 10)) * MINUTE),
    quietGapEnabled: Boolean(value('quietGapEnabled', false)),
    quietGapMs: value('quietGapMs', Number(value('quietGapMinutes', 3)) * MINUTE),
    maxSegmentMs: value('maxSegmentMs', Number(value('maxSegmentMinutes', 30)) * MINUTE),
    offlineTtlMs: value('offlineTtlMs', Number(value('offlineTtlMinutes', 30)) * MINUTE),
    halfLifeMs: value('halfLifeMs', Number(value('halfLifeDays', 7)) * days),
    relationHalfLifeMs: value('relationHalfLifeMs', Number(value('relationHalfLifeDays', 30)) * days),
    forgetThreshold: value('forgetThreshold', 0.15),
    cornerThreshold: value('cornerThreshold', 0.32),
    diaryThreshold: value('diaryThreshold', 0.55),
    relationCapacity: Number(value('relationCapacity', 12)),
    memoryTokenBudget: Number(value('memoryTokenBudget', 800)),
    maxRecallChars: Number(value('maxRecallChars', 4000)),
    maxDiaryChars: Number(value('maxDiaryChars', 4000)),
    archiveSummaryChars: Number(value('archiveSummaryChars', 180)),
    maxActivePerScope: Number(value('maxActivePerScope', 1000)),
    memeLexicon: parseMemeLexicon(config),
  }
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/** The exact Fetch route is restricted by DSH Connection to owner peers. */
function installAdminRoute(ctx, memory) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({
      path: ADMIN_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async request => {
        try {
          if (request.method === 'GET') {
            const url = new URL(request.url)
            const requested = url.searchParams.get('view')
            const view = ['forgotten', 'corner', 'diary', 'notebook'].includes(requested) ? requested : 'forgotten'
            const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0))
            const base = { dataDir: memory.dataDir, forgottenPath: join(memory.dataDir, 'forgotten.jsonl'), warnings: memory.warnings() }
            if (view === 'forgotten') {
              const forgotten = await memory.forgottenRecords({ limit: ADMIN_PAGE_SIZE, offset })
              return jsonResponse({
                ...base, forgotten, forgottenHasMore: forgotten.length === ADMIN_PAGE_SIZE,
                corner: [], cornerHasMore: false, diary: [], diaryHasMore: false,
                notebook: [], notebookHasMore: false,
              })
            }
            const all = memory.list(view).sort((a, b) => b.lastAt - a.lastAt)
            const page = all.slice(offset, offset + ADMIN_PAGE_SIZE).map(item => ({
              id: item.id, occurredAt: item.occurredAt, scope: item.scope,
              summary: item.summary, status: item.status, kind: item.kind,
            }))
            const result = {
              ...base, forgotten: [], forgottenHasMore: false,
              corner: [], cornerHasMore: false, diary: [], diaryHasMore: false,
              notebook: [], notebookHasMore: false,
              [view]: page, [view + 'HasMore']: page.length === ADMIN_PAGE_SIZE,
            }
            if (view === 'diary') {
              const detailId = url.searchParams.get('detail')
              const item = all.find(entry => entry.id === detailId)
              if (item) result.detail = memory.readDiary({ id: item.id, scope: item.scope, maxChars: memory.config.maxDiaryChars })
            }
            return jsonResponse(result)
          }
          const body = await request.json()
          const ids = Array.isArray(body?.ids) ? body.ids.filter(id => typeof id === 'string').slice(0, ADMIN_PAGE_SIZE) : []
          let result
          if (body?.action === 'sleep') result = { slept: true, ...(await memory.sleep({ actorId: memory.ownerId })) }
          else if (body?.action === 'clear') result = await memory.archiveAction('clear')
          else if (body?.action === 'delete' || body?.action === 'corner') result = await memory.archiveAction(body.action, ids)
          else if (body?.action === 'deleteCorner') result = { deleted: await memory.deleteMemories(ids, { layers: ['corner'] }) }
          else if (body?.action === 'deleteDiary') result = { deleted: await memory.deleteMemories(ids, { layers: ['diary'] }) }
          else if (body?.action === 'setNotebookStatus') {
            let changed = 0
            for (const id of ids) if (await memory.setNotebookStatus(id, body.status)) changed++
            result = { changed }
          } else return jsonResponse({ error: '未知的管理操作。' }, 400)
          return jsonResponse(result)
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'forgetting-memory: owner archive management API')
  })
}

/**
 * The QQ bridge supplies messages and reads recall through ctx.forgettingMemory.
 * The memory service is additive: it does not replace DSH's persona, tools, or
 * the prompt contributions of other plugins.
 */
export async function apply(ctx, config = {}) {
  const configuredDir = readValue(config.dataDir, '')
  const dataDir = configuredDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'forgetting-memory')
  const ownerId = readValue(config.ownerId, 'owner:unconfigured')
  const classify = typeof config.classify === 'function' ? config.classify : undefined
  const now = typeof config.now === 'function' ? config.now : Date.now
  const settings = memorySettings(config)
  const memory = new MemoryEngine({
    dataDir, ownerId, classify, now, ...settings,
    configProvider: () => memorySettings(config),
  })
  await memory.open()
  let authorizationRevision = ''
  const syncAuthorization = async () => {
    const ids = parseAuthorizedIds(config)
    const revision = JSON.stringify(ids)
    if (revision === authorizationRevision) return
    await memory.setSleepAuthorized(ids, ownerId)
    authorizationRevision = revision
  }
  await syncAuthorization()
  installAdminRoute(ctx, memory)
  ctx.effect(() => {
    const withdraw = ctx.provide('forgettingMemory', memory)
    let timer
    let stopped = false
    const delay = () => memory.config.quietGapEnabled
      ? Math.min(60_000, memory.config.quietGapMs)
      : memory.config.intervalMs
    const schedule = () => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(run, delay())
      timer.unref?.()
    }
    const run = async () => {
      try { await memory.tick() } catch (error) {
        console.error('[forgetting-memory] maintenance failed:', error)
      } finally {
        schedule()
      }
    }
    schedule()
    ctx.on?.('loader/volatile-update', () => {
      schedule()
      void syncAuthorization().catch(error => console.error('[forgetting-memory] permission update failed:', error))
    })
    return () => {
      stopped = true
      clearTimeout(timer)
      withdraw?.()
    }
  })
}

