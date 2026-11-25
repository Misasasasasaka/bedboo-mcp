import { z } from 'zod/v4'
import { checkDimension, type GameSession } from './bot/session.js'
import { inspect, readBlock, scanArea } from './bot/world.js'
import type { GameJobs } from './jobs.js'
import {
  BridgeError, commandStep, commandText, dimension, errorMessage,
  inspectOption, moveTarget, position, requestId,
} from './types.js'

export type ToolContext = { signal?: AbortSignal; onJob?: (id: string) => void }
type Data = Record<string, unknown>
type Annotations = { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
type GameTool = {
  inputSchema: z.ZodObject
  description: string
  annotations: Annotations
  call(input: unknown, context: ToolContext): Data | Promise<Data>
}
export type GameTools = Record<string, GameTool>

function tool<S extends z.ZodObject>(
  inputSchema: S,
  description: string,
  annotations: Annotations,
  action: (input: z.output<S>, context: ToolContext) => Data | Promise<Data>,
): GameTool {
  return { inputSchema, description, annotations, call: (input, context) => action(inputSchema.parse(input), context) }
}

export async function invokeTool(tools: GameTools, name: string, input: unknown, context: ToolContext = {}) {
  try {
    context.signal?.throwIfAborted()
    const definition = Object.hasOwn(tools, name) && tools[name]
    if (!definition) throw new BridgeError('UNKNOWN_TOOL', 'Unknown Minecraft tool: ' + name)
    return { data: await definition.call(input, context), isError: false }
  } catch (error) {
    const data = {
      code: error instanceof BridgeError ? error.code : error instanceof z.ZodError ? 'INVALID_ARGUMENTS' : 'BRIDGE_ERROR',
      error: errorMessage(error),
    }
    return { data, isError: true }
  }
}

const cursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
const jobId = z.uuid()
const readOnly = { readOnlyHint: true, openWorldHint: true }
const writesGame = { readOnlyHint: false, openWorldHint: true, destructiveHint: true }

export function makeGameTools(session: GameSession, jobs: GameJobs): GameTools {
  return {
    get_status: tool(
      z.object({ include: z.array(inspectOption).max(3).default([]) }),
      'Read connection, current position, dimension and active job. Optionally include inventory, players and nearby entities.',
      readOnly,
      ({ include }) => {
        const bot = session.bot
        return { ...session.status(), activeJobId: jobs.activeJob, ...(bot ? inspect(bot, include) : {}) }
      },
    ),
    get_blocks: tool(
      z.object({ dimension, positions: z.array(position).min(1).max(512) }),
      'Read blocks at integer [x,y,z] coordinates in the current dimension. Unloaded positions are unknown. Air has a loaded block ID.',
      readOnly,
      ({ dimension, positions }) => {
        const { bot } = session.requireConnection()
        checkDimension(bot, dimension)
        return { dimension, blocks: positions.map(pos => readBlock(bot, pos)) }
      },
    ),
    scan_area: tool(
      z.object({
        dimension, min: position, max: position, cursor: cursorSchema,
        limit: z.number().int().min(1).max(512).default(256),
      }),
      'Read one page of an inclusive [min,max] cuboid. Pass nextCursor with the same bounds to continue.',
      readOnly,
      ({ dimension, min, max, cursor, limit }) => {
        const { bot } = session.requireConnection()
        checkDimension(bot, dimension)
        return scanArea(bot, min, max, cursor, limit)
      },
    ),
    move_to: tool(
      moveTarget.extend({ requestId }),
      'Walk to a target in the current dimension. With y, arrive within one block of x,y,z. Without y, reach the x,z column. Wait for the job before depending on its position.',
      { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      ({ requestId, ...target }, context) => {
        const jobId = jobs.submit({ kind: 'move', target }, requestId)
        context.onJob?.(jobId)
        return { jobId }
      },
    ),
    run_command: tool(
      z.object({ command: commandText, requestId }),
      'Execute a full Minecraft command as this player. The server decides syntax and permissions. Return the receipt or a job ID if it is pending. Use /help <command> for usage.',
      writesGame,
      ({ command, requestId }, context) => {
        const id = jobs.submit({ kind: 'command', steps: [{ command }] }, requestId)
        context.onJob?.(id)
        return jobs.waitForCommand(id, context.signal)
      },
    ),
    run_commands: tool(
      z.object({ steps: z.array(commandStep).min(1).max(4096), requestId }),
      'Queue commands and return a job ID. Omit all atMs to wait for each receipt. Supply atMs on every step for nondecreasing offsets from the start of the job. Equal offsets dispatch in input order.',
      writesGame,
      ({ steps, requestId }, context) => {
        const timed = steps[0]?.atMs !== undefined
        let previous = 0
        for (const step of steps) {
          if ((step.atMs !== undefined) !== timed || (step.atMs ?? 0) < previous) {
            throw new BridgeError('INVALID_SCHEDULE', 'Supply nondecreasing atMs on every step or omit it on all steps')
          }
          previous = step.atMs ?? 0
        }
        const jobId = jobs.submit({ kind: 'commands', steps }, requestId)
        context.onJob?.(jobId)
        return { jobId }
      },
    ),
    get_job: tool(
      z.object({
        jobId, cursor: cursorSchema, limit: z.number().int().min(1).max(100).default(50),
        waitMs: z.number().int().min(0).max(12000).default(0),
      }),
      'Read job status and paginated receipts. Set waitMs to wait up to 12 seconds for a pending job to finish.',
      readOnly,
      ({ jobId, cursor, limit, waitMs }, context) => jobs.waitFor(jobId, waitMs, context.signal, cursor, limit),
    ),
    cancel_job: tool(
      z.object({ jobId }),
      'Stop walking or stop sending remaining commands. Dispatched commands may have executed.',
      { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      ({ jobId }) => jobs.cancel(jobId),
    ),
  }
}
