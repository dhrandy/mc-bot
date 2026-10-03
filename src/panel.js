const crypto = require('node:crypto')
const { version } = require('../package.json')
const { bad, stringField, numberField, integerField, materialName } = require('./validate')

const SESSION_COOKIE = 'mcb_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const LOGIN_MAX_FAILURES = 5
const LOGIN_LOCK_MS = 10 * 60 * 1000
const MAX_SESSIONS = 500
const MAX_LOGIN_ATTEMPT_IPS = 1000

function esc (value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function page (title, body, craftyEnabled = false) {
  return `<!doctype html>
<html lang="en" data-crafty="${craftyEnabled ? 'true' : 'false'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(title)} - mc-bot</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #14181d; color: #e6e6e6; font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 1.3rem; margin: 8px 0 12px; display: flex; align-items: center; gap: 10px; }
  h1 small { font-weight: normal; color: #8b949e; font-size: 0.8rem; }
  .card { background: #1c2128; border: 1px solid #2d333b; border-radius: 10px; padding: 14px; margin-bottom: 14px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.8rem; background: #2d333b; }
  .badge.online { background: #1f6f33; }
  .badge.offline, .badge.disconnected { background: #6e352c; }
  .flash { border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; }
  .flash.ok { background: #1f6f33; }
  .flash.err { background: #6e352c; }
  dl.status { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0; }
  dl.status dt { color: #8b949e; }
  dl.status dd { margin: 0; overflow-wrap: anywhere; }
  form { margin: 0; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row form { flex: 1 1 0; }
  button, .button { width: 100%; padding: 12px; font-size: 1rem; border: 0; border-radius: 8px; background: #38853e; color: #fff; cursor: pointer; }
  button.warn { background: #9a6a1e; }
  button.danger { background: #a04038; }
  button.quiet { background: #2d333b; }
  button:active { filter: brightness(1.2); }
  details { margin-bottom: 14px; }
  summary { cursor: pointer; padding: 12px 14px; background: #1c2128; border: 1px solid #2d333b; border-radius: 10px; font-weight: 600; }
  details[open] summary { border-radius: 10px 10px 0 0; border-bottom: 0; }
  details form { background: #1c2128; border: 1px solid #2d333b; border-radius: 0 0 10px 10px; padding: 14px; }
  label { display: block; color: #8b949e; font-size: 0.85rem; margin: 10px 0 4px; }
  input[type=text], input[type=password], input[type=number] { width: 100%; padding: 10px; font-size: 16px; background: #14181d; color: #e6e6e6; border: 1px solid #2d333b; border-radius: 8px; }
  .coords { display: flex; gap: 8px; }
  .coords > div { flex: 1; }
  .muted { color: #8b949e; font-size: 0.85rem; }
  .topbar { display: flex; justify-content: space-between; align-items: baseline; }
  .topbar form { flex: 0 0 auto; }
  .topbar button { width: auto; padding: 6px 12px; font-size: 0.85rem; }
  .login { margin-top: 15vh; }
  .crafty-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .crafty-actions form { min-width: 0; }
  .crafty-actions .stop { background: #9a6a1e; }
  .crafty-actions .restart { background: #6b5aa6; }
  pre.logs { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: #14181d; border-radius: 8px; padding: 10px; font: 0.8rem/1.45 ui-monospace, monospace; }
  textarea { width: 100%; min-height: 90px; resize: vertical; padding: 10px; font: 16px/1.4 ui-monospace, monospace; background: #14181d; color: #e6e6e6; border: 1px solid #2d333b; border-radius: 8px; }
  @media (max-width: 420px) { .crafty-actions { grid-template-columns: 1fr; } .topbar { align-items: flex-start; } }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}

function loginPage (error) {
  return page('Sign in', `
<div class="card login">
  <h1>mc-bot <small>control panel</small></h1>
  ${error ? `<p class="flash err">${esc(error)}</p>` : ''}
  <form method="post" action="/login">
    <label for="password">Access code</label>
    <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
    <p><button type="submit">Sign in</button></p>
    <p class="muted">The access code is the same secret the JSON API uses.</p>
  </form>
</div>`)
}

function formatPosition (position) {
  if (!position) return '-'
  const round = n => Math.round(n * 10) / 10
  return `${round(position.x)}, ${round(position.y)}, ${round(position.z)}`
}

function formatHostiles (hostiles) {
  if (!hostiles || !hostiles.length) return 'none nearby'
  return hostiles.map(h => `${h.name} (${h.distance}m)`).join(', ')
}

function panelPage (service, csrf, flash, craftyEnabled) {
  const s = service.status()
  const field = (id, value) => `<dd id="${id}">${esc(value)}</dd>`
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`
  const coordInputs = `
    <div class="coords">
      <div><label for="x">x</label><input type="number" id="x" name="x" step="any" inputmode="decimal" required></div>
      <div><label for="y">y</label><input type="number" id="y" name="y" step="any" inputmode="decimal" required></div>
      <div><label for="z">z</label><input type="number" id="z" name="z" step="any" inputmode="decimal" required></div>
    </div>`
  return page('Control panel', `
<div class="topbar">
  <h1>mc-bot <small>v${esc(version)} beta</small> <span class="badge ${esc(s.state)}" id="s-badge">${esc(s.state)}</span></h1>
  <form method="post" action="/logout">${hidden}<button type="submit" class="quiet">Sign out</button></form>
</div>
${flash ? `<p class="flash ${flash.ok ? 'ok' : 'err'}">${esc(flash.text)}</p>` : ''}
<div class="card">
  <dl class="status">
    <dt>Player</dt>${field('s-username', s.username || '-')}
    <dt>Health</dt>${field('s-health', s.health == null ? '-' : `${s.health} / 20`)}
    <dt>Food</dt>${field('s-food', s.food == null ? '-' : `${s.food} / 20`)}
    <dt>Position</dt>${field('s-position', formatPosition(s.position))}
    <dt>Hostiles</dt>${field('s-hostiles', formatHostiles(s.nearbyHostiles))}
    <dt>Auto-flee</dt>${field('s-flee', s.autoFlee ? 'on' : 'off')}
    <dt>Last error</dt>${field('s-error', s.lastError || 'none')}
  </dl>
</div>
<div class="row">
  <form method="post" action="/panel/join">${hidden}<button type="submit">Join</button></form>
  <form method="post" action="/panel/jump">${hidden}<button type="submit">Jump</button></form>
  <form method="post" action="/panel/stop">${hidden}<button type="submit" class="warn">Stop</button></form>
  <form method="post" action="/panel/quit">${hidden}<button type="submit" class="danger">Quit</button></form>
</div>
<div class="card">
  <form method="post" action="/panel/auto-flee">
    ${hidden}
    <input type="hidden" name="enabled" value="${s.autoFlee ? 'false' : 'true'}">
    <button type="submit" class="${s.autoFlee ? 'warn' : ''}">${s.autoFlee ? 'Turn auto-flee off' : 'Turn auto-flee on (run from creepers)'}</button>
  </form>
</div>
${craftyEnabled ? `<details open>
  <summary>Crafty server controls</summary>
  <div class="card">
    <dl class="status">
      <dt>Server</dt><dd id="crafty-server-name">Loading...</dd>
      <dt>State</dt><dd id="crafty-server-state">-</dd>
      <dt>Players</dt><dd id="crafty-server-players">-</dd>
      <dt>Version</dt><dd id="crafty-server-version">-</dd>
    </dl>
    <p class="muted">These controls apply to the Crafty server configured for this bot.</p>
    <div class="crafty-actions">
      <form method="post" action="/panel/crafty/start">${hidden}<button type="submit">Start server</button></form>
      <form method="post" action="/panel/crafty/stop">${hidden}<button class="stop" type="submit">Stop server</button></form>
      <form method="post" action="/panel/crafty/restart">${hidden}<button class="restart" type="submit">Restart server</button></form>
    </div>
  </div>
  <div class="card">
    <button type="button" id="crafty-load-logs">Load recent logs</button>
    <pre class="logs" id="crafty-logs" aria-live="polite">Logs have not been loaded.</pre>
  </div>
  <form method="post" action="/panel/crafty/command">
    ${hidden}
    <label for="crafty-command">Console command</label>
    <textarea id="crafty-command" name="command" maxlength="512" required spellcheck="false" placeholder="list"></textarea>
    <p class="muted">One line, up to 512 characters. Console commands can change the world.</p>
    <p><button type="submit">Send console command</button></p>
  </form>
</details>` : ''}
<details>
  <summary>Chat</summary>
  <form method="post" action="/panel/chat">
    ${hidden}
    <label for="message">Message</label>
    <input type="text" id="message" name="message" maxlength="256" required>
    <p><button type="submit">Send</button></p>
  </form>
</details>
<details>
  <summary>Follow a player</summary>
  <form method="post" action="/panel/follow">
    ${hidden}
    <label for="player">Player name</label>
    <input type="text" id="player" name="player" maxlength="32" required>
    <p><button type="submit">Follow</button></p>
  </form>
</details>
<details>
  <summary>Go to coordinates</summary>
  <form method="post" action="/panel/goto">
    ${hidden}
    ${coordInputs}
    <p><button type="submit">Walk there</button></p>
  </form>
</details>
<details>
  <summary>Gather one block</summary>
  <form method="post" action="/panel/gather">
    ${hidden}
    ${coordInputs}
    <p><button type="submit">Gather</button></p>
  </form>
</details>
<details>
  <summary>Place a block</summary>
  <form method="post" action="/panel/place">
    ${hidden}
    ${coordInputs}
    <label for="material">Material</label>
    <input type="text" id="material" name="material" pattern="[a-z0-9_]+" maxlength="64" placeholder="stone" required>
    <p><button type="submit">Place</button></p>
  </form>
</details>
<details>
  <summary>Build a shelter</summary>
  <form method="post" action="/panel/shelter">
    ${hidden}
    ${coordInputs}
    <label for="material">Material</label>
    <input type="text" id="material" name="material" pattern="[a-z0-9_]+" maxlength="64" placeholder="oak_planks" required>
    <p class="muted">Builds a 5x5 box around the origin; needs 55 of the material in inventory.</p>
    <p><button type="submit">Build shelter</button></p>
  </form>
</details>
<p class="muted">Status updates itself every few seconds when scripts are allowed; reload the page otherwise.</p>
<script src="/panel/app.js"></script>`, craftyEnabled)
}

const appJs = `const craftyEnabled = document.documentElement.dataset.crafty === 'true'\nasync function tick () {
  try {
    const response = await fetch('/panel/status.json', { credentials: 'same-origin' })
    if (response.status === 401) { window.location.href = '/login'; return }
    if (!response.ok) return
    const s = await response.json()
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value }
    const round = n => Math.round(n * 10) / 10
    set('s-badge', s.state)
    set('s-username', s.username || '-')
    set('s-health', s.health == null ? '-' : s.health + ' / 20')
    set('s-food', s.food == null ? '-' : s.food + ' / 20')
    set('s-position', s.position ? round(s.position.x) + ', ' + round(s.position.y) + ', ' + round(s.position.z) : '-')
    set('s-hostiles', s.nearbyHostiles && s.nearbyHostiles.length ? s.nearbyHostiles.map(h => h.name + ' (' + h.distance + 'm)').join(', ') : 'none nearby')
    set('s-flee', s.autoFlee ? 'on' : 'off')
    set('s-error', s.lastError || 'none')
    if (craftyEnabled) await tickCraftyStatus()
  } catch (error) { /* keep the last good values on screen */ }
}
async function tickCraftyStatus () {
  try {
    const response = await fetch('/panel/crafty/status.json', { credentials: 'same-origin' })
    if (!response.ok) return
    const result = await response.json()
    const server = result.server || {}
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value }
    set('crafty-server-name', server.name || 'Configured server')
    set('crafty-server-state', server.running === true ? 'Running' : server.running === false ? (server.crashed ? 'Crashed' : 'Stopped') : 'Unknown')
    set('crafty-server-players', server.online == null ? '-' : server.online + (server.max == null ? '' : ' / ' + server.max))
    set('crafty-server-version', server.version || '-')
  } catch (error) { /* keep the last good values on screen */ }
}
async function loadCraftyLogs () {
  const output = document.getElementById('crafty-logs')
  if (!output) return
  output.textContent = 'Loading logs...'
  try {
    const response = await fetch('/panel/crafty/logs.json?limit=100', { credentials: 'same-origin' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Could not load logs')
    output.textContent = result.lines.join('\\n') || 'No log lines returned.'
  } catch (error) { output.textContent = error.message || 'Could not load logs.' }
}
document.getElementById('crafty-load-logs')?.addEventListener('click', loadCraftyLogs)
document.querySelector('form[action="/panel/crafty/command"]')?.addEventListener('submit', event => {
  if (!window.confirm('Send this command to the configured Minecraft server console?')) event.preventDefault()
})
if (craftyEnabled) tickCraftyStatus()
setInterval(tick, 5000)
`

function panel (service, token, crafty = null) {
  const secret = crypto.randomBytes(32)
  const sessions = new Map()
  const attempts = new Map()

  function html (res, status, bodyText) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer'
    })
    res.end(bodyText)
  }

  function json (res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive'
    })
    res.end(JSON.stringify(data))
  }

  function redirect (res, location) {
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' })
    res.end()
  }

  async function formBody (req) {
    let input = ''
    for await (const chunk of req) {
      input += chunk
      if (input.length > 4096) throw bad('Request too large', 413)
    }
    return Object.fromEntries(new URLSearchParams(input))
  }

  function sign (id) {
    return crypto.createHmac('sha256', secret).update(id).digest('hex')
  }

  function clientIp (req) {
    // Use the peer address only: X-Forwarded-For is spoofable unless a trusted proxy is explicitly configured.
    return req.socket.remoteAddress || 'unknown'
  }

  function sweep () {
    const now = Date.now()
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id)
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      for (const [id] of oldest.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id)
    }
  }

  function createSession () {
    sweep()
    const id = crypto.randomBytes(24).toString('base64url')
    sessions.set(id, { csrf: crypto.randomBytes(16).toString('hex'), expiresAt: Date.now() + SESSION_TTL_MS, flash: null })
    return id
  }

  function sessionFrom (req) {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=')).filter(pair => pair[0] && pair[1]))
    const raw = cookies[SESSION_COOKIE]
    if (!raw) return null
    const dot = raw.lastIndexOf('.')
    if (dot <= 0) return null
    const id = raw.slice(0, dot)
    const presented = Buffer.from(raw.slice(dot + 1))
    const expected = Buffer.from(sign(id))
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return null
    const session = sessions.get(id)
    if (!session) return null
    if (session.expiresAt <= Date.now()) { sessions.delete(id); return null }
    return { id, session }
  }

  function setCookie (res, req, id) {
    const secure = Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https'
    const parts = [`${SESSION_COOKIE}=${id}.${sign(id)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`]
    if (secure) parts.push('Secure')
    res.setHeader('Set-Cookie', parts.join('; '))
  }

  function clearCookie (res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
  }

  function checkCsrf (session, fields) {
    const presented = Buffer.from(String(fields.csrf || ''))
    const expected = Buffer.from(session.csrf)
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) throw bad('Missing or bad form token', 403)
  }

  function pruneAttempts (now) {
    for (const [ip, record] of attempts) {
      const windowExpired = now - record.first > LOGIN_WINDOW_MS
      const lockExpired = !record.lockedUntil || record.lockedUntil <= now
      if (windowExpired && lockExpired) attempts.delete(ip)
    }
  }

  function lockedOut (ip) {
    const record = attempts.get(ip)
    return Boolean(record && record.lockedUntil && record.lockedUntil > Date.now())
  }

  function capacityReached (ip) {
    const now = Date.now()
    pruneAttempts(now)
    return !attempts.has(ip) && attempts.size >= MAX_LOGIN_ATTEMPT_IPS
  }

  function recordFailure (ip) {
    const now = Date.now()
    pruneAttempts(now)
    let record = attempts.get(ip)
    if (!record || now - record.first > LOGIN_WINDOW_MS) record = { fails: 0, first: now, lockedUntil: 0 }
    record.fails++
    if (record.fails >= LOGIN_MAX_FAILURES) record.lockedUntil = now + LOGIN_LOCK_MS
    attempts.set(ip, record)
  }

  function auditCrafty (action) {
    console.info('Crafty panel control:', JSON.stringify({ at: new Date().toISOString(), action }))
  }

  function correctPassword (password) {
    if (typeof password !== 'string') return false
    const a = Buffer.from(password)
    const b = Buffer.from(token)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  async function runAction (name, fields, crafty) {
    switch (name) {
      case 'join':
        service.join()
        return 'Joining the server'
      case 'quit':
        service.disconnect()
        return 'Left the server'
      case 'stop':
        service.stop()
        return 'Stopped current movement'
      case 'jump':
        service.move('jump', 500)
        return 'Jumped for half a second; current navigation stopped'
      case 'chat': {
        const message = stringField(fields.message, 'message')
        service.ready().chat(message)
        return 'Message sent'
      }
      case 'follow': {
        const player = stringField(fields.player, 'player', 32)
        service.follow(player)
        return `Following ${player}`
      }
      case 'goto': {
        const [x, y, z] = [numberField(fields.x, 'x'), numberField(fields.y, 'y'), numberField(fields.z, 'z')]
        service.goto(x, y, z)
        return `Walking to ${x}, ${y}, ${z}`
      }
      case 'gather': {
        const coords = { x: integerField(fields.x, 'x'), y: integerField(fields.y, 'y'), z: integerField(fields.z, 'z') }
        await service.gather(coords)
        return `Gathered the block at ${coords.x}, ${coords.y}, ${coords.z}`
      }
      case 'place': {
        const material = materialName(fields.material)
        const [x, y, z] = [integerField(fields.x, 'x'), integerField(fields.y, 'y'), integerField(fields.z, 'z')]
        await service.place(x, y, z, material)
        return `Placed ${material} at ${x}, ${y}, ${z}`
      }
      case 'shelter': {
        const material = materialName(fields.material)
        const coords = { x: integerField(fields.x, 'x'), y: integerField(fields.y, 'y'), z: integerField(fields.z, 'z') }
        await service.shelter(material, coords)
        return `Shelter built at ${coords.x}, ${coords.y}, ${coords.z}`
      }
      case 'crafty/start':
      case 'crafty/stop':
      case 'crafty/restart': {
        if (!crafty) throw bad('Crafty integration is not configured', 503)
        const action = name.slice('crafty/'.length)
        auditCrafty(action)
        await crafty.action(`${action}_server`)
        return `Crafty server ${action} request sent`
      }
      case 'crafty/command': {
        if (!crafty) throw bad('Crafty integration is not configured', 503)
        auditCrafty('command')
        await crafty.command(fields.command)
        return 'Console command sent to Crafty server'
      }
      case 'auto-flee': {
        if (!['true', 'false'].includes(fields.enabled)) throw bad('Expected enabled true or false')
        const result = service.setAutoFlee(fields.enabled === 'true')
        return result.autoFlee ? 'Auto-flee on: the bot runs from creepers' : 'Auto-flee off'
      }
      default:
        throw bad('Unknown action', 404)
    }
  }

  return async function handle (req, res) {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path.startsWith('/api/')) return false
    try {
      const auth = sessionFrom(req)
      if (req.method === 'GET' && path === '/') return redirect(res, auth ? '/panel' : '/login'), true
      if (req.method === 'GET' && path === '/login') {
        if (auth) return redirect(res, '/panel'), true
        return html(res, 200, loginPage()), true
      }
      if (req.method === 'POST' && path === '/login') {
        const ip = clientIp(req)
        if (lockedOut(ip)) return html(res, 429, loginPage('Too many tries. Wait a few minutes and try again.')), true
        if (capacityReached(ip)) return html(res, 429, loginPage('Login is temporarily busy. Try again in a few minutes.')), true
        const fields = await formBody(req)
        if (!correctPassword(fields.password)) {
          recordFailure(ip)
          return html(res, 401, loginPage('Wrong access code.')), true
        }
        attempts.delete(ip)
        const id = createSession()
        setCookie(res, req, id)
        return redirect(res, '/panel'), true
      }
      if (!auth) {
        if (path === '/panel' || path.startsWith('/panel/')) return redirect(res, '/login'), true
        return html(res, 404, page('Not found', '<div class="card"><h1>Not found</h1></div>')), true
      }
      if (req.method === 'GET' && path === '/panel') {
        const flash = auth.session.flash
        auth.session.flash = null
        return html(res, 200, panelPage(service, auth.session.csrf, flash, Boolean(crafty))), true
      }
      if (req.method === 'GET' && path === '/panel/app.js') {
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Robots-Tag': 'noindex, nofollow, noarchive'
        })
        res.end(appJs)
        return true
      }
      if (req.method === 'GET' && path === '/panel/status.json') return json(res, 200, service.status()), true
      if (req.method === 'GET' && path === '/panel/crafty/status.json') {
        if (!crafty) return json(res, 503, { error: 'Crafty integration is not configured' }), true
        return json(res, 200, await crafty.status()), true
      }
      if (req.method === 'GET' && path === '/panel/crafty/logs.json') {
        if (!crafty) return json(res, 503, { error: 'Crafty integration is not configured' }), true
        const rawLimit = new URL(req.url, 'http://localhost').searchParams.get('limit')
        return json(res, 200, await crafty.logs(rawLimit == null ? 100 : Number(rawLimit))), true
      }
      if (req.method === 'POST' && path === '/logout') {
        const fields = await formBody(req)
        checkCsrf(auth.session, fields)
        sessions.delete(auth.id)
        clearCookie(res)
        return redirect(res, '/login'), true
      }
      if (req.method === 'POST' && path.startsWith('/panel/')) {
        const fields = await formBody(req)
        checkCsrf(auth.session, fields)
        try {
          const text = await runAction(path.slice('/panel/'.length), fields, crafty)
          auth.session.flash = { ok: true, text }
        } catch (error) {
          auth.session.flash = { ok: false, text: error.status ? error.message : 'Something went wrong' }
          if (!error.status) console.error('Panel action error:', error)
        }
        return redirect(res, '/panel'), true
      }
      return html(res, 404, page('Not found', '<div class="card"><h1>Not found</h1></div>')), true
    } catch (error) {
      const status = error.status || 500
      if (!error.status) console.error('Panel error:', error)
      return html(res, status, page('Error', `<div class="card"><h1>Something went wrong</h1><p>${esc(error.status ? error.message : 'Try again.')}</p></div>`)), true
    }
  }
}

module.exports = { panel }
