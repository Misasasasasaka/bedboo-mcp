import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const entry = new URL('../.bedboo/packages/bedboo-mcp/dist/main.js', import.meta.url)
if (!existsSync(entry)) {
  console.error('Run node scripts/setup.mjs to install and build bedboo-mcp.')
  process.exitCode = 1
} else {
  process.chdir(root)
  if (existsSync('.env')) process.loadEnvFile('.env')
  await import(entry.href)
}
