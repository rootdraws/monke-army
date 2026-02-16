# monke.army — TODO

---

**Phase 1 (pool + Alpha Vault) and Phase 2 (programs) completed Feb 16, 2026.** All mainnet addresses in `README.MD`.

---

## Phase 3 — Run bot locally

- [ ] Configure `.env`: `RPC_URL`, `GRPC_ENDPOINT`, `BOT_KEYPAIR_PATH`, program IDs, `BANANAS_MINT`, DAMM v2 vars
- [ ] `npx ts-node bot/anchor-harvest-bot.ts` — verify it starts, connects gRPC, loads positions
- [ ] Validate LaserStream subscription — bin detection, active_id parsing, position tracking
- [ ] Validate relay server — `http://localhost:8080/api/stats`, WebSocket `/ws` events
- [ ] Validate Saturday keeper — claim pool fees → unwrap WSOL → sweep → fee rovers → deposit → cleanup
- [ ] Quick smoke test: open a small position → bot detects → harvests → fee routes correctly

**Unlocks:** Relay serves live data to frontend. Bot cranks permissionless instructions. Full data backbone running.

---

## Phase 4 — Frontend (all pages, live transactions)

All 5 pages have HTML + styles + event wiring. Stubs exist in `app.js`. See `frontend-dev.md` for page specs and design constraints.

### Trade page
- [ ] Replace demo-mode position creation with live `open_position` tx
- [ ] Wire positions list to on-chain `position.all()` (falls back to relay REST)
- [ ] Resolve token symbols from mint addresses in `loadPool()`
- [ ] Pool selector UX — featured pools from relay, recent pools, paste address
- [ ] Bin range visualization — bins on a price axis relative to current price
- [ ] Close position: live `user_close` tx
- [ ] Claim LP fees button per position

### Rank page — Monke sub-page
- [ ] Fetch user's SMB Gen2/Gen3 NFTs via Helius DAS `getAssetsByOwner`
- [ ] NFT grid: image + name + collection badge (Gen2/Gen3)
- [ ] Per-NFT: read MonkeBurn PDA → show weight + claimable SOL
- [ ] Feed button: live `feed_monke` tx
- [ ] Claim button: live `claim` tx
- [ ] "Claim All" button: batch claim across all fed monkes
- [ ] Jupiter Terminal embed for "Buy $BANANAS" (with live BANANAS_MINT)
- [ ] "No NFTs found" state — link to SMB marketplace

### Rank page — Roster sub-page
- [ ] Leaderboard: fetch all MonkeBurn PDAs, sort by weight, render table
- [ ] MonkeBurn lookup: paste NFT mint → read PDA → weight + unclaimed estimate
- [ ] Global stats: read MonkeState for total_burned, total_share_weight, total_sol_distributed

### Ops page
- [ ] Bounty board from relay REST (`GET /api/pending-harvests`)
- [ ] Per-harvest "Harvest" button: live `harvest_bins` tx
- [ ] "Harvest All" button: batch harvests
- [ ] Crank buttons: live `sweep_rover`, `deposit_sol`, `compost_monke` txs
- [ ] Stats grid from relay REST (`GET /api/stats`)

### Recon page
- [ ] Rover leaderboard from relay REST (`GET /api/rovers`)
- [ ] Top-5 analytics cards from `GET /api/rovers/top5`
- [ ] Bribe deposit: live `open_rover_position` tx
- [ ] Click-to-trade: pool row → loads into Trade page

### Enlist page
- [ ] Verify end-to-end with live Alpha Vault (countdown → deposit → claim)

### Cross-cutting
- [ ] Aesthetics pass — visual consistency across all 5 pages
- [ ] Loading states — spinners/skeletons while fetching
- [ ] Error states — graceful handling when relay offline or RPC fails
- [ ] Mobile responsiveness check

---

## Phase 5 — Deploy bot to server

- [ ] DigitalOcean 1-2GB droplet ($6-12/mo)
- [ ] Configure env vars, PM2/systemd for auto-restart
- [ ] Set `BOT_RELAY_URL` in prod `config.json` to `wss://bot.monke.army` (or droplet IP)
- [ ] Verify relay accessible from public internet
- [ ] Monitor: health endpoint, reconnect behavior, cache hit rates

---

## Phase 6 — End-to-end testing

- [ ] Full loop: open position → bot harvests → fee to rover → sweep to dist_pool → feed monke → claim SOL
- [ ] Verify all 5 frontend pages with live data
- [ ] Test permissionless fallback — stop bot for 60s, harvest as keeper, verify tip
- [ ] Test emergency close flow (propose → wait 24hr → apply)
- [ ] Test edge cases: Token-2022 pool, dust positions, empty rover sweep

---

## Phase 7 — Go live

- [ ] Deploy frontend to Vercel (or equivalent)
- [ ] DNS: monke.army → Vercel
- [ ] Final config.json with production RPC, relay URL, all addresses
- [ ] Remove demo mode banner (app.js line ~1117)
- [ ] Remove Enlist page after Alpha Vault closes (pull `#page-enlist`, revert to 4-page nav)

---

## Low Priority (post-launch)

- [ ] **Rover TVL computation** — callback wired to relay, dollar-value computation stubbed. Implement DLMM bin value queries.
- [ ] **Token-2022 transfer hook support** — documented limitation. Deferred post-launch.
- [ ] **Remove Enlist page** — after Alpha Vault closes, pull `#page-enlist` from HTML, revert to 4-page nav.

---

## Funding / Distribution

- [ ] **Submit Graveyard Hackathon** — deadline Feb 28. Target NFT bounty ($2.5K) and main prizes ($15K/$10K/$5K).
- [ ] **Apply to MonkeFoundry Cohort 2** — when applications open. Build relationships in MonkeDAO Discord first.
- [ ] **Pitch Helius for LaserStream sponsorship** — "100% of fees to monke holders. Zero dev cut. I need LaserStream to run it."
- [ ] **Attend Monke Weekly Townhall** — Feb 27, 17:00 UTC, Discord. Be in the room.
- [ ] **Monday Monke Spotlight pitch** — when ready to present.

---

## Non-Development

- [ ] **Document bot key rotation procedure** — Sequence: core first, then restart bot. Write before mainnet.
- [ ] **Rover framing template** — One paragraph for token projects announcing rover deposits. Include in Recon page.
- [ ] **Secure program upgrade authority** — Hardware wallet for upgrade authority keypair. Plan for freezing (immutable) once stable.
- [ ] **Participate in Alpha Vault** — buy alongside everyone else. Same price, same terms.
- [ ] **Smoke test the full loop with 0.1 SOL** — Open position → bot harvests → fee to rover_authority → Saturday keeper sweeps to dist_pool → feed monke → claim SOL.
- [ ] **Demo Pitch to 5 SMBv2 Holders associated with LP Army**

---

## Audit Fixes — Feb 16

- [x] **H-01: Side validation** — `side` derived from on-chain `active_id` in `open_position` + `open_position_v2`. User parameter ignored. Prevents fee evasion.
- [x] **H-02: Emergency close deadlock** — `apply_emergency_close` now transfers vault tokens to owner as part of closing. No separate drain step, no catch-22 on deprecated pools.
- [x] **M-01: Rover ATA validation** — `claim_pool_fees` validates `remaining_accounts[7]` and `[8]` are owned by `rover_authority`. Prevents fee redirection.
- [x] **M-02: Hardcode DAMM v2 discriminator** — `claim_position_fee` discriminator hardcoded. No runtime hash, no Anchor convention assumption.
- [x] **M-03: Mint constraint** — `user_token_account` in `OpenPosition` v1 now validates mint matches `token_mint`.
- [x] **IDL regenerated** — `bin_farm.json` regenerated and copied to `bot/idl/`.
- [x] **AUDIT comments stripped** — ~140 dangling audit references removed across 18 files. Technical context preserved.
- [x] **Bot: verify-active-id-offset.mjs** — Fixed hardcoded offset (168 → 76).
- [x] **Bot: safetyPoll cache** — Uses shared `getDLMM` 10-minute cache instead of fresh `DLMM.create()`.
- [x] **Config: DEFAULT_POOL** — Cleared (was DLMM program ID, not a pool). `HELIUS_RPC_URL` added.
- [ ] **Token-2022 transfer hooks unsupported** — Documented as known limitation. Full support deferred post-launch.
- [ ] **Initialize not gated to deployer** — Mitigated via `scripts/deploy-and-init.mjs`. On-chain gating not added.

---

**IDL regeneration:** `cargo update -p proc-macro2 --precise 1.0.94` then `RUSTUP_TOOLCHAIN=nightly-2024-11-01 anchor idl build -p <program> -o target/idl/<program>.json`

*Last updated: Feb 16, 2026. Audit fixes applied. IDL regenerated. 7-phase plan: pool → programs → bot local → frontend → bot server → E2E → go live.*
