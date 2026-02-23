# monke.army — TODO

---

## BLOCKER — Token-2022 transfer CPI fix (program change required)

Position `3qQGCmDY` on pool `ABdAmqgz3CNvU9kjn5fAtnFurvBvgs6PP7ksTb3VfzQM` is stuck. Token X is `79hW22KCd32YsJA59pWU5Y2Wthuchb5GsmZCT8v4pump` (Token-2022, flag=1). Token Y is SOL (SPL Token).

**What works:** Account validation passes (Feb 23 fix — `InterfaceAccount` for token accounts, `UncheckedAccount` for mints). All 3 Meteora CPIs succeed (`RemoveLiquidityByRange2`, `ClaimFee2`, `ClosePosition2`). Owner + rover ATAs are pre-created correctly by the bot.

**What fails:** After Meteora CPIs, the program's own outbound transfers fail. `anchor_spl::token::transfer()` generates an SPL Token `Transfer` instruction, but the token accounts are owned by Token-2022. SPL Token can't read Token-2022 account data → `InvalidAccountData`.

**Evidence (from `npx tsx scripts/test-close-position.ts`):**
```
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]
Program log: Instruction: Transfer
Program log: Error: InvalidAccountData
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: invalid account data for instruction
```

**Fix:** In `programs/bin-farm/src/lib.rs`, replace all 8 `transfer()` call sites with `transfer_checked()` from `anchor_spl::token_interface`:

1. Change import (line 17): `use anchor_spl::token::{Transfer, transfer};` → `use anchor_spl::token_interface::{TransferChecked, transfer_checked};`
2. Each call site changes from:
```rust
transfer(CpiContext::new_with_signer(
    token_x_program.to_account_info(),
    Transfer { from, to, authority }, signer,
), amount)?;
```
to:
```rust
transfer_checked(CpiContext::new_with_signer(
    token_x_program.to_account_info(),
    TransferChecked { from, mint: token_x_mint.to_account_info(), to, authority }, signer,
), amount, decimals)?;
```
3. The `mint` and `decimals` parameters must be threaded to `execute_close_transfers` and the harvest/emergency-close handlers. Get decimals from the mint account (read on-chain) or hardcode a lookup.
4. **8 call sites** at lines: 897, 908, 1107, 1120, 1844, 1855, 1866, 1877.
5. Rebuild: `PATH="$HOME/.cargo/bin:$PATH" cargo-build-sbf --manifest-path programs/bin-farm/Cargo.toml`
6. Deploy: `solana program deploy target/deploy/bin_farm.so --program-id 8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia --url mainnet-beta`
7. Verify: `npx tsx scripts/test-close-position.ts` — should print `SUCCESS` with a tx signature.

- [ ] **Fix transfer CPI for Token-2022** — Replace `anchor_spl::token::{Transfer, transfer}` with `anchor_spl::token_interface::{TransferChecked, transfer_checked}` at all 8 call sites. Thread mint accounts + decimals. Rebuild + redeploy.

---

## Tier 1 — Security

- [ ] **Rotate Helius API key** — Go to Helius dashboard, generate new key. Free-tier key for `public/config.json`, Pro key in `bot/.env` only. Do before repo goes public.

---

## Tier 2 — Deploy + E2E testing

### Deploy bot to server

PM2 config ready at `bot/ecosystem.config.cjs`. Steps:

1. Create DigitalOcean droplet (Ubuntu 22.04, 2GB RAM, $12/mo)
2. `ssh root@<ip>`, install Node 20, clone repo, `npm install`
3. `cp bot/anchor-harvest-bot.env.example bot/.env` — fill RPC_URL, GRPC_ENDPOINT, BOT_KEYPAIR_PATH
4. Copy bot keypair JSON to server
5. `npm install -g pm2`
6. `pm2 start bot/ecosystem.config.cjs`
7. `pm2 save && pm2 startup`
8. Verify: `curl http://localhost:8080/api/stats`
9. Set up nginx reverse proxy with SSL for `wss://bot.monke.army` (or open port 8080)

### Deploy frontend

Vercel config ready at `vercel.json`. Steps:

1. `npm i -g vercel`
2. `vercel` — link project, confirm build command (`npm run build:frontend`), output dir (`dist`)
3. DNS: point `monke.army` to Vercel
4. Update `dist/config.json` with production `BOT_RELAY_URL` (`wss://bot.monke.army` or droplet IP)
5. Verify all 6 pages load

### E2E test runbook

Run with bot active and wallet connected. 0.01-0.1 SOL per test.

- [ ] **Open position** — Trade page, SOL/USDC (default pool). Buy side, 5%-35% range, 0.01 SOL. Approve. Verify position on Positions page.
- [ ] **Wait for harvest** — Watch Ops activity feed. Bot harvests when price crosses bins.
- [ ] **Test user_close** — Positions page, click "close". Approve. Verify SOL returns minus 0.3% fee.
- [ ] **Test claim_fees** — Open position, wait for LP fees to accrue, click "fees" on Positions page.
- [ ] **Test sweep** — Ops page, check rover_authority balance. If > 0, click "sweep". Verify SOL moves to dist_pool.
- [ ] **Test deposit** — Ops page, check dist_pool balance. If > 0, click "deposit". Verify SOL moves to program_vault.
- [ ] **Test feed_monke** — Rank page, select SMB NFT, click "Burn 1M $BANANAS to your Monke." Verify weight increments.
- [ ] **Test claim** — After deposit_sol, click "claim" on fed monke. Verify SOL arrives.
- [ ] **Test permissionless fallback** — Stop bot for 60s. Go to Ops bounty board. Click "harvest" on a pending position. Verify keeper tip.
- [ ] **Validate Saturday keeper** — Wait for Saturday or manually trigger. Verify 6-step sequence: claim_pool_fees -> unwrap WSOL -> sweep_rover -> fee rovers -> deposit_sol -> cleanup.

---

## Tier 4 — Independent feature work (no program changes)

- [ ] **Recon page** — Rover TVL leaderboard, top-5 analytics, bribe deposit, click-to-trade. Pure frontend, depends on relay data.
- [ ] **Rover TVL computation** — Bot-side dollar-value computation for rover positions. Wire callback to relay.
- [ ] **Load $BANANAS DLMM** — Create a BANANAS/SOL DLMM pool on Meteora, list as default pair option on Trade page. Operational task.
- [ ] **compost_monke crank** — Requires an observation indexer to scan for burned NFTs (supply == 0) with active MonkeBurn PDAs. New infrastructure.
- [ ] **Transfer hook support** — Resolve transfer hook extra accounts from mint extension data via DLMM SDK. Unlocks pools with transfer hook mints. Add when demand exists.
- [ ] **Program split** — Move rover system to separate program. Constrained by rover_authority LP NFT ownership (CPI gateway required). Add if stack pressure or code separation justifies it.

---

## BD

- [ ] **Submit Graveyard Hackathon** — Deadline Feb 28.
- [ ] **Attend Monke Weekly Townhall** — Feb 27, 17:00 UTC.
- [ ] **Apply MonkeFoundry Cohort 2**
- [ ] **Apply Meteora Rising**
- [ ] **Pitch Helius for LaserStream sponsorship**
- [ ] **Share with LP Army**

---

## Ideas

- Aggregated order profiles across DLMM + DAMM v2 pools
- NFT metadata for commonly traded pairs
- Question Market Workflow (one token CA -> pool launch flow)
- DAMM v2 Pool Liquidity profiles
- Discord Bot for bin fill notifications

---

*Last updated: Feb 23, 2026 (session 2).*
