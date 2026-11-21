import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'client.src.js'), 'utf8')
const header = '/* 生络 ShengLuo — DSH client plugin. Original code; no vendored runtime. */\n'
writeFileSync(join(root, 'client.js'), header + source, 'utf8')
console.log('built client.js', Buffer.byteLength(header + source), 'bytes')
