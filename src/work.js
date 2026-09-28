const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }) }
const point = ({ x, y, z }) => new Vec3(x, y, z)
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const inventoryCount = (bot, name) => bot.inventory.items().filter(item => item.name === name).reduce((n, item) => n + item.count, 0)
const empty = block => block && ['air', 'cave_air', 'void_air'].includes(block.name)
const bedside = name => /^(?:white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_bed$/.test(name)

function nearby (bot, names, radius = 4.5) {
  return bot.findBlock({ matching: block => names.some(name => typeof name === 'string' ? block.name === name : name.test(block.name)), maxDistance: radius, useExtraInfo: true })
}

async function exclusive (service, fn) {
  const bot = service.ready()
  if (service.building) fail('Another world action is in progress')
  service.building = true
  try { return await fn(bot) } finally { service.building = false }
}

function missingFor (bot, recipe, count) {
  const needed = new Map()
  for (const ingredient of recipe.delta) {
    if (ingredient.count >= 0 || ingredient.id < 0) continue
    const name = bot.registry.items?.[ingredient.id]?.name || `item_${ingredient.id}`
    const key = `${ingredient.id}:${ingredient.metadata ?? '*'}`
    const row = needed.get(key) || { item: name, required: 0, available: bot.inventory.count(ingredient.id, ingredient.metadata) }
    row.required -= ingredient.count * count
    needed.set(key, row)
  }
  return [...needed.values()].filter(row => row.available < row.required)
}

async function craft (service, name, count) {
  return exclusive(service, async bot => {
    const item = bot.registry.itemsByName?.[name]
    if (!item) fail('Unknown craftable item', 400)
    const table = nearby(bot, ['crafting_table'])
    const recipes = bot.recipesAll(item.id, null, table || true)
    if (!recipes.length) fail(`No recipe for ${name} on this server`, 400)
    const choices = recipes.map(recipe => ({ recipe, iterations: Math.ceil(count / recipe.result.count), missing: missingFor(bot, recipe, Math.ceil(count / recipe.result.count)) }))
    const usable = choices.find(choice => !choice.missing.length && (!choice.recipe.requiresTable || table))
    if (!usable) {
      const readyWithTable = choices.find(choice => !choice.missing.length && choice.recipe.requiresTable)
      if (readyWithTable) fail('A placed crafting table is required within 4.5 blocks; craft and place one first')
      const closest = choices.sort((a, b) => a.missing.length - b.missing.length)[0]
      fail(`Missing materials for ${name}: ${closest.missing.map(m => `${m.item} ${m.available}/${m.required}`).join(', ')}`)
    }
    if (usable.recipe.requiresTable && gap(bot.entity.position, table.position) > 4.5) fail('Crafting table is out of reach')
    await bot.craft(usable.recipe, usable.iterations, usable.recipe.requiresTable ? table : null)
    return { crafted: name, count: usable.iterations * usable.recipe.result.count }
  })
}

async function placeBed (service, coords) {
  return exclusive(service, async bot => {
    const foot = target(bot, coords)
    if (!empty(foot)) fail('Bed foot target is not empty')
    const support = bot.blockAt(foot.position.offset(0, -1, 0))
    if (support?.boundingBox !== 'block') fail('Bed needs solid ground')
    const bed = bot.inventory.items().find(item => bedside(item.name))
    if (!bed) fail('Missing a bed in inventory')
    const directions = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    const possible = directions.map(direction => foot.position.plus(direction))
      .filter(head => empty(bot.blockAt(head)) && bot.blockAt(head.offset(0, -1, 0))?.boundingBox === 'block' && gap(bot.entity.position, head) <= 4.5)
    if (possible.length !== 4) fail('Bed needs four clear neighboring spaces over solid ground; orientation cannot be guaranteed safely here')
    await bot.equip(bed, 'hand')
    await bot.placeBlock(support, new Vec3(0, 1, 0))
    const placed = bot.blockAt(foot.position)
    if (placed?.name !== bed.name) fail('Placement was not confirmed as a bed; check the world before retrying')
    return { placed: bed.name, foot: coords, confirmed: true }
  })
}

async function sleep (service, wake = false) {
  return exclusive(service, async bot => {
    if (wake) { await bot.wake(); return { awake: true } }
    const bed = nearby(bot, [/^(?:\w+_)?bed$/], 4.5)
    if (!bed) fail('No placed bed within reach; craft and place a bed first')
    try { await bot.sleep(bed) } catch (error) { fail(`Cannot sleep: ${error.message}`) }
    return { sleeping: true, bed: { x: bed.position.x, y: bed.position.y, z: bed.position.z } }
  })
}

function target (bot, coords, radius = 4.5) {
  const pos = point(coords)
  if (gap(bot.entity.position, pos) > radius) fail('Target is out of reach', 400)
  const block = bot.blockAt(pos)
  if (!block) fail('Target chunk is not loaded')
  return block
}

async function till (service, coords) {
  return exclusive(service, async bot => {
    const block = target(bot, coords)
    if (!['dirt', 'grass_block'].includes(block.name)) fail('Only dirt or grass blocks can be tilled here')
    if (!empty(bot.blockAt(block.position.offset(0, 1, 0)))) fail('Space above soil must be empty')
    const wet = [-1, 0, 1].some(dy => {
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        const b = bot.blockAt(block.position.offset(dx, dy, dz))
        if (b && /^(?:water|flowing_water)$/.test(b.name)) return true
      }
      return false
    })
    if (!wet) fail('No water within four horizontal blocks of soil at soil level or one below/above')
    const hoe = bot.inventory.items().find(item => /_hoe$/.test(item.name))
    if (!hoe) fail('A hoe is required in inventory')
    await bot.equip(hoe, 'hand')
    await bot.activateBlock(block, new Vec3(0, 1, 0))
    return { tilled: coords }
  })
}

async function plant (service, coords) {
  return exclusive(service, async bot => {
    const soil = target(bot, coords)
    if (soil.name !== 'farmland' || !empty(bot.blockAt(soil.position.offset(0, 1, 0)))) fail('Target must be empty farmland')
    const seeds = bot.inventory.items().find(item => item.name === 'wheat_seeds')
    if (!seeds) fail('Missing wheat_seeds in inventory')
    await bot.equip(seeds, 'hand')
    await bot.placeBlock(soil, new Vec3(0, 1, 0))
    return { planted: 'wheat', soil: coords }
  })
}

async function harvest (service, coords, replant = false) {
  return exclusive(service, async bot => {
    const crop = target(bot, coords)
    if (crop.name !== 'wheat') fail('Target is not wheat')
    const age = crop.getProperties?.().age
    if (age !== 7 && age !== '7') fail('Wheat is not mature (age 7)')
    await bot.dig(crop)
    let replanted = false
    if (replant) {
      const seeds = bot.inventory.items().find(item => item.name === 'wheat_seeds')
      const soil = bot.blockAt(crop.position.offset(0, -1, 0))
      if (seeds && soil?.name === 'farmland') {
        await bot.equip(seeds, 'hand')
        await bot.placeBlock(soil, new Vec3(0, 1, 0))
        replanted = true
      }
    }
    return { harvested: 'wheat', replanted, note: 'Drops must be picked up separately; replant requires seeds already in inventory' }
  })
}

async function gather (service, coords) {
  return exclusive(service, async bot => {
    const block = target(bot, coords)
    const grass = ['short_grass', 'tall_grass'].includes(block.name)
    const log = /^(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/.test(block.name)
    if (!grass && !log) fail('Only wild grass or tree logs can be gathered; built structures are excluded')
    if (log) {
      let leaves = false
      for (let dx = -3; dx <= 3; dx++) for (let dy = 0; dy <= 5; dy++) for (let dz = -3; dz <= 3; dz++) {
        if (bot.blockAt(block.position.offset(dx, dy, dz))?.name?.endsWith('_leaves')) leaves = true
      }
      if (!leaves) fail('Log has no nearby leaves; it may be player-built, so it was not broken')
    }
    if (!bot.canDigBlock(block)) fail('Block cannot be safely dug from here')
    await bot.dig(block)
    const dropped = Object.values(bot.entities || {}).filter(entity => entity.name === 'item' && entity.position && gap(entity.position, block.position) < 3)
    let pickup = 'no nearby dropped item observed; approach the drops manually'
    if (dropped.length) {
      const item = dropped.sort((a, b) => gap(a.position, bot.entity.position) - gap(b.position, bot.entity.position))[0]
      if (gap(item.position, bot.entity.position) <= 4.5) {
        await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1))
        pickup = 'walked to a nearby dropped item; check inventory to confirm collection'
      }
    }
    return { gathered: block.name, position: coords, pickup }

  })
}

function shelterPlan (origin) {
  const blocks = []
  for (let y = 0; y < 2; y++) for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) {
    if (Math.abs(x) !== 2 && Math.abs(z) !== 2) continue
    if (z === -2 && x === 0) continue
    blocks.push(new Vec3(origin.x + x, origin.y + y, origin.z + z))
  }
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) blocks.push(new Vec3(origin.x + x, origin.y + 2, origin.z + z))
  return blocks
}

async function shelter (service, material, originInput) {
  return exclusive(service, async bot => {
    const origin = point(originInput)
    if (gap(bot.entity.position, origin) > 4) fail('Shelter origin must be within four blocks of bot')
    if (!['dirt', 'oak_planks', 'spruce_planks', 'birch_planks', 'cobblestone'].includes(material)) fail('Shelter material must be dirt, cobblestone or common planks', 400)
    const plan = shelterPlan(origin)
    const available = inventoryCount(bot, material)
    if (available < plan.length) fail(`Missing ${material}: ${available}/${plan.length} blocks in inventory`)
    for (const pos of plan) {
      if (!empty(bot.blockAt(pos))) fail(`Shelter footprint is not empty at ${pos.x},${pos.y},${pos.z}`)
      if (Object.values(bot.entities || {}).some(entity => entity.type === 'player' && entity.position && gap(entity.position, pos) < 1.5)) fail('Player is too close to shelter footprint')
      if (bot.blockAt(pos.offset(0, -1, 0)) == null) fail('Shelter footprint is not fully loaded')
      if (pos.y === origin.y && bot.blockAt(pos.offset(0, -1, 0)).boundingBox !== 'block') fail('Shelter walls require solid ground')
    }
    let placed = 0
    for (const pos of plan) {
      if (gap(bot.entity.position, pos) > 4.2) await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y - 1, pos.z, 3))
      if (gap(bot.entity.position, pos) > 4.5) fail(`Stopped after ${placed} blocks: target is out of reach`)
      const faces = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]
      const face = faces.find(v => bot.blockAt(pos.minus(v))?.boundingBox === 'block')
      if (!face) fail(`Stopped after ${placed} blocks: no support at ${pos.x},${pos.y},${pos.z}`)
      const item = bot.inventory.items().find(i => i.name === material && i.count > 0)
      if (!item) fail(`Stopped after ${placed} blocks: material ran out`)
      await bot.equip(item, 'hand')
      try { await bot.placeBlock(bot.blockAt(pos.minus(face)), face) } catch (error) { fail(`Stopped after ${placed} blocks: ${error.message}`) }
      placed++
    }
    return { built: '5x5 shelter with 3x3 interior and 1x2 doorway', material, blocks: placed, origin: originInput }
  })
}

module.exports = { craft, sleep, placeBed, till, plant, harvest, gather, shelter, shelterPlan, missingFor, bedside }
