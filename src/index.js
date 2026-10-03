const { BotService } = require('./service')
const { server } = require('./http')
const { CraftyClient } = require('./crafty')

const mcHost = process.env.MC_HOST
const mcAccountId = process.env.MC_ACCOUNT_ID
const apiToken = process.env.API_TOKEN
const mcPort = Number(process.env.MC_PORT || 25565)
const apiPort = Number(process.env.API_PORT || 42883)
if (!mcHost || !mcAccountId || !apiToken || apiToken.length < 32 || !Number.isInteger(mcPort) || mcPort < 1 || mcPort > 65535 || !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  console.error('Set MC_HOST, MC_ACCOUNT_ID, and a random API_TOKEN of at least 32 characters; ports must be valid')
  process.exit(1)
}
const flags = ['AUTO_DEFEND', 'AUTO_EAT', 'AUTO_JOIN', 'AUTO_FLEE']
for (const flag of flags) {
  if (!['true', 'false', '', undefined].includes(process.env[flag])) {
    console.error(`${flag} must be true or false`)
    process.exit(1)
  }
}
const craftyValues = ['CRAFTY_API_TOKEN', 'CRAFTY_API_BASE_URL', 'CRAFTY_SERVER_ID'].map(key => process.env[key] || '')
const craftyConfigured = craftyValues.some(Boolean)
if (craftyConfigured && craftyValues.some(value => !value)) {
  console.error('Set all of CRAFTY_API_TOKEN, CRAFTY_API_BASE_URL, and CRAFTY_SERVER_ID to enable Crafty controls')
  process.exit(1)
}
const crafty = craftyConfigured ? new CraftyClient({ baseUrl: process.env.CRAFTY_API_BASE_URL, serverId: process.env.CRAFTY_SERVER_ID, token: process.env.CRAFTY_API_TOKEN }) : null
const bot = new BotService({ mcHost, mcPort, mcAccountId, mcVersion: process.env.MC_VERSION || undefined, cacheDir: process.env.AUTH_CACHE_DIR || '/data/auth', autoDefend: process.env.AUTO_DEFEND === 'true', autoEat: process.env.AUTO_EAT === 'true', autoFlee: process.env.AUTO_FLEE === 'true' })
const httpServer = server(bot, apiToken, crafty)
httpServer.listen(apiPort, process.env.API_BIND || '0.0.0.0', () => {
  console.log(`Control API listening on port ${apiPort}`)
  if (process.env.AUTO_JOIN === 'true') {
    bot.connect()
  } else {
    bot.stayOffline()
    console.log('AUTO_JOIN is off; the bot stays offline until Join on the panel or POST /api/join')
  }
})
function shutdown () {
  bot.shutdown()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
