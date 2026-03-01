# $PEGGED — Implementation Plan

**Replace raw SOL distribution to monke holders with $PEGGED, a yield-bearing LST staked to the MonkeDAO validator.**

---

## Current Flow

```
sweep_rover (bin_farm)
  → 50% SOL → revenue_dest (dist_pool PDA, bare lamports)
  → 50% SOL → Config.bot (operations)

deposit_sol (monke_bananas)
  → dist_pool lamports → program_vault lamports
  → accumulator updated

claim (monke_bananas)
  → program_vault lamports → user wallet
```

`dist_pool` and `program_vault` are bare PDAs (zero data, `AccountInfo`) holding native lamports. All transfers are direct lamport manipulation (`try_borrow_mut_lamports`), not token CPIs.

---

## Target Flow

```
sweep_rover (bin_farm — NO CODE CHANGE)
  → 50% SOL → revenue_dest (bridge PDA, native SOL)
  → 50% SOL → Config.bot (operations)

stake_and_forward (bridge program — NEW, permissionless crank)
  → bridge PDA SOL → CPI spl-stake-pool deposit → $PEGGED minted
  → $PEGGED → dist_pool token account

deposit_pegged (monke_bananas — UPGRADED)
  → dist_pool $PEGGED → program_vault $PEGGED
  → accumulator updated

claim (monke_bananas — UPGRADED)
  → program_vault $PEGGED → user's $PEGGED ATA
```

Bot never holds funds. All PDAs. All permissionless cranks.

---

## Components

### 1. SPL Multi-Validator Stake Pool (deploy via CLI)

No code to write. Solana's audited `spl-stake-pool` program.

**Steps:**
- Install `spl-stake-pool` CLI
- Create pool with protocol-owned authority (admin keypair)
- Set token metadata: name=$PEGGED, symbol=PEGGED via Metaplex
- Add MonkeDAO validator: `DfpdmTsSCBPxCDwZwgBMfjjV8mF8xHkGRcXP8dJBVmrq`
- Deposit SOL → receive $PEGGED 1:1 (exchange rate adjusts with staking yield each epoch)

**Outputs:** stake pool address, $PEGGED mint address, pool authority.

### 2. Bridge Program (new Anchor program, ~1 instruction)

Tiny program. Single permissionless instruction: `stake_and_forward`.

**Accounts:**
- `bridge_vault` PDA — `[b"bridge_vault"]` — receives SOL from sweep_rover
- `stake_pool` — SPL stake pool address
- `pegged_mint` — $PEGGED mint
- `dist_pool_pegged_ata` — dist_pool's $PEGGED token account (on monke_bananas)
- SPL stake pool program accounts (reserve, validator list, etc.)
- Token program, system program

**Logic:**
1. Read `bridge_vault` lamports minus rent → `stakeable`
2. CPI into `spl-stake-pool::deposit_sol(stakeable)` — mints $PEGGED to a bridge-owned ATA
3. CPI `token::transfer` — $PEGGED from bridge ATA → `dist_pool_pegged_ata`

**State:** Minimal. Store `stake_pool`, `pegged_mint`, `dist_pool_pegged_ata`, bump. Initialized once by admin.

**Security:**
- Permissionless (anyone can crank, bot just does it faster)
- Bridge vault is a PDA — bot never touches SOL
- $PEGGED goes PDA-to-PDA — bot never receives tokens
- All destination addresses validated against stored config

### 3. monke_bananas Upgrade

**`dist_pool` and `program_vault`:** Convert from bare PDAs holding lamports to token accounts holding $PEGGED.

These are currently `AccountInfo<'info>` with `minimum_balance(0)`. They become `Account<'info, TokenAccount>` (or `InterfaceAccount` if $PEGGED could be Token-2022).

**New field in `MonkeState`:** `pegged_mint: Pubkey` — stored at init, validated in deposit/claim contexts. Fits in the existing 64-byte `_reserved` space (only need 32 bytes for one Pubkey).

**`deposit_sol` → `deposit_pegged`:**
- Currently: `dist_pool.lamports() - rent` → debit dist_pool, credit program_vault (lamport manipulation)
- New: `dist_pool_ata.amount` → CPI `token::transfer` from dist_pool ATA → program_vault ATA
- PDA signs via `CpiContext::new_with_signer` with `[b"dist_pool", &[bump]]`
- Accumulator math unchanged — units shift from lamports to $PEGGED base units, formula is identical

**`claim`:**
- Currently: debit program_vault lamports, credit user lamports
- New: CPI `token::transfer` from program_vault ATA → user's $PEGGED ATA
- PDA signs via `CpiContext::new_with_signer` with `[b"program_vault", &[bump]]`
- Need `user_pegged_account: Account<'info, TokenAccount>` in Claim context
- Accumulator math unchanged

**`compost_monke`:** Unclaimed $PEGGED stays in program_vault as surplus — same logic, different units. No structural change.

**Account context changes:**
- `DepositSol` → `DepositPegged`: dist_pool and program_vault become `Account<TokenAccount>`, add `token_program`, add `pegged_mint` for validation
- `Claim`: program_vault becomes `Account<TokenAccount>`, add `user_pegged_account`, `token_program`, `pegged_mint`
- `Initialize`: validate `pegged_mint`, create/validate dist_pool and program_vault as token accounts

**Migration concern:** MonkeState is already deployed with `_reserved: [u8; 64]`. Adding `pegged_mint: Pubkey` (32 bytes) can be carved from `_reserved` without realloc. Existing `accumulated_sol_per_share` and `total_sol_distributed` values will need to be rationalized during migration (they tracked lamports, new deposits track $PEGGED units). Consider a migration instruction or fresh reinitialization.

### 4. bin_farm — No Code Change

`sweep_rover` sends SOL to `revenue_dest`. We use the existing timelocked `propose_revenue_dest` / `apply_revenue_dest` (24hr timelock, admin-only propose, permissionless apply) to redirect `revenue_dest` from the current `dist_pool` bare PDA to the new bridge program's `bridge_vault` PDA.

**Steps:**
1. `propose_revenue_dest(bridge_vault_pubkey)` — admin tx
2. Wait 24 hours
3. `apply_revenue_dest()` — anyone can call

After this, `sweep_rover` sends the monke holder 50% to the bridge, which stakes and forwards $PEGGED.

### 5. Bot Keeper Changes

Add bridge crank to the Saturday sequence, between step 2 (sweep) and step 4 (deposit):

```
Current Saturday sequence:
  1. close_rover_wsol (unwrap WSOL)
  2. sweep_rover (50/50 split)
  3. open_fee_rovers (recycle token fees)
  4. deposit_sol (dist_pool → program_vault)
  5. close_exhausted_rovers

New Saturday sequence:
  1. close_rover_wsol (unwrap WSOL)
  2. sweep_rover (50/50 split — SOL now goes to bridge_vault)
  3. stake_and_forward (bridge: SOL → stake → $PEGGED → dist_pool)
  4. open_fee_rovers (recycle token fees)
  5. deposit_pegged (dist_pool $PEGGED → program_vault $PEGGED)
  6. close_exhausted_rovers
```

Also update `checkAndDepositSol` auto-trigger to check dist_pool's $PEGGED token balance instead of lamports.

### 6. Frontend Changes

- **Rank page claim UI:** Show $PEGGED balance instead of SOL. Update claim button text. Show $PEGGED token icon.
- **Ops page:** Fee pipeline display updates — dist_pool and program_vault show $PEGGED balances.
- **config.json:** Add `PEGGED_MINT`, `STAKE_POOL`, `BRIDGE_PROGRAM_ID`.

### 7. Relay / API Changes

- `/api/fees` endpoint: `distPool` and `programVault` report $PEGGED token balances instead of SOL lamport balances.
- `FeePipelineState` interface: update types.

---

## Deployment Sequence

1. **Deploy SPL stake pool** via CLI. Add MonkeDAO validator. Set $PEGGED metadata. Test deposit/withdraw on devnet.
2. **Deploy bridge program.** Initialize with stake pool address, $PEGGED mint, dist_pool ATA. Test: send SOL to bridge_vault, crank stake_and_forward, verify $PEGGED arrives at dist_pool ATA.
3. **Upgrade monke_bananas.** Deploy new code. Migrate MonkeState (carve `pegged_mint` from `_reserved`). Initialize dist_pool and program_vault as $PEGGED token accounts.
4. **Redirect revenue_dest.** `propose_revenue_dest(bridge_vault)` → wait 24hr → `apply_revenue_dest()`.
5. **Update bot keeper.** Add stake_and_forward crank. Update deposit_sol → deposit_pegged. Update checkAndDeposit threshold.
6. **Update frontend + relay.** Deploy to Vercel.
7. **E2E test.** Full Saturday cycle with real SOL: harvest → fees → sweep → bridge → deposit → claim $PEGGED.

---

## What Does NOT Change

- `bin_farm` program code — zero modifications
- `sweep_rover` 50/50 split logic — hardcoded, untouched
- Harvester (geyser-subscriber, harvest-executor) — fee collection unchanged
- Fee rover recycling — token fees still go to rover_authority ATAs
- Permissionless fallback on all operations
- MasterChef accumulator math — formula is unit-agnostic

---

## Open Questions

- **Migration path for existing MonkeBurn holders:** They have unclaimed SOL in program_vault. Need a clean cutover — either drain and distribute remaining SOL before switching, or support a dual-claim period.
- **$PEGGED as SPL Token or Token-2022?** SPL stake pool mints standard SPL tokens. If future features need extensions, consider Token-2022 pool. Standard SPL is simpler.
- **Epoch timing:** SPL stake pool deposits don't earn yield until the next epoch boundary. Bridge should crank promptly but the delay is inherent to Solana staking.
- **Unstaking for claims:** $PEGGED is liquid — holders can swap on the DLMM pool or hold for yield. The protocol distributes $PEGGED, not SOL. No unstaking needed on-chain.
