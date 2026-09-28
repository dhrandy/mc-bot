const mineflayer = require('mineflayer')
const { pathfinder, goals, Movements } = require('mineflayer-pathfinder')

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
    this.controlTimer = null
    this.navigation = null
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
      const movements = new Movements(bot)
      movements.liquidCost = 25
      movements.allowSprinting = false
      movements.canDig = false
      movements.allow1by1towers = false
      movements.infiniteLiquidDropdownDistance = false
      movements.exclusionAreasPlace.push(() => 100)
      bot.pathfinder.setMovements(movements)
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
      console.warn('Bot connection ended:', String(reason).slice(0, 200))
      if (this.bot !== bot || this.stopping) return
      this.clearControlTimer()
      this.state = 'offline'
      this.lastError = this.lastError || `Connection ended: ${String(reason).slice(0, 200)}`
      this.navigation = null
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
      lastError: this.lastError,
      navigation: this.navigation,
      inventory: this.state === 'online' ? (b.inventory?.items() || []).map(item => ({ slot: item.slot, name: item.name, count: item.count })) : []
    }
  }

  ready () {
    if (this.state !== 'online' || !this.bot?.entity) throw Object.assign(new Error('Bot is not in the world'), { status: 503 })
    return this.bot
  }

  goto (x, y, z) {
    const b = this.ready()
    this.clearControlTimer()
    const id = ++this.actionId
    this.navigation = { id, state: 'moving', target: { x, y, z } }
    const goal = new goals.GoalNear(x, y, z, 1)
    Promise.resolve().then(() => b.pathfinder.goto(goal)).then(() => {
      if (this.actionId === id && this.bot === b) this.navigation = { id, state: 'arrived', target: { x, y, z } }
    }).catch(error => {
      if (this.actionId !== id || this.bot !== b) return
      this.navigation = { id, state: 'failed', target: { x, y, z }, error: String(error.message || error).slice(0, 200) }
      console.error('Navigation failed:', this.navigation.error)
    })
    return this.navigation
  }

  follow (name) {
    const b = this.ready()
    const player = b.players[name]
    if (!player?.entity) throw Object.assign(new Error('Player not visible nearby'), { status: 404 })
    this.clearControlTimer()
    this.actionId++
    this.navigation = { id: this.actionId, state: 'following', player: name }
    b.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true)
    return { following: name }
  }

  stop () {
    const b = this.ready()
    this.actionId++
    this.navigation = null
    this.clearControlTimer()
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

  clearControlTimer () {
    if (this.controlTimer) clearTimeout(this.controlTimer)
    this.controlTimer = null
  }

  move (mode, durationMs, forward = false) {
    const b = this.ready()
    this.stop()
    b.setControlState('jump', true)
    if (mode === 'swim') b.setControlState('forward', forward)
    this.controlTimer = setTimeout(() => {
      if (this.bot === b) {
        b.setControlState('jump', false)
        if (mode === 'swim') b.setControlState('forward', false)
      }
      this.controlTimer = null
    }, durationMs)
    return { mode, durationMs, forward: mode === 'swim' ? forward : false }
  }

  async eat (slot) {
    const b = this.ready()
    const item = b.inventory.items().find(item => item.slot === slot)
    if (!item) throw Object.assign(new Error('No item in that slot'), { status: 404 })
    const food = b.registry.foodsByName?.[item.name]
    const unsafe = new Set(['rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'chorus_fruit'])
    if (!food || unsafe.has(item.name)) throw Object.assign(new Error('Item is not a supported safe food'), { status: 400 })
    if (b.food >= 20) throw Object.assign(new Error('Food bar is full'), { status: 409 })
    await b.equip(item, 'hand')
    await b.consume()
    return { eaten: item.name, food: b.food }
  }

  disconnect () {
    if (this.stopping) return { disconnected: true }
    this.stopping = true
    this.state = 'disconnected'
    this.navigation = null
    this.actionId++
    this.clearControlTimer()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.bot?.pathfinder?.setGoal(null)
    this.bot?.clearControlStates()
    this.bot?.quit('Disconnected via control API')
    return { disconnected: true }
  }

  reconnect () {
    if (!this.stopping) throw Object.assign(new Error('Bot is not disconnected'), { status: 409 })
    this.stopping = false
    this.connect()
    return { connecting: true }
  }

  shutdown () {
    this.stopping = true
    this.clearControlTimer()
    this.state = 'stopped'
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.bot?.quit('Shutting down')
  }
}

module.exports = { BotService }
