import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import bedboo from 'bedboo'

const port = Number(process.env.BEDBOO_TEST_PORT)
assert(port > 0, 'Set BEDBOO_TEST_PORT to a local disposable BDS with OP commands enabled')
const version = process.env.BEDBOO_TEST_VERSION ?? '1.26.63.1'
const transport = process.env.BEDBOO_TEST_TRANSPORT ?? 'raknet'
const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const goal = '读取附近方块，把一个方块换成另一种材质，再读回确认。'
const finalText = '已读取游戏并验证方块已改变。'

async function until(test, details) {
  const end = performance.now() + 28000
  while (performance.now() < end) {
    if (test()) return
    await wait(50)
  }
  throw new Error('Agent test timed out: ' + details())
}

function fakeModel(mode) {
  const requests = []
  let error
  let position
  let dimension
  let block
  let stage = 'status'
  let attempts = 0

  function choose(result) {
    switch (stage) {
      case 'status':
        stage = 'read'
        return ['get_status', {}]
      case 'read': {
        assert.equal(result.state, 'online')
        dimension = result.dimension
        const { x, y, z } = result.position
        position = [Math.floor(x), Math.floor(y) + 1, Math.floor(z) + 4]
        stage = 'place'
        return ['get_blocks', { dimension, positions: [position] }]
      }
      case 'place':
        if (result.blocks[0].state === 'unknown' && attempts++ < 8) {
          return ['get_blocks', { dimension, positions: [position] }]
        }
        assert.equal(result.blocks[0].state, 'loaded')
        block = result.blocks[0].id === 'minecraft:glass' ? 'minecraft:stone' : 'minecraft:glass'
        stage = 'check'
        return ['run_command', { command: '/setblock ' + position.join(' ') + ' ' + block }]
      case 'check':
        assert.equal(result.state, 'succeeded', JSON.stringify(result))
        stage = 'verify'
        return ['get_blocks', { dimension, positions: [position] }]
      case 'verify':
        if (result.blocks[0].id !== block && attempts++ < 8) {
          return ['get_blocks', { dimension, positions: [position] }]
        }
        assert.equal(result.blocks[0].id, block)
        stage = 'done'
        return null
      default:
        throw new Error('Unexpected request after completing the goal')
    }
  }

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer local-agent-test-key')
      assert.equal(request.method, 'POST')
      assert.equal(request.url, mode === 'responses' ? '/v1/responses' : '/v1/chat/completions')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(body.model, 'local-test-model')
      const tools = body.tools.map(tool => mode === 'responses' ? tool.name : tool.function.name)
      assert(tools.includes('get_blocks') && tools.includes('run_command'))
      const messages = mode === 'responses' ? body.input : body.messages
      const last = messages.at(-1)
      if (requests.length === 0) assert(last.content.includes(goal))
      else {
        assert.equal(mode === 'responses' ? last.call_id : last.tool_call_id, 'call_' + requests.length)
        assert.equal(mode === 'responses' ? last.type : last.role, mode === 'responses' ? 'function_call_output' : 'tool')
      }
      requests.push(body)
      await wait(100)
      const choice = choose(requests.length === 1 ? undefined : JSON.parse(mode === 'responses' ? last.output : last.content))
      const n = requests.length
      const callId = 'call_' + n
      let output
      if (mode === 'responses') {
        output = {
          id: 'resp_' + n, object: 'response', status: 'completed',
          output: choice ? [{
            type: 'function_call', id: 'fc_' + n, call_id: callId, status: 'completed',
            name: choice[0], arguments: JSON.stringify(choice[1]),
          }] : [{
            type: 'message', id: 'msg_' + n, role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: finalText, annotations: [] }],
          }],
        }
      } else {
        output = {
          id: 'chatcmpl_' + n, object: 'chat.completion', created: 1, model: body.model,
          choices: [{
            index: 0, finish_reason: choice ? 'tool_calls' : 'stop',
            message: choice ? {
              role: 'assistant', content: null,
              tool_calls: [{ id: callId, type: 'function', function: { name: choice[0], arguments: JSON.stringify(choice[1]) } }],
            } : { role: 'assistant', content: finalText },
          }],
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output))
    } catch (cause) {
      error = cause
      response.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"test assertion failed"}}')
    }
  })
  return { server, error: () => error, done: () => stage === 'done', requests }
}

async function check(mode, useChat) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bedboo-agent-bds-test-'))
  const model = fakeModel(mode)
  model.server.listen(0, '127.0.0.1')
  await once(model.server, 'listening')
  const baseURL = 'http://127.0.0.1:' + model.server.address().port + '/v1'
  const env = {
    ...process.env, MC_HOST: '127.0.0.1', MC_PORT: String(port),
    MC_VERSION: version, MC_TRANSPORT: transport, MC_AUTH: 'offline',
    MC_ACCOUNT: useChat ? 'AutoAgentChat' : 'AutoAgentStart', MC_DATA_DIR: dataDir,
    OPENAI_API_KEY: 'local-agent-test-key', OPENAI_BASE_URL: baseURL,
    OPENAI_MODEL: 'local-test-model', OPENAI_API_MODE: mode,
    AGENT_COMMANDERS: useChat ? 'AgentOwner' : '', AGENT_GOAL: useChat ? '' : goal,
    AGENT_MAX_ROUNDS: '24',
  }
  // A configured model key should enable the embedded agent by default.
  delete env.MCP_TRANSPORT

  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stderr.setEncoding('utf8').on('data', text => { logs += text })
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
  let owner
  try {
    await until(() => logs.includes('已入服') || child.exitCode !== null, () => logs)
    assert(logs.includes('已入服'), logs)
    let whisper
    if (useChat) {
      owner = bedboo.createBot({
        host: '127.0.0.1', port, version, transport,
        username: 'AgentOwner', auth: 'offline', hideErrors: true,
      })
      owner.on('error', error => { logs += '\nOwner connection: ' + error.message })
      let ready = false
      owner.once('spawn', () => { ready = true })
      owner.on('whisper', (_sender, message) => { whisper = message })
      await until(() => ready, () => logs)
      owner.chat('!bot ' + goal)
    }
    await until(() => model.error() || (useChat ? whisper === finalText : logs.includes(finalText)), () => logs)
    if (model.error()) throw model.error()
    assert(model.done())
    assert(model.requests.length >= 5)
    assert.equal(stdout, '')
    console.log(mode + ' passed: automatic join, ' + (useChat ? 'in-game request and private reply' : 'startup goal') +
      ', API function calls, world read, command receipt and verified changed block')
  } finally {
    owner?.end()
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit')
      child.kill('SIGTERM')
      await done
    }
    await new Promise((resolve, reject) => model.server.close(error => error ? reject(error) : resolve()))
    await rm(dataDir, { force: true, recursive: true })
  }
}

await check('responses', false)
await check('chat', true)
