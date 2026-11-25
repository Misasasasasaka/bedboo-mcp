import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { checkDimension, type GameSession } from '../bot/session.js'
import { inspect, readBlock, scanArea } from '../bot/world.js'
import type { GameJobs } from '../jobs.js'
import {
  BridgeError, commandStep, commandText, dimension, errorMessage,
  inspectOption, moveTarget, position, requestId,
} from '../types.js'

async function respond(action: () => Record<string, unknown> | Promise<Record<string, unknown>>) {
  try {
    const data = await action()
    return { structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
  } catch (error) {
    const data = {
      code: error instanceof BridgeError ? error.code : 'BRIDGE_ERROR',
      error: errorMessage(error),
    }
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
  }
}

const cursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
const jobId = z.uuid()
const readOnly = { readOnlyHint: true, openWorldHint: true }
const writesGame = { readOnlyHint: false, openWorldHint: true, destructiveHint: true }

export function makeMcpServer(session: GameSession, jobs: GameJobs) {
  const server = new McpServer({ name: 'bedboo-mcp', version: '0.1.0' })
  server.registerTool('get_status', {
    description: 'Read the Minecraft player connection, game version, current position and active job. Optionally include inventory, online players and nearby entities.',
    inputSchema: z.object({ include: z.array(inspectOption).max(3).default([]) }),
    annotations: readOnly,
  }, ({ include }) => respond(() => {
    const bot = session.bot
    return { ...session.status(), activeJobId: jobs.activeJob, ...(bot ? inspect(bot, include) : {}) }
  }))

  server.registerTool('get_blocks', {
    description: 'Read blocks at integer [x,y,z] coordinates in the current dimension. Unloaded positions are unknown. Air has a loaded block ID.',
    inputSchema: z.object({ dimension, positions: z.array(position).min(1).max(512) }),
    annotations: readOnly,
  }, ({ dimension, positions }) => respond(() => {
    const { bot } = session.requireConnection()
    checkDimension(bot, dimension)
    return { dimension, blocks: positions.map(pos => readBlock(bot, pos)) }
  }))

  server.registerTool('scan_area', {
    description: 'Read a page of blocks in an inclusive [min,max] cuboid in the current dimension. Pass nextCursor with the same bounds to continue.',
    inputSchema: z.object({
      dimension, min: position, max: position, cursor: cursorSchema,
      limit: z.number().int().min(1).max(512).default(256),
    }),
    annotations: readOnly,
  }, ({ dimension, min, max, cursor, limit }) => respond(() => {
    const { bot } = session.requireConnection()
    checkDimension(bot, dimension)
    return scanArea(bot, min, max, cursor, limit)
  }))

  server.registerTool('move_to', {
    description: 'Walk to the target in the current dimension. With y, arrive within one block of x,y,z. Without y, reach the x,z column. Poll get_job for the result.',
    inputSchema: moveTarget.extend({ requestId }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ requestId, ...target }) => respond(() =>
    ({ jobId: jobs.submit({ kind: 'move', target }, requestId) })))

  server.registerTool('run_command', {
    description: 'Execute a full Minecraft command as this player. The server decides syntax and permissions. Return the command receipt or a job ID if it is still pending. Use /help <command> for usage on this server.',
    inputSchema: z.object({ command: commandText, requestId }),
    annotations: writesGame,
  }, ({ command, requestId }, context) => respond(() => {
    const id = jobs.submit({ kind: 'command', steps: [{ command }] }, requestId)
    return jobs.waitForCommand(id, context.mcpReq.signal)
  }))

  server.registerTool('run_commands', {
    description: 'Queue a sequence of Minecraft commands and return a job ID. Omit atMs on every step to wait for each receipt. Supply atMs on every step for dispatch at nondecreasing offsets from the start of the job. Equal offsets dispatch in input order.',
    inputSchema: z.object({
      steps: z.array(commandStep).min(1).max(4096),
      requestId,
    }),
    annotations: writesGame,
  }, ({ steps, requestId }) => respond(() => {
    const timed = steps[0]?.atMs !== undefined
    let previous = 0
    for (const step of steps) {
      if ((step.atMs !== undefined) !== timed || (step.atMs ?? 0) < previous) {
        throw new BridgeError('INVALID_SCHEDULE', 'Supply nondecreasing atMs on every step or omit it on all steps')
      }
      previous = step.atMs ?? 0
    }
    return { jobId: jobs.submit({ kind: 'commands', steps }, requestId) }
  }))

  server.registerTool('get_job', {
    description: 'Poll a job and read Minecraft command receipts. Command steps are paged with nextCursor.',
    inputSchema: z.object({ jobId, cursor: cursorSchema, limit: z.number().int().min(1).max(100).default(50) }),
    annotations: readOnly,
  }, ({ jobId, cursor, limit }) => respond(() => jobs.view(jobId, cursor, limit)))

  server.registerTool('cancel_job', {
    description: 'Stop walking or stop sending remaining Minecraft commands. Previously dispatched commands may already have executed.',
    inputSchema: z.object({ jobId }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  }, ({ jobId }) => respond(() => jobs.cancel(jobId)))

  return server
}
