import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const serverPort = process.env.BEDBOO_TEST_PORT
assert(serverPort, 'Set BEDBOO_TEST_PORT to the port of a disposable local offline BDS with operator commands enabled')
const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))

async function until(read, ready, timeoutMs = 18000) {
  const deadline = performance.now() + timeoutMs
  let result
  do {
    result = await read()
    if (ready(result)) return result
    await wait(120)
  } while (performance.now() < deadline)
  throw new Error('Test timed out. Last result: ' + JSON.stringify(result))
}

async function availablePort() {
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const { port } = listener.address()
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  return port
}

async function testBridge(transportName) {
  const directory = await mkdtemp(join(tmpdir(), 'bedboo-mcp-bds-test-'))
  const env = {
    ...process.env,
    MC_HOST: '127.0.0.1',
    MC_PORT: serverPort,
    MC_VERSION: process.env.BEDBOO_TEST_VERSION ?? '1.26.63.1',
    MC_TRANSPORT: process.env.BEDBOO_TEST_TRANSPORT ?? 'nethernet',
    MC_AUTH: 'offline',
    MC_ACCOUNT: transportName === 'stdio' ? 'McpSmokeStdio' : 'McpSmokeHttp',
    MC_DATA_DIR: directory,
    MCP_TRANSPORT: transportName,
    MCP_HTTP_TOKEN: 'local-smoke-token',
  }
  const client = new Client({ name: 'integration-test', version: '0.1.0' })
  let child
  try {
    if (transportName === 'stdio') {
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [entry], env, stderr: 'inherit',
      }))
    } else {
      env.MCP_PORT = String(await availablePort())
      const address = new URL('http://127.0.0.1:' + env.MCP_PORT + '/mcp')
      child = spawn(process.execPath, [entry], { env, stdio: 'inherit' })
      await until(async () => {
        try { return (await fetch(address)).status } catch { return 0 }
      }, status => status === 401, 10000)
      await client.connect(new StreamableHTTPClientTransport(address, {
        requestInit: { headers: { Authorization: 'Bearer ' + env.MCP_HTTP_TOKEN } },
      }))
    }

    const toolNames = (await client.listTools()).tools.map(tool => tool.name)
    assert.deepEqual(toolNames, [
      'get_status', 'get_blocks', 'scan_area', 'move_to', 'run_command', 'run_commands', 'get_job', 'cancel_job',
    ])
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      assert(!result.isError, JSON.stringify(result.content))
      return result.structuredContent ?? JSON.parse(result.content[0].text)
    }

    const player = await until(() => call('get_status', { include: ['players', 'inventory', 'entities'] }), result => result.state === 'online')
    assert.equal(player.username, env.MC_ACCOUNT)
    assert(player.players.some(other => other.username === player.username))
    const { x, y, z } = player.position
    const position = [Math.floor(x), Math.floor(y) + 1, Math.floor(z) + 2]
    const dimension = player.dimension
    const blocks = positions => call('get_blocks', { dimension, positions })
    const block = async () => (await blocks([position])).blocks[0]
    await until(block, result => result.state === 'loaded')
    const unloaded = (await blocks([[10000000, position[1], 10000000]])).blocks[0]
    assert.equal(unloaded.state, 'unknown')
    const firstPage = await call('scan_area', { dimension, min: position, max: [position[0] + 1, position[1], position[2]], limit: 1 })
    assert.equal(firstPage.nextCursor, 1)

    const run = (command, requestId) => call('run_command', { command, requestId })
    const help = await run('/help playsound')
    assert.equal(help.state, 'succeeded', JSON.stringify(help))
    assert(help.steps[0].receipt.messages.length > 0)

    // Reset the test cell so repeated test runs exercise the same state change.
    await run('/setblock ' + position.join(' ') + ' minecraft:air')
    const placed = await run('/setblock ' + position.join(' ') + ' minecraft:glass', 'test-placement')
    assert.equal(placed.state, 'succeeded', JSON.stringify(placed))
    await until(block, result => result.id === 'minecraft:glass')
    assert.equal((await run('/setblock ' + position.join(' ') + ' minecraft:glass', 'test-placement')).jobId, placed.jobId)

    const rejected = await run('/missing_mcp_test_command')
    assert.equal(rejected.state, 'failed', JSON.stringify(rejected))
    assert.equal(rejected.steps[0].receipt.successCount, 0)
    assert(rejected.steps[0].receipt.messages.length > 0)

    const { jobId: movement } = await call('move_to', { dimension, x: Math.floor(x) + 2, z: Math.floor(z) })
    const readJob = jobId => call('get_job', { jobId })
    const done = result => !['queued', 'running'].includes(result.state)
    const moved = await until(() => readJob(movement), done)
    assert.equal(moved.state, 'succeeded', JSON.stringify(moved))
    assert.equal(Math.floor(moved.result.position.x), Math.floor(x) + 2)

    const { jobId: sounds } = await call('run_commands', { steps: [
      { command: '/playsound note.harp @s ~ ~ ~ 1 1', atMs: 0 },
      { command: '/playsound note.harp @s ~ ~ ~ 1 1.25', atMs: 0 },
      { command: '/playsound note.harp @s ~ ~ ~ 1 1.5', atMs: 200 },
    ] })
    const played = await until(() => readJob(sounds), done)
    assert.equal(played.state, 'succeeded', JSON.stringify(played))
    assert.equal(played.progress.succeeded, 3)
    assert(played.steps[2].dispatchedAtMs >= 195)

    const beforeSilent = await run('/gamerule sendcommandfeedback false')
    assert.equal(beforeSilent.state, 'succeeded', JSON.stringify(beforeSilent))
    try {
      const silent = await run('/setblock ' + position.join(' ') + ' minecraft:stone')
      assert.equal(silent.state, 'succeeded', JSON.stringify(silent))
      await until(block, result => result.id === 'minecraft:stone')
    } finally {
      await run('/gamerule sendcommandfeedback true')
      await run('/setblock ' + position.join(' ') + ' minecraft:air')
    }

    console.log(transportName + ' passed: spawn, world read, movement, command output, rejected command, block update, timed playsound and silent command')
  } finally {
    try { await client.close() } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'exit')
        child.kill('SIGTERM')
        await closed
      }
      await rm(directory, { force: true, recursive: true })
    }
  }
}

for (const transport of process.argv.slice(2).length ? process.argv.slice(2) : ['stdio', 'http']) {
  assert(['stdio', 'http'].includes(transport))
  await testBridge(transport)
}
