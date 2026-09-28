const { goals } = require('mineflayer-pathfinder')

const MELEE = new Set(['zombie', 'husk', 'zombie_villager', 'spider', 'cave_spider'])
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'drowned'])
const DANGEROUS = new Set(['creeper', ...MELEE, ...RANGED])
const EXCLUDED = new Set(['enderman', 'player'])

function distance (a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function mobName (entity) {
  return String(entity?.name || '').toLowerCase()
}

function retreat (bot, entity, minimum = 7) {
  const from = bot.entity.position
  const towards = entity.position
  const dx = from.x - towards.x
  const dz = from.z - towards.z
  const length = Math.hypot(dx, dz)
  if (length < 0.1) return false
  const steps = Math.max(0, minimum - length) + 2
  bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(from.x + dx / length * steps), Math.floor(from.y), Math.floor(from.z + dz / length * steps), 1))
  return true
}

function defend (bot, entity, lastHitAt = 0, now = Date.now()) {
  const name = mobName(entity)
  const gap = distance(bot.entity.position, entity.position)
  if (name === 'creeper') {
    if (gap > 9) return { action: 'none', mob: name }
    return { action: retreat(bot, entity, 9) ? 'retreat' : 'unsafe', mob: name }
  }
  if (name === 'drowned' || RANGED.has(name)) {
    if (gap > 8) return { action: 'none', mob: name }
    return { action: retreat(bot, entity, 9) ? 'retreat' : 'unsafe', mob: name }
  }
  if (!MELEE.has(name)) return { action: 'unsupported', mob: name }
  if (gap > 2.8 || now - lastHitAt < (name.includes('spider') ? 700 : 650)) return { action: 'hold', mob: name }
  bot.attack(entity)
  return { action: 'attack', mob: name }
}

function selectThreat (bot) {
  const entities = Object.values(bot.entities || {})
    .filter(entity => entity?.position && DANGEROUS.has(mobName(entity)) && !EXCLUDED.has(mobName(entity)))
    .map(entity => ({ entity, gap: distance(bot.entity.position, entity.position) }))
    .filter(({ gap }) => gap <= 9)
  entities.sort((a, b) => {
    const ap = mobName(a.entity) === 'creeper' ? 0 : 1
    const bp = mobName(b.entity) === 'creeper' ? 0 : 1
    return ap - bp || a.gap - b.gap
  })
  return entities[0]?.entity || null
}

module.exports = { MELEE, RANGED, DANGEROUS, distance, mobName, defend, selectThreat }
