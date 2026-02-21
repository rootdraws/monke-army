import { Connection, PublicKey } from '@solana/web3.js';

const conn = new Connection('https://mainnet.helius-rpc.com/?api-key=3ed2a463-fd75-4c6b-921c-6b0d67f43aa1', 'confirmed');
const poolPubkey = new PublicKey('GxC4SFsT2sJEPjgXziBmCnBkrpvwYzZYWPoWRpTj9jZR');

const info = await conn.getAccountInfo(poolPubkey);
const data = info.data;
const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

console.log('Owner:', info.owner.toString());
console.log('Data length:', data.length, 'bytes');
console.log('Discriminator:', Buffer.from(data.slice(0, 8)).toString('hex'));

// Find known pubkeys
const bananaMint = 'ABj8RJzGHxbLoB8JBea8kvBx626KwSfvbpce9xVfkK7w';
const solMint = 'So11111111111111111111111111111111111111112';

for (let off = 8; off <= data.length - 32; off++) {
  const pk = new PublicKey(data.slice(off, off + 32)).toString();
  if (pk === bananaMint) console.log('BANANAS mint at offset', off);
  if (pk === solMint) console.log('SOL mint at offset', off);
}

// Dump all u64 fields
console.log('\n--- All non-zero u64 fields ---');
for (let off = 8; off < data.length - 8; off += 8) {
  try {
    const val = dv.getBigUint64(off, true);
    if (val > 0n) {
      const numVal = Number(val);
      let note = '';
      if (numVal === 420000000000) note = ' <- maxBuyingCap 420 SOL';
      if (numVal === 1000000000000000) note = ' <- 1B tokens (6 dec)';
      if (numVal > 1700000000 && numVal < 2000000000) note = ` <- timestamp ${new Date(numVal * 1000).toISOString()}`;
      console.log(`  [${off}] ${val.toString()}${note}`);
    }
  } catch {}
}

// Activation point
if (data.length >= 480) {
  const ap = Number(dv.getBigInt64(472, true));
  console.log('\nActivation point (offset 472):', ap, '=', new Date(ap * 1000).toISOString());
}

// Try to read sqrtPrice (u128) - common in CLMM pools
console.log('\n--- Potential u128 sqrtPrice candidates ---');
for (let off = 200; off < Math.min(600, data.length - 16); off += 8) {
  try {
    const lo = dv.getBigUint64(off, true);
    const hi = dv.getBigUint64(off + 8, true);
    if (hi > 0n && hi < 1000000000000n) {
      const u128 = (hi << 64n) | lo;
      console.log(`  [${off}] lo=${lo} hi=${hi} u128=${u128}`);
    }
  } catch {}
}

// Hex dump of first 600 bytes for manual inspection
console.log('\n--- Hex dump (32-byte rows) ---');
for (let i = 0; i < Math.min(600, data.length); i += 32) {
  const row = Buffer.from(data.slice(i, Math.min(i + 32, data.length))).toString('hex');
  console.log(`  ${String(i).padStart(4, ' ')} | ${row}`);
}
