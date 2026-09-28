# mc-bot

**EXPERIMENTAL BETA** - a small Minecraft Java bot controlled through an HTTP JSON API. It has unit-tested controls, but water exits, combat and placement still need live verification. Expect rough edges; do not give it valuable inventory or unrestricted access to a production world.

The bot signs into an **online-mode** server using a Microsoft account that owns Minecraft Java Edition. It can report position/status and inventory, read and send chat, follow a visible player, walk near coordinates, look at coordinates, jump, swim upward, eat selected food, stop, defend itself against a narrow set of mobs when enabled, attack a nearby hostile, place one ordinary solid block at explicit coordinates, and disconnect. There is no autonomous AI model in the container: any authorized client can call the API.

## Start with Docker Compose

Use Node 22+ and Docker Compose. Clone this repo, then create `.env` next to `compose.yaml`:

```dotenv
MC_HOST=minecraft.example.net
MC_PORT=25565
MC_VERSION=
MC_ACCOUNT_ID=bot-account-alias
API_PORT=42883
API_TOKEN=replace-with-a-random-secret-at-least-32-characters
AUTO_DEFEND=false
```

| Variable | Purpose |
| --- | --- |
| `MC_HOST` | Reachable Minecraft Java server host |
| `MC_PORT` | Server port, usually 25565 |
| `MC_VERSION` | Server version; blank auto-detects |
| `MC_ACCOUNT_ID` | Stable Microsoft login cache identifier |
| `API_PORT` | Host port for the private control API |
| `API_TOKEN` | Random bearer secret, at least 32 characters |
| `AUTO_DEFEND` | `false` by default; opt in to bounded mob defense after damage and creeper avoidance |

`MC_ACCOUNT_ID` is a stable cache identifier for the account, not its password or in-game name. Use the same identifier after restart so the cached login is reused. `MC_VERSION` may be blank to auto-detect. Generate a fresh, long random API token, for example `openssl rand -hex 32`; never commit the real `.env`. The `bot-auth` volume contains Microsoft authentication tokens; keep it private and back it up or sign in again if it is lost.

Copy-paste Compose block (`compose.yaml` in this repo):

```yaml
services:
  mc-bot:
    build: .
    container_name: mc-bot
    restart: unless-stopped
    environment:
      MC_HOST: ${MC_HOST}
      MC_PORT: ${MC_PORT}
      MC_VERSION: ${MC_VERSION}
      MC_ACCOUNT_ID: ${MC_ACCOUNT_ID}
      API_TOKEN: ${API_TOKEN}
      AUTO_DEFEND: ${AUTO_DEFEND}
      API_PORT: "42883"
      AUTH_CACHE_DIR: /data/auth
    ports:
      - "127.0.0.1:${API_PORT}:42883"
    volumes:
      - bot-auth:/data/auth
volumes:
  bot-auth:
```

Run `docker compose up -d --build` then `docker compose logs -f mc-bot`. On first start, the log prints a Microsoft sign-in URL and one-time device code. Open that URL yourself, enter the code, and sign into the **spare account that owns Java Edition**. Do not give the account password to the bot, an agent, or chat. The code is sensitive while valid, so do not publish your logs. Sign-in tokens are cached in the Docker volume; later restarts should not require another code unless the token expires or is revoked. The account's actual Minecraft profile determines the in-game name. An account without Java ownership will not join an online-mode server.

For Dockhand, use the same Compose contents but change `build: .` to `build: https://github.com/dhrandy/mc-bot.git#main` if deploying from a remote Git URL. Put the variables in Dockhand's Environment tab and mount a private persistent volume to `/data/auth`. If the service runs on another machine and needs remote API access, explicitly change the host port binding from `127.0.0.1` to a LAN address and firewall it to trusted clients. Do not expose this port to the internet. Use a secure private tunnel for remote control, and keep the bearer token secret. The Minecraft server itself can be elsewhere on your LAN; point `MC_HOST` to its reachable address in your private `.env` only.

## API

All routes require `Authorization: Bearer <API_TOKEN>`, including reads. JSON responses have a no-crawl header. Body size is limited to 4 KB; chat is capped at 256 characters and recent chat is kept in memory only (last 100, reads return 50). The API deliberately has no raw server-command endpoint.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/status` | none | connection state, username, position, health, food, inventory slots, navigation progress, nearby hostile IDs, defense action, last error |
| GET | `/api/chat` | none | recent chat |
| POST | `/api/chat` | `{"message":"Hello"}` | send public chat |
| POST | `/api/follow` | `{"player":"PlayerName"}` | follow a nearby visible player |
| POST | `/api/goto` | `{"x":0,"y":64,"z":0}` | start walking near coordinates, return `202` immediately with an action ID; poll status for arrived/failed |
| POST | `/api/look` | `{"x":0,"y":65,"z":0}` | look at coordinates |
| POST | `/api/jump` | `{"durationMs":500}` | jump for 100-30000 ms on land; cancels navigation |
| POST | `/api/swim` | `{"durationMs":3000,"forward":true}` | swim upward for 100-30000 ms, optionally moving forward in the direction the bot faces; cancels navigation |
| POST | `/api/eat` | `{"slot":36}` | eat a selected safe food item from the inventory; no automatic food selection |
| POST | `/api/attack` | `{}` for nearest allowed hostile, or `{"id":17}` from status | one melee hit within 3 blocks; players, neutral mobs, creepers and endermen excluded |
| POST | `/api/place` | `{"x":2,"y":64,"z":1,"material":"stone"}` | place one solid ordinary inventory block at the exact integer coordinate, within reach and adjacent to a solid block |
| POST | `/api/stop` | empty | stop navigation and release movement controls |
| POST | `/api/disconnect` | empty | quit the server and disable automatic reconnect until `/api/reconnect` or container restart |
| POST | `/api/reconnect` | empty | reconnect after an API disconnect |

Example:

```sh
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:42883/api/status
curl -X POST -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"player":"PlayerName"}' http://127.0.0.1:42883/api/follow
```

The port is bound to loopback in the default Compose. To call it from a different device or cloud-based assistant, first set up a private network route. The bot will retry failed connections with backoff up to 60 seconds. API status can show `connecting` or `offline` while it retries. A `goto` may fail after its `202` response if it cannot pathfind to the destination. Poll `GET /api/status` for `navigation.state` (`moving`, `arrived`, `failed`, or `following`) and the action ID. A newer navigation command or stop cancels the earlier goal. A failed connection records the reason in logs and `lastError` before retrying; an intentional disconnect does not retry. Pathfinder gives water a higher cost, disables sprinting, digging, building, towers, and unlimited drops into water. It may still choose water when there is no land path. Jump and swim are distinct calls: in Mineflayer the swim-up input uses the same jump control state, with optional forward movement. Face shore with `/api/look`, then swim forward if needed. Both controls are time-limited; `/api/stop` releases them early. They are not a guaranteed fix for every waterline or Minecraft physics bug. `/api/stop` stops a following goal but cannot instantly undo a chat or movement already sent.

### Mob defense (opt in)

Set `AUTO_DEFEND=true` in `.env` (or Dockhand's Environment tab) and restart the container to enable it. Off by default. When health drops, the bot checks nearby listed mobs for eight seconds; it cannot identify which mob hit it, so it may respond to another nearby mob. A creeper within nine blocks triggers retreat even before damage. `/api/stop` cancels the current movement and disarms retaliation until new damage, but creeper avoidance can resume while auto-defense remains enabled. For control without autonomous behavior, leave the setting off and use `/api/attack` for a single hit. Neither mode attacks players or endermen. No pursuit or continuous combat; melee only when a listed mob is within 2.8 blocks. There is no claim of a safe win in every fight. The bot does not equip a weapon automatically, use a shield or bow, heal or eat automatically. Don't test with valuable inventory.

| Mob | Behavior | Reason and limit |
| --- | --- | --- |
| Creeper | Retreat toward a point about nine blocks away; never melee through the API | Fuse can explode in about 1.5 seconds after approaching within three blocks; pathfinding might fail, especially in a tight space. |
| Skeleton, stray, bogged | Retreat rather than trade ranged fire | Without shield, bow or line-of-sight planning the bot cannot close safely. |
| Zombie, husk, zombie villager | One close-range hit with a cooldown while armed after damage | Basic melee only. |
| Spider, cave spider | One close-range hit with a cooldown while armed after damage | Fast or climbing movement needs live testing; cave spider poison is a risk. |
| Drowned | Retreat rather than fight in water | Can use melee or a trident; water exits are not reliable. |
| Enderman, players, and all other entities | No automatic or manual attack | Endermen are neutral until provoked; unknown mob behavior is not guessed. |

Defense may interrupt following/navigation to flee. Check `GET /api/status` for `defense` and `nearbyHostiles`. Entity IDs are temporary and change when mobs despawn or the bot reconnects. `/api/attack` never changes the automatic-defense setting.

### Building

`/api/place` changes the world on a successful server confirmation. It requires a material by exact Minecraft item name and integer block coordinates, and places only one block per request. It refuses an occupied or unloaded target, targets outside 4.5 blocks, positions overlapping the bot or a nearby player, absent inventory material, and blocks without reachable solid adjacent support. Only ordinary full blocks are allowed; no TNT, liquids, containers, redstone controls or gravity blocks. It never digs, scaffolds, crafts or walks to the requested location. The server's claim/protection plugins may still deny placement; a failed response may need a visual world check before retrying. Build a line or wall as separate calls after checking each result. Test a single disposable block first.

### Paste-ready AI connection prompt

> Connect to my Minecraft bot at `https://YOUR-PRIVATE-ENDPOINT` with bearer token `YOUR-SECRET-TOKEN` provided through a secure secret store, not in chat. Call `GET /api/status` first. Use the documented JSON routes for movement and chat. Ask me before sending chat, attacking a mob, or placing blocks. Check nearby entities and inventory first. Do not reveal the endpoint or token, and stop on authentication or connection errors.

## Development

`npm ci && npm test` runs tests without joining a server. These tests cover API auth, validation, movement, mob-selection and block-placement behavior without a server; live water-exit, combat and placement tests remain necessary. To run without Docker, set the variables above in your own environment and run `npm start` with `AUTH_CACHE_DIR` pointing to a private directory. License: MIT. No account or server address belongs in this repository.

### Known issues

This remains an experimental build. Earlier live play showed the bot getting trapped at a waterline; the new swim control has not yet been tested on that server. At the time of the initial build, `npm audit` reports six moderate advisories in transitive Mineflayer/Microsoft-auth dependencies and no high or critical advisories. Monitor upstream updates and avoid public API exposure.

### Deferred controls

There is no general mob AI, mining, container access or multi-block building. Advanced combat needs equipment, line-of-sight and live fight testing; digging can alter the world. Automatic eating also waits for a clear policy on which food to use; `/api/eat` selects a slot explicitly. No free sprint toggle is exposed because disabling sprinting avoids a known pathfinder waterline problem. No general-purpose keypress endpoint is exposed; jump and swim are bounded instead.
