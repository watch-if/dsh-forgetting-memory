import { join } from 'node:path'
import { homedir } from 'node:os'
import { MemoryEngine } from './src/engine.js'

export const name = 'forgetting-memory'

// The QQ bridge supplies messages and reads recall through ctx.forgettingMemory.
// No dependency on one particular QQ plugin is required here.
export async function apply(ctx, config = {}) {
  const dataDir = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'forgetting-memory')
  const { ownerId, classify, now, ...memoryConfig } = config
  if (!ownerId) throw new Error('forgetting-memory requires ownerId, for example onebot:123456')
  const memory = new MemoryEngine({ dataDir, ownerId, classify, now, ...memoryConfig })
  await memory.open()
  ctx.effect(() => {
    const withdraw = ctx.provide('forgettingMemory', memory)
    const timer = setInterval(() => {
      void memory.tick().catch(error => console.error('[forgetting-memory] maintenance failed:', error))
    }, memory.config.intervalMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      withdraw?.()
    }
  })
}

export { MemoryEngine }
