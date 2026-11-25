import type { Bot } from 'bedboo'
import vec3 from 'vec3'
import { BridgeError, type InspectOption, type Position } from '../types.js'
import { positionOf } from './session.js'

const { Vec3 } = vec3

function namespaced(name: string) {
  return name.includes(':') ? name : 'minecraft:' + name
}

export function readBlock(bot: Bot, position: Position) {
  const [x, y, z] = position
  // bedboo supplies minY and height from the current Bedrock dimension.
  const game = bot.game as Bot['game'] & { minY?: number; height?: number }
  if (game.minY !== undefined && game.height !== undefined && (y < game.minY || y >= game.minY + game.height)) {
    return { position, state: 'out_of_bounds' as const }
  }

  const block = bot.blockAt(new Vec3(x, y, z), false)
  if (!block) return { position, state: 'unknown' as const }
  const overlay = (block as typeof block & { superimposed?: { name: string } }).superimposed
  return {
    position,
    state: 'loaded' as const,
    id: namespaced(block.name),
    blockStateId: block.stateId,
    properties: block.getProperties(),
    overlay: overlay && namespaced(overlay.name),
  }
}

export function scanArea(bot: Bot, min: Position, max: Position, cursor: number, limit: number) {
  const [minX, minY, minZ] = min
  const width = max[0] - minX + 1
  const height = max[1] - minY + 1
  const depth = max[2] - minZ + 1
  const volume = width * height * depth
  if (width < 1 || height < 1 || depth < 1 || !Number.isSafeInteger(volume)) {
    throw new BridgeError('INVALID_REGION', 'Supply ordered bounds with a safe integer volume')
  }
  if (cursor > volume) throw new BridgeError('INVALID_CURSOR', 'Cursor exceeds the region volume')

  const blocks = []
  const pageEnd = cursor + Math.min(limit, volume - cursor)
  for (let index = cursor; index < pageEnd; index++) {
    const x = minX + index % width
    const z = minZ + Math.floor(index / width) % depth
    const y = minY + Math.floor(index / (width * depth))
    blocks.push(readBlock(bot, [x, y, z]))
  }

  return {
    dimension: bot.game.dimension, min, max, volume,
    blocks, nextCursor: pageEnd < volume ? pageEnd : null,
  }
}

export function inspect(bot: Bot, include: InspectOption[]) {
  return {
    inventory: include.includes('inventory')
      ? bot.inventory?.items().map(item => ({ id: namespaced(item.name), count: item.count, slot: item.slot }))
      : undefined,
    players: include.includes('players')
      ? Object.values(bot.players).map(player => ({
        username: player.username,
        position: player.entity ? positionOf(player.entity.position) : null,
      }))
      : undefined,
    entities: include.includes('entities')
      ? Object.values(bot.entities).sort((a, b) =>
        a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position),
      ).slice(0, 100).map(entity => ({
        id: String(entity.id), type: entity.type, name: entity.name, username: entity.username,
        position: positionOf(entity.position),
      }))
      : undefined,
  }
}
