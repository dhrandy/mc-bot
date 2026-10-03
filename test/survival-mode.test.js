const { test } = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { SurvivalMode, escapeTarget, shelterPlan } = require('../src/survival-mode')
const { BotService } = require('../src/service')

function fixture () {
  const calls = []
  const items = []
  const blocks = new Map()
  const bot = {
    health: 20, food: 20, entity: { position: new Vec3(0.5, 64, 0.5), onGround: true }, entities: {},
    inventory: { items: () => items }, registry: { foodsByName: { bread: { foodPoints: 5 } } },
    time: { timeOfDay: 1000 },
    pathfinder: { movements: { canDig: true }, setGoal: () => {}, goto: async () => {} },
    blockAt (pos) { return blocks.get(pos.toString()) || { name: pos.y < 64 ? 'grass_block' : 'air', boundingBox: pos.y < 64 ? 'block' : 'empty', position: pos } },
    findBlock: () => null,
    clearControlStates: () => {}, stopDigging: () => {},
    equip: async item => { calls.push(['equip', item.name]); bot.heldItem = item },
    attack: entity => calls.push(['attack', entity.id]),
    quit: () => calls.push(['quit']),
    placeBlock: async (support, face) => { const pos = support.position.plus(face); blocks.set(pos.toString(), { name: bot.heldItem.name, boundingBox: 'block', position: pos }); calls.push(['place', pos.toString()]) }
  }
  const service = new BotService({})
  service.bot = bot
  service.state = 'online'
  const mode = service.survivalMode
  const start = () => { mode.state.enabled = true; mode.startedAt = Date.now() }
  const put = (pos, name) => blocks.set(pos.toString(), { name, boundingBox: name === 'air' ? 'empty' : 'block', position: pos })
  return { service, mode, bot, calls, items, blocks, start, put }
}

test('Survive defaults off, cannot enable offline and disables destructive path digging', () => {
  const { service, mode, bot } = fixture()
  assert.equal(mode.state.enabled, false)
  service.state = 'offline'
  assert.throws(() => mode.enable(), { status: 503 })
  service.state = 'online'
  mode.busy = true // enable cannot overlap an older unfinished operation
  assert.throws(() => mode.enable(), { status: 409 })
  mode.busy = false
  mode.tick = () => {}
  mode.enable()
  assert.equal(bot.pathfinder.movements.canDig, false)
  service.setSurvive(false)
  assert.equal(service.state, 'disconnected')
  assert.equal(mode.state.enabled, false)
})

test('no reachable wood searches an inspected corridor instead of quitting', async () => {
  const { service, mode, bot, start } = fixture(); start()
  mode.searchOrigin = bot.entity.position.floored()
  service.goto = (x, y, z) => { service.navigation = { state: 'arrived' }; bot.entity.position = new Vec3(x + 0.5, y, z + 0.5) }
  await mode.tick(bot)
  assert.equal(service.state, 'online')
  assert.equal(mode.state.goal, 'searching')
  assert.equal(mode.visited.size, 1)
})

test('safe inventory food is used, hunger without food quits', async () => {
  const { service, mode, bot, items, start } = fixture()
  start(); bot.food = 12
  items.push({ name: 'bread', count: 1 })
  service.consumeFood = async (b, food) => { assert.equal(food.name, 'bread'); b.food = 17 }
  await mode.tick(bot)
  assert.equal(mode.state.goal, 'eating')
  assert.equal(bot.food, 17)
  items.length = 0; bot.food = 12
  await mode.tick(bot)
  assert.equal(service.state, 'disconnected')
  assert.match(mode.state.reason, /food acquisition is not implemented/)
})

test('critical health, water and lava quit before any world work', async () => {
  for (const danger of ['health', 'isInWater', 'isInLava']) {
    const { service, mode, bot, calls, start } = fixture(); start()
    if (danger === 'health') bot.health = 6
    else bot.entity[danger] = true
    await mode.tick(bot)
    assert.equal(service.state, 'disconnected')
    assert.deepEqual(calls, [['quit']])
  }
})

test('known melee fights only with sword and healthy bot, never attacks players', async () => {
  const { mode, bot, calls, items, start } = fixture(); start()
  items.push({ name: 'wooden_sword', count: 1 })
  bot.entities = { 1: { id: 1, name: 'zombie', position: new Vec3(2, 64, 0) }, 2: { id: 2, name: 'player', type: 'player', position: new Vec3(1, 64, 0) } }
  await mode.tick(bot)
  assert.ok(calls.some(call => call[0] === 'attack' && call[1] === 1))
  assert.ok(!calls.some(call => call[0] === 'attack' && call[1] === 2))
})

test('flee corridor rejects holes, water, unloaded blocks and nearby players', () => {
  const { bot, put } = fixture()
  const threat = { name: 'creeper', position: new Vec3(-2, 64, 0) }
  assert.ok(escapeTarget(bot, threat))
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(new Vec3(dx, 63, dz), 'lava')
  assert.equal(escapeTarget(bot, threat), null)
})

test('night shelter closes a 1x1 interior, confirms every block, then quits', async () => {
  const { service, mode, bot, calls, items, start } = fixture(); start()
  bot.time.timeOfDay = 14000
  items.push({ name: 'dirt', count: 25 })
  assert.equal(shelterPlan(bot.entity.position.floored()).length, 25)
  await mode.tick(bot)
  assert.equal(calls.filter(call => call[0] === 'place').length, 25)
  assert.equal(service.state, 'disconnected')
  assert.match(mode.state.reason, /Shelter completed/)
})

test('shelter refuses occupied/player footprint before placing anything', async () => {
  for (const obstacle of ['block', 'player']) {
    const { service, mode, bot, calls, items, start, put } = fixture(); start()
    bot.time.timeOfDay = 14000; items.push({ name: 'dirt', count: 25 })
    if (obstacle === 'block') put(new Vec3(1, 64, 1), 'chest')
    else bot.entities = { 1: { type: 'player', position: new Vec3(1, 64, 1) } }
    await mode.tick(bot)
    assert.equal(calls.filter(call => call[0] === 'place').length, 0)
    assert.equal(service.state, 'disconnected')
  }
})

test('manual Stop disconnects enabled survival and cancels generation', () => {
  const { service, mode, start } = fixture(); start()
  const old = mode.generation
  assert.equal(service.stop().disconnected, true)
  assert.ok(mode.generation > old)
  assert.equal(mode.state.enabled, false)
})

test('craft prerequisites and tools use existing checked recipes', async () => {
  const { service, mode, bot, calls, items, start } = fixture(); start()
  items.push({ name: 'oak_log', count: 1 })
  service.craft = async (name, count) => calls.push(['craft', name, count])
  await mode.tick(bot)
  assert.deepEqual(calls.at(-1), ['craft', 'oak_planks', 4])
  items.splice(0, 1, { name: 'oak_planks', count: 16 })
  await mode.tick(bot)
  assert.deepEqual(calls.at(-1), ['craft', 'crafting_table', 1])
  bot.findBlock = () => ({ name: 'crafting_table', position: new Vec3(2, 64, 0) })
  items.push({ name: 'stick', count: 4 })
  await mode.tick(bot)
  assert.deepEqual(calls.at(-1), ['craft', 'wooden_pickaxe', 1])
})

test('unfinished world action does not overlap and quits on hostile interruption', async () => {
  const { service, mode, bot, start } = fixture(); start()
  mode.busy = true
  bot.entities = { 1: { name: 'zombie', position: new Vec3(1, 64, 0) } }
  await mode.tick(bot)
  assert.equal(service.state, 'disconnected')
  assert.match(mode.state.reason, /interrupted/)
})

test('disabled pending craft cannot progress into another action', async () => {
  const { service, mode, bot, items, calls, start } = fixture(); start()
  items.push({ name: 'oak_log', count: 1 })
  let finish
  service.craft = () => new Promise(resolve => { finish = resolve })
  const running = mode.tick(bot)
  assert.equal(mode.busy, true)
  service.setSurvive(false)
  finish()
  await running
  assert.equal(mode.busy, false)
  assert.equal(service.state, 'disconnected')
  assert.equal(mode.state.enabled, false)
  assert.deepEqual(calls, [['quit']])
})

test('failed craft disconnects with visible reason and does not retry', async () => {
  const { service, mode, bot, items, start } = fixture(); start()
  items.push({ name: 'oak_log', count: 1 })
  let calls = 0
  service.craft = async () => { calls++; throw new Error('Protected or missing recipe') }
  await mode.tick(bot)
  await mode.tick(bot)
  assert.equal(calls, 1)
  assert.equal(service.state, 'disconnected')
  assert.equal(mode.state.error, 'Protected or missing recipe')
})

test('unknown world time is a safety failure, not a soft idle state', async () => {
  const { service, mode, bot, calls, start } = fixture(); start()
  bot.time = null
  await mode.tick(bot)
  assert.equal(service.state, 'disconnected')
  assert.deepEqual(calls, [['quit']])
})

test('bounded search refuses hazards, player corridors and radius overflow', () => {
  const { searchStep } = require('../src/survival-mode')
  const { bot, put } = fixture()
  const origin = bot.entity.position.floored()
  assert.ok(searchStep(bot, origin, new Set()))
  assert.equal(searchStep(bot, origin, new Set(), 2), null)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(origin.offset(dx, -1, dz), 'lava')
  assert.equal(searchStep(bot, origin, new Set()), null)
})

test('search blocked does not quit or make blind movement', async () => {
  const { service, mode, bot, start, put } = fixture(); start()
  const feet = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(feet.offset(dx, -1, dz), 'lava')
  await mode.tick(bot)
  assert.equal(service.state, 'online')
  assert.equal(mode.state.goal, 'search-blocked')
})

test('soft blocked search remains connected beyond the former turn budget', async () => {
  const { service, mode, bot, start, put } = fixture(); start()
  const feet = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(feet.offset(dx, -1, dz), 'lava')
  for (let turn = 0; turn < 150; turn++) await mode.tick(bot)
  assert.equal(service.state, 'online')
  assert.equal(mode.state.enabled, true)
  assert.equal(mode.state.goal, 'search-blocked')
})
