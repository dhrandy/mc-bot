// Avoid harmful, unpredictable and uncooked food. No hunting, farming or crafting.
const SAFE_FOODS = new Set([
  'bread', 'baked_potato', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken',
  'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'apple',
  'carrot', 'golden_carrot', 'melon_slice', 'pumpkin_pie', 'cookie',
  'beetroot', 'beetroot_soup', 'mushroom_stew', 'rabbit_stew',
  'dried_kelp', 'sweet_berries', 'glow_berries', 'honey_bottle'
])

function chooseFood (bot) {
  return (bot.inventory?.items() || [])
    .filter(item => SAFE_FOODS.has(item.name) && item.count > 0 && bot.registry.foodsByName?.[item.name])
    .sort((a, b) => {
      const ap = bot.registry.foodsByName[a.name].foodPoints
      const bp = bot.registry.foodsByName[b.name].foodPoints
      return bp - ap || a.slot - b.slot
    })[0] || null
}

module.exports = { SAFE_FOODS, chooseFood }
