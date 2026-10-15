# Ludo Supreme Backend: Production Notes

## 1. Deploy se pehle (zaroori)

1. **`.env` ke secrets rotate karo.** Tumhare zip mein `.env` tha aur `JWT_SECRET` sirf 22 characters ka tha. Naya banao:
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   (Isse sab users logout ho jayenge, normal hai.)
2. **`.env` kabhi GitHub par mat daalo.** `.gitignore` pehle khali tha, ab sahi hai. Agar `.env` pehle push ho chuka hai to us secret ko compromised maano.
3. **MongoDB replica set chahiye** (MongoDB Atlas free tier bhi replica set hai). Wallet/entry-fee transactions ke liye zaroori hai. Production mein `REQUIRE_REPLICA_SET=true` default hai, standalone mongod par server start hi nahi hoga.
4. `.env.example` ko `.env` mein copy karke values bharo. `NODE_ENV=production`, `CLIENT_URL`, `TRUST_PROXY=1` (nginx/Render/Railway ke peeche) set karo.
5. Agar purane users DB mein hain: API band karke `npm run migrate:coins -- --dry-run`, phir bina `--dry-run` ke chalao. Naye DB ke liye zaroorat nahi.
6. Naye unique indexes: pehli baar start par ban jayenge (`MONGO_AUTO_INDEX=true`). Purane DB mein duplicate data ho to `node scripts/sync-indexes.js` ka error dekho.

Run: `npm ci && npm start`, ya Docker: `docker compose up -d --build`.
Health: `/health` (process zinda hai), `/ready` (DB connected hai, load balancer ke liye).

## 2. Jo security bugs mile aur fix hue

| # | Bug | Asar | Fix |
|---|-----|------|-----|
| 1 | `POST /games/session/:id/complete` koi bhi logged-in user, kisi bhi match par, kisi bhi waqt call kar sakta tha | Match beech mein khatam, score leader ko prize pool | Sirf participant, aur sirf jab match ka clock khatam ho |
| 2 | `POST .../timeout` koi bhi user kisi ke bhi match par | 3 baar call karke opponent ko auto-forfeit karwa ke jeet jaana | Sirf participant, aur sirf jab turn deadline nikal chuki ho |
| 3 | `POST /leaderboard/update-result` | Koi bhi `{"result":"win"}` bhej ke unlimited score badha sakta tha | Ab no-op. Result sirf server settlement ke waqt likhta hai |
| 4 | `GET /games/session/:id` aur room details | Koi bhi dusre ka match / host ka email dekh sakta tha | Sirf participants; email hata diya |
| 5 | Prize pool = `entryFee * maxPlayers` | 4-player room mein 2 log khelein to coins ban jaate the (free money) | Pool = jitni fees asli mein collect hui |
| 6 | Host naya room banaye to purana room cancel, par refund nahi | Host aur guests ki entry fee gayab | `cancelRoomAndRefund`, sabko exactly once refund |
| 7 | `user.coins -= fee; save()` (read-modify-write) | Double-spend race, negative balance possible | Atomic `$inc` with `balance >= amount` guard |
| 8 | Settlement non-atomic | Double prize / prize kho jana | Atomic claim + idempotent payout (referenceId) + crash recovery |
| 9 | Do alag balance: `User.coins` aur `Wallet.balance` | Hamesha mismatch | Wallet = single source of truth |
| 10 | Rewards: "First Win", "Master Player (10 games)" bina shart ke claimable; claim ban jaata par coins fail ho to user ka nuksan | Free coins / lost coins | Server par eligibility check, claim rollback |
| 11 | JWT secret ka hardcoded fallback (`"ludo-supreme-default-secret"`) | Env miss ho to koi bhi token forge kar sakta tha | Fallback hata diya; production mein weak/missing secret par boot fail |
| 12 | `Math.random()` se dice aur room code | Predictable | `crypto.randomInt` |
| 13 | Login: user na mile to fast, mile to slow; inactive status pehle batata tha | Account enumeration | Hamesha ek bcrypt compare; inactive check password ke baad |
| 14 | `error: error.message` responses mein | DB/internal info leak | Central error handler; sirf safe messages |
| 15 | Koi rate limit nahi | Brute force, dice spam | Login (IP+email), register, global, game actions |
| 16 | Non-contiguous seats par turn skip (`(seat+i) % players.length`) | Kisi player ka turn kabhi na aana | Seat-order se next player |
| 17 | All tokens home hone par bhi score se winner | Finisher haar sakta tha | Finisher forced winner |
| 18 | Score barabar (0-0) par seat 0 poora pool le jaata | Unfair | Draw: pool barabar baant diya jaata hai |

## 3. Naya kya add hua

- **`jobs/matchSweeper.js`**: server-side referee (socket nahi hai isliye zaroori). Expire hue matches settle karta hai, idle turns ka timeout lagata hai, adhoori settlement recover karta hai, purane waiting rooms cancel + refund karta hai. Multi-instance par bhi safe.
- **`game/engine/ludoEngine.js`**: saare rules pure functions mein, 14 unit tests ke saath.
- **Operational**: env validation, structured JSON logs + request id (`X-Request-Id`), graceful shutdown (SIGTERM), HTTP timeouts, `/ready`, Dockerfile (non-root), docker-compose (replica set), GitHub Actions CI, `engines: node >= 22`.
- **Optimistic concurrency** GameSession par: do parallel requests (double-tap) ek turn ko corrupt nahi kar sakte (409 milta hai, client retry kare).
- Ek room ke liye database level par sirf ek live session (unique partial index).

## 4. API behaviour jo badla (Flutter app mein check karo)

- `/games/session/:id/complete`: match chalte hue 400 deta hai. Beech mein chhodna ho to `/surrender` use karo. Settle ho chuka match dobara call karo to 200 (idempotent).
- `/games/session/:id/timeout`: deadline se pehle 400 (1 second ki chhoot hai).
- `/games/start`: guest tab start kar sakta hai jab room full ho; host kabhi bhi (2+ players ke saath).
- History mein naya `outcome` ("win"/"loss"/"draw") aur sahi `prizeEarned`.
- `/leaderboard/update-result` chalta rahega (purane app builds crash na hon) par kuch change nahi karta.
- Insufficient coins ka message wahi hai: `Insufficient coins. Required: X, Available: Y`.
- Rate limit hone par HTTP 429 + `Retry-After` header.
- Password max 72 characters (bcrypt limit).

## 5. Maine kya test kiya, kya NAHI

**Chala aur pass hua (36 tests, `npm test`)**: game engine rules (capture, safe tiles, home, settlement/draw/fee rounding), config validation, rate limiter, auth rejection (missing/forged/`alg:none`/expired token), NoSQL injection, malformed/oversized body, security headers, error leak check.

**Maine NAHI chala paya**: MongoDB-dependent code (wallet, rooms, game service, sweeper, settlement). Meri sandbox mein MongoDB nahi hai. Ye code padh kar aur syntax check karke likha hai, run nahi kiya. Isliye `tests/integration/flow.test.js` likha hai jo in sab ko real DB par check karta hai (concurrent debits, room refunds, 3 log last seat ke liye race, complete/timeout exploits, double payout, sweeper):

```
docker compose up -d mongo
MONGO_URI_TEST="mongodb://localhost:27017/ludo_test?replicaSet=rs0" npm run test:integration
```
(DB ka naam "test" hona chahiye, test ke baad poora DB drop hota hai.) **Production se pehle ye zaroor chalao**, aur koi test fail ho to mujhe output bhejo.

Purani `tests/legacy/test_*.js` tumhari manual scripts hain, ab `npm test` mein nahi chalti. Unka wallet-starts-at-0 wala assumption abhi bhi sahi hai.

## 6. Abhi bhi baaki (jaanbujhkar nahi kiya)

- **Real-time**: `sockets/` khali hai. Abhi client polling karta hai. Production scale ke liye Socket.IO (+ Redis adapter) chahiye.
- **Rate limiter in-memory hai**: ek instance ke liye theek. Kai instances par Redis store lagao.
- **Token revoke / logout / refresh token**: nahi hai (JWT 7 din valid). Password reset aur email verification bhi nahi.
- **Rewards**: "Daily Login", "Lucky Spin", "Referral" abhi bhi ek baar claim hone wale honor-system rewards hain (koi condition nahi). Coins sirf game mein use hote hain to risk kam hai, par agar kabhi coins ko cash/IAP se jodo to ye farm ho sakte hain (fake accounts). Daily reset ke liye product decision chahiye.
- **2-player board**: seat 0 aur 1 pass-pass hain (Red/Green). Asli Ludo mein 2 players saamne baithte hain (seat 0 aur 2). Ye client + rules ka design decision hai, maine nahi badla.
- **Monitoring/backup**: Sentry/Datadog, MongoDB backups, aur `npm audit` alerts khud setup karne honge.
- Admin panel ke liye ab APIs hain, section 7 aur `docs/admin-api.md` dekho.

## 7. Admin backend (v1.2.0)

**Naya:** admin login/me/change-password/logout-all, dashboard (real data, 30s cache), users (list/search/detail/block-unblock), coins adjust (superadmin, idempotent),
games, transactions, economy summary, daily reports, banners (+ player `GET /api/banners`), support tickets (+ player `/api/support`), audit log, admin management, settings.
Poori list: `docs/admin-api.md`.

**Security changes**
- Admin token me `typ:"admin"`, issuer check, 8h expiry. Player token admin route par aur admin token player route par kaam nahi karta.
- Password change / logout-all / admin deactivate par purane saare admin tokens revoke (`tokensValidAfter`).
- Admin login: 5 galat try / 15 min (IP+email) aur 30 / IP. Password policy: 10-72 chars, letter + digit.
- Roles: `admin` aur `superadmin`. Coins, admin management, audit log sirf superadmin.
- Har state-changing admin action audit log me (kisne, kya, kispar, IP, requestId). Passwords/tokens kabhi log nahi hote.
- Hardcoded `Admin@123456` wali create-admin script hata di; ab env se (neeche).
- Dashboard ke `distinct()` (saari ids memory me) hata ke DB-side aggregations, indexes add, 30s cache.
- Revenue ab sach me platform ka rakha hua fee hai (`prizePool - prizes paid`), coins me. `PLATFORM_FEE_PERCENT=0` par ye 0 hoga. Purana "revenue" (coins wagered) ab `coinVolume`.
- `.env` zip se hata diya gaya. `.env.example` update (`//` comment galat tha, ab `#`).

**Deploy checklist (admin)**
1. Atlas DB password aur `JWT_SECRET` **rotate** karo (purani `.env` share ho chuki hai). Naya `.env` `.env.example` se banao.
2. Atlas Network Access me sirf apne server ka IP (ya `0.0.0.0/0` + strong password). DB user: ek database par `readWrite`.
3. Pehla superadmin:
   `ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='Strong-Pass-123' npm run create-admin`
   Purana admin (role `admin`) ko promote: `ADMIN_EMAIL=old@x.com npm run create-admin -- --promote`. Password reset: `--reset-password`.
4. Flutter **Web** par panel chalana ho to `CLIENT_URL` me uska origin daalo (mobile/desktop par zaroori nahi). Server start par warning aati hai agar placeholder hai.
5. Purane admin tokens (bina `typ`) ab invalid hain, sabko dobara login karna hoga.
6. `MONGO_URI_TEST=... npm run test:integration` chalao (tests/integration/admin.test.js + flow.test.js). Ye maine real MongoDB par **nahi** chalaya.

**Jo ab bhi baaki hai**
- Notifications (push) API: FCM credentials aur product decision chahiye.
- "Online users" abhi sirf live match wale players hain (sockets nahi). Real presence ke liye Socket.IO.
- Phone number User model me nahi hai, isliye panel me phone column nahi aa sakta.
- Rate limiter in-memory; kai instances par Redis store.
- Dashboard all-time totals poori `gamesessions` collection scan karte hain (cache ke saath). Lakhon matches ke baad daily roll-up collection banao.
- Admin 2FA nahi hai (high-value coins kaam ke liye baad me add karna chahiye).


## Admin panel contract update
- Games: `winner` ab `{id, name}`; moves me player ka naam + id; settings me sirf whitelisted asli keys; audit log `action` prefix search + `meta`/`requestId`; banners default 50/page; `/me` me `createdAt`; dashboard `?refresh=1` par 10s limit; users search par 8s time limit.
- Deploy ke baad `npm run sync-indexes` chalao (naye User indexes).
- **Rate limiter abhi in-memory hai.** Ek hi instance par theek hai. Multi-instance deploy me `middleware/rateLimit.middleware.js` ka store Redis (jaise `rate-limit-redis`) se badlo, warna har instance ki limit alag count hogi (admin login throttle bhi).
- Users ka substring search (`name/email/username`) index use nahi karta (case-insensitive regex). Bahut bade user base par Atlas Search ya normalised lowercase search field chahiye.
