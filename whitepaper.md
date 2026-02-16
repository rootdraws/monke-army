# monke.army

**Limit orders that earn fees. Burn $BANANAS, feed your monke, earn SOL.**

---

## The Problem

You set a limit order on Meteora DLMM. Price sweeps through your bins — you're filled. Then price reverses. You earn fees, but you round trip your exit or entry unless you are hovering to withdraw at just the right moment.

On Jupiter, limit orders cost 0.12% as a platform fee, in addition to whatever you are paying as a taker.

Your market buys and sells are clumsy. They slam the orderbook, and slippage eats away at your edge -- especially on microcap tokens.

---

## The Solution

### Limit Orders That Earn Fees

Set your range as a single-sided LP. If price moves through your range, Monke's Harvester protects your position against round-trip loss.

**Sell the Rips.** Deposit tokens above current price. Price rips up through your bins — Monke's Harvester pulls your SOL before it reverses. You sold the top and earned LP fees on the way up.

**Buy the Dips.** Deposit SOL below current price. Price dips down through your bins — Monke's Harvester pulls your tokens before they bounce back. You accumulated and earned LP fees on the way down.

**How it works:**

1. User deposits SOL or TOKEN into bins above/below current price
2. Position acts as a limit order, earning LP fees as the position fills
3. Price sweeps through bins, DLMM converts each one (SOL → token or token → SOL)
4. Monke's Harvester detects fully-converted bins via Helius LaserStream gRPC
5. Harvester calls `harvest_bins` with those specific bin IDs
6. Anchor program CPIs to Meteora `removeLiquidity` for only those bins
7. Harvested tokens flow directly into the owner's wallet
8. Remaining bins stay open, waiting to be filled

### Monke's Harvester — Powered by Helius LaserStream

Sub-second bin detection via Helius LaserStream gRPC. CONFIRMED commitment — from block to harvest in under a second. The Harvester parses raw account data directly from the gRPC stream, identifies which bins have converted, and submits the harvest transaction before price can reverse.

Flash loans unwind within the same slot. The Harvester always submits to a future slot — it reacts to settled on-chain state, never mid-transaction snapshots.

### Permissionless Harvesting - Decentralized Backup

If the Monke Harvester is down for longer than 40 seconds, anybody can call harvest, close, or sweep — and earn 10% of the fees for the work they do.

Every step in the revenue pipeline is permissionless. Harvest, close, sweep, distribute, deposit — all crankable by anyone. The bot is just faster. monke.army is built to be fast and convenient through running our own infrastructure, but the system is resilient without it. 

### Performance Fee

Zero fee on deposit. 0.3% on converted output only.

Unconverted tokens always return to you whole — no fee, no cut, no exceptions. The 0.3% only applies to the side that converted (SOL you received from a sell, or tokens you received from a buy).

LP fees can be claimed anytime at zero cost. Unclaimed LP fees at close are included in the 0.3% — effectively dust.

---

## Gamma Scalping

monke.army is a form of active liquidity provision. Trade flow routes through your ranges, filling your orders. The Harvester withdraws that liquidity from the market once filled — widening the bandwidth on fill, then closing the aperture by withdrawing your LP.

Meme tokens with low liquidity and fat orders have structural slippage — an acceleration of price toward the outer bands of available liquidity. This acceleration of price is a byproduct of AMM curves, and is called gamma.

monke.army scalps this gamma.

The result is structural predation against existing passive LPs. Your users are providing discretionary liquidity to the market and withdrawing on fill — imposing adverse selection on passive pools.

---

## Burn $BANANAS, Feed Your Monke

1. Buy an SMB Gen2 NFT
2. Buy $BANANAS
3. Feed your monke
4. Claim your $SOL

- 1M $BANANAS must be burned at a time, assigned on-chain to your specific Monke
- Gen2 = 2x weight per feed. Gen3 = 1x weight per feed.
- Burns stack. Feed 5M $BANANAS to the same Gen2 Monke — that NFT has a weight of 10
- 100% of protocol fees are directed to fed Monkes, proportional to their weight
- SMB Gen2 / Gen3 NFTs are fully tradeable. Weight and unclaimed SOL travel with the NFT

**SMB Gen2 collection:** `SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W`
**SMB Gen3 collection:** `8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH`

---

## Fee Flow

100% of fees go to monke holders. Zero dev fee.

```
Three revenue streams → one destination:

1. Position fees (0.3% on converted output)
     SOL fees → rover_authority WSOL ATA → close_rover_token_account (unwrap)
        → sweep_rover → dist_pool → monke holders
     TOKEN fees → rover_authority → sell-side DLMM (BidAskOneSide)
        → natural trading converts to SOL → sweep_rover → dist_pool → monke holders

2. Rover bribe proceeds
     External deposits → rover DLMM positions → converts to SOL
        → sweep_rover → dist_pool → monke holders

3. $BANANAS/SOL trading fees (DAMM v2 pool)
     claim_pool_fees → rover_authority → sweep_rover → dist_pool → monke holders
```

Token fees are never market-dumped. They become sell-side liquidity above current price. If the token pumps, they convert at better prices. If it doesn't, they sit there earning LP fees while they wait. Your protocol fees don't destroy your chart.

---

## FAQ

**Why Meteora DLMM?**
Single-sided bid-ask orders in discrete price bins. monke.army watches those bins, and after they convert, pulls them back into your wallet.

**Why not just use Meteora directly?**
monke.army is an automation cooperative for yield-bearing limit orders. Our programs are a minimalist vault wrapper on the DLMM API. Our LaserStream gRPC subscription provides an economy of scale — one connection monitoring all positions in the wrapper.

**Why burn instead of stake?**
Staking creates mercenaries. They lock, farm, unlock, dump. Burning $BANANAS is permanent — the tokens are gone forever. You stack weight on a tradeable SMB Gen2 or Gen3 NFT that earns SOL. You can sell the monke, but you can never un-burn the $BANANAS.

**Why Solana Monke Business?**
Prefer Aesthetic.

**Does it work with Token-2022 / pump.fun tokens?**
Yes. Runtime detection, V1/V2 CPI branching. Zero additional configuration. Exception: Token-2022 mints with active transfer hooks are not yet supported.

**What about the dev fee?**
There is no dev fee. 100% of protocol fees go to monke holders who burned $BANANAS. The dev participates in the Alpha Vault fair launch like everyone else — same price, same terms.

**How was $BANANAS launched?**
100% of supply (1B tokens, 6 decimals) into a Meteora DAMM v2 pool. Alpha Vault pro-rata fair launch — everyone deposits SOL during a 2-week window, everyone gets the same price. 420 SOL vault capacity. initPrice: 0.000001 SOL/token (1 SOL = 1 monke feed). Liquidity permanently locked to rover_authority. 69% sniper tax decaying to 1% over 3 hours. Zero dev allocation. No pre-mine. No team tokens.

---

*DLMM Limit Orders that pay you to trade. Burn $BANANAS, feed your monke.*

*monke.army*
