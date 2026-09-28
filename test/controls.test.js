const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { server } = require('../src/http')
const { BotService } = require('../src/service')

const token = 'test-token-abcdefghijklmnopqrstuvwxyz'

async function withServer (service, fn) {
  const app = server(service, token)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.address().port}`
  const post = async (path, payload = {}) => {
    const response = await fetch(url + path, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(payload) })
    return { status: response.status, data: await response.json() }
  }
  try { await fn(post) } finally { app.close(); service.clearControlTimer() }
}

function onlineService () {
  const service = new BotService({})
  const controls = {}
  const goals = []
  const bot = {
    username: 'Bot', entity: { position: { x: 0, y: 64, z: 0 } }, health: 20, food: 10,
    inventory: { items: () => [{ slot: 36, name: 'bread', count: 2 }, { slot: 37, name: 'rotten_flesh', count: 1 }] },
    registry: { foodsByName: { bread: { foodPoints: 5 }, rotten_flesh: { foodPoints: 4 } } },
    pathfinder: { setGoal: goal => goals.push(goal), goto: () => new Promise(() => {}) },
    setControlState: (key, value) => { controls[key] = value },
    clearControlStates: () => { for (const key of Object.keys(controls)) controls[key] = false },
    equip: async item => { bot.equipped = item.name }, consume: async () => { bot.food = 15 },
    quit: reason => { bot.quitReason = reason }
  }
  service.bot = bot
  service.state = 'online'
  return { service, bot, controls, goals }
}

test('jump and swim are separate bounded, token-gated controls; stop releases both', async () => {
  const { service, controls } = onlineService()
  await withServer(service, async post => {
    assert.equal((await post('/api/jump', { durationMs: 99 })).status, 400)
    assert.equal((await post('/api/swim', { durationMs: 30001 })).status, 400)
    assert.equal((await post('/api/jump', { durationMs: 500, forward: true })).status, 400)
    assert.equal((await post('/api/jump', { durationMs: 500 })).data.mode, 'jump')
    assert.equal(controls.jump, true)
    assert.equal((await post('/api/swim', { durationMs: 500, forward: true })).data.mode, 'swim')
    assert.equal(controls.forward, true)
    assert.equal((await post('/api/stop')).status, 200)
    assert.equal(controls.jump, false)
    assert.equal(controls.forward, false)
  })
})

test('goto acknowledges immediately and reports navigation; inventory is visible', async () => {
  const { service } = onlineService()
  await withServer(service, async post => {
    const result = await post('/api/goto', { x: 4, y: 64, z: 5 })
    assert.equal(result.status, 202)
    assert.equal(result.data.state, 'moving')
    assert.deepEqual(service.status().inventory[0], { slot: 36, name: 'bread', count: 2 })
    assert.equal(service.status().navigation.id, result.data.id)
    service.stop()
    assert.equal(service.status().navigation, null)
  })
})

test('eat only a selected safe food, disconnect and reconnect without an unwanted retry', async () => {
  const { service, bot } = onlineService()
  await withServer(service, async post => {
    assert.equal((await post('/api/eat', { slot: '36' })).status, 400)
    assert.equal((await post('/api/eat', { slot: 37 })).status, 400)
    assert.equal((await post('/api/eat', { slot: 38 })).status, 404)
    assert.deepEqual((await post('/api/eat', { slot: 36 })).data, { eaten: 'bread', food: 15 })
    assert.equal(bot.equipped, 'bread')
    assert.equal((await post('/api/disconnect')).status, 200)
    assert.equal(bot.quitReason, 'Disconnected via control API')
    assert.equal(service.stopping, true)
    assert.equal((await post('/api/jump', { durationMs: 100 })).status, 503)
    service.createBot = () => {
      const replacement = new EventEmitter()
      replacement.loadPlugin = () => {}
      return replacement
    }
    assert.equal((await post('/api/reconnect')).status, 200)
    assert.equal(service.stopping, false)
    assert.equal((await post('/api/reconnect')).status, 409)
  })
})

test('spawn configures safer pathfinder movements and end records the disconnect reason', () => {
  const bot = new EventEmitter()
  bot.registry = require('minecraft-data')('1.21.4')
  bot.loadPlugin = () => {}
  bot.pathfinder = { setMovements: movements => { bot.movements = movements } }
  bot.quit = () => {}
  const service = new BotService({ mcHost: 'localhost', mcPort: 25565, mcAccountId: 'test' }, () => bot)
  const { Movements } = require('mineflayer-pathfinder')
  service.connect()
  bot.emit('spawn')
  assert.equal(bot.movements.liquidCost, 25)
  assert.equal(bot.movements.allowSprinting, false)
  assert.equal(bot.movements.canDig, false)
  assert.equal(bot.movements.allow1by1towers, false)
  assert.equal(bot.movements.infiniteLiquidDropdownDistance, false)
  assert.equal(bot.movements.exclusionPlace({}), 100)
  assert.ok(bot.movements instanceof Movements)
  bot.emit('end', 'socketClosed')
  assert.match(service.lastError, /socketClosed/)
  assert.equal(service.state, 'offline')
  service.shutdown()
})
