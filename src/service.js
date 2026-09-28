const mineflayer = require('mineflayer')
const { pathfinder, goals, Movements } = require('mineflayer-pathfinder')
const { DANGEROUS, MELEE, distance, mobName, strategy, defend, selectThreat } = require('./survival')
const { SAFE_FOODS, chooseFood } = require('./food')
const Vec3 = require('vec3')
const work = require('./work')

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
    this.defenseTimer = null
    this.defenseLastHitAt = 0
    this.defenseArmedUntil = 0
    this.building = false
    this.defense = null
    this.foodTimer = null
    this.eating = false
    this.lastEatError = null
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
      if (this.config.autoDefend) this.startDefense(bot)
      if (this.config.autoEat) this.startAutoEat(bot)
      console.log('Bot spawned; control API is ready')
    })
    let previousHealth = bot.health ?? null
    bot.on('health', () => {
      if (this.bot !== bot || this.state !== 'online') return
      if (this.config.autoEat) this.autoEat(bot).catch(error => { this.lastEatError = String(error.message || error).slice(0, 160) })
      if (this.config.autoDefend && previousHealth !== null && bot.health < previousHealth) this.defenseArmedUntil = Date.now() + 8000
      previousHealth = bot.health
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
      this.clearDefense()
      this.clearAutoEat()
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
      autoDefend: Boolean(this.config.autoDefend),
      autoEat: Boolean(this.config.autoEat),
      eating: this.eating,
      lastEatError: this.lastEatError,
      defense: this.defense,
      inventory: this.state === 'online' ? (b.inventory?.items() || []).map(item => ({ slot: item.slot, name: item.name, count: item.count })) : [],
      nearbyHostiles: this.state === 'online' ? Object.values(b.entities || {}).filter(entity => entity?.position && DANGEROUS.has(mobName(entity)) && distance(b.entity.position, entity.position) <= 10).map(entity => ({ id: entity.id, name: mobName(entity), distance: Math.round(distance(b.entity.position, entity.position) * 10) / 10 })) : []
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
    this.defense = null
    this.defenseArmedUntil = 0
    return { stopped: true }
  }

  async look (x, y, z) {
    const b = this.ready()
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
    if (!food || !SAFE_FOODS.has(item.name)) throw Object.assign(new Error('Item is not a supported safe food'), { status: 400 })
    if (b.food >= 20) throw Object.assign(new Error('Food bar is full'), { status: 409 })
    if (this.eating) throw Object.assign(new Error('Already eating'), { status: 409 })
    await this.consumeFood(b, item)
    return { eaten: item.name, food: b.food }
  }



  async consumeFood (bot, item) {
    if (this.eating) return false
    this.eating = true
    const held = bot.heldItem
    try {
      await bot.equip(item, 'hand')
      await bot.consume()
      this.lastEatError = null
      return true
    } finally {
      if (this.bot === bot && held && bot.inventory.items().some(candidate => candidate.slot === held.slot && candidate.name === held.name)) {
        try { await bot.equip(held, 'hand') } catch (error) { this.lastEatError = `Could not restore held item: ${String(error.message || error).slice(0, 100)}` }
      }
      this.eating = false
    }
  }

  async autoEat (bot) {
    if (this.bot !== bot || this.state !== 'online' || this.eating || this.building || this.defense?.action === 'attack' || this.defense?.action === 'hit-and-retreat' || bot.food == null || bot.food > 14 || bot.food >= 20) return false
    const item = chooseFood(bot)
    if (!item) { this.lastEatError = 'No safe food in inventory'; return false }
    return this.consumeFood(bot, item)
  }

  startAutoEat (bot) {
    this.clearAutoEat()
    this.autoEat(bot).catch(error => { this.lastEatError = String(error.message || error).slice(0, 160) })
    this.foodTimer = setInterval(() => {
      this.autoEat(bot).catch(error => { this.lastEatError = String(error.message || error).slice(0, 160) })
    }, 10000)
    this.foodTimer.unref?.()
  }

  clearAutoEat () {
    if (this.foodTimer) clearInterval(this.foodTimer)
    this.foodTimer = null
  }

  clearDefense () {
    if (this.defenseTimer) clearInterval(this.defenseTimer)
    this.defenseTimer = null
    this.defense = null
    this.defenseArmedUntil = 0
  }

  startDefense (bot) {
    this.clearDefense()
    this.defenseTimer = setInterval(() => {
      if (this.bot !== bot || this.state !== 'online' || this.building) return
      const entity = selectThreat(bot)
      if (!entity) {
        if (['retreat', 'hit-and-retreat'].includes(this.defense?.action) && !this.navigation) bot.pathfinder.setGoal(null)
        this.defense = null
        return
      }
      if (mobName(entity) !== 'creeper' && Date.now() > this.defenseArmedUntil) {
        if (['retreat', 'hit-and-retreat'].includes(this.defense?.action) && !this.navigation) bot.pathfinder.setGoal(null)
        this.defense = null
        return
      }
      try {
        if (['retreat', 'hit-and-retreat'].includes(this.defense?.action) && this.defense.entityId === entity.id && Date.now() - Date.parse(this.defense.at) < 1400) return
        const result = defend(bot, entity, this.defenseLastHitAt)
        if (result.action === 'attack' || result.action === 'hit-and-retreat') this.defenseLastHitAt = Date.now()
        if (result.action === 'retreat' || result.action === 'hit-and-retreat') {
          this.actionId++
          this.navigation = null
        }
        this.defense = { ...result, entityId: entity.id, at: new Date().toISOString() }
      } catch (error) {
        this.defense = { action: 'failed', error: String(error.message || error).slice(0, 160) }
      }
    }, 700)
    this.defenseTimer.unref?.()
  }

  attack (id) {
    const bot = this.ready()
    const candidates = Object.values(bot.entities || {}).filter(entity =>
      entity?.position && MELEE.has(mobName(entity)) &&
      distance(bot.entity.position, entity.position) <= 3)
    const target = id == null
      ? candidates.sort((a, b) => distance(bot.entity.position, a.position) - distance(bot.entity.position, b.position))[0]
      : candidates.find(entity => entity.id === id)
    if (!target) throw Object.assign(new Error('No allowed melee hostile in reach; risky, neutral, player and unknown targets are excluded'), { status: 404 })
    bot.attack(target)
    return { attacked: { id: target.id, name: mobName(target) }, singleHit: true }
  }

  async place (x, y, z, material) {
    const bot = this.ready()
    if (this.building) throw Object.assign(new Error('Placement already in progress'), { status: 409 })
    const point = new Vec3(x, y, z)
    if (distance(bot.entity.position, point) < 1.5) throw Object.assign(new Error('Target overlaps the bot'), { status: 409 })
    if (distance(bot.entity.position, point) > 4.5) throw Object.assign(new Error('Target is out of reach'), { status: 400 })
    if (Object.values(bot.entities || {}).some(entity => entity?.type === 'player' && entity.position && distance(entity.position, point) < 1.5)) throw Object.assign(new Error('A player is too close to the target block'), { status: 409 })
    const current = bot.blockAt(point)
    if (!current || !['air', 'cave_air', 'void_air'].includes(current.name)) throw Object.assign(new Error('Target is not a loaded, empty block'), { status: 409 })
    const excluded = /(?:tnt|lava|water|bucket|spawn_egg|command_block|bedrock|end_crystal|fire|shulker|chest|barrel|furnace|hopper|dispenser|dropper|door|trapdoor|button|lever|pressure_plate|rail|bed|sign|torch|lantern|slab|stair|fence|wall|pane|carpet|powder|sand|gravel|concrete_powder)$/
    const block = bot.registry.blocksByName?.[material]
    if (!block || block.boundingBox !== 'block' || excluded.test(material) || block.name !== material) {
      throw Object.assign(new Error('Material must be an ordinary full solid block'), { status: 400 })
    }
    const item = bot.inventory.items().find(item => item.name === material && item.count > 0)
    if (!item) throw Object.assign(new Error('Material is not in inventory'), { status: 409 })
    const faces = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]
    const face = faces.find(vector => {
      const support = bot.blockAt(point.minus(vector))
      return support && support.boundingBox === 'block' && distance(bot.entity.position, support.position) <= 4.5
    })
    if (!face) throw Object.assign(new Error('No reachable solid adjacent support block'), { status: 409 })
    this.building = true
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(bot.blockAt(point.minus(face)), face)
      return { placed: material, x, y, z }
    } finally {
      this.building = false
    }
  }

  craft (item, count) { return work.craft(this, item, count) }
  sleep () { return work.sleep(this) }
  placeBed (coords) { return work.placeBed(this, coords) }
  wake () { return work.sleep(this, true) }
  till (coords) { return work.till(this, coords) }
  plant (coords) { return work.plant(this, coords) }
  harvest (coords, replant) { return work.harvest(this, coords, replant) }
  gather (coords) { return work.gather(this, coords) }
  shelter (material, origin) { return work.shelter(this, material, origin) }

  disconnect () {
    if (this.stopping) return { disconnected: true }
    this.stopping = true
    this.state = 'disconnected'
    this.navigation = null
    this.actionId++
    this.clearControlTimer()
    this.clearDefense()
    this.clearAutoEat()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.bot?.pathfinder?.setGoal(null)
    this.bot?.clearControlStates()
    this.bot?.quit('Disconnected via control API')
    this.bot = null
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
    this.clearDefense()
    this.clearAutoEat()
    this.state = 'stopped'
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.bot?.quit('Shutting down')
  }
}

module.exports = { BotService }
