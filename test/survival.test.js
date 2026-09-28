const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { server } = require('../src/http')
const { BotService } = require('../src/service')
const { defend, selectThreat } = require('../src/survival')
const token = 'test-token-abcdefghijklmnopqrstuvwxyz'

function fixture () {
  const actions = []
  const bot = new EventEmitter()
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  bot.health = 20
  bot.entities = {
    1: { id: 1, name: 'zombie', position: { x: 2, y: 64, z: 0 } },
    2: { id: 2, name: 'player', position: { x: 1, y: 64, z: 0 } },
    3: { id: 3, name: 'enderman', position: { x: 1, y: 64, z: 0 } }
  }
  bot.attack = entity => actions.push(['attack', entity.id])
  bot.pathfinder = { setGoal: goal => actions.push(['goal', goal]) }
  bot.blockAt = point => point.y === 63 ? { name: 'stone', boundingBox: 'block', position: point } : { name: 'air', boundingBox: 'empty', position: point }
  bot.registry = { blocksByName: { stone: { name: 'stone', boundingBox: 'block' }, tnt: { name: 'tnt', boundingBox: 'block' } } }
  bot.inventory = { items: () => [{ name: 'stone', count: 3 }] }
  bot.equip = async item => actions.push(['equip', item.name])
  bot.placeBlock = async (support, face) => actions.push(['place', support.position.y, face.y])
  const service = new BotService({ autoDefend: false })
  service.bot = bot
  service.state = 'online'
  return { bot, service, actions }
}

async function api (service, fn) {
  const app = server(service, token)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  const post = async (path, data = {}, auth = true) => {
    const res = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method: 'POST', headers: { authorization: auth ? `Bearer ${token}` : 'Bearer wrong' }, body: JSON.stringify(data) })
    return { status: res.status, body: await res.json() }
  }
  try { await fn(post) } finally { app.close(); service.clearDefense() }
}

test('attack allows one nearby hostile hit, never players, endermen, creepers or distant mobs', async () => {
  const { bot, service, actions } = fixture()
  await api(service, async post => {
    assert.equal((await post('/api/attack', {}, false)).status, 401)
    assert.equal((await post('/api/attack', { id: '1' })).status, 400)
    assert.equal((await post('/api/attack', { id: 2 })).status, 404)
    assert.equal((await post('/api/attack', { id: 3 })).status, 404)
    assert.equal((await post('/api/attack')).body.attacked.name, 'zombie')
    bot.entities[1].position.x = 5
    assert.equal((await post('/api/attack', { id: 1 })).status, 404)
    bot.entities[4] = { id: 4, name: 'creeper', position: { x: 2, y: 64, z: 0 } }
    assert.equal((await post('/api/attack', { id: 4 })).status, 404)
  })
  assert.deepEqual(actions.filter(([kind]) => kind === 'attack'), [['attack', 1]])
})

test('threat tactics retreat from creeper and ranged mobs; melee uses a cooldown', () => {
  const { bot, actions } = fixture()
  const zombie = bot.entities[1]
  assert.equal(selectThreat(bot), zombie)
  assert.equal(defend(bot, zombie, 0, 1000).action, 'attack')
  assert.equal(defend(bot, zombie, 1000, 1100).action, 'hold')
  bot.entities[4] = { id: 4, name: 'creeper', position: { x: 2, y: 64, z: 1 } }
  assert.equal(selectThreat(bot), bot.entities[4])
  assert.equal(defend(bot, bot.entities[4]).action, 'retreat')
  const skeleton = { name: 'skeleton', position: { x: 4, y: 64, z: 0 } }
  assert.equal(defend(bot, skeleton).action, 'retreat')
  const drowned = { name: 'drowned', position: { x: 2, y: 64, z: 0 } }
  assert.equal(defend(bot, drowned).action, 'retreat')
  assert.equal(defend(bot, bot.entities[3]).action, 'unsupported')
  assert.equal(actions.filter(([kind]) => kind === 'attack').length, 1)
})

test('placing requires valid exact coordinates, solid inventory material and adjacent support', async () => {
  const { bot, service, actions } = fixture()
  await api(service, async post => {
    assert.equal((await post('/api/place', { x: 2, y: 64, z: 1, material: 'stone' }, false)).status, 401)
    assert.equal((await post('/api/place', { x: 2.1, y: 64, z: 1, material: 'stone' })).status, 400)
    assert.equal((await post('/api/place', { x: 99, y: 64, z: 0, material: 'stone' })).status, 400)
    assert.equal((await post('/api/place', { x: 2, y: 64, z: 1, material: 'tnt' })).status, 400)
    assert.equal((await post('/api/place', { x: 2, y: 64, z: 1, material: 'dirt' })).status, 400)
    assert.equal((await post('/api/place', { x: 2, y: 64, z: 1, material: 'stone' })).status, 200)
    bot.inventory.items = () => []
    assert.equal((await post('/api/place', { x: 2, y: 64, z: 1, material: 'stone' })).status, 409)
  })
  assert.deepEqual(actions, [['equip', 'stone'], ['place', 63, 1]])
})

test('damage arms opt-in defense for eight seconds and disconnect clears its timer', async () => {
  const { bot, service, actions } = fixture()
  bot.loadPlugin = () => {}
  bot.registry = require('minecraft-data')('1.21.4')
  bot.pathfinder.setMovements = () => {}
  bot.quit = () => {}
  bot.clearControlStates = () => {}
  service.createBot = () => bot
  service.config = { mcHost: 'localhost', mcPort: 25565, mcAccountId: 'test', autoDefend: true }
  service.connect()
  bot.emit('spawn')
  assert.ok(service.defenseTimer)
  assert.equal(service.defenseArmedUntil, 0)
  bot.health = 18
  bot.emit('health')
  assert.ok(service.defenseArmedUntil > Date.now())
  await new Promise(resolve => setTimeout(resolve, 760))
  assert.ok(actions.some(([kind, id]) => kind === 'attack' && id === 1))
  service.disconnect()
  assert.equal(service.defenseTimer, null)
  assert.equal(service.defenseArmedUntil, 0)
})
