import { setTimeout as delay } from 'node:timers/promises'
import { commandSender } from './bot/commands.js'
import type { Connection, GameSession } from './bot/session.js'
import { JobStore, type JobState } from './job-store.js'
import { BridgeError, errorMessage, type CommandReceipt, type Work } from './types.js'

type Clock = {
  now(): number
  wait(ms: number, signal: AbortSignal): Promise<void>
}
const systemClock: Clock = {
  now: () => performance.now(),
  wait: (ms, signal) => delay(Math.ceil(ms), undefined, { signal }),
}
type PendingJob = { controller: AbortController; done: Promise<void> }
type FinalState = Exclude<JobState, 'queued' | 'running'>

export class GameJobs {
  private tail = Promise.resolve()
  private readonly active = new Map<string, PendingJob>()
  private stopping = false

  constructor(
    private readonly session: Pick<GameSession, 'requireConnection' | 'move'>,
    private readonly store: JobStore,
    private readonly commandTimeoutMs: number,
    private readonly clock = systemClock,
  ) {}

  get activeJob() { return this.store.activeJob() }

  submit(work: Work, requestId?: string) {
    if (this.stopping) throw new BridgeError('SHUTTING_DOWN', 'The bridge is stopping')
    const { id, fresh } = this.store.create(work, requestId)
    if (!fresh) return id

    const controller = new AbortController()
    const done = this.tail.then(() => this.execute(id, work, controller.signal)).catch(error => {
      // The store may be unavailable. Report this to the operator and keep the queue drainable.
      console.error('Unable to record Minecraft job result:', error)
      controller.abort(error)
    }).finally(() => this.active.delete(id)).then(() => undefined)
    this.tail = done
    this.active.set(id, { controller, done })
    return id
  }

  view(id: string, cursor?: number, limit?: number) {
    return {
      ...this.store.get(id, cursor, limit),
      cancelRequested: this.active.get(id)?.controller.signal.aborted ?? false,
    }
  }

  waitForCommand(id: string, signal?: AbortSignal) {
    return this.waitFor(id, this.commandTimeoutMs + 1000, signal)
  }

  async waitFor(id: string, waitMs: number, signal?: AbortSignal, cursor?: number, limit?: number) {
    const task = this.active.get(id)
    if (task && waitMs > 0) {
      const timer = new AbortController()
      try {
        await Promise.race([
          task.done,
          delay(waitMs, undefined, {
            signal: signal ? AbortSignal.any([timer.signal, signal]) : timer.signal,
          }),
        ])
      } finally {
        timer.abort()
      }
    }
    return this.view(id, cursor, limit)
  }

  cancel(id: string) {
    const before = this.store.get(id)
    this.active.get(id)?.controller.abort(new BridgeError('CANCELLED', 'Job cancelled by the caller'))
    if (before.state === 'queued') this.store.finish(id, 'cancelled', undefined, 'Job cancelled before execution')
    return this.view(id)
  }

  async close() {
    this.stopping = true
    for (const task of this.active.values()) {
      task.controller.abort(new BridgeError('SHUTTING_DOWN', 'The bridge stopped during this job'))
    }
    await this.tail
    this.store.close()
  }

  private async execute(id: string, work: Work, cancelled: AbortSignal) {
    if (cancelled.aborted) {
      if (this.stopping && this.store.get(id).state === 'queued') {
        this.store.finish(id, 'interrupted', undefined, errorMessage(cancelled.reason))
      }
      return
    }
    this.store.markRunning(id)
    let connection: Connection | undefined
    try {
      connection = this.session.requireConnection()
      const signal = AbortSignal.any([connection.signal, cancelled])
      let state: FinalState = 'succeeded'
      let result: unknown
      if (work.kind === 'move') {
        result = await this.session.move(connection, work.target, signal)
      } else {
        state = await this.executeCommands(id, work.steps, connection, signal)
      }
      this.store.finish(id, state, result)
    } catch (error) {
      let state: FinalState = 'failed'
      if (cancelled.aborted) state = this.stopping ? 'interrupted' : 'cancelled'
      else if (connection?.signal.aborted) state = 'interrupted'
      this.store.finish(id, state, undefined, errorMessage(error))
    }
  }

  private async executeCommands(
    id: string,
    steps: { command: string; atMs?: number }[],
    connection: Connection,
    signal: AbortSignal,
  ): Promise<FinalState> {
    const send = commandSender(connection.bot, this.commandTimeoutMs)
    const started = this.clock.now()
    const dispatch = async (index: number, command: string): Promise<CommandReceipt> => {
      this.store.sent(id, index, this.clock.now() - started)
      const receipt = await send(command)
      this.store.answer(id, index, receipt)
      return receipt
    }

    if (steps[0]?.atMs === undefined) {
      for (const [index, step] of steps.entries()) {
        signal.throwIfAborted()
        const receipt = await dispatch(index, step.command)
        if (receipt.state !== 'succeeded') return receipt.state
      }
      return 'succeeded'
    }

    const sent: Promise<CommandReceipt>[] = []
    try {
      for (const [index, step] of steps.entries()) {
        signal.throwIfAborted()
        const remaining = (step.atMs ?? 0) - (this.clock.now() - started)
        if (remaining > 0) await this.clock.wait(remaining, signal)
        signal.throwIfAborted()
        const receipt = dispatch(index, step.command)
        // A receipt can settle before the last dispatch. Attach a rejection handler immediately.
        void receipt.catch(() => {})
        sent.push(receipt)
      }
    } finally {
      const settled = await Promise.allSettled(sent)
      for (const receipt of settled) {
        if (receipt.status === 'rejected') throw receipt.reason
      }
    }

    const progress = this.store.progress(id)
    if (progress.unknown) return 'unknown'
    return progress.failed ? 'failed' : 'succeeded'
  }
}
