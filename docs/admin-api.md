# Admin API

Base: `/api/admin`. All responses: `{ "success": true, "data": ... }` or `{ "success": false, "message": ..., "requestId": ... }`.
Auth: `Authorization: Bearer <admin-token>` (from `/login`). Admin tokens (`typ: "admin"`) never work on player routes and
player tokens never work here. Admin tokens last `ADMIN_JWT_EXPIRES_IN` (default 8h).

Roles: **admin** = operations (users, games, support, banners, read-only reports).
**superadmin** = everything + coin adjustments, admin management, audit log.

Lists accept `page` (1..), `limit` (1..100, default 20) and return `pagination: { page, limit, total, totalPages }`.

## Session
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/login` | public | `{email,password}` → `{admin, token, expiresIn}`. 5 failed tries / 15 min per IP+email, 30 per IP |
| GET | `/me` | any | current admin |
| POST | `/change-password` | any | `{currentPassword,newPassword}` (10-72 chars, letter+digit). Revokes **all** older tokens, returns a fresh `token` |
| POST | `/logout-all` | any | revokes every token issued so far |

## Dashboard
`GET /dashboard[?refresh=1]` (cached `ADMIN_DASHBOARD_CACHE_SECONDS`, default 30 s) → `data`:
`stats {totalUsers, usersGrowth, activePlayers, playersGrowth, totalGames, gamesGrowth, totalRevenue, revenueGrowth, coinVolume, coinVolumeGrowth, openTickets}`,
`growth {labels,total,active}`, `modes [{name,label,count,percent}]`, `topGames [{roomId,mode,modeLabel,players,maxPlayers,playersLabel,status,createdAt}]`,
`revenue {labels,values,volume,platform}`, `recentUsers`, `activities`, `onlineUsers {count,list}`, `live {matches,playersInMatch}`,
`health {backend,database,dbPingMs,apiResponseMs,activeConnections,uptimeSeconds,memoryMB}`.

Definitions (all in **coins**, not rupees):
* `activePlayers` – distinct players seated in a match created in the last 30 days.
* `coinVolume` – coins wagered in settled matches. `totalRevenue` – coins the platform kept (`prizePool − prizes paid`). It is **0 while `PLATFORM_FEE_PERCENT=0`**.
* `onlineUsers` – players inside a match that is `in_progress` right now (there are no websockets yet).
* Growth % compares the last 30 days with the 30 days before.

## Users
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/users?search=&status=active\|blocked&sort=newest\|oldest\|name` | any | includes wallet balance (`coins`) |
| GET | `/users/:id` | any | profile + last 10 transactions + last 10 games |
| PATCH | `/users/:id/status` | any | `{isActive:false, reason}` (reason ≥3 chars required to block). Player is locked out on their next request |
| POST | `/users/:id/coins` | **superadmin** | `{type:"credit"\|"debit", amount, reason, idempotencyKey?}`. Max `ADMIN_MAX_COIN_ADJUST`. Same ledger as the game; balance can never go below 0. Send a unique `idempotencyKey` (8-64 chars) so a retried request is applied once (`duplicate:true` on retry) |

## Games, economy, reports
| Method | Path | Notes |
|---|---|---|
| GET | `/games?status=&mode=&roomCode=&userId=&from=&to=` | summaries (no board state) |
| GET | `/games/:id` | full board state + last 200 moves. `winner` is `{id, name}` (or `null`), `players[].userId` is the user id, every move has `player` (name), `playerId`, `action`, `diceValue`, `tokenId`, `prevStep`, `newStep`, `pointsEarned`, `timestamp` |
| GET | `/transactions?type=&source=&userId=&from=&to=` | wallet ledger, with user name/email |
| GET | `/economy/summary` | coins in circulation, 30-day credits/debits by source, platform revenue, coin volume |
| GET | `/reports/daily?days=7..90` | per day: newUsers, activePlayers, games, coinVolume, platformRevenue |

## Banners & events (admin) — players read `GET /api/banners`
`GET/POST /banners` (list: default 50, max 100 per page), `PATCH/DELETE /banners/:id`. Every banner has `id` (and `_id`). Fields: `title, subtitle, imageUrl (https), linkUrl (https), type banner|event, startsAt, endsAt, isActive, priority 0-100`.

## Support / complaints
Player: `POST /api/support/tickets {subject,message,category}`, `GET /api/support/tickets/mine`, `POST /api/support/tickets/:id/reply`.
Admin: `GET /support/tickets?status=&priority=&category=&ticketNo=`, `GET /support/tickets/:id`,
`POST /support/tickets/:id/reply {message}`, `PATCH /support/tickets/:id/status {status?, priority?}`.

## Super admin only
`GET /audit-logs?action=&adminId=&targetId=&from=&to=` (`action` is a case-insensitive **prefix** match: `user` finds `user.block`, `wallet.` finds `wallet.credit`; each row has `id, createdAt, adminId, adminEmail, action, targetType, targetId, meta, ip, requestId`) · `GET /admins` · `POST /admins {name,email,password,role}` ·
`PATCH /admins/:id/status {isActive}` (cannot deactivate yourself or the last active super admin).
Every state-changing call writes to the append-only audit log (who, what, target, IP, request id).

## Settings
`GET /settings` – read-only view of non-secret runtime config (explicit whitelist, never the raw config object). Change values via environment variables and restart.
Keys: `game {turnTimeoutSeconds, turnTimeoutGraceMs, matchDurationSeconds, sweeperEnabled, sweeperIntervalMs}`,
`economy {signupBonusCoins, maxEntryFee, platformFeePercent, roomWaitingTtlMinutes}`,
`admin {jwtExpiresIn, maxCoinAdjust, dashboardCacheSeconds}`,
`rateLimit {enabled, globalPerMinute, authAttempts, authWindowMinutes, registerPerHour, gameActionsPerMinute, adminAuthAttempts, adminIpAttempts, adminWritesPerMinute}`,
`database {requireReplicaSet, maxPoolSize}`. The panel reads `admin.maxCoinAdjust` for its coin-adjust limit.

## Limits and errors worth knowing
* `GET /dashboard?refresh=1` (cache bypass) is limited to **1 per 10 s per admin** (429 + message). Plain cached reads are not limited.
* `GET /users?search=` can be slow on very large collections; it is cut off after 8 s and returns **503 "The query took too long..."**. Run `npm run sync-indexes` after deploying (new indexes: `User{name}`, `User{isActive, createdAt}`).
* `GET /me` includes `createdAt`.

## Not implemented
Push notifications (needs FCM credentials + a product decision). `Notifications` in the panel has no backend yet.
