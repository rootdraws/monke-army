# monke.army — TODO

---

## E2E test runbook

Run with bot active and wallet connected. 0.01-0.1 SOL per test.

- [ ] **Open position** — Trade page, SOL/USDC (default pool). Buy side, 5%-35% range, 0.01 SOL. Approve. Verify position on Positions page.
- [ ] **Wait for harvest** — Watch Ops activity feed. Bot harvests when price crosses bins.
- [ ] **Test user_close** — Positions page, click "close". Approve. Verify SOL returns minus 0.3% fee.
- [ ] **Test claim_fees** — Open position, wait for LP fees to accrue, click "fees" on Positions page.
- [ ] **Test sweep** — Ops page, check rover_authority balance. If > 0, click "sweep". Verify SOL splits 50/50: half to dist_pool, half to Config.bot.
- [ ] **Test deposit** — Ops page, check dist_pool balance. If > 0, click "deposit". Verify SOL moves to program_vault.
- [ ] **Test feed_monke** — Rank page, select SMB NFT, click "Burn 1M $BANANAS to your Monke." Verify weight increments.
- [ ] **Test claim** — After deposit_sol, click "claim" on fed monke. Verify SOL arrives.
- [ ] **Test permissionless fallback** — Stop bot for 60s. Go to Ops bounty board. Click "harvest" on a pending position. Verify keeper tip.
- [ ] **Validate Saturday keeper** — Wait for Saturday or manually trigger. Verify 5-step sequence: unwrap WSOL -> sweep_rover -> fee rovers -> deposit_sol -> cleanup.

---

## Feature work

- [ ] **Recon page** — Rover TVL leaderboard, top-5 analytics, bribe deposit, click-to-trade. Pure frontend, depends on relay data.
- [ ] **Rover TVL computation** — Bot-side dollar-value computation for rover positions. Wire callback to relay.
- [ ] **Add BANANAS/SOL to Trade page** — DAMM v2 pool is live. Add as selectable pair on Trade page (needs DLMM pool or adapter).
- [ ] **compost_monke crank** — Requires an observation indexer to scan for burned NFTs (supply == 0) with active MonkeBurn PDAs.
- [ ] **Transfer hook support** — Resolve transfer hook extra accounts from mint extension data via DLMM SDK. Add when demand exists.
- [ ] **Program split** — Move rover system to separate program. Add if stack pressure or code separation justifies it.

---

## BD

- [ ] **Apply MonkeFoundry Cohort 2**
- [ ] **Apply Meteora Rising**
- [ ] **Pitch Helius for LaserStream sponsorship**
- [ ] **Share with LP Army**

---

## Ideas

- Aggregated order profiles across DLMM pools
- NFT metadata for commonly traded pairs
- Question Market Workflow (one token CA -> pool launch flow)
- Discord Bot for bin fill notifications

---

*Last updated: Mar 1, 2026.*
