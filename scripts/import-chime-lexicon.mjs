import { readFile } from 'node:fs/promises'

const [inputPath, scope, includeSensitiveFlag] = process.argv.slice(2)
if (!inputPath || !scope) {
  process.stderr.write('用法：node scripts/import-chime-lexicon.mjs <chime_full.json> <scope> [--include-sensitive]\n')
  process.exitCode = 2
} else {
  const includeSensitive = includeSensitiveFlag === '--include-sensitive'
  const root = JSON.parse(await readFile(inputPath, 'utf8'))
  const rows = Array.isArray(root) ? root : Array.isArray(root?.data) ? root.data : Array.isArray(root?.memes) ? root.memes : root && typeof root === 'object' ? [root] : null
  if (!rows) throw new TypeError('输入文件应为梗条目数组，或包含 data/memes 数组的对象。')
  const entries = {}
  let skippedSensitive = 0
  for (const row of rows) {
    const canonical = String(row?.meme ?? row?.term ?? row?.name ?? '').trim()
    if (!canonical) continue
    const sensitive = Boolean(row.profanity || row.offense)
    if (sensitive && !includeSensitive) {
      skippedSensitive++
      continue
    }
    const meaning = String(row.meaning ?? row.description ?? '').trim().replace(/\s+/g, ' ').slice(0, 100)
    entries[canonical] = {
      aliases: [canonical, ...(Array.isArray(row.aliases) ? row.aliases : [])]
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim())
        .slice(0, 20),
      ...(meaning ? { description: meaning } : {}),
      ...(row.type_cn ? { category: String(row.type_cn).slice(0, 32) } : {}),
      ...(sensitive ? { sensitive: true } : {}),
      source: 'CHIME',
      sourceUrl: 'https://github.com/yuboxie/chime',
      license: 'MIT',
    }
  }
  process.stdout.write(JSON.stringify({ [scope]: entries }, null, 2) + '\n')
  process.stderr.write('已转换 ' + Object.keys(entries).length + ' 条；因脏话/冒犯标记跳过 ' + skippedSensitive + ' 条。请审核后再导入群配置。\n')
}
