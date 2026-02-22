# monke.army — TODO

---

**Phase 1 (pool + Alpha Vault) and Phase 2 (programs) completed Feb 16, 2026.** All mainnet addresses in `CLAUDE.md`.

---

## Phase 3 — Run bot locally

- [ ] Configure `.env`: `RPC_URL`, `GRPC_ENDPOINT`, `BOT_KEYPAIR_PATH`, program IDs, `BANANAS_MINT`, DAMM v2 vars
- [ ] `npx ts-node bot/anchor-harvest-bot.ts` — verify it starts, connects gRPC, loads positions
- [ ] Validate LaserStream subscription — bin detection, active_id parsing, position tracking
- [ ] Validate relay server — `http://localhost:8080/api/stats`, WebSocket `/ws` events
- [ ] Validate Saturday keeper — claim pool fees → unwrap WSOL → sweep → fee rovers → deposit → cleanup

**Unlocks:** Relay serves live data to frontend. Bot cranks permissionless instructions. Full data backbone running.

---

## Phase 4 — Frontend (all pages, live transactions)

All 5 pages have HTML + styles + event wiring. See `frontend-dev.md` for page specs and design constraints.

### Trade page
- [x] Replace demo-mode position creation with live `open_position` tx *(Feb 21 — V1 for SPL pools, V2 for Token-2022 pools. First mainnet position opened.)*
- [x] Wire positions list to on-chain `getProgramAccounts` *(Feb 21 — `refreshPositionsList()` with corrected byte offsets)*
- [x] Close position: live `user_close` tx wired *(Feb 21 — wired but untested on mainnet)*
- [ ] Claim LP fees button per position
- [ ] Pool selector UX — featured pools from relay, recent pools, paste address
- [ ] Bin range visualization improvements

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

- [x] Open position on mainnet *(Feb 21 — 0.1 SOL buy on Speedrun/SOL Token-2022 pool)*
- [ ] Full loop: open → bot harvests → fee to rover → sweep to dist_pool → feed monke → claim SOL
- [ ] Test V1 `open_position` on SPL-only pool *(untested post-Box<> changes)*
- [ ] Test `user_close` on mainnet
- [ ] Verify all 5 frontend pages with live data
- [ ] Test permissionless fallback — stop bot for 60s, harvest as keeper, verify tip
- [ ] Test emergency close flow (propose → wait 24hr → apply)
- [ ] Test edge cases: dust positions, empty rover sweep

---

## Phase 7 — Go live

- [ ] Deploy frontend to Vercel (or equivalent)
- [ ] DNS: monke.army → Vercel
- [ ] Final config.json with production RPC, relay URL, all addresses
- [ ] Remove demo mode banner
- [ ] Remove Enlist page after Alpha Vault closes (pull `#page-enlist`, revert to 4-page nav)

---

## Low Priority (post-launch)

- [ ] **Rover TVL computation** — callback wired to relay, dollar-value computation stubbed. Implement DLMM bin value queries.
- [ ] **Token-2022 transfer hook support** — documented limitation. Deferred post-launch.
- [ ] **Remove Enlist page** — after Alpha Vault closes, pull `#page-enlist` from HTML, revert to 4-page nav.

---

## Technical Debt — Feb 21 session

See `refactor.md` for full details.

- [ ] **Program split** — core.rs is at 3440 lines and hitting BPF 4KB stack frame limits. Split rover system into a separate program.
- [ ] **Reduce remaining_accounts** — `OpenPositionV2` has 6 accounts in `remaining_accounts` with no Anchor validation. Use `InterfaceAccount<Mint>` for mints, `LazyAccount` (Anchor 0.31) for deferred deserialization, or program split to free stack space.
- [ ] **Unify V1/V2 open_position** — use `add_liquidity_by_strategy2` for all pools (SPL-only pools work fine with V2). Eliminates frontend V1/V2 branching.
- [ ] **Smoke test V1 path** — `open_position` (SPL-only) untested on mainnet after `Box<>` changes.
- [ ] **IDL regeneration** — IDL is stale after `OpenPositionV2` struct expansion + new CPI types. Regenerate for client codegen.
- [ ] **Freeze program upgrades** — 8 deploys in one session. Transfer upgrade authority to multisig or hardware wallet once stable.

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
- [ ] **Demo Pitch to 5 SMBv2 Holders associated with LP Army**

---

**IDL regeneration:** `cargo update -p proc-macro2 --precise 1.0.94` then `RUSTUP_TOOLCHAIN=nightly-2024-11-01 anchor idl build -p <program> -o target/idl/<program>.json`

**Build:** `PATH="$HOME/.cargo/bin:$PATH" cargo-build-sbf --manifest-path programs/bin-farm/Cargo.toml` (Homebrew cargo doesn't support +toolchain)

*Last updated: Feb 21, 2026. First mainnet position opened. V2 Token-2022 CPI added. See `refactor.md` for technical debt from this session.*
