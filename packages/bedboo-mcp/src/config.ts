import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'

const configSchema = z.object({
  MC_HOST: z.string().trim().min(1),
  MC_PORT: z.coerce.number().int().min(1).max(65535).default(19132),
  MC_VERSION: z.string().trim().min(1),
  MC_TRANSPORT: z.enum(['raknet', 'nethernet']).default('nethernet'),
  MC_ACCOUNT: z.string().trim().min(1),
  MC_AUTH: z.enum(['microsoft', 'offline']).default('microsoft'),
  MC_DATA_DIR: z.string().min(1).default('.bedboo-mcp'),
  MC_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(500).max(25000).default(8000),
  MC_MOVE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(45000),
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3107),
  MCP_HTTP_TOKEN: z.string().min(1).optional(),
})

export function loadConfig(env: NodeJS.ProcessEnv) {
  const config = configSchema.parse(env)
  const dataDir = resolve(config.MC_DATA_DIR)
  const serverIdentity = JSON.stringify([
    config.MC_HOST.toLowerCase(), config.MC_PORT, config.MC_AUTH,
    config.MC_AUTH === 'microsoft' ? config.MC_ACCOUNT.toLowerCase() : config.MC_ACCOUNT,
  ])
  const storeName = createHash('sha256').update(serverIdentity).digest('hex')
  return {
    game: {
      host: config.MC_HOST,
      port: config.MC_PORT,
      version: config.MC_VERSION,
      transport: config.MC_TRANSPORT,
      account: config.MC_ACCOUNT,
      auth: config.MC_AUTH,
      profilesDir: join(dataDir, 'profiles'),
      commandTimeoutMs: config.MC_COMMAND_TIMEOUT_MS,
      moveTimeoutMs: config.MC_MOVE_TIMEOUT_MS,
    },
    mcp: {
      transport: config.MCP_TRANSPORT,
      port: config.MCP_PORT,
      token: config.MCP_HTTP_TOKEN,
    },
    database: join(dataDir, storeName + '.sqlite'),
  }
}

export type Config = ReturnType<typeof loadConfig>
