// Estimate average entry price for Alpha Vault depositors
// DAMM v2 constant-product with virtual reserves
//
// Virtual SOL reserve = totalSupply * initPrice = 1B * 0.000001 = 1000 SOL
// k = totalSupply * virtualSOL = 1e15 * 1e12 = 1e27 (in raw units)
//
// After vault buys with X SOL:
//   newVirtualSOL = 1000 + X
//   newTokenReserve = k / newVirtualSOL
//   tokensBought = totalSupply - newTokenReserve
//   avgPrice = X / tokensBought

const TOTAL_SUPPLY = 1_000_000_000;      // 1B BANANAS
const INIT_PRICE = 0.000001;              // SOL per BANANAS
const VIRTUAL_SOL = TOTAL_SUPPLY * INIT_PRICE; // 1000 SOL
const K = TOTAL_SUPPLY * VIRTUAL_SOL;     // 1e12 (in human units)

function estimate(solDeposited) {
  const newVSOL = VIRTUAL_SOL + solDeposited;
  const newTokens = K / newVSOL;
  const bought = TOTAL_SUPPLY - newTokens;
  const avgPrice = solDeposited / bought;
  const pctSupply = (bought / TOTAL_SUPPLY) * 100;
  const priceImpact = ((avgPrice / INIT_PRICE) - 1) * 100;
  return { solDeposited, bought, avgPrice, pctSupply, priceImpact };
}

console.log('initPrice: 0.000001 SOL/BANANAS');
console.log('virtualSOL: 1000 SOL');
console.log('k:', K.toExponential(2));
console.log('');
console.log('SOL In    | Tokens Bought       | % Supply | Avg Price (SOL)  | Price Impact');
console.log('----------|---------------------|----------|------------------|------------');

const amounts = [0.1, 1, 5, 10, 25, 50, 100, 200, 300, 420];
for (const sol of amounts) {
  const e = estimate(sol);
  const boughtStr = Math.floor(e.bought).toLocaleString().padEnd(19);
  const pctStr = e.pctSupply.toFixed(2).padStart(6) + '%';
  const priceStr = e.avgPrice.toFixed(10);
  const impactStr = '+' + e.priceImpact.toFixed(2) + '%';
  console.log(`${String(sol).padEnd(9)} | ${boughtStr} | ${pctStr} | ${priceStr} | ${impactStr}`);
}
