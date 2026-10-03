const DEFAULT_TIMEOUT_MS = 10000
const MAX_LOG_LIMIT = 200

function apiBase (value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Crafty API URL must use HTTPS')
  }
  if (url.username || url.password) throw new Error('Crafty API URL must not contain credentials')
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function redact (value, token) {
  if (typeof value === 'string') return token ? value.split(token).join('[redacted]') : value
  if (Array.isArray(value)) return value.map(item => redact(item, token))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, token)]))
  }
  return value
}

function serverStatus (result) {
  if (result?.status !== 'ok' || !result.data || typeof result.data !== 'object') {
    throw new Error('Crafty API returned an unexpected status response')
  }
  const data = result.data
  const nestedServer = data.server_id && typeof data.server_id === 'object' ? data.server_id : {}
  const sources = [result, data]
  const first = key => sources.find(source => source[key] !== undefined)?.[key]
  return {
    status: 'ok',
    server: {
      name: data.server_name || nestedServer.server_name || null,
      running: first('running') ?? null,
      crashed: first('crashed') ?? null,
      online: first('online') ?? null,
      max: first('max') ?? null,
      version: first('version') ?? null,
      started: first('started') ?? null
    }
  }
}

class CraftyClient {
  constructor ({ baseUrl, serverId, token, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!baseUrl || !serverId || !token) throw new Error('Crafty API configuration is incomplete')
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(serverId))) throw new Error('Crafty server ID is invalid')
    if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable')
    this.baseUrl = apiBase(baseUrl)
    this.serverId = String(serverId)
    this.token = String(token)
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async request (path, { method = 'GET', body, contentType } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }
      if (contentType) headers['Content-Type'] = contentType
      const response = await this.fetch(`${this.baseUrl}/api/v2/servers/${encodeURIComponent(this.serverId)}${path}`, {
        method,
        headers,
        signal: controller.signal,
        redirect: 'error',
        ...(body === undefined ? {} : { body })
      })
      if (!response.ok) throw new Error(`Crafty API returned HTTP ${response.status}`)
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error('Crafty API returned invalid JSON') }
      if (data?.status === 'error') throw new Error(`Crafty API error${data.error ? `: ${String(data.error).slice(0, 120)}` : ''}`)
      return redact(data, this.token)
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Crafty API request timed out')
      if (error.message?.startsWith('Crafty API')) throw new Error(redact(error.message, this.token))
      throw new Error('Crafty API request failed')
    } finally {
      clearTimeout(timer)
    }
  }

  async status () {
    return serverStatus(await this.request('/stats'))
  }

  async logs (limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) throw Object.assign(new Error(`limit must be an integer from 1 to ${MAX_LOG_LIMIT}`), { status: 400 })
    const result = await this.request('/logs?file=false&colors=false&raw=false&html=false')
    if (result?.status !== 'ok' || !Array.isArray(result.data) || !result.data.every(line => typeof line === 'string')) {
      throw new Error('Crafty API returned an unexpected log response')
    }
    return { status: 'ok', lines: result.data.slice(-limit) }
  }

  async action (name) {
    if (!['start_server', 'stop_server', 'restart_server'].includes(name)) throw new Error('Unsupported Crafty action')
    const result = await this.request(`/action/${name}`, { method: 'POST' })
    if (result?.status !== 'ok') throw new Error('Crafty API did not confirm the action')
    return { status: 'ok', action: name.replace('_server', '') }
  }

  async command (command) {
    if (typeof command !== 'string' || !command.trim() || command.length > 512 || /[\r\n\0]/.test(command) || command.startsWith('/') || command.includes(this.token)) {
      throw Object.assign(new Error('command must be 1-512 characters on one line, without a leading slash or the Crafty token'), { status: 400 })
    }
    const result = await this.request('/stdin', { method: 'POST', body: command, contentType: 'text/plain; charset=utf-8' })
    if (result?.status !== 'ok') throw new Error('Crafty API did not confirm the command')
    return { status: 'ok', sent: true }
  }
}

module.exports = { CraftyClient, MAX_LOG_LIMIT }
