# mc-bot

**EXPERIMENTAL BETA** - a small Minecraft Java bot controlled through an HTTP JSON API. It has unit-tested controls, but water exits, mob defense, food handling and placement still need live verification. Expect rough edges; do not give it valuable inventory or unrestricted access to a production world.

The bot signs into an **online-mode** server using a Microsoft account that owns Minecraft Java Edition. It can report position/status and inventory, read and send chat, follow a visible player, walk near coordinates, look at coordinates, jump, swim upward, eat selected food, stop, avoid or defend against known mobs when enabled, attack a nearby low-risk hostile, eat selected inventory food when enabled, place one ordinary solid block at explicit coordinates, and disconnect. There is no autonomous AI model in the container: any authorized client can call the API.

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
AUTO_EAT=false
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
| `AUTO_EAT` | `false` by default; opt in to safe food selection from inventory when food is 14 or below |

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
      AUTO_EAT: ${AUTO_EAT}
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
| GET | `/api/status` | none | connection state, username, position, health, food, inventory slots, navigation progress, nearby threat IDs, defense action, auto-eat state/error, last error |
| GET | `/api/chat` | none | recent chat |
| POST | `/api/chat` | `{"message":"Hello"}` | send public chat |
| POST | `/api/follow` | `{"player":"PlayerName"}` | follow a nearby visible player |
| POST | `/api/goto` | `{"x":0,"y":64,"z":0}` | start walking near coordinates, return `202` immediately with an action ID; poll status for arrived/failed |
| POST | `/api/look` | `{"x":0,"y":65,"z":0}` | look at coordinates |
| POST | `/api/jump` | `{"durationMs":500}` | jump for 100-30000 ms on land; cancels navigation |
| POST | `/api/swim` | `{"durationMs":3000,"forward":true}` | swim upward for 100-30000 ms, optionally moving forward in the direction the bot faces; cancels navigation |
| POST | `/api/eat` | `{"slot":36}` | eat a selected safe food item from inventory; auto-eat is opt-in |
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

Set `AUTO_DEFEND=true` in `.env` (or Dockhand's Environment tab) and restart the container. It is off by default. After health drops, the bot chooses one nearby known threat for eight seconds. Mineflayer reports that the bot took damage, but not a reliable attacker identity, so it may respond to the wrong nearby mob. Creepers are watched within nine blocks even without damage. Dangerous mobs and neutral mobs that punish provocation are prioritized for escape; the bot will not deliberately look at or hit an enderman. Pathfinder can still turn its head in an unsafe direction while escaping, so this is not a guarantee against provoking one. `/api/stop` cancels current movement and disarms retaliation until new damage, though creeper avoidance resumes while enabled. The API's manual `/api/attack` still allows only one hit at a time against a small set of close melee mobs; no player, creeper, enderman or passive mob can be manually targeted. The bot has no ranged weapon, shield, armor logic or complex fight planner. Do not test with valuable inventory.

The table covers known Java Edition threats through 1.21.11, and 26.2 adds a passive sulfur cube (not attacked). The current installed Minecraft data does not expose a 26.2 registry, so newly added or modded mobs are left untouched until their behavior and entity IDs can be verified. "Retreat" means try to path away when within eight blocks after damage, not a guaranteed escape. "Avoid" means retreat and never attack. A creeper at the outer edge of melee reach (2.6-3 blocks) can get one hit only when a sword or axe is already held followed immediately by a retreat command, at most once every three seconds. At closer range it only retreats. No chase. This may still explode if the retreat path fails or the fuse has started. Mobs not listed are left untouched. Some mobs are neutral until provoked; their names still appear in this safety table.

| Mob | Threat and response |
| --- | --- |
| Creeper | Explodes after closing in: one hit only at outer melee reach then retreat, otherwise just retreat. |
| Zombie, husk, zombie villager | Basic close melee: single hit with cooldown after damage. |
| Spider, cave spider | Fast, jump/climb; cave spider poisons: single close hit with cooldown after damage, not a pursuit. |
| Silverfish, endermite, slime | Small or swarming melee: single close hit with cooldown, no pursuit. |
| Skeleton, stray, bogged, parched | Arrows or status-effect arrows: retreat rather than trade shots without shield/bow. |
| Drowned, zombie nautilus | Underwater melee or trident/rider: retreat; water exits remain unreliable. |
| Pillager | Crossbow: retreat rather than trade shots. |
| Witch | Potions and healing: retreat; no potion counterplay. |
| Blaze, ghast | Fireballs or flight: retreat; no ranged counterattack. |
| Guardian, elder guardian | Beam/mining fatigue underwater: retreat; no underwater combat. |
| Shulker | Homing levitation projectiles: retreat; no projectile counterplay. |
| Breeze | Wind charges and displacement: retreat; no chase. |
| Evoker | Fangs and summoned vexes: retreat. |
| Magma cube, phantom | Fire contact or airborne swoop: retreat instead of blind melee. |
| Wither skeleton | Wither effect and high melee damage: retreat. |
| Hoglin, zoglin, piglin brute | Knockback or heavy melee: retreat. |
| Vindicator, vex, ravager | Axe, fast flight through walls, or charge: retreat. |
| Camel husk | Hostile rider risk in desert: retreat, never attack mount. |
| Enderman | Neutral until looked at/attacked; retreat, never deliberately look at face or attack. |
| Piglin, zombified piglin | Neutral until provoked or gold conditions change; retreat, never attack. |
| Creaking | Body is invulnerable while linked to its heart; retreat, no attack or heart removal. |
| Warden | Sonic boom, strong melee, tracks vibration/smell: retreat, never engage. Movement itself may draw it. |
| Wither, ender dragon | Bosses: retreat, never engage. |
| Giant, illusioner | Unused/command-spawned mobs: retreat, never engage. |
| Players, passive animals (including sulfur cube), and unknown mobs | No attack or automatic handling. |

Check `GET /api/status` for `defense` and `nearbyHostiles`. IDs change when mobs despawn or the bot reconnects. These are cautious first-pass tactics, not validated survival strategies against every mob or on every server version. Reference: [Minecraft Wiki combat guide](https://minecraft.wiki/w/Tutorial:Combat), [creeper](https://minecraft.wiki/w/Creeper), [warden](https://minecraft.wiki/w/Warden), [Mounts of Mayhem](https://minecraft.wiki/w/Java_Edition_guides/Mounts_of_Mayhem), [Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md).

### Food (opt in)

Set `AUTO_EAT=true` and restart to let the bot eat from its own inventory when food is 14 or lower. Off by default. It picks the safe food with the most food points, checks again every ten seconds and on health/food updates, and will not eat when full. It keeps one eating action at a time and tries to restore the held item afterward. `GET /api/status` shows `autoEat`, `eating` and `lastEatError`; no food available is reported there. The `/api/eat` endpoint remains for a chosen slot. Safe choices include bread, cooked meat/fish, baked potato, carrot, fruit/berries, soups and honey. It excludes raw meat, rotten flesh, poisonous potato, pufferfish, spider eye, suspicious stew, chorus fruit, golden apples and unknown foods. This is an explicit allowlist, not an inference that every registry food is safe. Auto-eat does not hunt, harvest, craft or refill inventory; killing passive animals or altering farms needs a separate owner choice. Eating may briefly replace a weapon in hand during a fight. Reference: [Mineflayer consume/equip API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md), [food mechanics](https://minecraft.wiki/w/Food), [auto-eat plugin's food exclusions](https://github.com/linkle69/mineflayer-auto-eat). We use a small built-in policy rather than the plugin so the allowed foods and threshold are explicit.

### Building

`/api/place` changes the world on a successful server confirmation. It requires a material by exact Minecraft item name and integer block coordinates, and places only one block per request. It refuses an occupied or unloaded target, targets outside 4.5 blocks, positions overlapping the bot or a nearby player, absent inventory material, and blocks without reachable solid adjacent support. Only ordinary full blocks are allowed; no TNT, liquids, containers, redstone controls or gravity blocks. It never digs, scaffolds, crafts or walks to the requested location. The server's claim/protection plugins may still deny placement; a failed response may need a visual world check before retrying. Build a line or wall as separate calls after checking each result. Test a single disposable block first.

### Paste-ready AI connection prompt

> Connect to my Minecraft bot at `https://YOUR-PRIVATE-ENDPOINT` with bearer token `YOUR-SECRET-TOKEN` provided through a secure secret store, not in chat. Call `GET /api/status` first. Use the documented JSON routes for movement and chat. Ask me before sending chat, attacking a mob, placing blocks, or enabling autonomous defense/food. Check nearby entities and inventory first. Do not reveal the endpoint or token, and stop on authentication or connection errors.

## Development

`npm ci && npm test` runs tests without joining a server. These tests cover API auth, validation, movement, mob-selection, safe-food choice and block-placement behavior without a server; live water-exit, combat, eating and placement tests remain necessary. To run without Docker, set the variables above in your own environment and run `npm start` with `AUTH_CACHE_DIR` pointing to a private directory. License: MIT. No account or server address belongs in this repository.

### Known issues

This remains an experimental build. Earlier live play showed the bot getting trapped at a waterline; the new swim control has not yet been tested on that server. At the time of the initial build, `npm audit` reports six moderate advisories in transitive Mineflayer/Microsoft-auth dependencies and no high or critical advisories. Monitor upstream updates and avoid public API exposure.

### Deferred controls

There is no general mob AI, mining, container access or multi-block building. Advanced combat needs equipment, line-of-sight and live fight testing; digging can alter the world. Auto-eating only uses food already in inventory; hunting passive mobs, farming and crafting are not implemented. No free sprint toggle is exposed because disabling sprinting avoids a known pathfinder waterline problem. No general-purpose keypress endpoint is exposed; jump and swim are bounded instead.
