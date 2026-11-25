import { mkdirSync } from 'node:fs'
import bedboo, { type Bot, type Plugin } from 'bedboo'
import pathfinding from 'mineflayer-pathfinder'
import type { Config } from '../config.js'
import { BridgeError, errorMessage, type Dimension, type MoveTarget } from '../types.js'

const { pathfinder, Movements, goals } = pathfinding

type Pathfinder = {
  setMovements(movements: InstanceType<typeof Movements>): void
  setGoal(goal: null): void
  goto(goal: InstanceType<typeof goals.GoalNear> | InstanceType<typeof goals.GoalXZ>): Promise<void>
}
type PlayerBot = Bot & { pathfinder: Pathfinder }
export type Connection = { bot: PlayerBot; signal: AbortSignal }
type Connecting = {
  bot: PlayerBot
  controller: AbortController
  ready: boolean
}

export function positionOf(value: { x: number; y: number; z: number }) {
  return { x: value.x, y: value.y, z: value.z }
}

export class GameSession {
  private current?: Connecting
  private reconnect?: NodeJS.Timeout
  private closing = false
  private lastError?: string

  constructor(private readonly config: Config['game']) {}

  start() {
    mkdirSync(this.config.profilesDir, { recursive: true, mode: 0o700 })
    this.connect()
  }

  private connect() {
    if (this.closing || this.current) return
    const { host, port, version, transport, account, auth, profilesDir } = this.config

    try {
      const bot = bedboo.createBot({
        host, port, version, transport, username: account, auth,
        profilesFolder: profilesDir,
        hideErrors: true,
        onMsaCode: data => console.error(data.message),
      }) as PlayerBot
      const current = { bot, controller: new AbortController(), ready: false }
      this.current = current

      bot.on('error', error => {
        this.lastError = errorMessage(error)
        console.error('Minecraft connection:', this.lastError)
      })
      bot.on('kicked', reason => {
        this.lastError = String(reason)
      })
      bot.once('end', reason => {
        if (this.current !== current) return
        current.controller.abort(new BridgeError('DISCONNECTED', String(reason ?? 'Minecraft disconnected')))
        this.current = undefined
        if (!this.closing) this.lastError ??= String(reason ?? 'Minecraft disconnected')
        this.scheduleReconnect()
      })
      bot.on('spawn', () => {
        current.ready = true
        this.lastError = undefined
      })
      bot.loadPlugin(pathfinder as unknown as Plugin)
    } catch (error) {
      this.lastError = errorMessage(error)
      this.current?.bot.end()
      this.current = undefined
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.closing || this.reconnect) return
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined
      this.connect()
    }, 5000)
  }

  get bot(): PlayerBot | undefined {
    return this.current?.ready && !this.current.controller.signal.aborted ? this.current.bot : undefined
  }

  status() {
    const bot = this.bot
    return {
      state: bot ? 'online' : this.current ? 'connecting' : 'offline',
      username: bot?.username,
      version: bot?.version ?? this.config.version,
      protocolVersion: bot?.protocolVersion,
      transport: this.config.transport,
      dimension: bot?.game.dimension,
      position: bot && positionOf(bot.entity.position),
      gameMode: bot?.game.gameMode,
      health: bot?.health,
      lastError: this.lastError,
    }
  }

  requireConnection(): Connection {
    if (!this.current || !this.bot) throw new BridgeError('BOT_NOT_READY', 'The Minecraft player has not spawned')
    return { bot: this.current.bot, signal: this.current.controller.signal }
  }

  stop() {
    this.closing = true
    clearTimeout(this.reconnect)
    const current = this.current
    this.current = undefined
    current?.controller.abort(new BridgeError('DISCONNECTED', 'Minecraft session closed'))
    current?.bot.end('MCP server shutdown')
  }

  async move(connection: Connection, target: MoveTarget, signal: AbortSignal) {
    const { bot } = connection
    checkDimension(bot, target.dimension)

    const moves = new Movements(bot as unknown as ConstructorParameters<typeof Movements>[0])
    moves.canDig = false
    moves.allow1by1towers = false
    moves.scafoldingBlocks = []
    bot.pathfinder.setMovements(moves)

    const goal = target.y === undefined
      ? new goals.GoalXZ(target.x, target.z)
      : new goals.GoalNear(target.x, target.y, target.z, 1)

    const changed = new AbortController()
    const stopped = AbortSignal.any([signal, changed.signal, AbortSignal.timeout(this.config.moveTimeoutMs)])
    const watchDimension = () => {
      if (bot.game.dimension !== target.dimension) {
        changed.abort(new BridgeError('DIMENSION_CHANGED', 'The Minecraft player changed dimension during movement'))
      }
    }

    let stopMoving: (() => void) | undefined
    bot.on('game', watchDimension)
    try {
      stopped.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        stopMoving = () => {
          reject(stopped.reason)
          bot.pathfinder.setGoal(null)
        }
        stopped.addEventListener('abort', stopMoving, { once: true })
        void bot.pathfinder.goto(goal).then(resolve, reject)
      })
      return { dimension: bot.game.dimension, position: positionOf(bot.entity.position) }
    } finally {
      if (stopMoving) stopped.removeEventListener('abort', stopMoving)
      bot.removeListener('game', watchDimension)
    }
  }
}

export function checkDimension(bot: Bot, expected: Dimension) {
  if (bot.game.dimension !== expected) {
    throw new BridgeError('DIMENSION_MISMATCH', 'Player is in ' + bot.game.dimension + ', requested ' + expected)
  }
}
