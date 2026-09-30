const Vec3 = require('vec3')

const air = block => block && ['air', 'cave_air', 'void_air'].includes(block.name)
const leaf = block => block?.name.endsWith('_leaves')
const hazard = /(?:water|lava|fire|magma|cactus|powder_snow|sand|gravel|concrete_powder|campfire|sweet_berry_bush|wither_rose)/

function supports (bot) {
  const p = bot.entity.position
  const y = Math.floor(p.y + 0.01) - 1
  const result = []
  // Check the whole player footprint, not just its center. A neighboring leaf
  // can otherwise keep the player suspended after the center leaf is broken.
  for (let x = Math.floor(p.x - 0.299); x <= Math.floor(p.x + 0.299); x++) {
    for (let z = Math.floor(p.z - 0.299); z <= Math.floor(p.z + 0.299); z++) {
      result.push(bot.blockAt(new Vec3(x, y, z)))
    }
  }
  return result
}

function safeLeafStep (bot, blocks) {
  if (!bot.entity.onGround || !blocks.length || blocks.some(block => !leaf(block))) return false
  for (const block of blocks) {
    if (!bot.canDigBlock(block)) return false
    if (Object.values(bot.entities || {}).some(entity => entity.type === 'player' && entity.position?.distanceTo(block.position) < 2)) return false
    for (const offset of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
      const neighbor = bot.blockAt(block.position.plus(offset))
      if (!neighbor || hazard.test(neighbor.name)) return false
    }
    let landing = false
    // Surface-to-surface drop, not distance to the landing block's bottom.
    for (let depth = 1; depth <= 3; depth++) {
      const below = bot.blockAt(block.position.offset(0, -depth, 0))
      if (!below || hazard.test(below.name)) return false
      for (const offset of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const side = bot.blockAt(below.position.plus(offset))
        if (!side || /(?:water|lava)/.test(side.name)) return false
      }
      if (below.boundingBox === 'block') { landing = true; break }
      if (!air(below)) return false
    }
    if (!landing) return false
  }
  return true
}

function waitForTicks (bot, active, condition, limit, message) {
  return new Promise((resolve, reject) => {
    let ticks = 0
    const timer = setTimeout(() => done(new Error(message)), 6000)
    const onTick = () => {
      if (!active()) return done(new Error('Navigation cancelled'))
      if (condition()) return done()
      if (++ticks >= limit) done(new Error(message))
    }
    function done (error) {
      clearTimeout(timer)
      bot.removeListener('physicsTick', onTick)
      error ? reject(error) : resolve()
    }
    bot.on('physicsTick', onTick)
  })
}

async function digLeaf (bot, block, active) {
  let timer
  let deadline
  try {
    await Promise.race([
      bot.dig(block, true),
      new Promise((resolve, reject) => {
        timer = setInterval(() => {
          if (!active()) reject(new Error('Navigation cancelled'))
        }, 50)
        deadline = setTimeout(() => reject(new Error('Leaf dig timed out; check spawn or region protection')), 5000)
      })
    ])
  } catch (error) {
    if (active()) bot.stopDigging?.()
    throw error
  } finally {
    clearTimeout(deadline)
    clearInterval(timer)
  }
}

async function escapeCanopy (bot, target, active, report) {
  for (let step = 0; step < 8; step++) {
    if (!active()) throw new Error('Navigation cancelled')
    if (bot.entity.position.y <= target.y + 1) return
    const blocks = supports(bot)
    if (blocks.every(leaf) && !bot.entity.onGround) {
      await waitForTicks(bot, active, () => bot.entity.onGround, 40, 'Bot did not settle on the canopy')
    }
    if (!safeLeafStep(bot, blocks)) return
    const startY = bot.entity.position.y
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    await bot.unequip('hand')
    for (const block of blocks) {
      if (!active()) throw new Error('Navigation cancelled')
      report({ phase: 'clearing-leaves', block: { x: block.position.x, y: block.position.y, z: block.position.z } })
      await digLeaf(bot, block, active)
      if (!active()) throw new Error('Navigation cancelled')
      if (!air(bot.blockAt(block.position))) throw new Error('Leaf dig was not confirmed by the server; check spawn or region protection')
    }
    report({ phase: 'landing' })
    await waitForTicks(bot, active, () => bot.entity.onGround && bot.entity.position.y < startY - 0.5, 100,
      'Leaf escape did not land; stopped before another dig')
    report({ phase: 'landed', position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } })
  }
  throw new Error('Canopy escape reached its eight-step limit')
}

module.exports = { escapeCanopy, safeLeafStep, supports }
