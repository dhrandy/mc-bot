const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')

class BotService {
  constructor (config, createBot = mineflayer.createBot) {
    this.config = config
    this.createBot = createBot
    this.bot = null
    this.state = 'starting'
    this.lastError = null
    this.messages = []
    this.retryTimer = null
    this.retries = 0
    this.stopping = false
    this.actionId = 0
  }

  connect () {
    if (this.stopping) return
    this.state = 'connecting'
    const bot = this.createBot({
      host: this.config.mcHost,
      port: this.config.mcPort,
      username: this.config.mcAccountId,
      auth: 'microsoft',
      version: this.config.mcVersion || false,
      profilesFolder: this.config.cacheDir,
      onMsaCode: data => console.log(`Sign in to your Minecraft Java account at ${data.verification_uri || 'https://www.microsoft.com/link'} using code ${data.user_code}`)
    })
    this.bot = bot
    bot.loadPlugin(pathfinder)
    bot.once('spawn', () => {
      if (this.bot !== bot || this.stopping) return
      this.state = 'online'
      this.retries = 0
      this.lastError = null
      console.log('Bot spawned; control API is ready')
    })
    bot.on('messagestr', (message, position, json, sender) => {
      this.messages.push({ at: new Date().toISOString(), message: String(message).slice(0, 512), position, sender: sender || null })
      if (this.messages.length > 100) this.messages.shift()
    })
    bot.on('kicked', reason => {
      this.lastError = `Kicked: ${String(reason).slice(0, 300)}`
    })
    bot.on('error', error => {
      this.lastError = String(error.message || error).slice(0, 300)
      console.error('Bot error:', this.lastError)
    })
    bot.once('end', reason => {
      if (this.bot !== bot || this.stopping) return
      this.state = 'offline'
      this.lastError = this.lastError || `Connection ended: ${String(reason).slice(0, 200)}`
      this.retries++
      const delay = Math.min(60000, 2000 * 2 ** Math.min(this.retries, 5))
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect() }, delay)
    })
  }

  status () {
    const b = this.bot
    const pos = b && b.entity && b.entity.position
    return {
      state: this.state,
      username: this.state === 'online' ? b.username : null,
      position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
      health: b && this.state === 'online' ? b.health : null,
      food: b && this.state === 'online' ? b.food : null,
      lastError: this.lastError
    }
  }

  ready () {
    if (this.state !== 'online' || !this.bot?.entity) throw Object.assign(new Error('Bot is not in the world'), { status: 503 })
    return this.bot
  }

  async goto (x, y, z) {
    const b = this.ready()
    this.actionId++
    const goal = new goals.GoalNear(x, y, z, 1)
    await b.pathfinder.goto(goal)
    return this.status()
  }

  follow (name) {
    const b = this.ready()
    const player = b.players[name]
    if (!player?.entity) throw Object.assign(new Error('Player not visible nearby'), { status: 404 })
    this.actionId++
    b.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true)
    return { following: name }
  }

  stop () {
    const b = this.ready()
    this.actionId++
    b.pathfinder.setGoal(null)
    b.clearControlStates()
    return { stopped: true }
  }

  async look (x, y, z) {
    const b = this.ready()
    const Vec3 = require('vec3')
    await b.lookAt(new Vec3(x, y, z))
    return { lookingAt: { x, y, z } }
  }

  shutdown () {
    this.stopping = true
    this.state = 'stopped'
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.bot?.quit('Shutting down')
  }
}

module.exports = { BotService }
