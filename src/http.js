const http = require('node:http')
const { timingSafeEqual } = require('node:crypto')

function authorized (req, token) {
  const supplied = req.headers.authorization
  if (!supplied?.startsWith('Bearer ')) return false
  const a = Buffer.from(supplied.slice(7))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function respond (res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'",
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer'
  })
  res.end(JSON.stringify(data))
}

async function body (req) {
  let input = ''
  for await (const chunk of req) {
    input += chunk
    if (input.length > 4096) throw Object.assign(new Error('Request too large'), { status: 413 })
  }
  try { return JSON.parse(input) } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
}

function stringField (value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Object.assign(new Error(`Invalid ${label}`), { status: 400 })
  return value
}

function coordinates (input) {
  const { x, y, z } = input
  if (![x, y, z].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 30000000)) {
    throw Object.assign(new Error('Expected finite x, y, z coordinates'), { status: 400 })
  }
  return [x, y, z]
}

function server (service, token) {
  return http.createServer(async (req, res) => {
    if (!authorized(req, token)) return respond(res, 401, { error: 'Unauthorized' })
    try {
      const path = new URL(req.url, 'http://localhost').pathname
      if (req.method === 'GET' && path === '/api/status') return respond(res, 200, service.status())
      if (req.method === 'GET' && path === '/api/chat') return respond(res, 200, { messages: service.messages.slice(-50) })
      if (req.method === 'POST' && path === '/api/chat') {
        const { message } = await body(req)
        stringField(message, 'message')
        service.ready().chat(message)
        return respond(res, 200, { sent: true })
      }
      if (req.method === 'POST' && path === '/api/follow') {
        const { player } = await body(req)
        stringField(player, 'player', 32)
        return respond(res, 200, service.follow(player))
      }
      if (req.method === 'POST' && path === '/api/goto') {
        const coords = coordinates(await body(req))
        return respond(res, 202, service.goto(...coords))
      }
      if (req.method === 'POST' && path === '/api/look') {
        const coords = coordinates(await body(req))
        return respond(res, 200, await service.look(...coords))
      }
      if (req.method === 'POST' && (path === '/api/jump' || path === '/api/swim')) {
        const { durationMs, forward = false } = await body(req)
        const mode = path === '/api/swim' ? 'swim' : 'jump'
        if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 30000 || typeof forward !== 'boolean' || (mode === 'jump' && forward)) {
          throw Object.assign(new Error('Expected durationMs 100-30000; forward boolean only for swim'), { status: 400 })
        }
        return respond(res, 200, service.move(mode, durationMs, forward))
      }
      if (req.method === 'POST' && path === '/api/eat') {
        const { slot } = await body(req)
        if (!Number.isInteger(slot) || slot < 0 || slot > 100) throw Object.assign(new Error('Expected inventory slot 0-100'), { status: 400 })
        return respond(res, 200, await service.eat(slot))
      }
      if (req.method === 'POST' && path === '/api/disconnect') return respond(res, 200, service.disconnect())
      if (req.method === 'POST' && path === '/api/reconnect') return respond(res, 200, service.reconnect())
      if (req.method === 'POST' && path === '/api/stop') return respond(res, 200, service.stop())
      respond(res, 404, { error: 'Not found' })
    } catch (error) {
      respond(res, error.status || 500, { error: error.status ? error.message : 'Internal error' })
      if (!error.status) console.error('API error:', error)
    }
  })
}

module.exports = { server, coordinates, authorized }
