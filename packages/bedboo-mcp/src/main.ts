import { Console } from 'node:console'
import { createHash, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
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
  const { makeMcpServer } = await import('./mcp/tools.js')
  const session = new GameSession(config.game)
  const jobs = new GameJobs(session, new JobStore(config.database), config.game.commandTimeoutMs)
  const factory = () => makeMcpServer(session, jobs)
  let closeTransport: (() => Promise<void>) | undefined
  let shuttingDown: Promise<void> | undefined

  function shutdown() {
    return shuttingDown ??= Promise.resolve().then(async () => {
      session.stop()
      try {
        await closeTransport?.()
      } finally {
        await jobs.close()
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
    if (config.mcp.transport === 'stdio') {
      const mcp = factory()
      mcp.server.onclose = stop
      closeTransport = () => mcp.close()
      await mcp.connect(new StdioServerTransport())
    } else {
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
