const http = require('node:http')
const { timingSafeEqual, createHash } = require('node:crypto')
const { bad, stringField, coordinates, blockCoordinates, materialName } = require('./validate')
const { panel } = require('./panel')

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
    if (input.length > 4096) throw bad('Request too large', 413)
  }
  try { return JSON.parse(input) } catch { throw bad('Invalid JSON') }
}

function auditCrafty (req, action) {
  const caller = createHash('sha256').update(req.headers.authorization.slice(7)).digest('hex').slice(0, 12)
  console.info('Crafty control:', JSON.stringify({ at: new Date().toISOString(), action, caller }))
}

function server (service, token, crafty = null) {
  const handlePanel = panel(service, token, crafty)
  return http.createServer(async (req, res) => {
    if (await handlePanel(req, res)) return
    if (!authorized(req, token)) return respond(res, 401, { error: 'Unauthorized' })
    try {
      const path = new URL(req.url, 'http://localhost').pathname
      if (req.method === 'POST' && service.survivalMode?.state.enabled && !['/api/survive', '/api/quit', '/api/disconnect', '/api/stop'].includes(path)) return respond(res, 409, { error: 'Disable Survive before manual controls' })
      if (path.startsWith('/api/crafty/')) {
        if (!crafty) return respond(res, 503, { error: 'Crafty integration is not configured' })
        if (req.method === 'GET' && path === '/api/crafty/status') return respond(res, 200, await crafty.status())
        if (req.method === 'GET' && path === '/api/crafty/logs') {
          const rawLimit = new URL(req.url, 'http://localhost').searchParams.get('limit')
          const limit = rawLimit == null ? 100 : Number(rawLimit)
          return respond(res, 200, await crafty.logs(limit))
        }
        if (req.method === 'POST' && /^\/api\/crafty\/action\/(start|stop|restart)$/.test(path)) {
          const action = path.split('/').pop()
          auditCrafty(req, action)
          return respond(res, 200, await crafty.action(`${action}_server`))
        }
        if (req.method === 'POST' && path === '/api/crafty/command') {
          const { command } = await body(req)
          auditCrafty(req, 'command')
          return respond(res, 200, await crafty.command(command))
        }
        return respond(res, 404, { error: 'Not found' })
      }
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
          throw bad('Expected durationMs 100-30000; forward boolean only for swim')
        }
        return respond(res, 200, service.move(mode, durationMs, forward))
      }
      if (req.method === 'POST' && path === '/api/attack') {
        const { id } = await body(req)
        if (id != null && (!Number.isInteger(id) || id < 0)) throw bad('Expected nonnegative entity id')
        return respond(res, 200, service.attack(id))
      }
      if (req.method === 'POST' && path === '/api/place') {
        const { x, y, z, material } = await body(req)
        coordinates({ x, y, z })
        if (![x, y, z].every(Number.isInteger)) throw bad('Expected integer block coordinates')
        stringField(material, 'material', 64)
        if (!/^[a-z0-9_]+$/.test(material)) throw bad('Invalid material')
        return respond(res, 200, await service.place(x, y, z, material))
      }
      if (req.method === 'POST' && path === '/api/eat') {
        const { slot } = await body(req)
        if (!Number.isInteger(slot) || slot < 0 || slot > 100) throw bad('Expected inventory slot 0-100')
        return respond(res, 200, await service.eat(slot))
      }
      if (req.method === 'POST' && path === '/api/craft') {
        const { item, count = 1 } = await body(req)
        materialName(item, 'item')
        if (!Number.isInteger(count) || count < 1 || count > 16) throw bad('Expected count 1-16')
        return respond(res, 200, await service.craft(item, count))
      }
      if (req.method === 'POST' && path === '/api/place-bed') return respond(res, 200, await service.placeBed(blockCoordinates(await body(req))))
      if (req.method === 'POST' && path === '/api/sleep') return respond(res, 200, await service.sleep())
      if (req.method === 'POST' && path === '/api/wake') return respond(res, 200, await service.wake())
      if (req.method === 'POST' && ['/api/till', '/api/plant', '/api/harvest', '/api/gather'].includes(path)) {
        const input = await body(req)
        const coords = blockCoordinates(input)
        if (path === '/api/harvest') {
          if (input.replant != null && typeof input.replant !== 'boolean') throw bad('Expected boolean replant')
          return respond(res, 200, await service.harvest(coords, input.replant === true))
        }
        return respond(res, 200, await service[path.slice(5)](coords))
      }
      if (req.method === 'POST' && path === '/api/shelter') {
        const input = await body(req)
        materialName(input.material)
        return respond(res, 200, await service.shelter(input.material, blockCoordinates(input)))
      }
      if (req.method === 'POST' && path === '/api/survive') {
        const { enabled } = await body(req)
        if (typeof enabled !== 'boolean') throw bad('Expected boolean enabled')
        return respond(res, 200, service.setSurvive(enabled))
      }
      if (req.method === 'POST' && path === '/api/auto-flee') {
        const { enabled } = await body(req)
        if (typeof enabled !== 'boolean') throw bad('Expected boolean enabled')
        return respond(res, 200, service.setAutoFlee(enabled))
      }
      if (req.method === 'POST' && path === '/api/join') return respond(res, 200, service.join())
      if (req.method === 'POST' && (path === '/api/quit' || path === '/api/disconnect')) return respond(res, 200, service.disconnect())
      if (req.method === 'POST' && path === '/api/reconnect') return respond(res, 200, service.reconnect())
      if (req.method === 'POST' && path === '/api/stop') return respond(res, 200, service.stop())
      respond(res, 404, { error: 'Not found' })
    } catch (error) {
      const clientError = error.status === 400
      respond(res, clientError ? 400 : (error.status || 500), { error: error.status ? error.message : 'Internal error' })
      if (!error.status) console.error('API error:', String(error.message || error).slice(0, 200))
    }
  })
}

module.exports = { server, coordinates, authorized }
