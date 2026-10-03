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

test('Crafty routes require bot API auth and stay disabled without config', async () => {
  const app = server(new BotService({}), 'test-token-abcdefghijklmnopqrstuvwxyz')
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${app.address().port}/api/crafty/status`
    assert.equal((await fetch(url)).status, 401)
    const response = await fetch(url, { headers: { authorization: 'Bearer test-token-abcdefghijklmnopqrstuvwxyz' } })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Crafty integration is not configured' })
  } finally { app.close() }
})

test('Crafty routes proxy status, capped logs and actions with existing API auth', async () => {
  const calls = []
  const crafty = {
    async status () { calls.push(['status']); return { status: 'ok', server: { running: true } } },
    async logs (limit) { if (limit > 200) throw Object.assign(new Error('limit invalid'), { status: 400 }); calls.push(['logs', limit]); return { status: 'ok', lines: ['line'] } },
    async action (name) { calls.push(['action', name]); return { status: 'ok' } },
    async command (command) { if (/[\r\n\0]/.test(command)) throw Object.assign(new Error('bad command'), { status: 400 }); calls.push(['command', command]); return { status: 'ok' } }
  }
  const app = server(new BotService({}), 'test-token-abcdefghijklmnopqrstuvwxyz', crafty)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${app.address().port}`
    const headers = { authorization: 'Bearer test-token-abcdefghijklmnopqrstuvwxyz', 'content-type': 'application/json' }
    assert.deepEqual(await (await fetch(base + '/api/crafty/status', { headers })).json(), { status: 'ok', server: { running: true } })
    assert.equal((await fetch(base + '/api/crafty/logs?limit=30', { headers })).status, 200)
    assert.equal((await fetch(base + '/api/crafty/logs?limit=201', { headers })).status, 400)
    assert.equal((await fetch(base + '/api/crafty/action/restart', { method: 'POST', headers })).status, 200)
    assert.equal((await fetch(base + '/api/crafty/command', { method: 'POST', headers, body: JSON.stringify({ command: 'list' }) })).status, 200)
    assert.equal((await fetch(base + '/api/crafty/command', { method: 'POST', headers, body: JSON.stringify({ command: 'say\nhello' }) })).status, 400)
    assert.deepEqual(calls, [['status'], ['logs', 30], ['action', 'restart_server'], ['command', 'list']])
  } finally { app.close() }
})

const { CraftyClient, cleanConfigValue } = require('../src/crafty')

test('Crafty config values trim whitespace and one matching pair of outer quotes', () => {
  assert.equal(cleanConfigValue('  "https://crafty.example.test/"  '), 'https://crafty.example.test/')
  assert.equal(cleanConfigValue(" 'server-id' "), 'server-id')
  assert.equal(cleanConfigValue('   '), '')
})

test('Crafty client attaches token only as auth and redacts it from responses', async () => {
  const token = 'crafty-secret-test-not-real'
  const seen = []
  const client = new CraftyClient({
    baseUrl: 'https://crafty.example.test/', serverId: 'server-id', token,
    fetchImpl: async (url, options) => {
      seen.push([url, options])
      const payload = url.endsWith('/stats')
        ? { status: 'ok', data: { server_name: `received ${token}`, server_id: { server_name: 'World' } }, running: true, online: 1, max: 10 }
        : { status: 'ok' }
      return new Response(JSON.stringify(payload), { status: 200 })
    }
  })
  const status = await client.status()
  assert.equal(status.server.name, 'received [redacted]')
  assert.equal(status.server.running, true)
  assert.equal(status.server.online, 1)
  assert.equal(seen[0][0], 'https://crafty.example.test/api/v2/servers/server-id/stats')
  assert.equal(seen[0][1].headers.Authorization, `Bearer ${token}`)
  assert.equal(JSON.stringify(status).includes(token), false)
  await client.command('list')
  assert.equal(seen[1][0], 'https://crafty.example.test/api/v2/servers/server-id/stdin')
  assert.equal(seen[1][1].body, 'list')
  assert.equal(seen[1][1].headers['Content-Type'], 'text/plain; charset=utf-8')
})

test('Crafty client validates URL, commands, and log limits; errors do not echo token', async () => {
  const token = 'crafty-secret-test-not-real'
  assert.throws(() => new CraftyClient({ baseUrl: 'http://crafty.example.test', serverId: 'id', token }), /HTTPS/)
  const client = new CraftyClient({
    baseUrl: 'https://crafty.example.test', serverId: 'id', token,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok', data: Array.from({ length: 250 }, (_, i) => `line-${i}`) }), { status: 200 })
  })
  await assert.rejects(client.command(`say ${token}\n`), { status: 400 })
  await assert.rejects(client.command(`say ${token}`), { status: 400 })
  await assert.rejects(client.command('  /op player'), { status: 400 })
  await assert.rejects(client.command('\t/stop'), { status: 400 })
  await assert.rejects(client.command('say hello\tstop'), { status: 400 })
  await assert.rejects(client.command('say\u2028stop'), { status: 400 })
  assert.throws(() => new CraftyClient({ baseUrl: 'https://user:pass@crafty.example.test', serverId: 'id', token }), /credentials/)
  await assert.rejects(client.logs(0), { status: 400 })
  await assert.rejects(client.logs(201), { status: 400 })
  assert.deepEqual((await client.logs(2)).lines, ['line-248', 'line-249'])
  const failing = new CraftyClient({ baseUrl: 'https://crafty.example.test', serverId: 'id', token, fetchImpl: async () => { throw new Error(`Oops ${token}`) } })
  await assert.rejects(failing.status(), error => !error.message.includes(token) && error.message === 'Crafty API request failed')
})

test('Crafty HTTP errors include bounded sanitized response details without the token', async () => {
  const token = 'crafty-secret-response-redact-test'
  const body = `<html>Bad request ${token}${'x'.repeat(500)}\nnext\nline</html>`
  const client = new CraftyClient({
    baseUrl: 'https://crafty.example.test', serverId: 'id', token,
    fetchImpl: async () => new Response(body, { status: 400 })
  })
  await assert.rejects(client.status(), error => {
    assert.match(error.message, /^Crafty API returned HTTP 400: /)
    assert.match(error.message, /Bad request \[redacted\]/)
    assert.equal(error.message.includes(token), false)
    assert.equal(error.message.includes('\\n'), false)
    assert.ok(error.message.length < 360)
    return true
  })
})

test('survival endpoint never accepts anonymous or wrong-token activation', async () => {
  const service = new BotService({})
  const app = server(service, 'test-token-abcdefghijklmnopqrstuvwxyz')
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${app.address().port}/api/survive`
    for (const authorization of ['', 'Bearer wrong']) {
      assert.equal((await fetch(url, { method: 'POST', headers: { authorization }, body: '{"enabled":true}' })).status, 401)
    }
    assert.equal(service.survivalMode.state.enabled, false)
  } finally { app.close() }
})
