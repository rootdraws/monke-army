# monke.army

**Limit orders that earn fees, instead of paying them.** Sell the rips. Buy the dips. Monke's Harvester protects your position against round-trip loss.

Managed Meteora DLMM positions with sub-second bin harvesting via Helius LaserStream and SMB Gen2/Gen3 monke revenue sharing on Solana.

## Programs

| Program | Description |
|---------|-------------|
| `core.rs` | Position management. Open, harvest, close. All CPI via V2 variants (Token-2022 native). Performance fee on converted output — SOL fees → rover_authority → dist_pool, TOKEN fees → rover_authority (BidAskImBalanced DLMM recycling, no market dump). `claim_pool_fees` for DAMM v2 trading fee collection. Permissionless fallback on harvest + close (heartbeat + staleness). Rovers use BidAskImBalanced distribution. Emergency escape hatch for deprecated pools. |
| `monke_bananas.rs` | Feed BANANAS to your Monke. Burn $BANANAS (1M per tx, unlimited stacking) against SMB Gen2 (2x weight) or Gen3 (1x weight) NFTs. MasterChef accumulator. 100% of all fees flow to fed monke holders. `compost_monke`: permissionless cleanup of burned NFTs. |

## How It Works

Users deposit single-sided liquidity into Meteora DLMM bins via the core program — sell the rips (tokens above price) or buy the dips (SOL below price). A vault PDA owns the Meteora position on behalf of the user. As price moves through bins, Monke's Harvester detects fully-converted bins in sub-second via Helius LaserStream gRPC and calls `harvest_bins` to withdraw them. Tokens flow Meteora → vault ATA → owner wallet in a single instruction.

Performance fee (0.3%) is taken on converted output only. All fees flow through rover_authority directly to dist_pool — 100% to monke holders. No splitter, no dev fee, no governance. TOKEN fees route to rover_authority for BidAskImBalanced DLMM recycling — no market dumping on thin meme pools. DAMM v2 $BANANAS/SOL trading fees are claimed via `claim_pool_fees` through rover_authority. Unconverted deposits return untaxed.

### Key Instructions

```
open_position_v2(pool, amount, min_bin, max_bin, side, max_active_bin_slippage)
  → No fee. 100% deposited into Meteora bins.
  → `side` is derived on-chain from active_id (parameter ignored).
  → Token-2022 native. All CPI via V2 variants.

harvest_bins(bin_ids: Vec<i32>)
  → SOL fees → rover_authority → dist_pool (100% to monke holders). TOKEN fees → rover_authority (DLMM recycling)
  → Remainder → owner. Position stays open.
  → Permissionless fallback: anyone can call when bot is stale (~40s),
    earns keeper_tip_bps (10%) of the fee.

close_position()
  → Same fee mechanic + permissionless fallback.
  → Meteora position closed, rent refunded to owner.

user_close()
  → User-initiated close. Same fee. No free exits.

feed_monke(nft_mint)
  → Burn 1M $BANANAS, assigned to an SMB Gen2 or Gen3 NFT you hold.
  → Gen2 = +2 weight, Gen3 = +1 weight per feed. Burns stack. No cap.

compost_monke()
  → Permissionless. Clean up MonkeBurn PDA for burned NFTs (supply == 0).
  → Subtracts dead weight. Rent refund to caller.

open_rover_position(amount, bin_step)
  → Anyone deposits bribe tokens into sell-side BidAskImBalanced DLMM position.
  → active_id read from on-chain lb_pair (never trust caller).
  → Position owned by rover_authority PDA. One-way. No refunds.

open_fee_rover(amount, bin_step)
  → Bot-gated. Opens BidAskImBalanced position from accumulated fee tokens
    in rover_authority ATAs. Bot pays rent.

sweep_rover()
  → Permissionless. SOL from rover_authority → dist_pool (100% to monke holders).

close_rover_token_account()
  → Permissionless. Closes any token account owned by rover_authority.
  → For WSOL: unwraps to native SOL on rover_authority (picked up by sweep_rover).
  → For empty ATAs: reclaims rent to rover_authority.

claim_pool_fees()
  → Permissionless. Claims DAMM v2 trading fees to rover_authority.
  → CPI into DAMM v2 program, rover_authority PDA signs as position owner.
  → SOL accumulates in rover_authority → sweep_rover moves it to dist_pool.
```

### Bin Detection Logic — Sell the Rips, Buy the Dips

```
SELL THE RIPS (token deposited above price → SOL output):
  Safe bins = bins where binId < activeId (price ripped above them)
  These hold Y (SOL). Harvest Y.

BUY THE DIPS (SOL deposited below price → token output):
  Safe bins = bins where binId > activeId (price dipped below them)
  These hold X (token). Harvest X.
```

## Project Structure

```
bin-farm/
├── programs/                      # Anchor workspace (build targets)
│   ├── bin-farm/src/
│   │   ├── lib.rs                 # Core program (positions, harvest, close, fees, rovers)
│   │   └── meteora_dlmm_cpi.rs   # Meteora DLMM CPI wrappers (V2 only)
│   └── monke-bananas/src/lib.rs   # Burn $BANANAS, stack weight, claim SOL, compost dead monkes
├── src/
│   ├── contracts/                 # Reference copies (keep in sync with programs/)
│   ├── enlist.js                  # Alpha Vault SDK integration (bundled → dist/enlist.bundle.js)
│   ├── sdk/
│   │   └── meteora.js             # DLMM wrapper (read-only queries + fill%)
│   ├── utils/
│   │   ├── transaction.js         # TX builders (Anchor discriminator + borsh)
│   │   └── bins.js                # Bin/price math utilities
│   └── hooks/
│       └── useWallet.js           # Multi-wallet connection (wallet-adapter)
├── bot/                           # Monke's Harvester (off-chain infrastructure)
│   ├── anchor-harvest-bot.ts      # Orchestrator + health endpoint + relay wiring
│   ├── geyser-subscriber.ts       # Helius LaserStream gRPC — sub-second bin detection
│   ├── relay-server.ts            # WebSocket + REST relay for frontend (/ws + /api/*)
│   ├── meteora-accounts.ts        # Shared Meteora CPI account resolution + DLMM cache
│   ├── harvest-executor.ts        # Job queue: harvest/close tx (emits events to relay)
│   ├── keeper.ts                  # MonkeKeeper: Saturday sequencer + rover TVL computation
│   ├── retry.ts                   # Shared withRetry (exponential backoff, 3 retries)
│   └── logger.ts                  # Pino structured logging
├── public/                        # Frontend: Enlist / Trade / Positions / Rank / Ops / Recon
│   ├── index.html                 # 6 pages (Enlist/Trade/Positions/Rank/Ops/Recon) + sigil astrolabe
│   ├── styles.css                 # Military monke color palette + all page styles
│   ├── app.js                     # Page logic, relay WebSocket client, Codama instruction builders
│   └── config.json                # Program IDs, RPC, BOT_RELAY_URL, ALPHA_VAULT_ADDRESS
├── scripts/
│   ├── deploy-and-init.mjs        # Deploy + init atomically (anti-front-run)
│   ├── build-frontend.mjs         # Frontend build: bundle app.js (Codama + @solana/kit) + enlist.js
│   └── generate-clients.mjs       # Codama client generation from IDL → src/generated/
├── meteora-invent/                # Meteora DAMM v2 launch toolkit (cloned)
│   └── studio/config/damm_v2_config.jsonc  # $BANANAS pool + Alpha Vault config (locked params)
├── Anchor.toml                    # Workspace config (2 programs, devnet + mainnet)
├── Cargo.toml                     # Workspace root
├── whitepaper.md                  # Product overview + mechanics
├── TODO.md                        # Task list
├── ref/dlmm-sdk/                  # Cloned Meteora DLMM SDK (source of truth for CPI layouts)
└── src/generated/                 # Codama-generated TypeScript clients
```

## Build & Deploy

```bash
npm install

# Build program (Homebrew cargo doesn't support +toolchain — use rustup cargo)
PATH="$HOME/.cargo/bin:$PATH" cargo-build-sbf --manifest-path programs/bin-farm/Cargo.toml

# Deploy / upgrade (upgrade authority required)
solana program deploy target/deploy/bin_farm.so \
  --program-id 8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia \
  --url mainnet-beta

# First-time deploy + initialize atomically (prevents front-running)
BOT_PUBKEY=<bot-key> BANANAS_MINT=<mint> \
  node scripts/deploy-and-init.mjs --cluster mainnet

# Verify no one front-ran initialization
node scripts/deploy-and-init.mjs --verify-only
```

Note: `blake3` pinned to 1.5.5, `borsh` pinned to 1.5.5. If you `cargo update`, re-pin both:
```bash
cargo update -p blake3 --precise 1.5.5
cargo update -p borsh@1.6.0 --precise 1.5.5
```

### IDL & Client Generation

```bash
# Generate IDL from on-chain program structs (Anchor 0.31.1)
anchor idl build -p bin_farm -o bot/idl/bin_farm.json
anchor idl build -p monke_bananas -o bot/idl/monke_bananas.json

# Generate Codama TypeScript clients from IDL
node scripts/generate-clients.mjs
# Output: src/generated/bin-farm/ + src/generated/monke-bananas/
```

Regenerate after any on-chain struct change. IDL files at `bot/idl/` are used by the bot's Anchor client. Codama clients at `src/generated/` provide typed instruction builders and account decoders for the frontend (`app.js` imports them via esbuild bundling).

## Run Monke's Harvester

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Edit bot/.env — set RPC_URL, GRPC_ENDPOINT, BOT_KEYPAIR_PATH, etc.
npm run bot
```

Required env vars: `RPC_URL`, `GRPC_ENDPOINT`, `BOT_KEYPAIR_PATH`, `CORE_PROGRAM_ID`, `MONKE_BANANAS_PROGRAM_ID`, `BANANAS_MINT`. Plus DAMM v2 vars when pool is live: `DAMM_V2_POOL`, `DAMM_V2_POSITION`, `DAMM_V2_POSITION_NFT`, `DAMM_V2_TOKEN_A_MINT`, `DAMM_V2_TOKEN_B_MINT`, `DAMM_V2_TOKEN_A_VAULT`, `DAMM_V2_TOKEN_B_VAULT`.

Saturday sequence:
1. Claim DAMM v2 pool trading fees → rover_authority
2. Close WSOL ATAs on rover_authority (unwrap to native SOL)
3. Sweep SOL from rover_authority → dist_pool
4. Open fee rover positions from accumulated token fees (BidAskImBalanced DLMM)
5. Deposit SOL from dist_pool → monke program vault → accumulator
6. Close exhausted rover positions (reclaim rent)

Plus: sub-second harvest via LaserStream, permissionless fallback on all operations (harvest, close, sweep, deposit — anyone can crank when bot is stale and earn a tip), 5-minute safety poll, adaptive intervals, health endpoint.

## Run Frontend

```bash
node scripts/build-frontend.mjs && npx serve dist   # local dev
npm run build:frontend && npx serve dist             # production
```

Frontend pages: **Enlist** (Alpha Vault fair launch — temporary landing page), **Trade** (DLMM harvester, default SOL/USDC pool), **Positions** (all wallet positions with inline close + claim fees), **Rank** (monke feed/claim + leaderboard, sub-pages: Monke + Roster), **Ops** (bounty board + permissionless crank + live stats from relay), **Recon** (rover TVL — deferred). 6-page navigation with sigil astrolabe. Bot relay provides live data via WebSocket (`/ws`) and REST (`/api/*`) on the same health server port.

## Mainnet Addresses

### Programs

| Program | Address |
|---------|---------|
| core (bin_farm) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| monke_bananas | `myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH` |

### Token

| Item | Address |
|------|---------|
| $BANANAS Mint | `ABj8RJzGHxbLoB8JBea8kvBx626KwSfvbpce9xVfkK7w` |

### DAMM v2 Pool

| Item | Address |
|------|---------|
| Pool | `GxC4SFsT2sJEPjgXziBmCnBkrpvwYzZYWPoWRpTj9jZR` |
| Alpha Vault | `3Xv442KEA3kkAAaRbPH9YPt3XCsJ8EjjZisGjvgksXd5` |
| Position (locked) | `6MmPrnhPzCSKroURAHVETmrk6i5SJxuS1SqHbcbPMXH9` |
| Position NFT Mint | `CaFB7AsZYA7gXLgXSjByR5wArFWrQTZete4W666X7b4G` |
| Token A Vault (BANANAS) | `2nBSPJFyt258bK1LSEQ42RVSSjnsvVzHScuuHVnoGSd1` |
| Token B Vault (SOL) | `8vq8yCoUPpt4r53TdPyZZNS3dLr59S76UUu43hV4fWW9` |

### PDAs

| PDA | Address | Program |
|-----|---------|---------|
| Core Config | `MeTGCG86PTWhnN52yV9ie8oJkgfSLGyuRCFxhDd97i2` | core |
| Rover Authority | `56UrucGXHYPfsXS8BMZG82UA632fHDB1o6aXWwt9i6PR` | core |
| MonkeState | `6DZqJbD3rWzfySHyRASL5nMUsf5WroZvykdf256BNXMo` | monke_bananas |
| Dist Pool | `2uZxacLniw264zRpr84qGW4NcYkTv3M448733t6MRK1e` | monke_bananas |
| Program Vault | `6r63srLezrtjiYwwoVwMB82o3c7mwz3BUktGiHRq4FxX` | monke_bananas |

### Launch Parameters

- **Init Price:** 0.000001 SOL/token (1 SOL = 1M BANANAS = 1 monke feed)
- **Alpha Vault:** Pro-rata, 420 SOL max buying cap, permissionless
- **Deposit Window:** Feb 16, 2026 → March 1, 2026
- **Activation:** March 1, 2026 00:00 UTC (trading begins)
- **Vesting:** Instant (1s after activation)
- **Fee Decay:** 69% → 1% over 3 hours (sniper tax)
- **Liquidity:** 100% permanently locked to rover_authority. No dev allocation.
- **Supply:** 1,000,000,000 BANANAS (6 decimals). Mint/freeze/update authorities revoked.

## SMB Integration — Feed Your Monke

- **Gen2 Collection:** `SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W` — **2x weight per feed**
- **Gen3 Collection:** `8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH` — **1x weight per feed**
- **Burn:** 1,000,000 $BANANAS per `feed_monke` call (6 decimals enforced at init)
- **Stacking:** Unlimited. Per-NFT `MonkeBurn` PDA tracks cumulative weight.
- **Revenue:** 100% of all protocol fees + all rover proceeds + DAMM v2 trading fees flow to fed monke holders
- **Claiming:** Weight and unclaimed SOL travel with the NFT on secondary sales.
- **Cleanup:** `compost_monke` — permissionless removal of dead weight when NFT is burned (supply == 0)

## Known Limitations

- **Token-2022 outbound transfer CPI (in progress):** Account validation accepts Token-2022 mints/ATAs, and all Meteora CPIs succeed. However, the program's own outbound transfers (fee routing, owner payouts) use `anchor_spl::token::transfer` which fails for Token-2022 accounts. Fix in progress: migrate to `anchor_spl::token_interface::transfer_checked`. SPL Token-only pools work end-to-end. See `TODO.md` BLOCKER section.

- **Token-2022 Transfer Fee mints:** Once the transfer CPI fix lands, tokens with the Transfer Fee extension will work end-to-end, but the recipient receives slightly less than displayed. The protocol's delta-based fee calculation is accurate, but downstream transfers also incur the token's built-in transfer fee. Economic impact bounded by the token's fee rate (typically <2%).

- **Token-2022 Transfer Hook mints:** Mints with the Transfer Hook extension are **not supported**. Transfer hook extra accounts are not resolved (`RemainingAccountsInfo::empty_hooks()` used everywhere). Add when demand exists.

## Dependencies

- Solana CLI 3.0+ (Agave) or 1.18+
- Anchor 0.31.1
- Rust (via rustup)
- Node.js 18+
- Meteora DLMM SDK (`@meteora-ag/dlmm`)
- Meteora Alpha Vault SDK (`@meteora-ag/alpha-vault`)
- Helius LaserStream gRPC (`@triton-one/yellowstone-grpc`)
- tsx (TypeScript execution for bot)
- `@solana/kit` (Codama-generated client runtime)
- esbuild (build: bundle + minify)

## License

MIT
