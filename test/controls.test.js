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
    assert.equal(service.bot, null)
    assert.equal(service.status().position, null)
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
  assert.equal(bot.movements.canDig, true)
  assert.equal(bot.movements.maxDropDown, 3)
  assert.deepEqual(bot.movements.scafoldingBlocks, [])
  assert.equal(bot.movements.dontCreateFlow, true)
  assert.equal(bot.movements.dontMineUnderFallingBlock, true)
  for (const name of ['oak_leaves', 'mangrove_leaves', 'short_grass', 'tall_grass', 'dirt', 'stone']) {
    assert.equal(bot.movements.blocksCantBreak.has(bot.registry.blocksByName[name].id), false, name)
  }
  for (const name of ['chest', 'barrel', 'oak_log', 'oak_planks', 'tnt', 'white_bed', 'lever', 'bedrock']) {
    assert.equal(bot.movements.blocksCantBreak.has(bot.registry.blocksByName[name].id), true, name)
  }
  assert.equal(bot.movements.allow1by1towers, false)
  assert.equal(bot.movements.infiniteLiquidDropdownDistance, false)
  assert.equal(bot.movements.exclusionPlace({}), 100)
  assert.ok(bot.movements instanceof Movements)
  bot.emit('end', 'socketClosed')
  assert.match(service.lastError, /socketClosed/)
  assert.equal(service.state, 'offline')
  service.shutdown()
})

test('stayOffline keeps the bot off the server until join is requested', async () => {
  const service = new BotService({ mcHost: 'localhost', mcPort: 25565, mcAccountId: 'test' }, () => {
    const bot = new EventEmitter()
    bot.loadPlugin = () => {}
    bot.quit = () => {}
    return bot
  })
  service.stayOffline()
  assert.equal(service.state, 'offline')
  assert.equal(service.stopping, true)
  assert.throws(() => service.stop(), { status: 503 })
  service.join()
  assert.equal(service.state, 'connecting')
  assert.equal(service.stopping, false)
  assert.throws(() => service.join(), { status: 409 })
  assert.throws(() => service.reconnect(), { status: 409 })
  service.shutdown()
})

test('configured pathfinder plans a punch through leaves and refuses protected or hazardous blocks', () => {
  const Vec3 = require('vec3')
  const bot = new EventEmitter()
  bot.registry = require('minecraft-data')('26.1')
  const Block = require('prismarine-block')(bot.registry)
  const blocks = new Map()
  const put = (x, y, z, name) => {
    const block = Block.fromStateId(bot.registry.blocksByName[name].defaultState, 0)
    block.position = new Vec3(x, y, z)
    blocks.set(block.position.toString(), block)
    return block
  }
  bot.entity = { position: new Vec3(0, 70, 0), effects: {} }
  bot.blockAt = pos => blocks.get(pos.toString()) || put(pos.x, pos.y, pos.z, 'air')
  bot.loadPlugin = () => {}
  bot.pathfinder = { setMovements: m => { bot.movements = m }, bestHarvestTool: () => null }
  bot.quit = () => {}
  const service = new BotService({ mcHost: 'localhost', mcAccountId: 'test' }, () => bot)
  service.connect()
  bot.emit('spawn')
  const m = bot.movements
  put(0, 69, 0, 'oak_leaves')
  put(1, 69, 0, 'oak_leaves')
  put(1, 70, 0, 'oak_leaves')
  const Move = require('mineflayer-pathfinder/lib/move')
  const options = []
  m.getMoveForward(new Move(0, 70, 0, 0, 0), { x: 1, z: 0 }, options)
  assert.ok(options.some(move => move.toBreak.some(pos => pos.equals(new Vec3(1, 70, 0)))), 'forward move should include punching the obstructing leaf')
  assert.ok(options.every(move => move.toPlace.length === 0))
  assert.equal(m.safeToBreak(bot.blockAt(new Vec3(1, 70, 0))), true)
  put(2, 70, 0, 'water')
  assert.equal(m.safeToBreak(bot.blockAt(new Vec3(1, 70, 0))), false)
  put(2, 70, 0, 'air')
  put(1, 71, 0, 'gravel')
  assert.equal(m.safeToBreak(bot.blockAt(new Vec3(1, 70, 0))), false)
  put(1, 71, 0, 'air')
  for (const name of ['chest', 'oak_planks', 'oak_log', 'tnt']) {
    const block = put(1, 70, 0, name)
    assert.equal(Boolean(m.safeToBreak(block)), false, name)
  }
  service.shutdown()
})

test('jump releases automatically after its bounded duration', async () => {
  const { service, controls } = onlineService()
  await withServer(service, async post => {
    assert.equal((await post('/api/jump', { durationMs: 100 })).status, 200)
    assert.equal(controls.jump, true)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(controls.jump, false)
  })
})

test('Go To reaches the requested block instead of stopping one block short', async () => {
  const Vec3 = require('vec3')
  const { goals } = require('mineflayer-pathfinder')
  const { service, bot } = onlineService()
  bot.entity.position = new Vec3(10.5, 63, 10.5)
  bot.pathfinder.goto = async goal => {
    assert.ok(goal instanceof goals.GoalBlock)
    assert.equal(goal.isEnd(new Vec3(12, 63, 10)), false)
    assert.equal(goal.isEnd(new Vec3(13, 63, 10)), true)
    bot.entity.position = new Vec3(13.5, 63, 10.5)
  }
  service.goto(13, 63, 10.5)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.navigation.state, 'arrived')
})

test('Go To rejects false pathfinder completion and clears movement', async () => {
  const Vec3 = require('vec3')
  const { service, bot, goals } = onlineService()
  bot.entity.position = new Vec3(-10.5, 63, -10.5)
  bot.pathfinder.goto = async () => {}
  service.goto(-5.5, 63, -10.5)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.navigation.state, 'failed')
  assert.match(service.lastError, /without reaching the target/)
  assert.equal(goals.at(-1), null)
})

test('survival API validates booleans and blocks conflicting manual mutation', async () => {
  const { service } = onlineService()
  service.setSurvive = enabled => ({ enabled })
  await withServer(service, async post => {
    assert.equal((await post('/api/survive', { enabled: 'true' })).status, 400)
    assert.equal((await post('/api/survive', { enabled: false })).status, 200)
    service.survivalMode.state.enabled = true
    assert.equal((await post('/api/goto', { x: 3, y: 64, z: 0 })).status, 409)
    assert.equal((await post('/api/chat', { message: 'not sent' })).status, 409)
    assert.equal((await post('/api/quit')).status, 200)
    assert.equal(service.state, 'disconnected')
  })
})
