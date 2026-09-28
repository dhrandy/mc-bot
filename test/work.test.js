const { test } = require('node:test')
const assert = require('node:assert/strict')
const { server } = require('../src/http')
const { BotService } = require('../src/service')
const { shelterPlan } = require('../src/work')
const Vec3 = require('vec3')
const data = require('minecraft-data')('1.21.4')
const Recipe = require('prismarine-recipe')(data).Recipe
const token = 'test-token-abcdefghijklmnopqrstuvwxyz'

function fixture () {
  const calls = []
  const blocks = new Map()
  const inventory = [{ name: 'oak_log', type: data.itemsByName.oak_log.id, count: 2 }, { name: 'oak_planks', type: data.itemsByName.oak_planks.id, count: 64 }, { name: 'wooden_hoe', type: data.itemsByName.wooden_hoe.id, count: 1 }, { name: 'wheat_seeds', type: data.itemsByName.wheat_seeds.id, count: 4 }]
  const bot = {
    entity: { position: new Vec3(0, 64, 0) }, entities: {}, registry: data,
    inventory: { items: () => inventory, count: id => inventory.filter(i => i.type === id).reduce((n, i) => n + i.count, 0) },
    blockAt (p) { return blocks.get(p.toString()) || { name: p.y < 64 ? 'dirt' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p, getProperties: () => ({ age: 7 }) } },
    findBlock ({ matching, maxDistance }) {
      const hits = [...blocks.values()].filter(b => matching(b) && b.position.distanceTo(this.entity.position) <= maxDistance)
      return hits[0] || null
    },
    recipesAll: (id, meta, table) => Recipe.find(id, meta).filter(r => !r.requiresTable || table),
    craft: async (recipe, n, table) => calls.push(['craft', recipe.result.id, n, Boolean(table)]),
    equip: async item => { bot.heldItemName = item.name; calls.push(['equip', item.name]) },
    activateBlock: async block => calls.push(['activate', block.name]),
    placeBlock: async (block, face) => { const pos = block.position.plus(face); calls.push(['place', pos.toString()]); blocks.set(pos.toString(), { name: bot.heldItemName || 'oak_planks', position: pos, boundingBox: 'block' }) },
    dig: async block => calls.push(['dig', block.name]),
    canDigBlock: () => true,
    sleep: async block => calls.push(['sleep', block.name]),
    wake: async () => calls.push(['wake']),
    pathfinder: { goto: async () => {} }
  }
  const service = new BotService({})
  service.bot = bot
  service.state = 'online'
  const put = (x, y, z, name, props = { age: 7 }) => blocks.set(new Vec3(x, y, z).toString(), { name, position: new Vec3(x, y, z), boundingBox: 'block', getProperties: () => props })
  return { bot, service, calls, inventory, put }
}

async function api (service, fn) {
  const app = server(service, token)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  const post = async (path, body = {}, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method: 'POST', headers: { authorization: auth ? `Bearer ${token}` : 'Bearer wrong' }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  try { await fn(post) } finally { app.close() }
}

test('craft checks exact recipe counts and a placed table before dispatch', async () => {
  const { service, calls, put, inventory } = fixture()
  await api(service, async post => {
    assert.equal((await post('/api/craft', { item: 'oak_planks', count: 4 }, false)).status, 401)
    assert.equal((await post('/api/craft', { item: 'oak_planks', count: 17 })).status, 400)
    assert.equal((await post('/api/craft', { item: 'oak_planks', count: 4 })).status, 200)
    assert.match((await post('/api/craft', { item: 'wooden_sword' })).data.error, /Missing materials/)
    inventory.push({ name: 'stick', type: data.itemsByName.stick.id, count: 1 })
    assert.match((await post('/api/craft', { item: 'wooden_sword' })).data.error, /crafting table/)
    inventory.pop()
    put(2, 64, 0, 'crafting_table')
    assert.match((await post('/api/craft', { item: 'wooden_sword' })).data.error, /Missing materials/)
    inventory.push({ name: 'stick', type: data.itemsByName.stick.id, count: 1 })
    assert.equal((await post('/api/craft', { item: 'wooden_sword' })).status, 200)
  })
  assert.equal(calls.filter(c => c[0] === 'craft').length, 2)
})

test('sleep and wake require a nearby bed; propagates bed rules', async () => {
  const { service, bot, put, calls } = fixture()
  await api(service, async post => {
    assert.equal((await post('/api/sleep')).status, 409)
    put(2, 64, 0, 'white_bed')
    assert.equal((await post('/api/sleep')).status, 200)
    bot.sleep = async () => { throw new Error("it's not night") }
    assert.match((await post('/api/sleep')).data.error, /not night/)
    assert.equal((await post('/api/wake')).status, 200)
  })
  assert.deepEqual(calls.at(-1), ['wake'])
})

test('till needs water and hoe, plant needs seeds, harvest only mature wheat', async () => {
  const { service, put, bot, calls, inventory } = fixture()
  await api(service, async post => {
    const soil = { x: 2, y: 63, z: 0 }
    assert.match((await post('/api/till', soil)).data.error, /water/)
    put(4, 63, 0, 'water')
    assert.equal((await post('/api/till', soil)).status, 200)
    put(2, 63, 0, 'farmland')
    assert.equal((await post('/api/plant', soil)).status, 200)
    put(2, 64, 0, 'wheat', { age: 3 })
    assert.match((await post('/api/harvest', { x: 2, y: 64, z: 0 })).data.error, /not mature/)
    put(2, 64, 0, 'wheat', { age: 7 })
    assert.equal((await post('/api/harvest', { x: 2, y: 64, z: 0, replant: true })).status, 200)
    inventory.splice(inventory.findIndex(i => i.name === 'wheat_seeds'), 1)
    put(2, 64, 0, 'air')
    assert.match((await post('/api/plant', soil)).data.error, /wheat_seeds/)
  })
  assert.equal(calls.filter(c => c[0] === 'dig').length, 1)
})

test('gather permits wild grass or leafy logs only; shelter preflights materials and empty footprint', async () => {
  const { service, put, inventory, calls } = fixture()
  await api(service, async post => {
    put(2, 64, 0, 'oak_log')
    assert.match((await post('/api/gather', { x: 2, y: 64, z: 0 })).data.error, /nearby leaves/)
    put(2, 66, 0, 'oak_leaves')
    assert.equal((await post('/api/gather', { x: 2, y: 64, z: 0 })).status, 200)
    assert.equal((await post('/api/gather', { x: 0, y: 63, z: 0 })).status, 409)
    inventory[1].count = 3
    assert.match((await post('/api/shelter', { x: 0, y: 64, z: 0, material: 'oak_planks' })).data.error, /Missing oak_planks/)
    inventory[1].count = 64
    assert.match((await post('/api/shelter', { x: 0, y: 64, z: 0, material: 'oak_planks' })).data.error, /footprint/)
    put(2, 64, 0, 'air')
    put(2, 66, 0, 'air')
    put(0, 66, 0, 'air')
    const result = await post('/api/shelter', { x: 0, y: 64, z: 0, material: 'oak_planks' })
    assert.equal(result.status, 200, JSON.stringify(result.data))
  })
  assert.equal(shelterPlan(new Vec3(0, 64, 0)).length, 55)
  assert.equal(calls.filter(c => c[0] === 'place').length, 55)
})

test('placing a bed requires two empty blocks over solid support and inventory bed', async () => {
  const { service, inventory, put, calls } = fixture()
  await api(service, async post => {
    const foot = { x: 2, y: 64, z: 0 }
    assert.equal((await post('/api/place-bed', foot, false)).status, 401)
    assert.match((await post('/api/place-bed', foot)).data.error, /Missing a bed/)
    inventory.push({ name: 'white_bed', type: data.itemsByName.white_bed.id, count: 1 })
    put(3, 64, 0, 'stone')
    assert.match((await post('/api/place-bed', foot)).data.error, /Bed needs four clear/)
    put(3, 64, 0, 'air')
    assert.equal((await post('/api/place-bed', foot)).status, 200)
  })
  assert.ok(calls.some(call => call[0] === 'place'))
})
