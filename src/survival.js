const { goals } = require('mineflayer-pathfinder')

// Unknown entities are never attacked. Names match Minecraft Java entity IDs.
const MELEE = new Set(['zombie', 'husk', 'zombie_villager', 'spider', 'cave_spider', 'silverfish', 'endermite', 'slime'])
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'parched', 'drowned', 'pillager', 'witch', 'blaze', 'ghast', 'guardian', 'elder_guardian', 'shulker', 'breeze', 'evoker'])
const HEAVY = new Set(['magma_cube', 'phantom', 'camel_husk', 'zombie_nautilus', 'wither_skeleton', 'hoglin', 'zoglin', 'piglin_brute', 'vindicator', 'vex', 'ravager'])
const NEVER = new Set(['enderman', 'piglin', 'zombified_piglin', 'creaking', 'warden', 'wither', 'ender_dragon', 'giant', 'illusioner'])
const DANGEROUS = new Set(['creeper', ...MELEE, ...RANGED, ...HEAVY, ...NEVER])

function mobName (entity) {
  return String(entity?.name || '').toLowerCase()
}

function distance (a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function strategy (entity) {
  const name = mobName(entity)
  if (name === 'creeper') return 'creeper'
  if (NEVER.has(name)) return 'avoid'
  if (name === 'drowned' || RANGED.has(name) || HEAVY.has(name)) return 'retreat'
  if (MELEE.has(name)) return 'melee'
  return 'unknown'
}

function retreat (bot, entity, minimum = 9) {
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
  const type = strategy(entity)
  const gap = distance(bot.entity.position, entity.position)
  if (type === 'creeper') {
    if (gap > 9) return { action: 'none', mob: name }
    // One hit only from the outer edge of melee reach; escape takes priority.
    const weapon = /(?:_sword|_axe)$/.test(bot.heldItem?.name || '')
    const swing = weapon && gap >= 2.6 && gap <= 3 && now - lastHitAt >= 3000
    const escaping = retreat(bot, entity, 9)
    if (!escaping) return { action: 'unsafe', mob: name }
    if (swing) bot.attack(entity)
    return { action: swing ? 'hit-and-retreat' : 'retreat', mob: name }
  }
  if (type === 'retreat' || type === 'avoid') {
    if (gap > 8) return { action: 'none', mob: name }
    return { action: retreat(bot, entity) ? 'retreat' : 'unsafe', mob: name }
  }
  if (type !== 'melee') return { action: 'unsupported', mob: name }
  if (gap > 2.8 || now - lastHitAt < (name.includes('spider') ? 700 : 650)) return { action: 'hold', mob: name }
  bot.attack(entity)
  return { action: 'attack', mob: name }
}

// Run from the closest creeper inside nine blocks; never swings at it.
function flee (bot) {
  const creepers = Object.values(bot.entities || {})
    .filter(entity => entity?.position && mobName(entity) === 'creeper')
    .map(entity => ({ entity, gap: distance(bot.entity.position, entity.position) }))
    .filter(({ gap }) => gap <= 9)
    .sort((a, b) => a.gap - b.gap)
  if (!creepers.length) return { action: 'none' }
  const { entity, gap } = creepers[0]
  if (!retreat(bot, entity, 10)) return { action: 'unsafe', mob: 'creeper' }
  return { action: 'flee', mob: 'creeper', distance: Math.round(gap * 10) / 10 }
}

function selectThreat (bot) {
  const entities = Object.values(bot.entities || {})
    .filter(entity => entity?.position && DANGEROUS.has(mobName(entity)))
    .map(entity => ({ entity, gap: distance(bot.entity.position, entity.position) }))
    .filter(({ gap }) => gap <= 9)
  entities.sort((a, b) => {
    const priority = entity => strategy(entity) === 'creeper' ? 0 : strategy(entity) === 'avoid' ? 1 : strategy(entity) === 'retreat' ? 2 : 3
    return priority(a.entity) - priority(b.entity) || a.gap - b.gap
  })
  return entities[0]?.entity || null
}

module.exports = { MELEE, RANGED, HEAVY, NEVER, DANGEROUS, distance, mobName, strategy, defend, selectThreat, flee }
