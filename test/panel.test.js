const { test } = require('node:test')
const assert = require('node:assert/strict')
const { server } = require('../src/http')

const token = 'test-token-abcdefghijklmnopqrstuvwxyz'

function stubService () {
  return {
    calls: [],
    status () {
      return {
        state: 'offline', username: null, position: null, health: null, food: null,
        lastError: null, navigation: null, autoDefend: false, autoEat: false,
        autoFlee: false, fleeing: null, eating: false, lastEatError: null,
        defense: null, inventory: [], nearbyHostiles: []
      }
    },
    join () { this.calls.push(['join']); return { connecting: true } },
    disconnect () { this.calls.push(['quit']); return { disconnected: true } },
    move (mode, durationMs) { this.calls.push(['move', mode, durationMs]); return { mode, durationMs } },
    stop () { this.calls.push(['stop']); return { stopped: true } },
    follow (player) { this.calls.push(['follow', player]); return { following: player } },
    goto (x, y, z) { this.calls.push(['goto', x, y, z]); return { id: 1, state: 'moving', target: { x, y, z } } },
    async gather (coords) { this.calls.push(['gather', coords]); return { gathered: 'dirt' } },
    async place (x, y, z, material) { this.calls.push(['place', x, y, z, material]); return { placed: material } },
    async shelter (material, coords) { this.calls.push(['shelter', material, coords]); return { placed: 55 } },
    setAutoFlee (enabled) { this.calls.push(['autoFlee', enabled]); return { autoFlee: enabled } },
    ready () { throw Object.assign(new Error('Bot is not in the world'), { status: 503 }) }
  }
}

async function withPanel (service, fn) {
  const crafty = {
    calls: [],
    async status () { this.calls.push(['status']); return { status: 'ok', server: { name: 'main', running: true, online: 2, max: 20, version: '1.21.4' } } },
    async logs (limit) { this.calls.push(['logs', limit]); return { status: 'ok', lines: ['hello'] } },
    async action (name) { this.calls.push(['action', name]); return { status: 'ok' } },
    async command (command) { this.calls.push(['command', command]); return { status: 'ok' } }
  }
  const app = server(service, token, crafty)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.address().port}`
  const get = (path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
  const post = (path, fields, cookie) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual'
  })
  try { await fn({ get, post, base, crafty }) } finally { app.close() }
}

async function signIn (post) {
  const response = await post('/login', { password: token })
  assert.equal(response.status, 303)
  const cookie = response.headers.get('set-cookie').split(';')[0]
  assert.ok(cookie.startsWith('mcb_session='))
  return cookie
}

async function csrfOf (get, cookie) {
  const page = await (await get('/panel', cookie)).text()
  return page.match(/name="csrf" value="([0-9a-f]+)"/)[1]
}

test('panel hides behind the login form and never exposes the API token', async () => {
  const service = stubService()
  await withPanel(service, async ({ get, post }) => {
    const root = await get('/')
    assert.equal(root.status, 303)
    assert.equal(root.headers.get('location'), '/login')
    assert.equal((await get('/panel')).status, 303)
    const login = await get('/login')
    assert.equal(login.status, 200)
    const html = await login.text()
    assert.match(html, /name="password"/)
    assert.match(html, /autocomplete="current-password"/)
    assert.match(html, /noindex, nofollow/)
    assert.ok(!html.includes(token))
    assert.equal(login.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    const wrong = await post('/login', { password: 'nope-nope-nope-nope-nope-nope-nope' })
    assert.equal(wrong.status, 401)
    assert.ok(!wrong.headers.get('set-cookie'))
    const cookie = await signIn(post)
    const panel = await get('/panel', cookie)
    assert.equal(panel.status, 200)
    const body = await panel.text()
    assert.match(body, /action="\/panel\/join"/)
    assert.match(body, /action="\/panel\/jump"/)
    assert.match(body, /action="\/panel\/goto"/)
    assert.match(body, /action="\/panel\/gather"/)
    assert.match(body, /action="\/panel\/shelter"/)
    assert.ok(!body.includes(token), 'panel HTML must not contain the token')
    const logout = await post('/logout', { csrf: await csrfOf(get, cookie) }, cookie)
    assert.equal(logout.status, 303)
    assert.equal((await get('/panel', cookie)).status, 303)
  })
})

test('panel actions need the session cookie and CSRF token, then reach the service', async () => {
  const service = stubService()
  await withPanel(service, async ({ get, post }) => {
    const cookie = await signIn(post)
    const csrf = await csrfOf(get, cookie)
    assert.equal((await post('/panel/stop', {}, cookie)).status, 403)
    assert.equal((await post('/panel/stop', { csrf })).status, 303)
    assert.equal((await post('/panel/stop', { csrf }, cookie)).status, 303)
    assert.deepEqual(service.calls[0], ['stop'])
    assert.equal((await post('/panel/join', { csrf }, cookie)).status, 303)
    assert.equal((await post('/panel/goto', { csrf, x: '10.5', y: '64', z: '-20' }, cookie)).status, 303)
    assert.equal((await post('/panel/place', { csrf, x: '2', y: '64', z: '1', material: 'stone' }, cookie)).status, 303)
    assert.equal((await post('/panel/place', { csrf, x: '2.5', y: '64', z: '1', material: 'stone' }, cookie)).status, 303)
    assert.equal((await post('/panel/auto-flee', { csrf, enabled: 'true' }, cookie)).status, 303)
    assert.deepEqual(service.calls, [
      ['stop'], ['join'], ['goto', 10.5, 64, -20], ['place', 2, 64, 1, 'stone'], ['autoFlee', true]
    ])
    const page = await (await get('/panel', cookie)).text()
    assert.match(page, /Auto-flee on: the bot runs from creepers/)
    assert.doesNotMatch(await (await get('/panel', cookie)).text(), /class="flash/)
  })
})

test('panel chat while offline shows the service error instead of crashing', async () => {
  const service = stubService()
  await withPanel(service, async ({ get, post }) => {
    const cookie = await signIn(post)
    const csrf = await csrfOf(get, cookie)
    assert.equal((await post('/panel/chat', { csrf, message: 'hello' }, cookie)).status, 303)
    const page = await (await get('/panel', cookie)).text()
    assert.match(page, /Bot is not in the world/)
  })
})


test('Crafty panel controls require login and CSRF and proxy bounded operations server-side', async () => {
  const service = stubService()
  await withPanel(service, async ({ get, post, crafty }) => {
    assert.equal((await get('/panel/crafty/status.json')).status, 303)
    const cookie = await signIn(post)
    const csrf = await csrfOf(get, cookie)
    const page = await (await get('/panel', cookie)).text()
    for (const action of ['start', 'stop', 'restart']) assert.match(page, new RegExp(`action="/panel/crafty/${action}"`))
    assert.match(page, /crafty-load-logs/)
    assert.match(page, /crafty-command/)
    const logs = await get('/panel/crafty/logs.json?limit=100', cookie)
    assert.equal(logs.status, 200)
    assert.deepEqual(await logs.json(), { status: 'ok', lines: ['hello'] })
    assert.equal((await get('/panel/crafty/logs.json?limit=201', cookie)).status, 200)
    assert.equal((await post('/panel/crafty/start', {}, cookie)).status, 403)
    assert.equal((await post('/panel/crafty/start', { csrf }, cookie)).status, 303)
    assert.equal((await post('/panel/crafty/stop', { csrf }, cookie)).status, 303)
    assert.equal((await post('/panel/crafty/restart', { csrf }, cookie)).status, 303)
    assert.equal((await post('/panel/crafty/command', { csrf, command: 'say hello' }, cookie)).status, 303)
    assert.equal((await post('/panel/crafty/command', { csrf, command: 'say\nstop' }, cookie)).status, 303)
    assert.deepEqual((await get('/panel/crafty/status.json', cookie)).status, 200)
  })
})

test('login rate limiting locks out repeated failures', async () => {
  const service = stubService()
  await withPanel(service, async ({ post }) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await post('/login', { password: 'wrong-wrong-wrong-wrong-wrong' })).status, 401)
    }
    assert.equal((await post('/login', { password: token })).status, 429)
  })
})

test('join, quit and auto-flee API routes stay behind the bearer token', async () => {
  const service = stubService()
  await withPanel(service, async ({ base }) => {
    const api = (path, payload, auth = token) => fetch(base + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    assert.equal((await api('/api/join', {}, 'wrong')).status, 401)
    assert.equal((await api('/api/join', {})).status, 200)
    assert.equal((await api('/api/quit', {})).status, 200)
    assert.deepEqual((await (await api('/api/auto-flee', { enabled: true })).json()), { autoFlee: true })
    assert.equal((await api('/api/auto-flee', { enabled: 'yes' })).status, 400)
    assert.deepEqual(service.calls, [['join'], ['quit'], ['autoFlee', true]])
  })
})


test('Jump is a session and CSRF protected real form with a fixed duration', async () => {
  const service = stubService()
  await withPanel(service, async ({ get, post }) => {
    const cookie = await signIn(post)
    const csrf = await csrfOf(get, cookie)
    assert.equal((await post('/panel/jump', { csrf })).status, 303)
    assert.equal((await post('/panel/jump', {}, cookie)).status, 403)
    assert.equal((await post('/panel/jump', { csrf: 'wrong' }, cookie)).status, 403)
    assert.deepEqual(service.calls, [])
    assert.equal((await post('/panel/jump', { csrf, durationMs: '30000' }, cookie)).status, 303)
    assert.deepEqual(service.calls, [['move', 'jump', 500]])
    const response = await get('/panel', cookie)
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    assert.match(await response.text(), /Jumped for half a second/)
    service.move = () => { throw Object.assign(new Error('Bot is not in the world'), { status: 503 }) }
    await post('/panel/jump', { csrf }, cookie)
    assert.match(await (await get('/panel', cookie)).text(), /Bot is not in the world/)
  })
})
