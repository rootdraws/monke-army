# claude.md — monke.army codebase context

## Solana development skills — MANDATORY

**You MUST read the relevant skill files below BEFORE writing any Solana program code, bot code, security review, or frontend transaction code. Do not skip this. Read the file first, then write code.**

- **Security checklist:** `ref/solana-dev-skill/skill/security.md`
- **Anchor programs:** `ref/solana-dev-skill/skill/programs-anchor.md`
- **Testing:** `ref/solana-dev-skill/skill/testing.md`
- **IDL + codegen:** `ref/solana-dev-skill/skill/idl-codegen.md`
- **Frontend:** `ref/solana-dev-skill/skill/frontend-framework-kit.md`
- **Token-2022:** `ref/solana-dev-skill/skill/confidential-transfers.md`
- **Full skill index:** `ref/solana-dev-skill/skill/SKILL.md`

Additional security references: `ref/awesome-solana-security/README.md`

---

**Limit orders that earn fees, instead of paying them.**

monke.army wraps Meteora DLMM positions on Solana. Set your range as a single-sided LP — **sell the rips** or **buy the dips**. If price moves through your range, Monke's Harvester protects your position against round-trip loss by pulling each bin the moment it converts.

Performance fee on converted output only (0.3%). 100% of fees to SMB Gen2/Gen3 monke holders who have fed their monke $BANANAS. No dev fee, no split, no governance. Gen2 gets 2x weight per feed, Gen3 gets 1x.

## Architecture

Two on-chain programs. No governance. No staking. No voting.

- **core.rs** — Position management (open, harvest, close, claim fees) + rover system + DAMM v2 fee claiming. Token-2022 V1/V2 CPI branching. Memo CPI on all outbound transfers. `open_position` (SPL Token) + `open_position_v2` (Token-2022 compatible). **Fee routing:** All fees → rover_authority ATAs. SOL fees (Sell side) → `rover_fee_token_y` (WSOL ATA on rover_authority) → `close_rover_token_account` (unwrap) → `sweep_rover` → dist_pool. TOKEN fees (Buy side) → `rover_fee_token_x` (rover_authority ATA) for BidAskOneSide DLMM recycling (no market dump on thin meme pools). **Side derivation:** `open_position` and `open_position_v2` derive `side` (Buy/Sell) from on-chain `active_id` — user parameter ignored. Prevents fee evasion. **`claim_pool_fees`:** CPI into DAMM v2 to claim trading fees from $BANANAS/SOL pool, rover_authority PDA signs as position owner, permissionless crank. Rover ATAs validated before CPI. Discriminator hardcoded. **`close_rover_token_account`:** Permissionless — closes any token account owned by rover_authority (unwraps WSOL to native SOL, reclaims rent for empty ATAs). Destination always rover_authority itself. **Permissionless fallback:** harvest, close, and sweep all use heartbeat + staleness pattern — anyone can call when bot is stale, earns `keeper_tip_bps`. **Rovers:** BidAskOneSide distribution (more tokens at higher bins). `open_rover_position` (external deposits) and `open_fee_rover` (bot-gated fee recycling) both read `active_id` directly from lb_pair on-chain (never trust caller). `sweep_rover` sends SOL to dist_pool (`revenue_dest` — timelocked propose/apply). **Emergency:** `propose_emergency_close` / `apply_emergency_close` (24hr timelocked, transfers any remaining vault tokens to owner as part of closing) for deprecated Meteora pools. Config has 96-byte `_reserved`, RoverAuthority has 64-byte `_reserved` for future fields.
- **monke_bananas.rs** — Feed BANANAS to your Monke. Burn $BANANAS (1M per tx, unlimited stacking) against SMB Gen2 or Gen3 NFTs. **Gen2 = 2x weight, Gen3 = 1x weight per feed.** Per-NFT `MonkeBurn` PDA tracks weight. MasterChef accumulator. Claim always works when paused. `compost_monke`: permissionless cleanup of burned NFTs (supply==0) — subtracts dead weight, closes PDA, rent to caller. MonkeState has 64-byte `_reserved` for future fields. SMB Gen2: `SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W`. SMB Gen3: `8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH`. Initialize validates `bananas_mint.decimals == 6`.

## File map

```
programs/                        — Anchor workspace (build targets)
  bin-farm/src/
    lib.rs                       — core.rs (positions, harvest, close, fees, ROVER)
    meteora_dlmm_cpi.rs          — CPI module (V1 + V2 + BidAskOneSide)
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

src/
  enlist.js                      — Alpha Vault SDK integration (bundled → dist/enlist.bundle.js)

public/                          — Frontend: Enlist / Trade / Rank / Ops / Recon
  app.js                         — All page logic, relay WebSocket client, PDA derivation
  index.html                     — 5 pages (Enlist/Trade/Rank/Ops/Recon), 5-orbit astrolabe
  styles.css                     — Military monke color system, all page styles + Enlist
  config.json                    — Program IDs, RPC, HELIUS_RPC_URL, BOT_RELAY_URL, ALPHA_VAULT_ADDRESS

scripts/
  deploy-and-init.mjs            — Deploy + initialize both programs (anti-front-run)
  build-frontend.mjs             — Minify app.js + bundle enlist.js via esbuild

meteora-invent/                  — Meteora DAMM v2 launch toolkit (cloned)
  studio/config/damm_v2_config.jsonc — $BANANAS pool + Alpha Vault config

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

100% of fees go to monke holders. No splitter, no dev fee, no governance.

```
Three fee inputs → one destination:

1. Sell-side position fees (SOL)
     harvest/close → rover_authority WSOL ATA → close_rover_token_account (unwrap)
     → sweep_rover → dist_pool

2. Buy-side token fees + rover bribe proceeds
     rover_authority ATA → open_fee_rover (BidAskOneSide DLMM)
     → natural trading converts → SOL → sweep_rover → dist_pool

3. DAMM v2 $BANANAS/SOL trading fees (SOL via collectFeeMode=1)
     claim_pool_fees → SOL in rover_authority → sweep_rover → dist_pool

All → dist_pool → deposit_sol → program_vault → fed monke holders claim
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

`anchor build --no-idl` (IDL gen skipped — `anchor-syn` incompatible with Rust 1.93). `blake3` pinned to 1.5.5. `init-if-needed` enabled for monke_bananas. `solana-program = "=1.18.26"` for core. No `mpl-token-metadata` dep — raw Metaplex byte parsing.

## Frontend pages

**Pre-launch:** Enlist(0). Trade(1). Rank(2). Ops(3). Recon(4). 5-orbit sigil astrolabe.
**Post-launch:** Trade(0). Rank(1). Ops(2). Recon(3).

- **Enlist** — Alpha Vault fair launch (page 0, landing page). 3 phases: 2-week countdown → deposit SOL → claim $BANANAS. `src/enlist.js` bundled via esbuild with `@meteora-ag/alpha-vault` SDK. Gold `--bananas` accent. Pulled after launch.
- **Trade** — DLMM harvester. Order form + positions. Live data from relay. Mint `--mint` accent.
- **Rank** — Sub-pages: Monke (feed/claim) + Roster (leaderboard/lookup). Gold `--bananas` accent.
- **Ops** — War room. LaserStream feed, bounty board, permissionless crank. Gray `--fg` accent.
- **Recon** — Token intelligence. Rover TVL leaderboard, top-5 analytics, bribes. Click-to-trade. Mint `--mint` accent.

## Known issues

- **$BANANAS decimals: 6** — `BANANAS_PER_FEED = 1_000_000_000_000` is correct.
- **Token-2022 transfer hooks unsupported** — V1/V2 branching works but transfer hook extra accounts are not resolved.

## Deployment status (Feb 16, 2026)

**Mainnet — live.** Programs deployed, initialized, authorities verified. Pool + Alpha Vault live. LP permanently locked.

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

## Next steps

1. Provision bot server, start keeper (Phase 3)
2. E2E smoke test (full loop with 0.1 SOL)
3. Wire remaining frontend tx building (Trade, Rank, Ops, Recon) — see `frontend-dev.md`

## Reference docs

| Doc | What it covers |
|-----|---------------|
| `whitepaper.md` | Product narrative, mechanics, gamma scalping thesis, FAQ |
| `frontend-dev.md` | Frontend build plan — Enlist/Trade/Rank/Ops/Recon + LaserStream relay |
| `TODO.md` | Deploy checklist + fair launch + funding + audit fixes |
| `TODO.md` Blockers section | Known blockers and dependencies for frontend + deployment |
| `meteora-invent/studio/config/damm_v2_config.jsonc` | DAMM v2 pool + Alpha Vault launch config (executed Feb 16) |