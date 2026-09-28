const { BotService } = require('./service')
const { server } = require('./http')

const mcHost = process.env.MC_HOST
const mcAccountId = process.env.MC_ACCOUNT_ID
const apiToken = process.env.API_TOKEN
const mcPort = Number(process.env.MC_PORT || 25565)
const apiPort = Number(process.env.API_PORT || 42883)
if (!mcHost || !mcAccountId || !apiToken || apiToken.length < 32 || !Number.isInteger(mcPort) || mcPort < 1 || mcPort > 65535 || !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
  console.error('Set MC_HOST, MC_ACCOUNT_ID, and a random API_TOKEN of at least 32 characters; ports must be valid')
  process.exit(1)
}
if (!['true', 'false', undefined].includes(process.env.AUTO_DEFEND)) { console.error('AUTO_DEFEND must be true or false'); process.exit(1) }
const bot = new BotService({ mcHost, mcPort, mcAccountId, mcVersion: process.env.MC_VERSION || undefined, cacheDir: process.env.AUTH_CACHE_DIR || '/data/auth', autoDefend: process.env.AUTO_DEFEND === 'true' })
const httpServer = server(bot, apiToken)
httpServer.listen(apiPort, process.env.API_BIND || '0.0.0.0', () => {
  console.log(`Control API listening on port ${apiPort}`)
  bot.connect()
})
function shutdown () {
  bot.shutdown()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
