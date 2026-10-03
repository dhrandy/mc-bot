const Vec3 = require('vec3')
const { chooseFood } = require('./food')
const { selectThreat, strategy, distance, mobName } = require('./survival')

const LOG = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/
const HAZARD = /(?:lava|water|fire|magma|cactus|powder_snow|sand|gravel|concrete_powder|campfire|sweet_berry_bush|wither_rose)/
const empty = block => block && ['air', 'cave_air', 'void_air'].includes(block.name)
const count = (bot, name) => bot.inventory.items().filter(item => item.name === name).reduce((total, item) => total + item.count, 0)
const point = position => ({ x: position.x, y: position.y, z: position.z })

function safeStanding (bot, feet) {
  const floor = bot.blockAt(feet.offset(0, -1, 0))
  return floor?.boundingBox === 'block' && !HAZARD.test(floor.name) &&
    empty(bot.blockAt(feet)) && empty(bot.blockAt(feet.offset(0, 1, 0)))
}

// Only flee across a short, fully loaded, flat corridor we have inspected.
// A distant "away from mob" coordinate could lead into a hole or a lake.
function escapeTarget (bot, threat) {
  const feet = bot.entity.position.floored()
  const candidates = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let clear = true
    for (let step = 1; step <= 4; step++) {
      const pos = feet.offset(dx * step, 0, dz * step)
      if (!safeStanding(bot, pos)) { clear = false; break }
      for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const side = bot.blockAt(pos.offset(sx, 0, sz))
        if (!side || HAZARD.test(side.name)) { clear = false; break }
      }
      if (!clear) break
    }
    const end = feet.offset(dx * 4, 0, dz * 4)
    if (clear && distance(end, threat.position) > distance(feet, threat.position) + 2 &&
      !Object.values(bot.entities || {}).some(entity => entity.position && entity.type === 'player' && distance(end, entity.position) < 2)) {
      candidates.push(end)
    }
  }
  candidates.sort((a, b) => distance(b, threat.position) - distance(a, threat.position))
  return candidates[0] || null
}

function shelterPlan (feet) {
  const blocks = []
  for (let y = 0; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
      if (x || z) blocks.push(feet.offset(x, y, z))
    }
  }
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) blocks.push(feet.offset(x, 2, z))
  return blocks
}

function checkShelter (bot, feet) {
  if (!bot.entity.onGround || !safeStanding(bot, feet)) throw new Error('No safe standing space for shelter')
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    const floor = bot.blockAt(feet.offset(x, -1, z))
    if (floor?.boundingBox !== 'block' || HAZARD.test(floor.name)) throw new Error('Shelter needs loaded, safe, solid ground across its footprint')
  }
  const plan = shelterPlan(feet)
  for (const pos of plan) {
    if (!empty(bot.blockAt(pos))) throw new Error('Shelter footprint is occupied; refusing to replace blocks')
    if (Object.values(bot.entities || {}).some(entity => entity.position && entity.type === 'player' && distance(pos, entity.position) < 2)) throw new Error('Player is too close to shelter')
  }
  return plan
}

class SurvivalMode {
  constructor (service) {
    this.service = service
    this.timer = null
    this.busy = false
    this.generation = 0
    this.startedAt = 0
    this.steps = 0
    this.lastHit = 0
    this.state = { enabled: false, goal: 'off', reason: 'Enable Survive after joining', error: null }
  }

  describe (goal, reason, extra = {}) {
    this.state = { ...this.state, goal, reason, updatedAt: new Date().toISOString(), ...extra }
  }

  enable () {
    const bot = this.service.ready()
    if (this.busy || this.service.building || this.service.eating) throw Object.assign(new Error('Another world action is in progress'), { status: 409 })
    if (this.state.enabled) return this.state
    this.service.stop()
    this.service.clearDefense()
    this.service.clearAutoEat()
    this.service.clearAutoFlee()
    // Autonomous travel must never dig a route through terrain or builds.
    if (bot.pathfinder.movements) bot.pathfinder.movements.canDig = false
    this.generation++
    this.steps = 0
    this.startedAt = Date.now()
    this.state.enabled = true
    this.describe('starting', 'Checking threats, food and nearby materials', { error: null })
    this.timer = setInterval(() => this.tick(bot), 1000)
    this.timer.unref?.()
    this.tick(bot)
    return this.state
  }

  disable (reason = 'Stopped by user') {
    this.generation++
    clearInterval(this.timer)
    this.timer = null
    this.state.enabled = false
    this.describe('off', reason)
  }

  leave (reason, error = null) {
    this.disable(reason)
    this.describe('quit', reason, { error })
    this.service.disconnect()
  }

  async bounded (bot, task, active) {
    let timer
    try {
      await Promise.race([task(), new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          if (active()) this.leave('World action timed out; leaving instead of hanging idle', 'Action exceeded 15 seconds')
          reject(new Error('World action timed out'))
        }, 15000)
      })])
    } finally { clearTimeout(timer) }
  }

  async tick (bot) {
    const service = this.service
    if (!this.state.enabled || service.bot !== bot || service.state !== 'online') return
    // Safety check still runs while a dig/craft is pending. Disconnect cancels
    // the world connection rather than stacking a second operation on it.
    if (bot.health == null || bot.health <= 6 || bot.entity?.isInLava || bot.entity?.isInWater) {
      this.leave('Health or liquid danger; leaving the world')
      return
    }
    const threat = selectThreat(bot)
    if (this.busy) {
      if (threat && distance(bot.entity.position, threat.position) <= 4) this.leave('Hostile interrupted a world action; leaving safely')
      return
    }
    if (++this.steps > 120 || Date.now() - this.startedAt > 10 * 60 * 1000) {
      this.leave('Starter survival work budget reached; leaving instead of staying unattended')
      return
    }
    this.busy = true
    const generation = this.generation
    const active = () => this.state.enabled && this.generation === generation && service.bot === bot && service.state === 'online'
    try {
      if (threat) {
        const gap = distance(bot.entity.position, threat.position)
        const weapon = bot.inventory.items().find(item => /_sword$/.test(item.name))
        if (strategy(threat) === 'melee' && gap <= 2.8 && bot.health >= 16 && weapon) {
          this.describe('defending', 'Known melee hostile in reach; equipped sword only', { mob: mobName(threat) })
          await this.bounded(bot, async () => {
            await bot.equip(weapon, 'hand')
            if (active() && Date.now() - this.lastHit >= 800) { bot.attack(threat); this.lastHit = Date.now() }
          }, active)
        } else {
          const target = escapeTarget(bot, threat)
          if (!target) { this.leave('Hostile nearby and no inspected safe escape corridor'); return }
          this.describe('fleeing', 'Moving away through an inspected flat corridor', { target: point(target), mob: mobName(threat) })
          service.goto(target.x, target.y, target.z)
          await this.bounded(bot, () => new Promise((resolve, reject) => {
            const check = setInterval(() => {
              if (!active()) { clearInterval(check); resolve(); return }
              if (service.navigation?.state === 'arrived') { clearInterval(check); resolve() }
              else if (service.navigation?.state === 'failed') { clearInterval(check); reject(new Error(service.navigation.error)) }
            }, 200)
            check.unref?.()
            // The action timeout disconnects; active() then clears this observer.
          }), active)
        }
        return
      }
      if (bot.food <= 14) {
        const food = chooseFood(bot)
        if (!food) { this.leave('Hungry with no safe food in inventory; food acquisition is not implemented'); return }
        this.describe('eating', 'Food bar is low; using safe food already in inventory')
        await this.bounded(bot, () => service.consumeFood(bot, food), active)
        return
      }
      if (!bot.time || !Number.isFinite(bot.time.timeOfDay)) { this.leave('World time unavailable; cannot safely plan day or night work'); return }
      const night = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23500
      const materials = ['dirt', 'cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks']
      const material = materials.find(name => count(bot, name) >= 25)
      if (night) {
        if (!material) { this.leave('Night without enough shelter material; leaving rather than exposing the bot'); return }
        const feet = bot.entity.position.floored()
        const plan = checkShelter(bot, feet)
        this.describe('sheltering', 'Building a closed 3x3 shell around a 1x1 interior before leaving', { origin: point(feet) })
        await this.bounded(bot, async () => {
          service.building = true
          try {
            for (const pos of plan) {
              if (!active()) return
              if (!empty(bot.blockAt(pos))) throw new Error('Shelter target changed during construction')
              if (Object.values(bot.entities || {}).some(entity => entity.position && entity.type === 'player' && distance(pos, entity.position) < 2)) throw new Error('Player entered shelter footprint')
              const item = bot.inventory.items().find(item => item.name === material && item.count > 0)
              if (!item) throw new Error('Shelter material ran out')
              const faces = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
              const face = faces.find(face => bot.blockAt(pos.minus(face))?.boundingBox === 'block')
              if (!face) throw new Error('Shelter block has no support')
              await bot.equip(item, 'hand')
              if (!active()) return
              await bot.placeBlock(bot.blockAt(pos.minus(face)), face)
              if (active() && bot.blockAt(pos)?.name !== material) throw new Error('Shelter placement not confirmed by server')
            }
          } finally { service.building = false }
        }, active)
        if (active()) this.leave('Shelter completed; leaving instead of waiting through the night')
        return
      }
      // Craft one prerequisite per turn, with the real registry/recipe checks.
      const logs = bot.inventory.items().find(item => LOG.test(item.name))
      if (logs) {
        const planks = logs.name.replace(/_log$/, '_planks')
        this.describe('crafting', 'Turning gathered wood into planks')
        await this.bounded(bot, () => service.craft(planks, 4), active)
        return
      }
      const plank = ['oak_planks', 'spruce_planks', 'birch_planks'].find(name => count(bot, name) >= 4)
      const table = bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 4.5, useExtraInfo: true })
      const needsTools = !bot.inventory.items().some(item => /_pickaxe$/.test(item.name)) || !bot.inventory.items().some(item => /_sword$/.test(item.name))
      if (plank && needsTools) {
        if (!table && count(bot, 'crafting_table') === 0) {
          this.describe('crafting', 'Making a crafting table for basic tools')
          await this.bounded(bot, () => service.craft('crafting_table', 1), active)
          return
        }
        if (!table) {
          const feet = bot.entity.position.floored()
          const pos = [[2, 0], [-2, 0], [0, 2], [0, -2]].map(([x, z]) => feet.offset(x, 0, z)).find(pos => safeStanding(bot, pos))
          if (!pos) { this.leave('No safe empty spot for a crafting table'); return }
          this.describe('placing-table', 'Placing our table on clear loaded ground')
          // The general Place endpoint excludes interactive blocks. Table
          // placement here is narrow and only consumes our inventory table.
          await this.bounded(bot, async () => {
            if (Object.values(bot.entities || {}).some(entity => entity.type === 'player' && entity.position && distance(pos, entity.position) < 2)) throw new Error('Player too close to table target')
            const item = bot.inventory.items().find(item => item.name === 'crafting_table')
            await bot.equip(item, 'hand')
            if (!active()) return
            await bot.placeBlock(bot.blockAt(pos.offset(0, -1, 0)), new Vec3(0, 1, 0))
            if (active() && bot.blockAt(pos)?.name !== 'crafting_table') throw new Error('Table placement not confirmed')
          }, active)
          return
        }
        const item = count(bot, 'stick') < 2 ? 'stick' : !bot.inventory.items().some(item => /_pickaxe$/.test(item.name)) ? 'wooden_pickaxe' : 'wooden_sword'
        this.describe('crafting', 'Preparing basic tools: ' + item)
        await this.bounded(bot, () => service.craft(item, item === 'stick' ? 4 : 1), active)
        return
      }
      if (needsTools || !material) {
        const log = bot.findBlock({ matching: block => LOG.test(block.name), maxDistance: 4.5, useExtraInfo: true })
        if (!log) { this.leave('No reachable natural tree for the remaining work; leaving instead of idling'); return }
        this.describe('gathering', 'Gathering one reachable leafy log; existing protection checks apply', { target: point(log.position) })
        const before = bot.inventory.items().reduce((n, item) => n + item.count, 0)
        await this.bounded(bot, () => service.gather(point(log.position)), active)
        if (active() && bot.inventory.items().reduce((n, item) => n + item.count, 0) <= before) this.leave('Gathered block but pickup was not confirmed; stopping rather than stripping more trees')
        return
      }
      this.leave('Basic tools and shelter stock ready; no further task, so leaving the game')
    } catch (error) {
      if (active()) this.leave('Survival work blocked; leaving instead of retrying destructive actions', String(error.message || error).slice(0, 180))
    } finally { this.busy = false }
  }
}

module.exports = { SurvivalMode, safeStanding, escapeTarget, shelterPlan, checkShelter }
