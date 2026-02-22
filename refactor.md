# refactor.md — open_position Token-2022 session (Feb 21, 2026)

## What was done

### Problem

`open_position` and `open_position_v2` crashed with a BPF access violation on mainnet. The program had never been called successfully — the `initialize` instruction worked (Config PDA exists), but no position had ever been opened. Two root causes:

1. **BPF stack frame overflow.** Anchor's generated `try_accounts()` for the 19-account `OpenPosition` struct exceeded the 4KB BPF stack frame limit. Every `Account<'info, T>` field allocates the deserialized struct on the stack during validation.

2. **Token-2022 incompatibility.** The Meteora V1 `add_liquidity_by_strategy_one_side` instruction (12 accounts, single `token_program`) does not work on Token-2022 pools. Most DLMM pools (pump.fun tokens, etc.) use Token-2022 for at least one side. The Meteora SDK uses `add_liquidity_by_strategy2` (14 accounts, separate `token_x_program`/`token_y_program`) for these pools.

### Changes made

#### On-chain program (8 deploys to mainnet in this session)

1. **`Box<Account<>>` on all large structs.** Every `Account<'info, Config>`, `Account<'info, Position>`, `Account<'info, Vault>`, `Account<'info, TokenAccount>`, `Account<'info, Mint>`, and `Account<'info, RoverAuthority>` across 10+ instruction structs was wrapped in `Box<>`. Moves deserialization from the 4KB stack to the heap. ~200-400 extra CU per boxed account.

2. **`bin_array_bitmap_ext` removed from `#[account(mut)]`.** The bitmap extension is optional in Meteora — when absent, the DLMM program ID is passed as a placeholder. An executable program can't be writable, so the `mut` constraint was removed from all structs. The CPI module uses `bitmap_meta()` to conditionally set writable based on `is_writable`.

3. **New `OpenPositionV2` struct (expanded).** Replaced single `reserve`/`token_mint`/`token_program` with X/Y variants for both sides. Added separate `vault_token_x`/`vault_token_y`. To fit in the 4KB stack frame, 6 accounts were moved to `ctx.remaining_accounts`:
   - `[0]` bin_array_lower
   - `[1]` bin_array_upper
   - `[2]` event_authority
   - `[3]` dlmm_program
   - `[4]` token_x_mint
   - `[5]` token_y_mint

4. **New V2 CPI: `add_liquidity_by_strategy2`.** Added to `meteora_dlmm_cpi.rs`. 14 fixed accounts + remaining accounts for bin arrays. Uses `LiquidityParameterByStrategy` (two-sided: `amount_x`/`amount_y`) with `SpotImBalanced` strategy type and `RemainingAccountsInfo::empty_hooks()`.

5. **`open_position_v2` instruction body rewritten.** Detects deposit side from on-chain `active_id`. Sets `amount_x=0` for buy or `amount_y=0` for sell. Passes the pool's actual `active_id` (not `min_bin_id`) to the V2 CPI for slippage validation.

#### Frontend (public/app.js)

1. **V1/V2 branching.** Reads `tokenXProgramFlag`/`tokenYProgramFlag` from LbPair bytes (offsets 880/881). If either is 1 (Token-2022), uses `open_position_v2` with expanded accounts. Otherwise uses V1 `open_position` (19 accounts).

2. **V2 account resolution.** Resolves both reserves, both mints, both token programs, both vault ATAs. Creates vault ATAs for both token X and token Y. Passes 17 named accounts + 6 remaining accounts.

3. **SOL wrapping.** Manual `SystemProgram.transfer` + `SyncNative` for buy-side deposits (avoids `Buffer` dependency from CDN web3.js).

4. **Bin array initialization.** Calls Meteora's `initializeBinArray` for any missing bin arrays before the main instruction.

---

## What is fragile / security consequences

### remaining_accounts (6 accounts with no Anchor validation)

| Account | Risk | Mitigation |
|---------|------|------------|
| bin_array_lower/upper | Wrong PDA → Meteora CPI fails | Meteora validates internally |
| event_authority | Wrong PDA → Meteora CPI fails | Meteora validates internally |
| dlmm_program | Wrong program → CPI fails | Manual `require!()` check in instruction body |
| token_x_mint / token_y_mint | Wrong mint → CPI fails or wrong pool interaction | Meteora validates against lb_pair state |

**The ordering is a silent contract.** Index 0-5 must match exactly. No compiler enforcement. A frontend bug that swaps indices would produce confusing Meteora CPI errors, not a clear Anchor constraint message.

### Raw byte validation on vault token accounts

`vault_token_x` and `vault_token_y` use manual `try_borrow_data()` with byte-offset checks (`data[32..64]` for owner) instead of typed `Account<TokenAccount>`. This is necessary for Token-2022 compatibility but bypasses Anchor's owner/discriminator checks.

### Strategy type mismatch risk

`open_position_v2` uses `SpotImBalanced` (strategy type 6) because `add_liquidity_by_strategy2` rejects one-sided strategy types. If a future change uses `BidAsk` for rover positions through V2, it would need `BidAskImBalanced` (type 8), not `BidAskOneSide` (type 2).

### V1 `open_position` untested on mainnet

Only V2 has been tested during this session. V1 should work for SPL-only pools (the code is unchanged from the original) but has not been smoke-tested post-`Box<>` changes.

### Multiple mainnet deploys

8 program upgrades in one session. Each deploy is an atomic bytecode swap (same program ID, same state), but the rapid iteration means the deployed code wasn't reviewed or tested beyond simulation.

---

## What should be done instead

### Short term (before launch)

1. **Smoke test V1 path.** Load an SPL-only DLMM pool (e.g., SOL/USDC) and open a position via the frontend. Verify the V1 `open_position` instruction works post-`Box<>`.

2. **E2E test full lifecycle.** Open → harvest → close on both V1 and V2 pools. Verify the bot's harvest executor works with the new program.

3. **Freeze program upgrades.** Once tests pass, consider revoking upgrade authority or transferring to a multisig.

### Medium term (refactor)

1. **Split the program.** Move rover system (open_rover, open_fee_rover, sweep, close_rover_token, claim_pool_fees) to a separate program. This frees ~1.5KB of stack budget per instruction in the core program, eliminating the need for remaining_accounts on `OpenPositionV2`.

2. **Use `InterfaceAccount<'info, Mint>` for mints.** Available in Anchor 0.30+ via `anchor_spl::token_interface`. Accepts both SPL Token and Token-2022 mints with typed Anchor validation. Eliminates the need to push mints to remaining_accounts.

3. **Consider `LazyAccount` (Anchor 0.31+).** Defers deserialization — only validates owner + discriminator on entry. Ideal for accounts that are just passed through to CPIs (reserves, bin arrays, event authority). Reduces stack usage without `Box<>` overhead.

4. **Unify V1/V2 into a single instruction.** Use `add_liquidity_by_strategy2` for all pools (SPL-only pools work fine with the V2 instruction — just pass the SPL Token program for both sides). Eliminates the V1/V2 branching in the frontend. Requires both vault ATAs for all positions (minor rent cost).

### Long term

1. **Anchor 0.31 migration.** Brings `LazyAccount`, better stack management, and improved optional account handling.

2. **IDL generation.** Currently skipped (`anchor build --no-idl`). Generating the IDL would enable Codama client generation and eliminate manual instruction serialization in the frontend.

3. **Transfer hook support.** Currently `RemainingAccountsInfo::empty_hooks()` — no transfer hook accounts are resolved. Pools with transfer hook extensions would fail. The bot and frontend would need to resolve transfer hook accounts from the mint's extension data.
