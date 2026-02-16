# monke.army — Frontend Build Plan

**Five experiences: Enlist. Trade. Rank. Ops. Recon.**
**Data backbone: Helius LaserStream gRPC → bot relay → frontend.**
**Design system: military monke pixel art palette. Vanilla JS. No React.**

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              monke.army frontend                     │
│         (vanilla JS, monke design system)            │
├──────────┬───────────────┬───────────────────────────┤
│  READS   │  WRITES       │  WALLET                   │
│  --------|  ----------   │  --------                  │
│  Bot     │  Custom       │  wallet-standard           │
│  relay   │  Anchor CPI   │  or manual detect          │
│  REST +  │  tx builders  │  (Phantom/Solflare/        │
│  WebSocket│              │   Backpack)                │
├──────────┴───────────────┴───────────────────────────┤
│  Helius LaserStream gRPC → bot → relay-server.ts     │
├──────────────────────────────────────────────────────┤
│  bin-farm  │ monke_bananas │ Alpha Vault              │
│  (core)    │ (monke)       │ (Meteora)                │
└────────────┴───────────────┴──────────────────────────┘
```

**Rule:** Never touch the design system. The scaffold geometry, tangent rays, orbital nav, corner arcs, and JetBrains Mono typography are the product. Everything below is plumbing.

---

## Pages

### Pre-launch: Enlist(0). Trade(1). Rank(2). Ops(3). Recon(4).
### Post-launch: Trade(0). Rank(1). Ops(2). Recon(3).

| Page | Idx | What | Sub-pages |
|------|-----|------|-----------|
| Enlist | 0 | Alpha Vault fair launch. Join the army. 2-week countdown → deposit → claim. Pulled after launch. | — |
| Trade | 1 | Your positions, your orders. DLMM harvester (weapon #1). | Future: more products |
| Rank | 2 | Feed your monke, build weight, claim SOL. | Monke + Roster |
| Ops | 3 | War room. LaserStream feed, bounty board, permissionless crank. | — |
| Recon | 4 | Token intelligence. Rover TVL leaderboard, top-5 analytics, bribes. | — |

5-orbit sigil navigator. Enlist is the landing page (first thing users see). After launch, Enlist HTML is removed and Trade becomes page 0 again.

---

## Color System

Derived from the SMB Gen2 military monke pixel art. Every color traces back to the mascot.

```css
:root {
  --bg: #0F1A3A;              /* deep navy (monke outline) */
  --fg: #C4CFCB;              /* cool gray w/ green tint */
  --dim: #607080;             /* navy-gray mid */
  --faint: #1E2D50;           /* dark navy borders */
  --scaffold: #3A5A28;        /* army green (helmet) */
  --scaffold-fill: #4A6A38;   /* army green fills */
  --mint: #9DE5B5;            /* mint green: primary positive (NFT background) */
  --mint-faint: rgba(157, 229, 181, 0.12);
  --bananas: #F2D662;         /* gold: $BANANAS, rank, weight (helmet badge) */
  --bananas-faint: rgba(242, 214, 98, 0.12);
  --sell: #8B4513;            /* warm brown: sell/warning (leather straps) */
  --sell-faint: rgba(139, 69, 19, 0.12);
}
```

Per-page astrolabe accents: Enlist=`--bananas`, Trade=`--mint`, Rank=`--bananas`, Ops=`--fg`, Recon=`--mint`.

---

## Data Backbone: LaserStream Relay

The bot's `geyser-subscriber.ts` already parses raw LbPair data from Helius LaserStream gRPC at CONFIRMED commitment. `relay-server.ts` extends the bot's HTTP server (`:8080`) with:

**REST endpoints:**
- `GET /api/pools` — all watched pools with live data
- `GET /api/pools/{address}` — single pool by address
- `GET /api/positions` — all tracked positions with fill status
- `GET /api/pending-harvests` — bounty board data
- `GET /api/rovers` — rover TVL leaderboard
- `GET /api/rovers/top5` — top 5 with boosted analytics
- `GET /api/stats` — global protocol stats

**WebSocket events (`/ws`):**
- `activeBinChanged` — price moved (from geyser-subscriber)
- `harvestNeeded` — bins ready to harvest (from geyser-subscriber)
- `positionChanged` — position opened/closed (from geyser-subscriber)
- `harvestExecuted` — bot harvested bins (from harvest-executor)
- `positionClosed` — bot closed position (from harvest-executor)
- `roverTvlUpdated` — TVL data refreshed (from keeper)
- `feedHistory` — catch-up events on connect

Frontend opens WebSocket on page load. REST for initial state. WebSocket for real-time updates.

---

## Enlist (page 0, temporary, pre-launch)

Full Alpha Vault SDK integration via `@meteora-ag/alpha-vault`. Page 0 (landing page). Bundled separately via esbuild (`src/enlist.js` → `dist/enlist.bundle.js`). Pulled after launch.

Three phases (only one visible at a time):

**Phase 1 — Pre-deposit (2-week countdown):**
- Large countdown timer (days/hours/mins/secs) to `DEPOSIT_OPENS_AT`
- Hero: "Join the Army"
- Explainer: 420 SOL cap, 100% locked liquidity, zero dev allocation, 69% sniper tax
- Key stats: initPrice (0.000001 SOL), maxBuyingCap (420 SOL), supply (1B), dev allocation (zero)
- Connect wallet CTA

**Phase 2 — Deposit open:**
- SOL input field with max button (reads wallet balance)
- Deposit button → `alphaVault.deposit()`
- Live stats: total deposited, your deposit, your allocation %, vault capacity (X / 420 SOL)
- Withdraw button (pre-activation only)
- Countdown to pool activation

**Phase 3 — Post-activation / Claim:**
- Claim button → `alphaVault.withdraw()` (instant vesting)
- Your $BANANAS balance
- "Feed your monke" CTA → navigates to Rank page
- Pool stats: current price, total liquidity

**SDK:** `src/enlist.js` imports `@meteora-ag/alpha-vault`, bundled via esbuild with `bundle: true`. Phase detection reads vault state + `DEPOSIT_OPENS_AT` timestamp. Stats polling every 30s. Toast notifications via `window.showToast`.

**Config keys:** `ALPHA_VAULT_ADDRESS`, `DEPOSIT_OPENS_AT` (Unix timestamp).

---

## Trade (page 1)

Existing order form (left wing) + positions list (right wing). Mock data replaced with relay.

- `loadPool()` calls `GET /api/pools/{address}` (fallback: direct RPC)
- WebSocket `activeBinChanged` updates price in real-time
- Position creation via Anchor CPI (blocked by deployed programs)
- Featured pools loaded from Recon data

---

## Rank (page 2)

Sub-pages: **Monke** (personal) + **Roster** (public leaderboard).

### Monke
- User's SMB Gen2/Gen3 NFTs via Helius DAS API (`getAssetsByOwner`)
- Per NFT: image, weight (MonkeBurn PDA), claimable SOL
- Feed: burn 1M $BANANAS → `monke_bananas.feed_monke`
- Claim: withdraw SOL → `monke_bananas.claim`
- Buy $BANANAS: Jupiter Terminal embed

### Roster
- Leaderboard of all fed monkes by weight
- MonkeBurn lookup: paste NFT mint, see weight + unclaimed SOL
- Global stats: total burned, total fed, total distributed

---

## Ops (page 3)

The war room.

- **Activity feed:** scrolling real-time LaserStream events via WebSocket
- **Bounty board:** pending harvests from `GET /api/pending-harvests`, "Harvest" / "Harvest All" buttons
- **Crank buttons:** sweep_rover, deposit_sol, compost_monke (always available, permissionless)

---

## Recon (page 4)

Token intelligence. The B2B pitch page + user discovery page.

- **Leaderboard:** rover TVL from `GET /api/rovers`, sorted by TVL
- **Top 5:** expanded analytics cards (price, trade frequency, conversion progress, time-to-conversion, SOL generated)
- **Bribe deposit:** token mint + amount → `core.open_rover_position`
- **Click-to-trade:** click any token → loads that pool into Trade page

---

## Dependencies

```
# Core (already installed)
@solana/web3.js               # Solana client (CDN: unpkg)
@coral-xyz/anchor              # Anchor client (needs IDL files)
@meteora-ag/alpha-vault        # Alpha Vault SDK for Enlist page (installed)
@meteora-ag/dlmm              # Pool reads (fallback when relay offline)

# Bot (already installed)
ws                             # WebSocket server (transitive dep)
@types/ws                      # TypeScript types

# Build
esbuild                        # Bundle SDK imports + minify
```

---

## Current State (what exists in app.js)

All 5 pages have HTML scaffolding, styles, and JS event wiring. What's real vs stubbed:

- **Enlist:** Fully wired to Alpha Vault SDK. 3-phase UI complete. `ALPHA_VAULT_ADDRESS` + `DEPOSIT_OPENS_AT` set in `config.json`.
- **Trade:** Pool loading works via relay REST. WebSocket price updates work. Position creation has demo mode (simulated) with production path commented out. Close is stubbed.
- **Rank:** Monke sub-page has stats grid + NFT list placeholder + claim/feed buttons (all stubbed). Roster has leaderboard + MonkeBurn lookup (stubbed). Jupiter Terminal embed placeholder exists.
- **Ops:** Activity feed wired to relay WebSocket (works live). Stats grid, bounty board, and crank buttons all stubbed with "requires deployed programs" toasts.
- **Recon:** Stats grid, rover leaderboard, top-5 cards, bribe deposit form — all HTML exists, all JS stubbed.

**Cross-cutting that works:** Wallet connect/disconnect (Phantom/Solflare/Backpack), config loading, relay WebSocket + REST, PDA derivation, bin math, fee calc, PNL card canvas renderer, toast system, navigation (5-page + sub-pages), demo mode banner.

---

## Files

```
public/
  index.html       — 5 pages: Enlist/Trade/Rank/Ops/Recon + modals
  styles.css        — monke palette, all page styles + Enlist styles
  app.js            — page logic, relay client, PDA derivation, nav (5 pages)
  config.json       — program IDs, RPC, HELIUS_RPC_URL, BOT_RELAY_URL, ALPHA_VAULT_ADDRESS, DEPOSIT_OPENS_AT

src/
  enlist.js         — Alpha Vault SDK integration (bundled → dist/enlist.bundle.js)

scripts/
  build-frontend.mjs — minify app.js + bundle enlist.js via esbuild

bot/
  relay-server.ts   — WebSocket + REST relay (attached to health server)
```

---

## What NOT to Change

- **Scaffold geometry.** Corner arcs, tangent rays, panel corners — untouchable.
- **Vanilla JS architecture.** No React migration.
- **Typography.** JetBrains Mono 200/300/400 weight system.
- **Color variable names.** `--bg`, `--fg`, `--dim`, `--faint`, `--scaffold`, `--mint`, `--sell`, `--bananas`.
- **PNL card canvas renderer.** Done and distinctive.

---

*Last updated: Feb 16, 2026. Enlist page built (page 0, 3-phase Alpha Vault SDK). Splitter gutted. 5-page nav. Audit fixes applied. Programs deployed + initialized on mainnet. Pool + Alpha Vault live. All addresses in config.json + bot/.env. See TODO.md for build sequencing.*
