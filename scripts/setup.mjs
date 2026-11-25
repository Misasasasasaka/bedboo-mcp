import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const upstream = 'https://github.com/LiteLDev/bedboo.git'
const commit = '1d8d2ae4e7b5c062f71a6373b7aede65d6810bb9'
const workspace = join(root, '.bedboo')
const name = 'bedboo-mcp'

function run(command, args, cwd = workspace) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'corepack',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' failed')
}

mkdirSync(workspace, { recursive: true })
if (!existsSync(join(workspace, '.git'))) run('git', ['init'])
const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workspace, encoding: 'utf8' })
if (head.stdout?.trim() !== commit) {
  run('git', ['fetch', '--depth=1', upstream, commit])
  run('git', ['checkout', '--detach', commit])
}

const source = join(root, 'packages', name)
const target = join(workspace, 'packages', name)
mkdirSync(target, { recursive: true })
for (const file of ['package.json', 'tsconfig.json', 'src', 'test']) {
  cpSync(join(source, file), join(target, file), { recursive: true })
}

const patch = join(root, 'pnpm-lock.patch')
const applied = spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: workspace, stdio: 'ignore' })
if (applied.status !== 0) run('git', ['apply', patch])

run('corepack', ['pnpm', 'install', '--frozen-lockfile'])
run('corepack', ['pnpm', '--filter', name, 'build'])
if (process.argv.includes('--test')) run('corepack', ['pnpm', '--filter', name, 'test'])
