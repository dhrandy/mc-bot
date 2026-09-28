const { test } = require('node:test')
const assert = require('node:assert/strict')
const { BotService } = require('../src/service')
const { SAFE_FOODS, chooseFood } = require('../src/food')
const { strategy, defend, DANGEROUS, selectThreat } = require('../src/survival')

const data = require('minecraft-data')('1.21.11')
const response = {
  melee: ['zombie', 'husk', 'zombie_villager', 'spider', 'cave_spider', 'silverfish', 'endermite', 'slime'],
  creeper: ['creeper'],
  retreat: ['skeleton', 'stray', 'bogged', 'parched', 'drowned', 'pillager', 'witch', 'blaze', 'ghast', 'guardian', 'elder_guardian', 'shulker', 'breeze', 'evoker', 'magma_cube', 'phantom', 'camel_husk', 'zombie_nautilus', 'wither_skeleton', 'hoglin', 'zoglin', 'piglin_brute', 'vindicator', 'vex', 'ravager'],
  avoid: ['enderman', 'piglin', 'zombified_piglin', 'creaking', 'warden', 'wither', 'ender_dragon', 'giant', 'illusioner']
}

test('every supported hostile and boss has an explicit tactic, unknowns remain untouched', () => {
  const expected = new Set(Object.values(response).flat())
  assert.deepEqual(DANGEROUS, expected)
  for (const [tactic, names] of Object.entries(response)) {
    for (const name of names) assert.equal(strategy({ name }), tactic, name)
  }
  for (const mob of data.entitiesArray.filter(entity => entity.type === 'hostile')) assert.ok(expected.has(mob.name), mob.name)
  assert.equal(strategy({ name: 'player' }), 'unknown')
  assert.equal(strategy({ name: 'cow' }), 'unknown')
  const actions = []
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, entities: {}, pathfinder: { setGoal: goal => actions.push(['goal', goal]) }, attack: entity => actions.push(['attack', entity.name]) }
  for (const name of response.avoid) {
    assert.equal(defend(bot, { name, position: { x: 2, y: 64, z: 0 } }).action, 'retreat')
  }
  assert.equal(actions.filter(([kind]) => kind === 'attack').length, 0)
  bot.entities = { 1: { id: 1, name: 'enderman', position: { x: 2, y: 64, z: 0 } }, 2: { id: 2, name: 'zombie', position: { x: 1, y: 64, z: 0 } } }
  assert.equal(selectThreat(bot).name, 'enderman')
})

test('creeper only gets one outer-edge hit followed by retreat, never a close hit', () => {
  const actions = []
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, heldItem: { name: 'iron_sword' }, pathfinder: { setGoal: goal => actions.push(['goal', goal]) }, attack: entity => actions.push(['attack', entity.name]) }
  assert.equal(defend(bot, { name: 'creeper', position: { x: 2.9, y: 64, z: 0 } }, 0, 4000).action, 'hit-and-retreat')
  assert.equal(defend(bot, { name: 'creeper', position: { x: 2.9, y: 64, z: 0 } }, 4000, 4100).action, 'retreat')
  assert.equal(defend(bot, { name: 'creeper', position: { x: 1.5, y: 64, z: 0 } }, 0, 5000).action, 'retreat')
  assert.deepEqual(actions.filter(([kind]) => kind === 'attack'), [['attack', 'creeper']])
  bot.heldItem = null
  assert.equal(defend(bot, { name: 'creeper', position: { x: 2.9, y: 64, z: 0 } }, 0, 7000).action, 'retreat')
})

test('safe inventory food is selected by nutrition, rejects harmful and unknown food', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } }, food: 13,
    registry: { foodsByName: { bread: { foodPoints: 5 }, cooked_beef: { foodPoints: 8 }, rotten_flesh: { foodPoints: 4 } } },
    inventory: { items: () => [{ slot: 36, name: 'bread', count: 2 }, { slot: 37, name: 'rotten_flesh', count: 3 }, { slot: 38, name: 'cooked_beef', count: 1 }] },
    equip: async item => { bot.equipped = item.name }, consume: async () => { bot.food = 19 }
  }
  assert.equal(chooseFood(bot).name, 'cooked_beef')
  assert.equal(SAFE_FOODS.has('pufferfish'), false)
  assert.equal(SAFE_FOODS.has('suspicious_stew'), false)
  const service = new BotService({ autoEat: true })
  service.bot = bot; service.state = 'online'
  assert.equal(await service.autoEat(bot), true)
  assert.equal(bot.equipped, 'cooked_beef')
  assert.equal(await service.autoEat(bot), false)
  bot.food = 13; bot.inventory.items = () => [{ slot: 37, name: 'rotten_flesh', count: 1 }]
  assert.equal(await service.autoEat(bot), false)
  assert.match(service.lastEatError, /No safe food/)
  service.clearAutoEat()
})
