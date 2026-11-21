import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
for (const file of ['plugin-unit.mjs', 'family-space-contract.mjs']) {
  console.log('\n=== ' + file + ' ===')
  const result = spawnSync(process.execPath, [join(root, 'tests', file)], { stdio: 'inherit', env: process.env })
  if (result.status !== 0) failed += 1
}
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
