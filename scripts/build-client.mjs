import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const entry = await readFile(resolve(root, 'src/client/index.js'), 'utf8')
if (!entry.startsWith("import React from 'react'\n") || !entry.includes("export const inject = ['slots']") || !entry.includes('export function apply(ctx)')) {
  throw new Error('client entry must keep the expected React import and named apply export')
}
const body = entry
  .replace("import React from 'react'\n", "const React = require('react')\n")
  .replace("export const inject = ['slots']", "const inject = ['slots']")
  .replace('export function apply(ctx)', 'function apply(ctx)')
  + '\nmodule.exports = { apply, inject }\n'
const bundle = `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
${body}
return module.exports;
} });
`
const output = resolve(root, 'lib/client.js')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, bundle, 'utf8')
console.log('Built ' + output)
