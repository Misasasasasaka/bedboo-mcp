import { Console } from 'node:console'
import { createHash, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createInterface, type Interface } from 'node:readline'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import type { GameAgent } from './agent/controller.js'
import { loadConfig } from './config.js'
import { JobStore } from './job-store.js'
import { GameJobs } from './jobs.js'
import { errorMessage } from './types.js'

// bedboo and its login dependencies can log to the console. Keep stdout reserved for MCP.
globalThis.console = new Console(process.stderr, process.stderr)

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

async function main() {
  const config = loadConfig(process.env)
  const { GameSession } = await import('./bot/session.js')
  const { makeGameTools } = await import('./game-tools.js')
  const { makeMcpServer } = await import('./mcp/tools.js')
  let agent: GameAgent | undefined
  let terminal: Interface | undefined
  const session = new GameSession(config.game, connection => agent?.onJoin(connection))
  const jobs = new GameJobs(session, new JobStore(config.database), config.game.commandTimeoutMs)
  const tools = makeGameTools(session, jobs)
  const factory = () => makeMcpServer(tools)
  let closeTransport: (() => Promise<void>) | undefined
  let shuttingDown: Promise<void> | undefined

  function shutdown() {
    return shuttingDown ??= Promise.resolve().then(async () => {
      terminal?.close()
      try {
        await agent?.close()
      } finally {
        session.stop()
        try {
          await closeTransport?.()
        } finally {
          await jobs.close()
        }
      }
    })
  }

  function stop() {
    void shutdown().catch(error => {
      console.error('Shutdown:', errorMessage(error))
      process.exitCode = 1
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  try {
    if (config.agent) {
      const { GameAgent } = await import('./agent/controller.js')
      agent = new GameAgent(config.agent, session, jobs, tools)
      if (config.mcp.transport !== 'stdio' && process.stdin.isTTY) {
        terminal = createInterface({ input: process.stdin, terminal: false })
        terminal.on('line', line => agent?.fromConsole(line))
        console.error('[Agent] 在终端输入任务并回车。输入 stop 可停止当前任务。')
      }
    }
    if (config.mcp.transport === 'stdio') {
      const mcp = factory()
      mcp.server.onclose = stop
      closeTransport = () => mcp.close()
      await mcp.connect(new StdioServerTransport())
    } else if (config.mcp.transport === 'http') {
      const host = '127.0.0.1'
      const app = createMcpExpressApp({ host, jsonLimit: '4mb' })
      const handler = createMcpHandler(factory)
      const nodeHandler = toNodeHandler(handler)
      const token = config.mcp.token && digest('Bearer ' + config.mcp.token)
      app.all('/mcp', async (request, response) => {
        if (token && !timingSafeEqual(token, digest(request.get('Authorization') ?? ''))) {
          response.set('WWW-Authenticate', 'Bearer')
          response.sendStatus(401)
          return
        }
        await nodeHandler(request, response, request.body)
      })
      const http = app.listen(config.mcp.port, host)
      closeTransport = async () => {
        handler.close()
        if (http.listening) {
          await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
        }
      }
      await once(http, 'listening')
      console.error('MCP listening on http://' + host + ':' + config.mcp.port + '/mcp')
    }
    session.start()
  } catch (error) {
    await shutdown()
    throw error
  }
}

try {
  await main()
} catch (error) {
  console.error(errorMessage(error))
  process.exitCode = 1
}
