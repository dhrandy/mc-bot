const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const { Physics, PlayerState } = require('prismarine-physics')
const { BotService } = require('../src/service')
const { safeLeafStep, supports } = require('../src/navigation')

// Real block shapes, pathfinder and player physics; only the server's dig reply
// is simulated. The fixture is not proof of permissions on a particular server.
function canopyFixture ({ denyDig = false, version = '26.1' } = {}) {
  const bot = new EventEmitter()
  bot.registry = require('minecraft-data')(version)
  bot.version = version
  const Block = require('prismarine-block')(bot.registry)
  const blocks = new Map()
  const put = (x, y, z, name) => {
    const block = Block.fromStateId(bot.registry.blocksByName[name].defaultState, 0)
    block.position = new Vec3(x, y, z)
    blocks.set(block.position.toString(), block)
    return block
  }
  bot.blockAt = pos => {
    const p = pos.floored()
    return blocks.get(p.toString()) || put(p.x, p.y, p.z, 'air')
  }
  bot.entity = {
    position: new Vec3(250.7, 69, 349.7), velocity: new Vec3(0, 0, 0),
    onGround: true, yaw: 0, pitch: 0, effects: {}, attributes: { 'minecraft:movement_speed': { value: 0.1, modifiers: [] } },
    isInWater: false, isInLava: false, isInWeb: false
  }
  bot.game = { minY: -64 }
  bot.entities = {}
  bot.inventory = { slots: [], items: () => [] }
  bot.controlState = Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(key => [key, false]))
  bot.setControlState = (key, value) => { bot.controlState[key] = value }
  bot.clearControlStates = () => { bot.controlState = Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(key => [key, false])) }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async () => {}
  bot.unequip = async () => {}
  bot.canDigBlock = () => true
  bot.stopDigging = () => { bot.emit('diggingAborted') }
  bot.quit = () => {}
  bot.health = 12.17
  bot.food = 17
  bot.digs = []
  bot.dig = async block => {
    bot.digs.push(block.position.clone())
    if (denyDig) throw new Error('Server refused the dig')
    const air = put(block.position.x, block.position.y, block.position.z, 'air')
    bot.emit('blockUpdate', block, air)
    bot.emit('diggingCompleted', block)
  }
  bot.loadPlugin = plugin => plugin(bot)
  const world = { getBlock: bot.blockAt }
  bot.physics = Physics(bot.registry, world)
  // A broad canopy and a protected trunk wall. Ground is six blocks below;
  // a direct jump off the outside edge must not be used as an escape.
  for (let x = 242; x <= 258; x++) for (let z = 342; z <= 388; z++) put(x, 62, z, 'grass_block')
  for (let x = 247; x <= 253; x++) for (let z = 346; z <= 354; z++) {
    for (let y = 65; y <= 68; y++) put(x, y, z, 'oak_leaves')
  }
  const service = new BotService({ mcHost: 'fixture', mcAccountId: 'test' }, () => bot)
  service.connect()
  bot.emit('spawn')
  bot.trace = []
  const tick = async () => {
    bot.emit('physicsTick')
    bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), world).apply(bot)
    bot.trace.push({ x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z })
    assert.ok(Number.isFinite(bot.entity.position.x) && Number.isFinite(bot.entity.position.z))
    assert.equal(bot.entity.isInLava, false)
    assert.equal(bot.entity.isInWater, false)
    await new Promise(resolve => setImmediate(resolve))
  }
  return { bot, service, put, tick }
}

module.exports = { canopyFixture }

test('seeded canopy route punches leaves, lands and reaches the ground target', async () => {
  const { bot, service, tick } = canopyFixture()
  try {
    service.goto(250, 63, 382)
    for (let i = 0; i < 1000 && service.navigation.state === 'moving'; i++) await tick()
    require('node:fs').writeFileSync('/tmp/mc-canopy-trace.json', JSON.stringify(bot.trace))
    assert.equal(service.navigation.state, 'arrived')
    assert.equal(bot.digs.length, 4)
    assert.equal(bot.health, 12.17)
    assert.equal(bot.entity.position.y, 63)
    assert.ok(bot.entity.onGround)
  } finally { service.shutdown() }
})


test('survival escape also runs through 1.21.4 physics without teleporting', async () => {
  const { bot, service, tick } = canopyFixture({ version: '1.21.4' })
  try {
    service.goto(250, 63, 382)
    for (let i = 0; i < 1000 && service.navigation.state === 'moving'; i++) await tick()
    assert.equal(service.navigation.state, 'arrived')
    assert.equal(bot.digs.length, 4)
    assert.equal(bot.entity.position.y, 63)
  } finally { service.shutdown() }
})

test('server denied digging fails visibly after one attempt', async () => {
  const { bot, service, tick } = canopyFixture({ denyDig: true })
  try {
    service.goto(250, 63, 382)
    for (let i = 0; i < 50 && service.navigation.state === 'moving'; i++) await tick()
    assert.equal(service.navigation.state, 'failed')
    assert.match(service.lastError, /refused/)
    assert.equal(bot.digs.length, 1)
    assert.equal(bot.entity.position.y, 69)
    assert.equal(bot.pathfinder.goal, null)
  } finally { service.shutdown() }
})

test('leaf steps reject deep holes, unloaded blocks, liquids and dangerous landings', () => {
  for (const name of ['water', 'lava', 'magma_block', 'cactus', 'sand', 'gravel', 'powder_snow', 'air']) {
    const { bot, service, put } = canopyFixture()
    try {
      for (let y = 65; y <= 67; y++) put(250, y, 349, 'air')
      put(250, 67, 349, name)
      assert.equal(safeLeafStep(bot, supports(bot)), false, name)
    } finally { service.shutdown() }
  }
  const { bot, service } = canopyFixture()
  try {
    const original = bot.blockAt
    bot.blockAt = pos => pos.y === 67 ? null : original(pos)
    assert.equal(safeLeafStep(bot, supports(bot)), false)
  } finally { service.shutdown() }
})

test('escape accounts for the whole player footprint and never digs an ordinary support', async () => {
  const { bot, service, put, tick } = canopyFixture()
  try {
    bot.entity.position.x = 250.95
    put(251, 68, 349, 'oak_log')
    assert.equal(supports(bot).length, 2)
    assert.equal(safeLeafStep(bot, supports(bot)), false)
    put(251, 68, 349, 'oak_leaves')
    service.goto(250, 63, 382)
    for (let i = 0; i < 1000 && service.navigation.state === 'moving'; i++) await tick()
    assert.equal(service.navigation.state, 'arrived')
    assert.equal(bot.digs.length, 8)
  } finally { service.shutdown() }
})

test('Stop cancels a canopy action before its first dig', async () => {
  const { bot, service, tick } = canopyFixture()
  try {
    service.goto(250, 63, 382)
    service.stop()
    for (let i = 0; i < 10; i++) await tick()
    assert.equal(service.navigation, null)
    assert.equal(bot.digs.length, 0)
    assert.equal(bot.pathfinder.goal, null)
  } finally { service.shutdown() }
})

test('a pathfinder empty-path resolution is not reported as arrival', async () => {
  const { bot, service, put, tick } = canopyFixture()
  try {
    put(250, 68, 349, 'oak_log')
    bot.pathfinder.goto = async () => {}
    service.goto(250, 63, 382)
    for (let i = 0; i < 10 && service.navigation.state === 'moving'; i++) await tick()
    assert.equal(service.navigation.state, 'failed')
    assert.match(service.lastError, /without reaching/)
  } finally { service.shutdown() }
})


test('silent server refusal does not report a completed leaf escape', async () => {
  const { bot, service, tick } = canopyFixture()
  bot.dig = async block => { bot.digs.push(block.position.clone()) }
  try {
    service.goto(250, 63, 382)
    for (let i = 0; i < 20 && service.navigation.state === 'moving'; i++) await tick()
    assert.equal(service.navigation.state, 'failed')
    assert.match(service.lastError, /not confirmed.*protection/)
    assert.equal(bot.digs.length, 1)
  } finally { service.shutdown() }
})

test('Stop interrupts a pending dig and never resumes the old route', async () => {
  const { bot, service, tick } = canopyFixture()
  bot.dig = block => { bot.digs.push(block.position.clone()); return new Promise(() => {}) }
  try {
    service.goto(250, 63, 382)
    for (let i = 0; i < 10 && !bot.digs.length; i++) await tick()
    service.stop()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(service.navigation, null)
    assert.equal(bot.digs.length, 1)
    assert.equal(bot.pathfinder.goal, null)
  } finally { service.shutdown() }
})

test('liquid beside a descent shaft prevents the dig', () => {
  const { bot, service, put } = canopyFixture()
  try {
    put(251, 67, 349, 'water')
    assert.equal(safeLeafStep(bot, supports(bot)), false)
  } finally { service.shutdown() }
})
