const { test } = require('node:test')
const assert = require('node:assert/strict')
const { server, coordinates } = require('../src/http')
const { BotService } = require('../src/service')

test('coordinates reject invalid values', () => {
  assert.deepEqual(coordinates({ x: 1, y: 2, z: 3 }), [1, 2, 3])
  assert.throws(() => coordinates({ x: NaN, y: 2, z: 3 }))
  assert.throws(() => coordinates({ x: '1', y: 2, z: 3 }))
})

test('API rejects anonymous requests and reads status with token', async () => {
  const service = new BotService({})
  const app = server(service, 'test-token-abcdefghijklmnopqrstuvwxyz')
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${app.address().port}/api/status`
    assert.equal((await fetch(url)).status, 401)
    const response = await fetch(url, { headers: { authorization: 'Bearer test-token-abcdefghijklmnopqrstuvwxyz' } })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).state, 'starting')
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    const invalid = await fetch(url.replace('status', 'goto'), { method: 'POST', headers: { authorization: 'Bearer test-token-abcdefghijklmnopqrstuvwxyz' }, body: JSON.stringify({ x: '1', y: 2, z: 3 }) })
    assert.equal(invalid.status, 400)
  } finally { app.close() }
})

test('API refuses chat before connection and ignores bogus token', async () => {
  const service = new BotService({})
  const app = server(service, 'test-token-abcdefghijklmnopqrstuvwxyz')
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${app.address().port}/api/chat`
    const wrong = await fetch(url, { headers: { authorization: 'Bearer wrong-token' } })
    assert.equal(wrong.status, 401)
    const offline = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-token-abcdefghijklmnopqrstuvwxyz' }, body: JSON.stringify({ message: 'Hello' }) })
    assert.equal(offline.status, 503)
    const tooLong = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-token-abcdefghijklmnopqrstuvwxyz' }, body: JSON.stringify({ message: 'x'.repeat(257) }) })
    assert.equal(tooLong.status, 400)
  } finally { app.close() }
})

test('follow, stop, and look route through the bot without sending commands', async () => {
  const service = new BotService({})
  const goalsSeen = []
  let cleared = false
  let lookTarget
  service.bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    players: { Visitor: { entity: { position: { x: 2, y: 64, z: 2 } } } },
    pathfinder: { setGoal: goal => goalsSeen.push(goal) },
    clearControlStates: () => { cleared = true },
    lookAt: async point => { lookTarget = point },
    username: 'Bot'
  }
  service.state = 'online'
  assert.deepEqual(service.follow('Visitor'), { following: 'Visitor' })
  assert.equal(goalsSeen.length, 1)
  assert.equal(service.stop().stopped, true)
  assert.equal(goalsSeen[1], null)
  assert.equal(cleared, true)
  await service.look(1, 65, 2)
  assert.deepEqual([lookTarget.x, lookTarget.y, lookTarget.z], [1, 65, 2])
  assert.throws(() => service.follow('Absent'), { status: 404 })
})
