import type { Bot } from 'bedboo'
import { BridgeError, errorMessage, type CommandReceipt } from '../types.js'

type Output = {
  output_type: string
  success_count: number
  output: { message_id: string; parameters: string[]; success: boolean }[]
}

type CommandSupport = Bot & {
  _bedrock?: {
    commands?: {
      request(command: string, options: { timeout: number }): Promise<Output>
    }
  }
}

export function commandSender(bot: Bot, timeout: number) {
  const api = (bot as CommandSupport)._bedrock?.commands
  if (!api) throw new BridgeError('COMMAND_API_UNAVAILABLE', 'The pinned bedboo command request API is unavailable')

  return async (command: string): Promise<CommandReceipt> => {
    try {
      const result = await api.request(command, { timeout })
      return {
        state: result.success_count > 0 ? 'succeeded' : 'failed',
        successCount: result.success_count,
        outputType: result.output_type,
        messages: result.output.map(line => ({
          id: line.message_id,
          parameters: line.parameters,
          success: line.success,
        })),
      }
    } catch (error) {
      // The server may have executed a command whose response was lost.
      return { state: 'unknown', error: errorMessage(error) }
    }
  }
}
