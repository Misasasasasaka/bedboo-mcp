import { randomUUID } from 'node:crypto'
import type { Connection, GameSession } from '../bot/session.js'
import type { Config } from '../config.js'
import { invokeTool, type GameTools } from '../game-tools.js'
import type { GameJobs } from '../jobs.js'
import { BridgeError, errorMessage } from '../types.js'
import { AgentModel, type ConversationMessage } from './model.js'

type AgentConfig = NonNullable<Config['agent']>
type Reporter = (message: string) => void
type ActiveTask = {
  controller: AbortController
  done: Promise<void>
}
const writeTools = new Set(['move_to', 'run_command', 'run_commands'])

export class GameAgent {
  private readonly model: AgentModel
  private readonly commanders: Set<string>
  private readonly history = new Map<string, ConversationMessage[]>()
  private readonly pendingJobs = new Set<string>()
  private active?: ActiveTask
  private started = false
  private closing = false

  constructor(
    private readonly config: AgentConfig,
    private readonly session: GameSession,
    private readonly jobs: GameJobs,
    private readonly tools: GameTools,
  ) {
    this.commanders = new Set(config.commanders)
    this.model = new AgentModel(config, tools)
  }

  onJoin(connection: Connection) {
    const { bot, signal } = connection
    bot.on('chat', (username, message) => {
      const name = username.toLowerCase()
      if (name === bot.username.toLowerCase() || !this.commanders.has(name)) return
      const match = /^!bot\s+(.+)$/u.exec(message.trim())
      const task = match?.[1]?.trim()
      if (!task) return
      this.accept(task, name, username, reply => {
        if (!signal.aborted) bot.whisper(username, reply.replace(/\s+/gu, ' ').slice(0, 480))
      })
    })

    signal.addEventListener('abort', () => this.cancel(), { once: true })
    console.error('[Agent] 已入服。玩家 %s，模型 %s。', bot.username, this.config.model)
    if (!this.started && !this.closing && this.config.startupGoal) {
      this.started = true
      this.fromConsole(this.config.startupGoal)
    }
  }

  fromConsole(value: string) {
    if (value.trim()) this.accept(value.trim(), 'local', undefined, message => console.error('[Agent]', message))
  }

  private accept(task: string, key: string, username: string | undefined, report: Reporter) {
    if (this.closing) return
    if (task.toLowerCase() === 'stop') {
      report(this.cancel() ? '已请求停止。' : '当前没有待执行的任务。')
      return
    }
    if (this.active) {
      report('正在执行任务。完成后可继续发任务，也可输入 stop。')
      return
    }
    if (!this.session.bot) {
      report('机器人正在连接服务器，入服后可以发送任务。')
      return
    }

    const controller = new AbortController()
    const connection = this.session.requireConnection()
    const signal = AbortSignal.any([controller.signal, connection.signal])
    const text = username ? 'Minecraft player ' + JSON.stringify(username) + ' requests:\n' + task : task
    const user: ConversationMessage = { role: 'user', content: text }
    const previous = this.history.get(key) ?? []
    const messages = [...previous, user]

    const done = Promise.resolve().then(async () => {
      const response = await this.run(messages, signal)
      signal.throwIfAborted()
      const reply: ConversationMessage = { role: 'assistant', content: response }
      this.history.set(key, [...messages, reply].slice(-12))
      report(response)
    }).catch(error => {
      if (signal.aborted) return
      const message = errorMessage(error).split(this.config.apiKey).join('[redacted]')
      console.error('[Agent] 任务失败：%s', message)
      if (username) report('任务失败。详情见程序日志。')
    }).finally(() => {
      this.active = undefined
      this.pruneJobs()
    })
    this.active = { controller, done }
  }

  private async run(input: ConversationMessage[], signal: AbortSignal) {
    const conversation = this.model.conversation(input)
    const runId = randomUUID()
    let callIndex = 0
    for (let round = 0; round < this.config.maxRounds; round++) {
      signal.throwIfAborted()
      const result = await conversation.next(signal)
      signal.throwIfAborted()
      if (!result.calls.length) {
        const text = result.text.trim()
        if (!text) throw new BridgeError('EMPTY_MODEL_REPLY', 'The model returned neither text nor a tool call')
        return text
      }

      for (const call of result.calls) {
        signal.throwIfAborted()
        let args: unknown
        try { args = JSON.parse(call.arguments) } catch {
          conversation.answer(call, JSON.stringify({ error: 'Tool arguments must be valid JSON' }))
          continue
        }

        if (writeTools.has(call.name) && args && typeof args === 'object' && !Array.isArray(args)) {
          const fields = args as Record<string, unknown>
          args = { ...fields, requestId: fields.requestId ?? runId + ':' + callIndex++ }
        }
        const response = await invokeTool(this.tools, call.name, args, {
          signal, onJob: id => this.pendingJobs.add(id),
        })
        conversation.answer(call, JSON.stringify(response.data))
      }
    }
    return '本轮已达到模型调用上限。可以继续发任务，或通过任务状态确认已执行的操作。'
  }

  private pruneJobs() {
    for (const id of this.pendingJobs) {
      const state = this.jobs.view(id, 0, 1).state
      if (state !== 'queued' && state !== 'running') this.pendingJobs.delete(id)
    }
  }

  cancel() {
    this.pruneJobs()
    const active = this.active
    const requested = !!active || this.pendingJobs.size > 0
    active?.controller.abort(new Error('Agent task cancelled'))
    for (const id of this.pendingJobs) this.jobs.cancel(id)
    this.pendingJobs.clear()
    return requested
  }

  async close() {
    this.closing = true
    const active = this.active
    this.cancel()
    await active?.done
  }
}
