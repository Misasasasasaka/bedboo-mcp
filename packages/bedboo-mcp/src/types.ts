import { z } from 'zod/v4'

export const dimension = z.enum(['overworld', 'the_nether', 'the_end'])
export type Dimension = z.infer<typeof dimension>

export const coordinate = z.number().int().min(-30000000).max(30000000)
export const position = z.tuple([coordinate, coordinate, coordinate])
export type Position = z.infer<typeof position>

export const moveTarget = z.object({
  dimension, x: coordinate, z: coordinate, y: coordinate.optional(),
})
export type MoveTarget = z.infer<typeof moveTarget>

export const inspectOption = z.enum(['inventory', 'players', 'entities'])
export type InspectOption = z.infer<typeof inspectOption>

export const commandText = z.string().trim().min(1).max(32767)
  .refine(value => !/[\r\n\0]/.test(value) && value !== '/', 'Expected a single Minecraft command')
  .transform(value => value.startsWith('/') ? value : '/' + value)

export const commandStep = z.object({
  command: commandText,
  atMs: z.number().int().min(0).max(3600000).optional(),
})
export type CommandStep = z.infer<typeof commandStep>

export const requestId = z.string().min(1).max(128).optional()

export type Work =
  | { kind: 'move'; target: MoveTarget }
  | { kind: 'command' | 'commands'; steps: CommandStep[] }

export type CommandReceipt = {
  state: 'succeeded' | 'failed'
  successCount: number
  outputType: string
  messages: { id: string; parameters: string[]; success: boolean }[]
} | {
  state: 'unknown'
  error: string
}

export class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
