# mc-bot

**EXPERIMENTAL BETA** - a small Minecraft Java bot controlled through a built-in web control panel and an HTTP JSON API. It has unit-tested controls, but water exits, mob defense, food handling, crafting, farming, sleep and building still need live verification. Expect rough edges; do not give it valuable inventory or unrestricted access to a production world.

The bot signs into an **online-mode** server using a Microsoft account that owns Minecraft Java Edition. It can report position/status and inventory, read and send chat, follow a visible player, walk to a waypoint block, look at coordinates, jump, swim upward, eat selected food, stop, avoid or defend against known mobs when enabled, attack a nearby low-risk hostile, eat selected inventory food when enabled, place one ordinary solid block at explicit coordinates, craft from inventory, place and sleep in a bed, tend wheat, gather one requested diggable block with harvest-tool checks, build a small shelter, and disconnect. There is no autonomous AI model in the container: any authorized client can call the API.

## Start with Docker Compose

Use Node 22+ and Docker Compose. Clone this repo, then create `.env` next to `compose.yaml`:

```dotenv
MC_HOST=minecraft.example.net
MC_PORT=25565
MC_VERSION=
MC_ACCOUNT_ID=bot-account-alias
API_PORT=42883
API_TOKEN=replace-with-a-random-secret-at-least-32-characters
CRAFTY_API_BASE_URL=
CRAFTY_SERVER_ID=
CRAFTY_API_TOKEN=
AUTO_DEFEND=false
AUTO_EAT=false
AUTO_JOIN=false
AUTO_FLEE=false
```

| Variable | Purpose |
| --- | --- |
| `MC_HOST` | Reachable Minecraft Java server host |
| `MC_PORT` | Server port, usually 25565 |
| `MC_VERSION` | Server version; blank auto-detects |
| `MC_ACCOUNT_ID` | Stable Microsoft login cache identifier |
| `API_PORT` | Host port for the private control API |
| `API_TOKEN` | Random bearer secret, at least 32 characters |
| `CRAFTY_API_BASE_URL` | Optional Crafty Controller URL (HTTPS required except localhost) |
| `CRAFTY_SERVER_ID` | Optional server ID in Crafty |
| `CRAFTY_API_TOKEN` | Optional Crafty bearer token; keep it only in the server environment, never in this repo or logs |
| `AUTO_DEFEND` | `false` by default; opt in to bounded mob defense after damage and creeper avoidance |
| `AUTO_EAT` | `false` by default; opt in to safe food selection from inventory when food is 14 or below |
| `AUTO_JOIN` | `false` by default; the bot stays offline until Join on the panel or `POST /api/join`. Set `true` to join when the container starts |
| `AUTO_FLEE` | `false` by default; run from creepers on sight. Can also be toggled on the panel and through `POST /api/auto-flee` |

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
      CRAFTY_API_BASE_URL: ${CRAFTY_API_BASE_URL}
      CRAFTY_SERVER_ID: ${CRAFTY_SERVER_ID}
      CRAFTY_API_TOKEN: ${CRAFTY_API_TOKEN}
      AUTO_DEFEND: ${AUTO_DEFEND}
      AUTO_EAT: ${AUTO_EAT}
      AUTO_JOIN: ${AUTO_JOIN}
      AUTO_FLEE: ${AUTO_FLEE}
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

## Control panel

The same HTTP server hosts a small web control panel at `/` (the sign-in form lives at `/login`). Sign in with the `API_TOKEN` value as the access code; the panel never shows or stores it in the page, and a signed session cookie (HttpOnly, SameSite=Strict, 12 hours) keeps you signed in. Sessions live in memory, so a container restart signs everyone out. After five failed sign-ins from one TCP peer address it locks that address out for ten minutes (the panel ignores untrusted forwarded client-IP headers; behind a reverse proxy, users may share the proxy address for this limit), and every form post checks a per-session CSRF token. All panel routes send no-crawl headers and a robots meta tag.

The panel shows state, player name, health, food, position, nearby hostiles, auto-flee state, live navigation state and the last error, with buttons for Join, Jump, Stop and Quit (Jump holds the jump input for 500 ms and stops current navigation), an auto-flee toggle, and plain HTML forms for chat, follow, go to, gather, place a block and build a shelter. When all Crafty variables are set, the authenticated panel also shows Crafty server status, recent logs, start/stop/restart controls and a console command box. Crafty actions and commands use the same session cookie and CSRF checks as other panel forms; the Crafty bearer token stays server-side. The Chat accordion shows the last 50 incoming Minecraft messages, including timestamps. It uses a session-protected `/panel/chat.json` read route, not a bearer token in the browser. Messages are rendered as plain text, retained only in memory (last 100), and lost on restart. Go To now targets the block containing the supplied coordinates rather than a one-block radius, so fractional coordinates select a block, not an exact point inside it. The Navigation row shows moving, arrived or failed status; a submitted waypoint is an acknowledgement, not a claim that walking has finished. Everything works with scripts disabled; when scripts are allowed, status and incoming chat refresh about every five seconds, without overlapping requests. If chat refresh fails, the panel keeps the last messages and shows a warning. The layout is built for a phone screen first and stays centered and readable on desktop.

**Upgrading from 0.6.x:** the bot no longer joins the server when the container starts. Set `AUTO_JOIN=true` (or press Join on the panel after each start) to keep the old behavior. This also means a container restart while you are away no longer drops the bot into the world unattended.

## API

All API routes require `Authorization: Bearer <API_TOKEN>`, including reads. The control panel uses its own sign-in instead. JSON responses have a no-crawl header. Body size is limited to 4 KB; chat is capped at 256 characters and recent chat is kept in memory only (last 100, reads return 50). Crafty Controller actions are optional and separately scoped to the configured Crafty server. When enabled, the API can also send raw server-console commands; treat these routes as highly privileged.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/status` | none | connection state, username, position, health, food, inventory slots, navigation progress, nearby threat IDs, defense action, auto-eat state/error, last error |
| GET | `/api/crafty/status` | none | normalized status for the configured Crafty server (optional; requires Crafty variables below) |
| GET | `/api/crafty/logs?limit=100` | none | most recent stdout lines; limit 1-200 (optional) |
| POST | `/api/crafty/action/start` | empty | start the configured Crafty server |
| POST | `/api/crafty/action/stop` | empty | stop the configured Crafty server |
| POST | `/api/crafty/action/restart` | empty | restart the configured Crafty server |
| POST | `/api/crafty/command` | `{"command":"list"}` | send one line to the configured server console (max 512 characters; one line; no leading slash, even after leading whitespace) |
| GET | `/api/chat` | none | recent chat |
| POST | `/api/chat` | `{"message":"Hello"}` | send public chat |
| POST | `/api/follow` | `{"player":"PlayerName"}` | follow a nearby visible player |
| POST | `/api/goto` | `{"x":0,"y":64,"z":0}` | start walking to the containing waypoint block, return `202` immediately with an action ID; poll status for arrived/failed |
| POST | `/api/look` | `{"x":0,"y":65,"z":0}` | look at coordinates |
| POST | `/api/jump` | `{"durationMs":500}` | jump for 100-30000 ms on land; cancels navigation |
| POST | `/api/swim` | `{"durationMs":3000,"forward":true}` | swim upward for 100-30000 ms, optionally moving forward in the direction the bot faces; cancels navigation |
| POST | `/api/eat` | `{"slot":36}` | eat a selected safe food item from inventory; auto-eat is opt-in |
| POST | `/api/attack` | `{}` for nearest allowed hostile, or `{"id":17}` from status | one melee hit within 3 blocks; players, neutral mobs, creepers and endermen excluded |
| POST | `/api/place` | `{"x":2,"y":64,"z":1,"material":"stone"}` | place one solid ordinary inventory block at the exact integer coordinate, within reach and adjacent to a solid block |
| POST | `/api/craft` | `{"item":"oak_planks","count":4}` | craft at least count items (1-16); if recipe output is a bundle, reports actual output; use nearby crafting table for 3x3 |
| POST | `/api/place-bed` | `{"x":2,"y":64,"z":0}` | place a bed from inventory, requiring all adjacent head positions clear because facing may vary |
| POST | `/api/sleep` | `{}` | sleep in a nearby placed bed during night or thunderstorm; Minecraft sets spawn if valid |
| POST | `/api/wake` | `{}` | get out of bed |
| POST | `/api/till` | `{"x":2,"y":63,"z":0}` | use an inventory hoe on dirt or grass block, near water |
| POST | `/api/plant` | `{"x":2,"y":63,"z":0}` | plant inventory wheat seeds on empty farmland (coordinates target soil) |
| POST | `/api/harvest` | `{"x":2,"y":64,"z":0,"replant":false}` | break only wheat at age 7; optional replant uses seeds already in inventory |
| POST | `/api/gather` | `{"x":2,"y":64,"z":0}` | dig one requested nearby block; hand-dig soft blocks, equip the correct harvest tool for stone/ores, try walking to a visible drop |
| POST | `/api/shelter` | `{"x":0,"y":64,"z":0,"material":"oak_planks"}` | preflight and build a 5x5, 55-block box with 3x3 interior and 1x2 doorway; x/y/z are interior center at floor height |
| POST | `/api/join` | empty | join the server when offline; `409` while connected or connecting |
| POST | `/api/quit` | empty | leave the server and stay offline until `/api/join`; same as `/api/disconnect` |
| POST | `/api/auto-flee` | `{"enabled":true}` | toggle running from creepers on sight, independent of auto-defend |
| POST | `/api/stop` | empty | stop navigation and release movement controls |
| POST | `/api/disconnect` | empty | alias of `/api/quit`, kept for older clients |
| POST | `/api/reconnect` | empty | alias of `/api/join`, kept for older clients |

Example:

```sh
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:42883/api/status
curl -X POST -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"player":"PlayerName"}' http://127.0.0.1:42883/api/follow
```

### Optional Crafty Controller integration

Set all three Crafty variables to enable server status, recent logs, start/stop/restart, and console-command routes. Leave all three blank to disable them. Use a dedicated Crafty token with only the command and log/status permissions these operations require. Leading/trailing whitespace and one matching pair of surrounding quotes are trimmed from Crafty environment values at startup, so a copied value with accidental outer quotes or spaces does not corrupt a request. `CRAFTY_API_TOKEN` is sent only as an HTTPS bearer header from mc-bot to Crafty. It is never written into repository files, application logs, or API responses. It is also redacted from Crafty response text before anything can reach panel logs or status output. Failed Crafty HTTP responses log only the status and a short control-character-stripped response excerpt, with the bearer token redacted. The authenticated web panel exposes these controls when Crafty is configured; its requests run through mc-bot server-side and never expose the Crafty token to the browser. Every route still requires mc-bot's existing `API_TOKEN`; use that token only on a trusted private network.

The console-command route is powerful: a command can change or delete Minecraft world data. Send commands only when you intend a Crafty console action. The configured server ID and base URL are deployment settings, not compiled defaults.

Paste-ready Compose variables (replace the examples and keep real secrets in the deployment environment):

```yaml
CRAFTY_API_BASE_URL: ${CRAFTY_API_BASE_URL}
CRAFTY_SERVER_ID: ${CRAFTY_SERVER_ID}
CRAFTY_API_TOKEN: ${CRAFTY_API_TOKEN}
```

The matching `.env` entries use the same names. For Dockhand, fill them in its Environment tab. Do not put actual Crafty hostnames, server IDs, or tokens in a public commit. Endpoints follow the [Crafty Controller API v2](https://docs.craftycontrol.com/pages/developer-guide/api-reference/v2/) reference.

The port is bound to loopback in the default Compose. To call it from a different device or cloud-based assistant, first set up a private network route. The bot will retry failed connections with backoff up to 60 seconds. API status can show `connecting` or `offline` while it retries. A `goto` may fail after its `202` response if it cannot pathfind to the destination. Poll `GET /api/status` for `navigation.state` (`moving`, `arrived`, `failed`, or `following`) and the action ID. A newer navigation command or stop cancels the earlier goal. Since 0.7.2, Go To a lower target first checks for supporting leaves across the player's footprint. It punches them bare-handed only when every support is a leaf, the loaded landing is within a three-block drop, and visible liquids, hazards and nearby players are absent. It waits for each landing before another dig (at most eight steps), then resumes pathfinding. This does not bypass spawn or region protection. Refused/unconfirmed digs and a 15-second movement stall fail visibly instead of reporting endless walking. `navigation.phase`, `pathStatus`, `pathLength`, `resetReason` and `onGround` provide diagnostics; container logs record the leaf and landing steps. No teleport, operator permission or creative mode is used. A failed connection records the reason in logs and `lastError` before retrying; an intentional disconnect does not retry. Pathfinder gives water a higher cost, disables sprinting, building, towers, and unlimited drops into water. It can dig through leaves, grass and common natural terrain in its way, with drops limited to three blocks. Containers, logs, planks, controls and other non-terrain blocks are excluded from path digging; liquid-flow and falling-block checks stay enabled. Digging changes the world, and natural terrain can also be part of a player build, so choose routes away from valuable structures. It may still choose water when there is no land path. Jump and swim are distinct calls: in Mineflayer the swim-up input uses the same jump control state, with optional forward movement. Face shore with `/api/look`, then swim forward if needed. Both controls are time-limited; `/api/stop` releases them early. They are not a guaranteed fix for every waterline or Minecraft physics bug. `/api/stop` stops a following goal but cannot instantly undo a chat or movement already sent.

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

### Auto-flee (opt in)

Set `AUTO_FLEE=true`, press the panel toggle, or `POST /api/auto-flee` with `{"enabled":true}` to make the bot run from any creeper that comes within nine blocks, whether or not it has taken damage. It never swings at the creeper; escape is the whole plan. The check runs every 0.7 seconds, pauses while the bot is building, and re-issues the escape path at most every 1.4 seconds while the creeper stays close. Enabling it cancels current navigation when a creeper shows up. `GET /api/status` reports `autoFlee` and the last `fleeing` action. This is separate from `AUTO_DEFEND`, which answers damage with bounded retaliation. The toggle set through the panel or API lasts until the container restarts, when the `.env` value applies again.

### Food (opt in)

Set `AUTO_EAT=true` and restart to let the bot eat from its own inventory when food is 14 or lower. Off by default. It picks the safe food with the most food points, checks again every ten seconds and on health/food updates, and will not eat when full. It keeps one eating action at a time and tries to restore the held item afterward. `GET /api/status` shows `autoEat`, `eating` and `lastEatError`; no food available is reported there. The `/api/eat` endpoint remains for a chosen slot. Safe choices include bread, cooked meat/fish, baked potato, carrot, fruit/berries, soups and honey. It excludes raw meat, rotten flesh, poisonous potato, pufferfish, spider eye, suspicious stew, chorus fruit, golden apples and unknown foods. This is an explicit allowlist, not an inference that every registry food is safe. Auto-eat does not hunt, harvest, craft or refill inventory; killing passive animals or altering farms needs a separate owner choice. Eating may briefly replace a weapon in hand during a fight. Reference: [Mineflayer consume/equip API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md), [food mechanics](https://minecraft.wiki/w/Food), [auto-eat plugin's food exclusions](https://github.com/linkle69/mineflayer-auto-eat). We use a small built-in policy rather than the plugin so the allowed foods and threshold are explicit.

### Building

`/api/place` changes the world on a successful server confirmation. It requires a material by exact Minecraft item name and integer block coordinates, and places only one block per request. It refuses an occupied or unloaded target, targets outside 4.5 blocks, positions overlapping the bot or a nearby player, absent inventory material, and blocks without reachable solid adjacent support. Only ordinary full blocks are allowed; no TNT, liquids, containers, redstone controls or gravity blocks. It never digs, scaffolds, crafts or walks to the requested location. The server's claim/protection plugins may still deny placement; a failed response may need a visual world check before retrying. Build a line or wall as separate calls after checking each result. Test a single disposable block first.

### Survival loop (experimental)

Gather a natural leafy log with `/api/gather` (the bot refuses bare logs because they may be part of a player build). Dirt, grass blocks, sand, gravel and leafy tree logs can be broken with an empty hand. For stone and ores the bot checks the server registry's harvest tools against inventory before digging, then equips a suitable tool. A wrong or missing tool is refused rather than breaking the ore for no drop. Other diggable blocks are available by exact coordinate, except interactive, dangerous and protected-looking blocks (such as chests, doors, beds, TNT and lava). Do not point it at player builds. Leaves and short/tall grass can be punched bare-handed, without a tool or guaranteed drop. A leaf directly supporting the bot can be broken only if loaded solid ground is within three blocks below it and no visible liquid or falling-block landing is in the way. Other underfoot blocks remain protected. It refuses to dig next to a player, and refuses blocks bordering visible lava. It does not inspect for hidden lava or cave-ins, and these checks are not a world-protection guarantee. Sand and gravel can fall; stay clear of unsupported piles. Hand-digging is slower. The response identifies the chosen tool and whether it walked toward a nearby dropped item; check inventory for actual pickup. Look at inventory after walking near drops. Craft planks from the matching log (`oak_log` to `oak_planks`, for example), then sticks and a crafting table through `/api/craft`. Put the table down with `/api/place`, then craft a wooden sword, a hoe, or a bed with three same-colored wool and three planks. A stone sword needs two cobblestone and one stick. `/api/craft` checks recipes and full requested quantities first, says what is missing, and does not automatically gather, craft ingredients, or place the table. It supports the connected Minecraft server's recipe set, not a fixed shortlist: use successive calls for ingredients, tools, armor and other recipe outputs. It cannot invent recipes or gather components on its own. The table must be placed nearby for 3x3 recipes, rather than merely held in inventory. Bed colors depend on available wool and recipe version. `/api/place-bed` requires the foot and all four possible adjacent head positions empty and supported, since server-facing orientation can vary. Its response includes whether the foot block is confirmed as a bed. `/api/sleep` can then use it at night or in a thunderstorm. Mineflayer checks time, range, bed occupancy and nearby hostile mobs; server rules and dimensions may refuse. Sleeping can set spawn and skip night only under the server's ordinary multiplayer sleep rules; it does not force other players to sleep. Use `/api/wake` to get out of bed. [Mineflayer recipe and bed API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md), [Minecraft bed rules](https://minecraft.wiki/w/Bed).

For wheat, collect seeds from wild short or tall grass with `/api/gather` (not every broken grass yields a seed). Bring an inventory hoe and use `/api/till` on dirt or grass block with water at most four blocks away horizontally and within one level vertically. Plant wheat seeds on the farmland using `/api/plant` with the soil coordinates. Let the server grow them; wheat must reach age 7 before `/api/harvest` works. Three wheat can become bread at a crafting table; `AUTO_EAT=true` allows the bot to eat that bread. Replanting is opt-in per harvest and needs seeds already held before breaking the crop. Drops may still be on the ground afterward; move near them and check inventory. It does not autonomously cycle through farms or provide lighting. [Farmland hydration](https://minecraft.wiki/w/Farmland), [wheat growth and drops](https://minecraft.wiki/w/Wheat), [Mineflayer dig/place API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md).

`/api/shelter` constructs a fixed 5x5 exterior with a 3x3 interior, two-block-high walls and a roof. It leaves a 1x2 opening on the negative-z side, with no door or torch. Put the origin at the center of a flat, clear 5x5 footprint, with solid ground one block below floor height. Needs 55 identical inventory blocks of dirt, cobblestone, oak, spruce or birch planks. The entire footprint, ground and material count are checked before starting. It may walk a few steps to reach each placement, and the same terrain-only path digging rules apply. If the server rejects a block or navigation fails during construction, it stops and reports the number already placed; earlier placements are not rolled back. Check status and the world before retrying. An empty center lets you later place a bed and table manually; this is a bare shelter, not a complete furnished base. Avoid starting near valuable builds or players.

All these routes require the same bearer token. Every call is a requested action, not an autonomous survival routine. Quantities are bounded, reach is checked, and world changes can fail on protection plugins. No silent world scan or general mining is performed; pathfinder digging is limited to the documented natural terrain. Drops can take time to appear, and `/api/gather` only attempts to walk to a nearby observed item. There is no guaranteed item collection in the API response. Test with disposable inventory before trusting a long run.

### Paste-ready AI connection prompt

> Connect to my Minecraft bot at `https://YOUR-PRIVATE-ENDPOINT` with bearer token `YOUR-SECRET-TOKEN` provided through a secure secret store, not in chat. Call `GET /api/status` first. Use the documented JSON routes for movement and chat. Ask me before sending chat, attacking a mob, gathering, farming, crafting, sleeping, placing blocks, building a shelter, or enabling autonomous defense/food. Check nearby entities and inventory first. Do not reveal the endpoint or token, and stop on authentication or connection errors.

## Development

`npm ci && npm test` runs tests without joining a server. These tests cover API auth, validation, movement, mob-selection, safe-food choice, crafting, sleep, wheat farming, gathering, shelter, block-placement and the control panel (sign-in, sessions, CSRF, rate limiting, Crafty proxy actions and form actions) without a server; live world verification remains necessary. To run without Docker, set the variables above in your own environment and run `npm start` with `AUTH_CACHE_DIR` pointing to a private directory. License: MIT. No account or server address belongs in this repository.

### Known issues

This remains an experimental build. Earlier live play showed the bot getting trapped at a waterline; the new swim control has not yet been tested on that server. At the time of the initial build, `npm audit` reports six moderate advisories in transitive Mineflayer/Microsoft-auth dependencies and no high or critical advisories. Monitor upstream updates and avoid public API exposure.

### Deferred controls

There is no long-range autonomous mining, general recursive crafting, food foraging or container access. The optional starter survival mode below performs a bounded nearby wood/tool sequence. Mining is one requested block at a time; some blocks may be unsafe despite preflight checks. Advanced combat needs equipment, line-of-sight and live fight testing; digging can alter the world. Auto-eating only uses food already in inventory; farming stays manual. Survival mode can craft its narrow starter sequence; other recipes remain manual API actions. Hunting passive mobs is not implemented. No free sprint toggle is exposed because disabling sprinting avoids a known pathfinder waterline problem. No general-purpose keypress endpoint is exposed; jump and swim are bounded instead.

## 0.7.8

- Added a session-protected, auto-refreshing incoming chat transcript above the send box, with escaped server rendering and plain-text browser updates.
- Go To now uses an exact target block instead of a one-block-radius goal. The panel displays navigation completion and failure instead of leaving a static "Walking" message. Fractional coordinates choose their containing block.
- Added regression tests for waypoint arrival, false pathfinder completion, chat authentication, history limits and hostile chat text.
- Live movement and chat still need verification after upgrading; tests do not replace a survival-world check.

## 0.8.0: opt-in starter survival mode

Join first, then press **Survive (automatic starter tasks)** on the panel or send `POST /api/survive` with `{"enabled":true}`. It is off on every process start and never starts just because the container is pulled or the bot joins. No API-hardening or settings-file changes are part of this release. Only enable it in an area you permit the bot to change. Survival is experimental, not a promise of unattended Minecraft competence. Live checks are required after upgrading.

Priority is safety, food, night shelter, then nearby starter work:

- Critical health (6 or less), water/lava, death, lost connection, failed work, no safe escape or no further work makes it quit. It does not auto-rejoin after survival quits.
- Known nearby melee hostiles are fought only when health is at least 16 and a sword is in inventory. Players, passive mobs and unknown mobs are never attacked. Other known threats use a four-block flat escape corridor checked for loaded ground, hazards and nearby players. Autonomous path movement disables digging; it does not create a route by tearing through builds. If a hostile closes within four blocks while a world action is pending, it disconnects instead of running overlapping actions.
- At food 14 or below it eats safe inventory food. It does not hunt, farm or search for food. No food when hungry means quit, not starvation.
- During night (12500-23499 ticks), 25 dirt, cobblestone or common planks can become a closed 3x3 outer shell, with a 1x1 interior and roof. Every target must be loaded and empty, supported by safe ground, away from players, and server-confirmed after placement. It then quits rather than waiting through the night. This shell has no doorway: break one of its ordinary blocks to leave after rejoining. Existing terrain is not replaced. With insufficient material or an occupied footprint it quits.
- During daylight it gathers one reachable log at a time using existing gather protection checks, confirms inventory pickup before taking another, crafts planks, a table, sticks, a wooden pickaxe and sword, and stocks shelter blocks. Only nearby logs within 4.5 blocks are considered; no exploration or tree-chopping expedition. Leaf proximity is a heuristic, not proof that a log is natural. Builds containing leafy logs can still resemble trees, so use an approved natural area. The table is placed only on clear loaded ground away from players.

The panel's Survival row and `GET /api/status` expose `survival.enabled`, `goal`, `reason`, `error` and `updatedAt`. There are no secrets or chat-directed tasks in the loop. Incoming Minecraft chat is data, never commands. Manual mutation routes and panel actions return an error while Survive is enabled, except Stop, Quit and Survive itself. Reads remain available. Disabling Survive or pressing Stop quits, cancelling world work rather than leaving a pending dig behind. Turning survival off does not restore the old auto-defense/eat/flee timers until a new join; it leaves the bot disconnected.

Each action has a 15-second timeout. A session has a starter-work budget of 120 turns or ten minutes, whichever comes first; it then quits. These bounds prevent an unending resource/damage loop. This is a first survival batch: no stone upgrades, roaming, bed crafting, farming, storage or autonomous food collection. Test with low-value inventory and watch the first run.
