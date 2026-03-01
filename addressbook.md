# Address Book — Implementation Plan

**Replace raw lb_pair paste with token CA search, Meteora trending feed, and a server-side address book that silently remembers every pool a user trades — ranked by relevance, not polluted by dead memecoins.**

---

## Problem

The trade page has a single text input for a DLMM pool address. Users must paste a raw `lb_pair` base58 address and click "load." This is bad UX because:

1. Users know token CAs (contract addresses), not DLMM pool addresses
2. There are ~100K DLMM pools — no way to browse or discover
3. Nothing persists — refresh the page and you're back to the default pool
4. No history — "what was that memecoin I traded yesterday?"

---

## Solution

Three layers, each independent but composable:

1. **Token CA input + pool picker** — paste a token CA, see matching DLMM pools, pick one
2. **Trending feed** — top pools by volume shown on the trade page, one click to load
3. **Server-side address book** — the relay bot already tracks every position by owner and pool; a new endpoint serves the user's pool history, ranked and pruned, with zero on-chain writes or wallet interactions

---

## Why Server-Side, Not On-Chain

The original idea was a Metaplex Core NFT with AppData. After analysis, the server-side approach wins on every axis that matters:

| | Server-side (relay) | On-chain (AppData NFT) |
|-|---|---|
| **Cost to user** | Free | ~0.003 SOL first time, tx fees per write |
| **Wallet interactions** | Zero | Extra tx per trade (signAllTransactions) |
| **Capacity** | Unlimited | ~25 entries (tx size limit) |
| **Dead pool filtering** | Server enriches with live Meteora data | Client must fetch separately |
| **Ranking/sorting** | Server-side, tunable without redeploy | Client-side only |
| **Includes closed positions** | Yes (historical) | Only what was written |
| **Implementation effort** | ~1 relay endpoint + frontend fetch | Umi SDK, mpl-core, signAllTransactions, esbuild config |
| **Availability** | Depends on DO server | Always on-chain |
| **Portability** | Locked to monke.army | User-owned, readable by any app |

The portability/on-chain angle is cool but not needed for "the platform remembers." It can be added later as a "trade passport" feature if there's demand. See Phase 2 at the bottom of this doc.

---

## Current Frontend Architecture

Understanding the existing code is critical for integration.

### Script loading

- `@solana/web3.js` loaded via CDN IIFE → `window.solanaWeb3` global
- `public/app.js` uses ES module imports → bundled by esbuild into `dist/app.min.js`
- Imports: `@solana/kit` (for `address()` helper), Codama-generated clients from `src/generated/`
- Build script: `scripts/build-frontend.mjs` — esbuild with IIFE output format

### Trade page HTML (index.html lines 82-150)

```html
<div class="site-page active" id="page-trade">
  <div class="trade-layout">
    <!-- LEFT: bin visualization canvas -->
    <div class="trade-left-panel">...</div>

    <!-- RIGHT: order form -->
    <div class="trade-right-panel">
      <div class="trade-order-form">
        <!-- THIS IS WHAT WE'RE CHANGING -->
        <div class="pool-section">
          <input type="text" class="pool-input" id="poolAddress"
                 placeholder="DLMM pool address" value="">
          <button class="load-btn" id="loadPool">load</button>
        </div>

        <div class="pool-info" id="poolInfo">
          <div class="pool-stat">Pool: <span id="poolName">—</span></div>
          <div class="pool-stat">Price: <span id="currentPrice">—</span></div>
        </div>

        <!-- side tabs, range inputs, amount, action button below -->
      </div>
    </div>
  </div>
</div>
```

### Pool loading flow (app.js)

`loadPool()` at line 1018:
1. Reads `#poolAddress` input value
2. Validates as PublicKey
3. Tries bot relay: `relayFetch('/api/pools/' + addr)` — returns activeId, binStep, symbols, mints
4. Fallback: `parseLbPair(addr)` — reads raw 904-byte LbPair account via RPC
5. Resolves token symbols via `resolveTokenSymbol()` (Helius DAS `getAsset`)
6. Fetches decimals via `getMintDecimals()`
7. Computes price via `binToPrice()`
8. Updates DOM: pool name, price, makes `#poolInfo` visible
9. Calls `updateSide()`, `loadBinVizData()`, `refreshPositionsList()`

Key validation: `parseLbPair()` checks `accountInfo.data.length !== 904` — this is how we detect "not an lb_pair" and trigger the token CA search flow.

### Position creation flow (app.js)

`createPosition()` at line 1667. No changes needed for address book — the relay detects new positions via gRPC automatically.

### State object (app.js line 614)

```javascript
const state = {
  poolAddress: null,    // string — loaded lb_pair address
  activeBin: null,      // int — current active bin ID
  binStep: 10,          // int
  tokenXSymbol: 'TOKEN', tokenYSymbol: 'SOL',
  tokenXMint: null, tokenYMint: null,
  tokenXDecimals: 9, tokenYDecimals: 9,
  currentPrice: null,
  // ... wallet, positions, navigation
};
```

New fields needed:
```javascript
  addressBook: { active: [], recent: [] },  // from relay /api/addressbook
  trendingPools: [],                         // from Meteora API
```

### Token symbol cache (app.js line 936)

```javascript
const KNOWN_TOKENS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  // ... 8 entries total
};
```

The Meteora DataPI response includes full token metadata (name, symbol, decimals, price), so pool picker results can populate this cache.

---

## 1. Meteora DataPI — Pool Discovery

### API Reference

**Base URL:** `https://dlmm.datapi.meteora.ag`
**Rate limit:** 30 RPS
**Auth:** None

### Endpoints used

**GET `/pools`** — paginated pool list with sort

| Param | Type | Example |
|-------|------|---------|
| `page_size` | int | `10` (default 10, max 100) |
| `page` | int | `1` (1-indexed) |
| `sort_by` | string | `volume_24h:desc`, `tvl:desc`, `fee_tvl_ratio:desc` |

**GET `/pools/groups`** — pools grouped by token pair

| Param | Type | Example |
|-------|------|---------|
| `page_size` | int | `10` |
| `sort_by` | string | `volume_24h:desc` |

**GET `/pools/groups/{lexical_order_mints}`** — all pools for a specific token pair

The `{lexical_order_mints}` path param is both mint addresses joined with `-`, sorted lexicographically. Example for BONK-SOL:
```
DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263-So11111111111111111111111111111111111111112
```

Returns all pools (different bin steps) for that pair, with sort/pagination.

**GET `/pools/{address}`** — single pool detail

### Response shape (from `/pools`)

```json
{
  "total": 99432,
  "pages": 9944,
  "current_page": 1,
  "page_size": 10,
  "data": [
    {
      "address": "BGm1tav58oGc...",
      "name": "SOL-USDC",
      "token_x": {
        "address": "So111...",
        "name": "Wrapped SOL",
        "symbol": "SOL",
        "decimals": 9,
        "is_verified": true,
        "holders": 3820662,
        "price": 84.72,
        "market_cap": 48262681187
      },
      "token_y": {
        "address": "EPjFW...",
        "name": "USD Coin",
        "symbol": "USDC",
        "decimals": 6,
        "is_verified": true,
        "price": 1.0,
        "market_cap": 8970098169
      },
      "pool_config": {
        "bin_step": 10,
        "base_fee_pct": 0.1,
        "max_fee_pct": 0.0,
        "protocol_fee_pct": 5.0
      },
      "tvl": 5291752.33,
      "current_price": 84.77,
      "apr": 0.7519,
      "volume": {
        "30m": 732510, "1h": 1374743, "2h": 3388417,
        "4h": 6954488, "12h": 16948635, "24h": 40486843
      },
      "fees": { "30m": 722, "1h": 1346, "24h": 39788 },
      "fee_tvl_ratio": { "30m": 0.0136, "24h": 0.7519 },
      "is_blacklisted": false,
      "is_verified": true,
      "has_farm": false
    }
  ]
}
```

### Legacy API (fallback)

**Base URL:** `https://dlmm-api.meteora.ag`

**GET `/pair/all_with_pagination`** — paginated, sortable

| Param | Example |
|-------|---------|
| `page` | `0` (0-indexed) |
| `limit` | `10` |
| `sort_key` | `volume` |
| `order_by` | `desc` |

Response shape: `{ pairs: [...], total: N }`. Each pair has `address`, `name`, `mint_x`, `mint_y`, `bin_step`, `liquidity`, `trade_volume_24h`, `fees_24h`, `current_price`, `apr`, `is_blacklisted`, `is_verified`, `volume: { min_30, hour_1, ... }`, `fees: { ... }`, `fee_tvl_ratio: { ... }`.

Does NOT include token metadata (name, symbol, decimals, price) — only mints. Symbols must be resolved via `resolveTokenSymbol()`.

### Token CA to pool resolution strategy

When the user pastes a token CA (not a valid lb_pair):

1. **Detect it's a token CA, not an lb_pair:**
   - Try `parseLbPair(addr)` — if account is not 904 bytes, it's not an lb_pair
   - If RPC returns a ~82-byte mint account, it's a token mint
   - Can also check `getParsedAccountInfo` and look for `parsed.type === 'mint'`

2. **Find all DLMM pools containing that token:**
   - **Recommended: pair-specific group lookup** with SOL and USDC as assumed quote tokens. If the user pastes a token CA, try:
     1. `GET /pools/groups/{mint}-So111...112` (token/SOL pair)
     2. `GET /pools/groups/{mint}-EPjFW...Dt1v` (token/USDC pair)
     3. Both calls in parallel, merge results, sort by `volume_24h:desc`
     4. Note: the `{lexical_order_mints}` key requires mints sorted lexicographically — compare the two strings and order accordingly
   - **Fallback:** if no results, try the legacy API `GET https://dlmm-api.meteora.ag/pair/all_by_groups` (returns ALL pools ~1MB, cache client-side for 60s, filter by mint)

3. **Show picker with matching pools:**
   - Each result shows: pair name, bin step, 24h volume, TVL, current price
   - Sorted by volume (highest first)
   - Click → set `#poolAddress` to the lb_pair address, call `loadPool()`

### Trending feed strategy

On trade page init:
```
GET https://dlmm.datapi.meteora.ag/pools?sort_by=volume_24h:desc&page_size=10
```
Returns top 10 pools by 24h volume with full token metadata. Render as clickable pills/cards above the pool input. Refresh every 60s.

---

## 2. Server-Side Address Book

### Data already available

The bot's `geyser-subscriber.ts` maintains a live position registry:
- `positions: Map<string, PositionInfo>` — every active position, keyed by PDA
- Each `PositionInfo` has: `positionPDA`, `lbPair` (PublicKey), `owner` (PublicKey), `minBinId`, `maxBinId`
- `positionsByPool: Map<string, Set<string>>` — positions grouped by pool

The bot also tracks position lifecycle events via gRPC: `positionChanged` with `action: 'created' | 'closed'`.

### What we need to add

**Persistent per-wallet pool history** on the bot server. When a position is created or detected, record `{ wallet, lbPair, timestamp }`. When all positions on a pool are closed, record the close timestamp.

**Storage:** A simple JSON file on disk (`data/addressbook.json`), loaded into memory on startup. Structure:

```typescript
interface AddressBookStore {
  // wallet → pool → entry
  [wallet: string]: {
    [lbPair: string]: {
      firstSeen: number;    // unix timestamp — first position opened
      lastActive: number;   // unix timestamp — most recent position opened
      closedAt: number | null; // unix timestamp when last position closed (null = still active)
      positionCount: number; // lifetime positions on this pool
    }
  }
}
```

**Write triggers:**
- `geyser-subscriber` emits `positionChanged` with `action: 'created'` → upsert entry, set `lastActive = now`, `closedAt = null`, increment `positionCount`
- `geyser-subscriber` emits `positionChanged` with `action: 'closed'` → if no remaining positions for this wallet+pool, set `closedAt = now`
- Persist to disk every 60s (debounced) — same pattern as `positions-cache.json`

### New relay endpoint

```
GET /api/addressbook?wallet=<pubkey>
```

**Response:**

```json
{
  "active": [
    {
      "pair": "6oFWm7KPLfxn...",
      "name": "BONK/SOL",
      "binStep": 8,
      "openPositions": 2,
      "lastActive": 1709312400,
      "volume24h": 916028,
      "tvl": 333314,
      "alive": true
    }
  ],
  "recent": [
    {
      "pair": "3C5YE97HADPD...",
      "name": "TRUMP/USDC",
      "binStep": 10,
      "openPositions": 0,
      "lastActive": 1709226000,
      "closedAt": 1709280000,
      "volume24h": 20051473,
      "tvl": 13663377,
      "alive": true
    }
  ],
  "wallet": "<pubkey>",
  "timestamp": 1709312400
}
```

### Ranking and filtering logic

The relay handler computes the response tiers:

**"active"** — pools where the user currently has open positions:
- Filter: `closedAt === null` AND position registry confirms open positions
- Sort: `lastActive` descending (most recently traded first)
- No limit — show all active pools (typically 1-5)

**"recent"** — pools where all positions are closed, traded in last 14 days:
- Filter: `closedAt !== null` AND `closedAt > now - 14 days`
- **Dead pool pruning:** For each pool, check Meteora DataPI (cached) — if `volume_24h === 0` AND `tvl < 100`, mark `alive: false` and exclude from response
- Sort: `lastActive` descending
- Limit: 10 entries
- Dead memecoins that went to zero simply disappear

**"history"** (not served by default — for future management page):
- Everything older than 14 days
- Accessible via `GET /api/addressbook?wallet=<pubkey>&include_history=true`
- Sorted by `lastActive` descending
- Limit: 50 entries

### Meteora enrichment

The relay enriches each address book entry with live pool data from Meteora DataPI. To avoid hammering the API (30 RPS limit), cache pool metadata:

```typescript
class MeteoraPoolCache {
  private cache: Map<string, { data: any; fetchedAt: number }> = new Map();
  private TTL = 300_000; // 5 minutes

  async getPool(address: string): Promise<any> {
    const cached = this.cache.get(address);
    if (cached && Date.now() - cached.fetchedAt < this.TTL) return cached.data;
    const resp = await fetch(`https://dlmm.datapi.meteora.ag/pools/${address}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    this.cache.set(address, { data, fetchedAt: Date.now() });
    return data;
  }
}
```

The enrichment adds: `name` (pair name), `volume24h`, `tvl`, `alive` (volume > 0).

For pools the bot is already watching (has in `poolInfo` map), use local data — no Meteora API call needed. Only call Meteora for pools that are in the address book but no longer actively watched (all positions closed, no longer in gRPC subscription).

### Bot integration (relay-server.ts)

New handler in `relay-server.ts`:

```typescript
private async handleAddressBook(res: ServerResponse, wallet: string): Promise<boolean> {
  const entries = this.addressBookStore.get(wallet);
  if (!entries) {
    this.json(res, 200, { active: [], recent: [], wallet, timestamp: Date.now() });
    return true;
  }

  const now = Date.now() / 1000;
  const FOURTEEN_DAYS = 14 * 24 * 60 * 60;

  const active = [];
  const recent = [];

  for (const [lbPair, entry] of Object.entries(entries)) {
    // Check live position count from subscriber registry
    const livePositions = this.subscriber.getPositionsForWalletPool(wallet, lbPair);
    const isActive = livePositions > 0;

    // Enrich with Meteora data
    const poolData = await this.meteoraCache.getPool(lbPair);
    const volume24h = poolData?.volume?.['24h'] ?? 0;
    const tvl = poolData?.tvl ?? 0;
    const alive = volume24h > 0 || tvl > 100;
    const name = poolData?.name ?? '???';
    const binStep = poolData?.pool_config?.bin_step ?? 0;

    const enriched = {
      pair: lbPair, name, binStep,
      openPositions: livePositions,
      lastActive: entry.lastActive,
      closedAt: entry.closedAt,
      volume24h, tvl, alive,
    };

    if (isActive) {
      active.push(enriched);
    } else if (alive && entry.closedAt && (now - entry.closedAt) < FOURTEEN_DAYS) {
      recent.push(enriched);
    }
    // else: dead or too old — silently excluded
  }

  active.sort((a, b) => b.lastActive - a.lastActive);
  recent.sort((a, b) => b.lastActive - a.lastActive);

  this.json(res, 200, {
    active,
    recent: recent.slice(0, 10),
    wallet,
    timestamp: Date.now(),
  });
  return true;
}
```

### geyser-subscriber.ts changes

Add a helper method to count positions for a specific wallet+pool:

```typescript
getPositionsForWalletPool(wallet: string, lbPair: string): number {
  let count = 0;
  const poolPositions = this.positionsByPool.get(lbPair);
  if (!poolPositions) return 0;
  for (const pda of poolPositions) {
    const info = this.positions.get(pda);
    if (info && info.owner.toBase58() === wallet) count++;
  }
  return count;
}
```

### Persistence (anchor-harvest-bot.ts)

```typescript
class AddressBookStore {
  private data: Record<string, Record<string, AddressBookEntry>> = {};
  private dirty = false;
  private path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'addressbook.json');
    this.load();
    // Auto-save every 60s
    setInterval(() => this.save(), 60_000);
  }

  upsert(wallet: string, lbPair: string) {
    if (!this.data[wallet]) this.data[wallet] = {};
    const existing = this.data[wallet][lbPair];
    this.data[wallet][lbPair] = {
      firstSeen: existing?.firstSeen ?? Date.now() / 1000,
      lastActive: Date.now() / 1000,
      closedAt: null,
      positionCount: (existing?.positionCount ?? 0) + 1,
    };
    this.dirty = true;
  }

  markClosed(wallet: string, lbPair: string) {
    if (this.data[wallet]?.[lbPair]) {
      this.data[wallet][lbPair].closedAt = Date.now() / 1000;
      this.dirty = true;
    }
  }

  get(wallet: string) { return this.data[wallet] ?? null; }

  private load() { /* read JSON file if exists */ }
  private save() { if (this.dirty) { /* write JSON, set dirty=false */ } }
}
```

Wire the store to gRPC events in the orchestrator (`anchor-harvest-bot.ts`):

```typescript
this.subscriber.on('positionChanged', (event) => {
  const { positionPDA, action } = event;
  const position = this.subscriber.getPosition(positionPDA);
  if (!position) return;
  const wallet = position.owner.toBase58();
  const lbPair = position.lbPair.toBase58();

  if (action === 'created') {
    this.addressBookStore.upsert(wallet, lbPair);
  } else if (action === 'closed') {
    // Check if wallet has remaining positions on this pool
    const remaining = this.subscriber.getPositionsForWalletPool(wallet, lbPair);
    if (remaining === 0) {
      this.addressBookStore.markClosed(wallet, lbPair);
    }
  }
});
```

---

## 3. Full UX Flow

### Trade Page Load (before wallet connect)

1. Trending feed fetches from Meteora DataPI.
2. Trending pools render as clickable pills above the input.
3. Default pool (from config.json) auto-loads as before.
4. Address book sections are empty (no wallet connected yet).

### Wallet Connect

1. User connects wallet.
2. Frontend calls `relayFetch('/api/addressbook?wallet=' + pubkey)`.
3. Response arrives with `active` and `recent` arrays.
4. **"Active" section** renders above the input — pools with open positions:
   ```
   OPEN POSITIONS
   WIF / SOL  ·  2 positions  ·  $1.2M vol
   BONK / SOL ·  1 position   ·  $916K vol
   ```
5. **"Recent" section** renders below trending — recently closed pools that are still alive:
   ```
   RECENT
   TRUMP / USDC  ·  yesterday  ·  $20M vol
   POPCAT / SOL  ·  3 days ago ·  $450K vol
   ```
6. Dead memecoins (zero volume) are silently absent. No pollution.

### User Pastes a Token CA

1. User pastes `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` (BONK), clicks "load."
2. `loadPool()` fires. `parseLbPair()` fails (82-byte mint, not 904-byte lb_pair).
3. **New branch:** `resolveTokenToPools(addr)`:
   - Calls DataPI `/pools/groups/{lexical_order_mints}` for SOL pair and USDC pair in parallel
   - Returns matching pools with bin_step, volume, tvl, current_price
4. Pool picker dropdown appears below the input:
   ```
   BONK / SOL  ·  bin step 8   ·  $916K vol  ·  $333K tvl
   BONK / SOL  ·  bin step 50  ·  $6.9K vol  ·  $7.4K tvl
   BONK / SOL  ·  bin step 25  ·  $2.9K vol  ·  $17K tvl
   ```
5. User clicks the top result → `#poolAddress` set to the lb_pair, `loadPool()` called.
6. Normal pool load, no address book interaction needed.

### User Pastes an lb_pair (existing behavior)

`loadPool()` fires. `parseLbPair()` succeeds (904 bytes) → normal flow, no picker shown.

### User Opens a Position

1. `createPosition()` runs exactly as before. No extra txs, no extra wallet prompts.
2. The gRPC stream detects the new position → fires `positionChanged` with `action: 'created'`.
3. The bot's `AddressBookStore` records `{ wallet, lbPair, lastActive: now }`.
4. Next time the user loads the page + connects wallet, this pool appears in "Active."

### User Closes All Positions on a Pool

1. User closes their last position on BONK/SOL.
2. gRPC detects the close → fires `positionChanged` with `action: 'closed'`.
3. Bot checks remaining positions for this wallet+pool → 0.
4. `AddressBookStore` sets `closedAt = now`.
5. Next page load: BONK/SOL moves from "Active" to "Recent" (if still alive) or disappears (if dead).

### The Flagrant Shitcoiner (100+ pools)

- "Active" shows 3-5 pools with live positions
- "Recent" shows 5-10 pools from the last 2 weeks with volume > 0
- The other 90 dead memecoins are excluded — zero volume = not alive = not shown
- The user sees ~10-15 entries. Clean, relevant, useful.

---

## 4. Integration Points in app.js

### New state fields

```javascript
  addressBook: { active: [], recent: [] },
  trendingPools: [],
```

### Modified functions

**`loadPool()` (line 1018):**
- After PublicKey validation, try `parseLbPair(addr)` first
- If it throws "Not a DLMM pool" (size !== 904), branch to `resolveTokenToPools(addr)`
- `resolveTokenToPools` calls Meteora DataPI, renders picker dropdown
- If `parseLbPair` succeeds, proceed as normal (existing behavior preserved)

**`init()` (line 3296):**
- On startup, call `fetchTrendingPools()` → render trending feed
- Set `setInterval(fetchTrendingPools, 60000)` for refresh

**Wallet connect callback:**
- After wallet connects, call `loadAddressBook()` → render active/recent sections

### New functions

```javascript
// Meteora DataPI — resolve token CA to DLMM pools
async function resolveTokenToPools(mintAddress) {
  const mint = mintAddress;
  const sol = 'So11111111111111111111111111111111111111112';
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  // Build lexical-order keys
  const solKey = [mint, sol].sort().join('-');
  const usdcKey = [mint, usdc].sort().join('-');

  const base = CONFIG.METEORA_API_URL || 'https://dlmm.datapi.meteora.ag';
  const [solPools, usdcPools] = await Promise.all([
    fetch(`${base}/pools/groups/${solKey}?sort_by=volume_24h:desc&page_size=5`).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
    fetch(`${base}/pools/groups/${usdcKey}?sort_by=volume_24h:desc&page_size=5`).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
  ]);

  const allPools = [...(solPools.data || []), ...(usdcPools.data || [])];
  allPools.sort((a, b) => (b.volume?.['24h'] || 0) - (a.volume?.['24h'] || 0));

  if (allPools.length === 0) {
    showToast('No DLMM pools found for this token', 'error');
    return;
  }
  if (allPools.length === 1) {
    document.getElementById('poolAddress').value = allPools[0].address;
    loadPool();
    return;
  }
  renderPoolPicker(allPools);
}

// Meteora DataPI — fetch trending pools
async function fetchTrendingPools() {
  const base = CONFIG.METEORA_API_URL || 'https://dlmm.datapi.meteora.ag';
  try {
    const resp = await fetch(`${base}/pools?sort_by=volume_24h:desc&page_size=10`);
    if (!resp.ok) return;
    const { data } = await resp.json();
    state.trendingPools = data || [];
    renderTrendingFeed(state.trendingPools);
  } catch {}
}

// Relay — load address book for connected wallet
async function loadAddressBook() {
  if (!state.connected || !state.publicKey) return;
  const data = await relayFetch('/api/addressbook?wallet=' + state.publicKey.toBase58());
  if (data) {
    state.addressBook = { active: data.active || [], recent: data.recent || [] };
    renderAddressBook();
  }
}

// Render pool picker dropdown below input
function renderPoolPicker(pools) { /* ... */ }

// Render trending pills above input
function renderTrendingFeed(pools) { /* ... */ }

// Render active + recent sections from address book
function renderAddressBook() { /* ... */ }
```

### New HTML elements (index.html)

Replace the pool-section with:

```html
<div class="pool-section">
  <div class="pool-discovery">
    <!-- Active positions (from relay address book, shown after wallet connect) -->
    <div class="addressbook-active" id="addressBookActive"></div>

    <!-- Trending feed (from Meteora API, shown always) -->
    <div class="trending-feed" id="trendingFeed"></div>

    <!-- Recent pools (from relay address book, shown after wallet connect) -->
    <div class="addressbook-recent" id="addressBookRecent"></div>

    <!-- Search input (accepts token CA OR lb_pair) -->
    <div class="pool-search-row">
      <input type="text" class="pool-input" id="poolAddress"
             placeholder="token address or DLMM pool" value="">
      <button class="load-btn" id="loadPool">load</button>
    </div>

    <!-- Pool picker dropdown (shown when token CA resolves to multiple pools) -->
    <div class="pool-picker" id="poolPicker" style="display:none;"></div>
  </div>

  <!-- Pool info (existing, unchanged) -->
  <div class="pool-info" id="poolInfo">
    <div class="pool-stat"><div class="pool-stat-label">Pool</div><div class="pool-stat-value" id="poolName">—</div></div>
    <div class="pool-stat"><div class="pool-stat-label">Price</div><div class="pool-stat-value" id="currentPrice">—</div></div>
  </div>
</div>
```

### New config values (config.json)

```json
{
  "METEORA_API_URL": "https://dlmm.datapi.meteora.ag"
}
```

---

## 5. Edge Cases

**Relay is down:** Address book sections don't render. Trending feed still works (direct Meteora call). Token CA search still works. Raw lb_pair paste still works. Graceful degradation.

**Meteora API is down:** Trending feed shows nothing. Token CA resolution shows "paste the DLMM pool address directly." Everything else works.

**Token CA resolves to zero pools:** Show "No DLMM pools found for this token" toast. User can still paste a raw lb_pair.

**User has never traded:** `active` and `recent` are empty arrays. Only trending feed and search input shown.

**Pool was alive when traded, now dead:** The relay checks `volume_24h > 0 || tvl > 100` before including in "recent." Dead pools vanish automatically. No manual cleanup.

**Multiple wallets:** Each wallet has its own address book. Switching wallets triggers `loadAddressBook()` for the new wallet.

**Bot restart:** `addressbook.json` persists to disk. On startup, load from disk → full history restored. Any positions created while the bot was down are picked up by `buildRegistry()` on restart (which fetches all positions from chain).

---

## 6. Dependency on Other Features

**Independent of $PEGGED integration.** No program changes. Pure bot + frontend.

**Independent of Recon page.** But the trending feed data could feed into Recon's pool analytics.

**Subsumes "Add BANANAS/SOL to Trade page" TODO.** Token CA search handles any token, including BANANAS.

---

## 7. Implementation Order

1. **Meteora DataPI integration (frontend)** — `fetchTrendingPools()`, `resolveTokenToPools()`, render trending feed and pool picker. Pure frontend, no bot changes. Can test immediately.

2. **Token CA detection (frontend)** — modify `loadPool()` to detect non-lb_pair addresses and branch to the picker flow.

3. **Address book store (bot)** — `AddressBookStore` class, persistence to disk, wire to gRPC position events.

4. **Relay endpoint (bot)** — `GET /api/addressbook?wallet=<pubkey>`, `MeteoraPoolCache` for enrichment, ranking/filtering logic.

5. **Frontend address book fetch** — `loadAddressBook()`, render active/recent sections, wire to wallet connect.

6. **HTML/CSS** — new pool-section layout with discovery zones, pool-picker dropdown, active/recent/trending styles matching existing aesthetic.

---

## Phase 2 — On-Chain Trade Passport (Future)

The server-side address book covers the core UX. If there's later demand for a user-owned, portable, on-chain record, the Metaplex Core AppData approach is still viable:

- Mint a "monke trade passport" Core NFT per user
- AppData plugin (Binary schema, dataAuthority = user wallet)
- 40 bytes/entry (32B pubkey + 8B timestamp), max ~25 entries per tx
- Write via `signAllTransactions` alongside position tx
- LRU eviction at 25 entries
- DAS-indexed for off-chain queries
- Management page: user can edit/remove entries directly (they're the dataAuthority)
- Full SDK reference, serialization code, Umi integration details preserved from earlier research

This is a standalone feature. Ship when there's user demand for portable trade history or if the product expands to multi-frontend scenarios where server-side data isn't accessible.
