# claude.md — monke.army codebase context

**Limit orders that earn fees, instead of paying them.**

monke.army wraps Meteora DLMM positions on Solana. Set your range as a single-sided LP — **sell the rips** or **buy the dips**. If price moves through your range, Monke's Harvester protects your position against round-trip loss by pulling each bin the moment it converts.

Performance fee on converted output only (0.3%). `sweep_rover` splits 50/50: half to monke holders who fed $BANANAS, half to `Config.bot` (operations). Hardcoded on-chain. Gen2 gets 2x weight per feed, Gen3 gets 1x.

## Architecture

Two on-chain programs. No governance. No staking. No voting.

- **core.rs** — Position management (open, harvest, close, claim fees) + rover system + DAMM v2 fee claiming. All CPI via V2 variants (Token-2022 native). Mint fields are `UncheckedAccount`, token account fields are `InterfaceAccount` (dual SPL Token / Token-2022). Memo CPI on all outbound transfers. `open_position_v2` only. **Fee routing:** All fees → rover_authority ATAs. SOL fees (Sell side) → `rover_fee_token_y` (WSOL ATA on rover_authority) → `close_rover_token_account` (unwrap) → `sweep_rover` → 50/50 split (dist_pool + Config.bot). TOKEN fees (Buy side) → `rover_fee_token_x` (rover_authority ATA) for BidAskImBalanced DLMM recycling (no market dump on thin meme pools). **Side derivation:** `open_position_v2` derives `side` (Buy/Sell) from on-chain `active_id` — user parameter ignored. Prevents fee evasion. **`claim_pool_fees`:** CPI into DAMM v2 to claim trading fees from $BANANAS/SOL pool, rover_authority PDA signs as position owner, permissionless crank. Rover ATAs validated before CPI. Discriminator hardcoded. **`close_rover_token_account`:** Permissionless — closes any token account owned by rover_authority (unwraps WSOL to native SOL, reclaims rent for empty ATAs). Destination always rover_authority itself. **Permissionless fallback:** harvest, close, and sweep all use heartbeat + staleness pattern — anyone can call when bot is stale, earns `keeper_tip_bps`. **Rovers:** BidAskImBalanced distribution (more tokens at higher bins). `open_rover_position` (external deposits) and `open_fee_rover` (bot-gated fee recycling) both read `active_id` directly from lb_pair on-chain (never trust caller). `sweep_rover` splits SOL 50/50: half to dist_pool (`revenue_dest` — timelocked propose/apply), half to `Config.bot` (operations). Hardcoded split. **Emergency:** `propose_emergency_close` / `apply_emergency_close` (24hr timelocked, transfers any remaining vault tokens to owner as part of closing) for deprecated Meteora pools. Config has 96-byte `_reserved`, RoverAuthority has 64-byte `_reserved` for future fields.
- **monke_bananas.rs** — Feed BANANAS to your Monke. Burn $BANANAS (1M per tx, unlimited stacking) against SMB Gen2 or Gen3 NFTs. **Gen2 = 2x weight, Gen3 = 1x weight per feed.** Per-NFT `MonkeBurn` PDA tracks weight. MasterChef accumulator. Claim always works when paused. `compost_monke`: permissionless cleanup of burned NFTs (supply==0) — subtracts dead weight, closes PDA, rent to caller. MonkeState has 64-byte `_reserved` for future fields. SMB Gen2: `SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W`. SMB Gen3: `8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH`. Initialize validates `bananas_mint.decimals == 6`.

## File map

```
programs/                        — Anchor workspace (build targets)
  bin-farm/src/
    lib.rs                       — core.rs (positions, harvest, close, fees, ROVER)
    meteora_dlmm_cpi.rs          — CPI module (V2 only: BidAskImBalanced + all V2 variants)
  monke-bananas/src/lib.rs       — monke_bananas.rs

src/contracts/                   — Reference copies (keep in sync with programs/)

bot/                             — Monke's Harvester
  anchor-harvest-bot.ts          — Orchestrator + health endpoint + relay wiring + graceful shutdown
  geyser-subscriber.ts           — Helius LaserStream gRPC, sub-second bin detection,
                                   raw LbPair byte parsing, persistent cache, no jump filtering
  relay-server.ts                — WebSocket + REST relay for frontend (attached to health server)
  meteora-accounts.ts            — Shared Meteora CPI account resolution + DLMM cache (10min TTL)
  harvest-executor.ts            — Job queue, Token-2022 aware, emits harvestExecuted/positionClosed
  keeper.ts                      — MonkeKeeper: Saturday sequencer + fee rovers + rover TVL computation
  retry.ts                       — Shared withRetry (exponential backoff, 3 retries)

src/
  enlist.js                      — Alpha Vault SDK integration (bundled → dist/enlist.bundle.js)

public/                          — Frontend: Enlist / Trade / Positions / Rank / Ops / Recon
  app.js                         — All page logic, relay WebSocket client, Codama instruction builders
  index.html                     — 6 pages (Enlist/Trade/Positions/Rank/Ops/Recon), sigil astrolabe
  styles.css                     — Military monke color system, all page styles + Enlist
  config.json                    — Program IDs, RPC, HELIUS_RPC_URL, BOT_RELAY_URL, ALPHA_VAULT_ADDRESS

scripts/
  deploy-and-init.mjs            — Deploy + initialize both programs (anti-front-run)
  build-frontend.mjs             — Bundle app.js (Codama + @solana/kit) + bundle enlist.js via esbuild
  generate-clients.mjs           — Codama client generation from IDL → src/generated/
  test-close-position.ts         — E2E test: close a stuck position (mainnet, no DLMM SDK)
  recycle-fee-rover.ts           — Open fee rover from accumulated token fees (standalone)

meteora-invent/                  — Meteora DAMM v2 launch toolkit (cloned)
  studio/config/damm_v2_config.jsonc — $BANANAS pool + Alpha Vault config

src/generated/                   — Codama-generated TypeScript clients (bin-farm + monke-bananas)
ref/dlmm-sdk/                    — Cloned Meteora DLMM SDK (source of truth for CPI layouts + discriminators)
Anchor.toml                      — 2 programs, devnet + mainnet
```

## PDA seeds

| PDA | Seeds | Program |
|-----|-------|---------|
| Config | `[b"config"]` | core |
| Position | `[b"position", meteora_position.key()]` | core |
| Vault | `[b"vault", meteora_position.key()]` | core |
| RoverAuthority | `[b"rover_authority"]` | core |
| MonkeState | `[b"monke_state"]` | monke_bananas |
| Dist Pool | `[b"dist_pool"]` | monke_bananas |
| Program Vault | `[b"program_vault"]` | monke_bananas |
| MonkeBurn | `[b"monke_burn", nft_mint.key()]` | monke_bananas |

## Program IDs

| Program | ID |
|---------|------|
| core (bin_farm) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| monke_bananas | `myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH` |
| DAMM v2 (Meteora) | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |

## Fee flow

50% to monke holders, 50% to bot operations. Hardcoded 50/50 split in `sweep_rover`. Zero team token allocation.

```
Three fee inputs → sweep_rover splits 50/50:

1. Sell-side position fees (SOL)
     harvest/close → rover_authority WSOL ATA → close_rover_token_account (unwrap)
     → sweep_rover → 50% dist_pool + 50% Config.bot

2. Buy-side token fees + rover bribe proceeds
     rover_authority ATA → open_fee_rover (BidAskImBalanced DLMM)
     → natural trading converts → SOL → sweep_rover → 50/50 split

3. DAMM v2 $BANANAS/SOL trading fees (SOL via collectFeeMode=1)
     claim_pool_fees → SOL in rover_authority → sweep_rover → 50/50 split

Monke share → dist_pool → deposit_sol → program_vault → fed monke holders claim
Operator share → Config.bot (self-funding bot keypair)
```

## $BANANAS Launch

$BANANAS launched via Meteora Invent DAMM v2 pool with Alpha Vault pro-rata fair launch.
- **1B supply**, 6 decimals. 100% into pool. Zero dev allocation.
- **initPrice**: `0.000001` SOL/token (~$86K FDV). "1 SOL = 1 monke feed."
- **Alpha Vault (pro-rata)**: `maxBuyingCap = 420` SOL. Same price for all participants. Instant vesting.
- **Liquidity permanently locked**: position NFT held by rover_authority (`56UrucGXHYPfsXS8BMZG82UA632fHDB1o6aXWwt9i6PR`).
- **Sniper protection**: Fee Time Scheduler — 69% starting fee decaying to 1% over 3 hours.
- **`collectFeeMode: 1`** (SOL only): all pool trading fees arrive in SOL.
- **DAMM v2 program**: `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
- **Launch config**: `meteora-invent/studio/config/damm_v2_config.jsonc`

## Build

`cargo-build-sbf --manifest-path programs/bin-farm/Cargo.toml` (requires Solana CLI 3.0+ with platform-tools v1.47+ for rustc 1.84). Anchor 0.31.1. IDL generation: `anchor idl build -p bin_farm`. `blake3` pinned to 1.5.5, `borsh` pinned to 1.5.5 (avoid indexmap 2.13 incompatibility with BPF rustc). `init-if-needed` enabled for monke_bananas. No `mpl-token-metadata` dep — raw Metaplex byte parsing. Codama client gen: `node scripts/generate-clients.mjs`.

**Run bot:** `npm run bot` (uses `tsx`, loads env from `bot/.env`). IDL files at `bot/idl/*.json` (0.30 spec format — requires `@coral-xyz/anchor@^0.30.1`).

## Frontend pages

**Pre-launch:** Enlist(0). Trade(1). Positions(2). Rank(3). Ops(4). Recon(5).
**Post-launch:** Trade(0). Positions(1). Rank(2). Ops(3). Recon(4).

- **Enlist** — Alpha Vault fair launch (page 0, landing page). 3 phases: 2-week countdown → deposit SOL → claim $BANANAS. `src/enlist.js` bundled via esbuild with `@meteora-ag/alpha-vault` SDK. Gold `--bananas` accent. Pulled after launch.
- **Trade** — DLMM harvester. Order form + bin viz. Default pool: SOL/USDC (`BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y`). Live data from relay. Mint `--mint` accent.
- **Positions** — All wallet positions. Inline close + claim fees buttons per row. Stats grid (count, deposited, harvested, avg fill).
- **Rank** — Sub-pages: Monke (NFT carousel, feed/claim, MonkeBurn PDA reading) + Roster (leaderboard via `getProgramAccounts`, global stats from MonkeState). Gold `--bananas` accent.
- **Ops** — War room. Live activity feed, bounty board from `/api/pending-harvests`, permissionless harvest/sweep/deposit cranks. SOL balances for rover_authority + dist_pool shown. Gray `--fg` accent.
- **Recon** — Deferred. Rover TVL leaderboard, top-5 analytics, bribes. Mint `--mint` accent.

## Known issues

- **$BANANAS decimals: 6** — `BANANAS_PER_FEED = 1_000_000_000_000` is correct.
- **Token-2022 transfer hooks unsupported** — All CPI is V2 but transfer hook extra accounts are not resolved. `RemainingAccountsInfo::empty_hooks()` used everywhere.
- **Token-2022 fully supported (Feb 23, session 3).** All 14 outbound transfer calls use `anchor_spl::token_interface::{TransferChecked, transfer_checked}`. Decimals read from mint account data at byte offset 44 via `read_mint_decimals()` helper. SPL Token and Token-2022 pools both work end-to-end. Tested on mainnet with stuck position `3qQGCmDY`.
- **Yellowstone gRPC v5:** `@triton-one/yellowstone-grpc@^5.0.2` requires explicit `await client.connect()` before `client.subscribe()`. The constructor does not establish the gRPC connection.

## Implementation notes

**Transfer CPI fix (DONE — Feb 23, session 3).** All 14 `transfer()` calls replaced with `transfer_checked()` from `anchor_spl::token_interface`. `read_mint_decimals()` helper reads byte offset 44 from mint account data (same layout for SPL Token and Token-2022). `execute_close_transfers()` now takes `token_x_mint: &AccountInfo` and `token_y_mint: &AccountInfo` params. `ApplyEmergencyClose` context gained `token_x_mint`/`token_y_mint` fields (IDL change — admin-only instruction). Deployed to mainnet, verified on stuck Token-2022 position. First fee revenue recycled via `open_fee_rover`.

**All Meteora CPI is V2.** `initialize_position2`, `add_liquidity_by_strategy2`, `remove_liquidity_by_range2`, `claim_fee2`, `close_position2`. No V1 code remains.

**Do not remove `Box<>` wrappers on `InterfaceAccount` / `Account` fields.** These are `Box`ed to avoid BPF 4KB stack frame overflow. Removing any `Box<>` will cause access violations at runtime. Mint fields use `UncheckedAccount` (no Box needed — no deserialization). `CloseRoverTokenAccount.token_account` is unboxed `InterfaceAccount` (single field, fits in frame).

**Rover remaining_accounts (2).** `open_rover_position` and `open_fee_rover` pass `event_authority` + `dlmm_program` via remaining_accounts (BPF stack constraint from init accounts). Only the bot calls these.

**Fee rover CU budget: 1M.** `open_fee_rover` uses 1M compute units in `bot/keeper.ts` (overrides the default 400K). `AddLiquidityByStrategy2` with BidAskImBalanced across 69 bins exceeds 400K CUs. All other bot operations (harvest, close, sweep, deposit) stay at 400K.

**Bot wallet monitoring.** `/api/bot-wallet` endpoint on relay returns: address, balance, net spent since startup, spend rate per hour (rolling 24h window, 288 samples at 5min intervals), estimated hours remaining, status (healthy/warning/critical). Thresholds configurable via `SOL_BALANCE_WARN_LAMPORTS` (default 1 SOL) and `SOL_BALANCE_CRITICAL_LAMPORTS` (default 0.1 SOL) env vars. Bot wallet pays all tx fees, rent for positions/ATAs/rovers. 50% of swept revenue flows back to `Config.bot` via the hardcoded split in `sweep_rover`, self-funding operations.

**`bitmap_ext` is NOT `#[account(mut)]`.** The DLMM program ID placeholder (when no bitmap extension exists) is executable and can't be writable. CPI module uses `bitmap_meta()` helper.

**Source of truth for Meteora CPI:** `ref/dlmm-sdk/` — IDL at `ref/dlmm-sdk/idls/dlmm.json`, SDK at `ref/dlmm-sdk/ts-client/src/dlmm/`. Do not guess discriminators or account layouts.

**Codama clients integrated** into `app.js`. Generated at `src/generated/` from IDL via `node scripts/generate-clients.mjs`. All 10 program instructions use Codama-generated builders. All account deserialization uses Codama decoders. esbuild bundles `@solana/kit` + `src/generated/` into the IIFE output.

**Frontend adapter layer:** Three functions in `app.js` bridge `@solana/kit` types ↔ `@solana/web3.js`:
- `kitIxToWeb3(ix)` — converts Codama `Instruction` to web3.js `TransactionInstruction` (AccountRole bit flags)
- `asSigner(pubkey)` — wraps web3.js `PublicKey` as `@solana/kit` `TransactionSigner` shim
- `toEncodedAccount(pubkey, data, programAddr)` — wraps RPC data for Codama decoders

**What stays manual (external programs, no Codama clients):**
- Meteora LbPair / BinArray parsing (`parseLbPair`, `parseBinArrayData`, `LBPAIR_OFFSETS`)
- Meteora PDAs (`deriveBinArrayPDA`, `deriveEventAuthorityPDA`, `deriveBitmapExtPDA`)
- `resolveMeteoraCPIAccounts` (reads on-chain LbPair for reserves/mints/programs)
- ATA / SystemProgram / SyncNative helpers
- Metaplex metadata PDA
- PDA derivation functions (still needed for ATA resolution and RPC fetches)

## Deployment status

**Mainnet — live, Token-2022 fully operational.** Programs deployed, initialized. Transfer CPI fix deployed (Feb 23 session 3, sig `xvvSGjb...`). All Meteora CPI is V2. Bot verified locally. Frontend verified locally (all 6 pages, relay WebSocket, all 8 tx builders). PM2 + Vercel configs ready.

- **$BANANAS mint:** `ABj8RJzGHxbLoB8JBea8kvBx626KwSfvbpce9xVfkK7w`
- **DAMM v2 pool:** `GxC4SFsT2sJEPjgXziBmCnBkrpvwYzZYWPoWRpTj9jZR`
- **Alpha Vault:** `3Xv442KEA3kkAAaRbPH9YPt3XCsJ8EjjZisGjvgksXd5` (deposits open, trading March 1)
- **Position (locked):** `6MmPrnhPzCSKroURAHVETmrk6i5SJxuS1SqHbcbPMXH9`
- **Position NFT mint:** `CaFB7AsZYA7gXLgXSjByR5wArFWrQTZete4W666X7b4G`
- **Token A vault (BANANAS):** `2nBSPJFyt258bK1LSEQ42RVSSjnsvVzHScuuHVnoGSd1`
- **Token B vault (SOL):** `8vq8yCoUPpt4r53TdPyZZNS3dLr59S76UUu43hV4fWW9`
- **Core config PDA:** `MeTGCG86PTWhnN52yV9ie8oJkgfSLGyuRCFxhDd97i2`
- **Rover authority PDA:** `56UrucGXHYPfsXS8BMZG82UA632fHDB1o6aXWwt9i6PR`
- **MonkeState PDA:** `6DZqJbD3rWzfySHyRASL5nMUsf5WroZvykdf256BNXMo`
- **Dist pool PDA:** `2uZxacLniw264zRpr84qGW4NcYkTv3M448733t6MRK1e`
- **Program vault PDA:** `6r63srLezrtjiYwwoVwMB82o3c7mwz3BUktGiHRq4FxX`

## Next steps — Rebuild, redeploy, E2E testing + infra deployment

Transfer CPI fix done (session 3). 50/50 fee split done (session 4). Token-2022 works end-to-end. Bot and frontend verified locally (Feb 23). Next: rebuild program (`cargo-build-sbf`), redeploy to mainnet, then real-wallet E2E tests with SOL, then deploy to infra. Before deploying bot to server: generate dedicated bot keypair, call `update_bot` to separate bot from authority.

### 1. Bot setup

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Edit bot/.env — fill these three:
#   RPC_URL=<Helius Pro RPC URL>
#   GRPC_ENDPOINT=<Helius LaserStream gRPC URL with ?api-key=XXX>
#   BOT_KEYPAIR_PATH=<path to your keypair JSON>
# All other values (program IDs, DAMM v2 addresses) are pre-filled.
npm run bot
# Verify: curl http://localhost:8080/api/stats
```

Bot runs on port 8080 (health + relay WebSocket at `/ws` + REST at `/api/*`). Frontend connects to `ws://localhost:8080` (already set in `public/config.json` → `BOT_RELAY_URL`).

### 2. Frontend dev server

```bash
node scripts/build-frontend.mjs && npx serve dist
# Serves at http://localhost:3000
```

esbuild bundles `app.js` (resolves `@solana/kit` + `src/generated/` imports) into `dist/app.min.js`. No vite config exists — bare ES module imports require the esbuild bundling step. `public/config.json` has `HELIUS_RPC_URL` for direct RPC and `BOT_RELAY_URL: "ws://localhost:8080"` for relay. Both are already configured for local dev.

### 3. E2E test runbook

Walk through `TODO.md` Tier 2 checklist with wallet connected + real SOL (0.01-0.1 SOL per test). Every instruction path now uses Codama-generated builders — this validates the migration end-to-end.

Test order (matches dependency chain):
1. **Open position** (Trade page) — exercises `getOpenPositionV2InstructionAsync`
2. **Wait for harvest** (Ops feed) — bot calls `harvest_bins` via its own path
3. **Close position** (Positions page) — exercises `getUserCloseInstructionAsync`
4. **Claim LP fees** (Positions page) — exercises `getClaimFeesInstruction`
5. **Feed monke** (Rank page) — exercises `getFeedMonkeInstructionAsync`
6. **Sweep + Deposit** (Ops page) — exercises `getSweepRoverInstructionAsync` + `getDepositSolInstructionAsync`
7. **Claim SOL** (Rank page) — exercises `getClaimInstructionAsync`
8. **Permissionless harvest** (Ops bounty board) — exercises `getHarvestBinsInstructionAsync` from frontend

### After local testing

- Deploy bot to server (PM2 config at `bot/ecosystem.config.cjs`)
- Deploy frontend (Vercel config at `vercel.json`)
- Rotate Helius API key before repo goes public

## Reference docs

| Doc | What it covers |
|-----|---------------|
| `whitepaper.md` | Product narrative, mechanics, gamma scalping thesis, FAQ |
| `src/generated/` | Codama-generated TypeScript clients for bin_farm + monke_bananas (imported by app.js) |
| `TODO.md` | Task list: security, deploy, E2E tests, features, BD |
| `meteora-invent/studio/config/damm_v2_config.jsonc` | DAMM v2 pool + Alpha Vault launch config (executed Feb 16) |