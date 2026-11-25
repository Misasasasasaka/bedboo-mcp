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
  MCP_TRANSPORT: z.enum(['stdio', 'http', 'off']).optional(),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3107),
  MCP_HTTP_TOKEN: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_BASE_URL: z.string().trim().optional(),
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-5.4-mini'),
  OPENAI_API_MODE: z.enum(['responses', 'chat']).default('responses'),
  AGENT_COMMANDERS: z.string().default(''),
  AGENT_GOAL: z.string().trim().optional(),
  AGENT_MAX_ROUNDS: z.coerce.number().int().min(1).max(128).default(24),
})

export function loadConfig(env: NodeJS.ProcessEnv) {
  const config = configSchema.parse(env)
  const commanders = config.AGENT_COMMANDERS.split(',').map(name => name.trim().toLowerCase()).filter(Boolean)
  const transport = config.MCP_TRANSPORT ?? (config.OPENAI_API_KEY ? 'off' : 'stdio')
  if (!config.OPENAI_API_KEY && (commanders.length || config.AGENT_GOAL || transport === 'off')) {
    throw new Error('Set OPENAI_API_KEY to enable the embedded agent')
  }
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
      transport,
      port: config.MCP_PORT,
      token: config.MCP_HTTP_TOKEN,
    },
    agent: config.OPENAI_API_KEY ? {
      apiKey: config.OPENAI_API_KEY,
      baseURL: config.OPENAI_BASE_URL || undefined,
      model: config.OPENAI_MODEL,
      apiMode: config.OPENAI_API_MODE,
      commanders,
      startupGoal: config.AGENT_GOAL || undefined,
      maxRounds: config.AGENT_MAX_ROUNDS,
    } : undefined,
    database: join(dataDir, storeName + '.sqlite'),
  }
}

export type Config = ReturnType<typeof loadConfig>
