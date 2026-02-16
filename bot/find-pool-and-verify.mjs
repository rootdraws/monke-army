/**
 * find-pool-and-verify.mjs
 *
 * Finds a real Meteora DLMM LbPair account, then verifies ACTIVE_ID_OFFSET.
 * Two-step: first finds a pool via getProgramAccounts, then scans its bytes.
 *
 * Usage:
 *   RPC_URL=https://... node bot/find-pool-and-verify.mjs
 */

import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// Known LbPair struct size discriminator (first 8 bytes) — we filter by data size
// LbPair accounts are large (~900+ bytes)
const MIN_LBPAIR_SIZE = 800;

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');

  console.log(`RPC: ${RPC_URL.slice(0, 50)}...`);
  console.log(`Meteora DLMM Program: ${METEORA_DLMM_PROGRAM.toBase58()}\n`);

  // Step 1: Find LbPair accounts owned by the DLMM program
  // Use dataSize filter to narrow down (LbPair accounts have a specific size)
  console.log('Finding LbPair accounts...');

  // Try fetching a few accounts to find the right data size
  const accounts = await conn.getProgramAccounts(METEORA_DLMM_PROGRAM, {
    dataSlice: { offset: 0, length: 0 }, // We just want to know the accounts, not data yet
    filters: [
      { dataSize: 904 }, // Common LbPair size — try this first
    ],
  });

  let lbPairAddress;
  let lbPairSize = 904;

  if (accounts.length > 0) {
    lbPairAddress = accounts[0].pubkey;
    console.log(`Found ${accounts.length} accounts at size 904. Using: ${lbPairAddress.toBase58()}`);
  } else {
    // Try other sizes
    for (const size of [880, 912, 920, 928, 936, 944, 952, 960]) {
      const accts = await conn.getProgramAccounts(METEORA_DLMM_PROGRAM, {
        dataSlice: { offset: 0, length: 0 },
        filters: [{ dataSize: size }],
      });
      if (accts.length > 0) {
        lbPairAddress = accts[0].pubkey;
        lbPairSize = size;
        console.log(`Found ${accts.length} accounts at size ${size}. Using: ${lbPairAddress.toBase58()}`);
        break;
      }
    }
  }

  if (!lbPairAddress) {
    // Last resort — get any account
    console.log('Trying to get any account from the program...');
    const any = await conn.getProgramAccounts(METEORA_DLMM_PROGRAM, {
      dataSlice: { offset: 0, length: 8 }, // Just discriminator
    });
    console.log(`Found ${any.length} total accounts.`);
    if (any.length > 0) {
      // Group by size to find LbPair accounts (likely largest common group)
      const sizes = {};
      for (const a of any.slice(0, 100)) {
        const info = await conn.getAccountInfo(a.pubkey);
        const s = info.data.length;
        sizes[s] = (sizes[s] || 0) + 1;
      }
      console.log('Account sizes found:', JSON.stringify(sizes, null, 2));
    }
    console.error('Could not find LbPair accounts. Try providing a known pool address.');
    process.exit(1);
  }

  // Step 2: Fetch the full account data
  console.log(`\nFetching full account data for ${lbPairAddress.toBase58()}...`);
  const accountInfo = await conn.getAccountInfo(lbPairAddress);
  const data = accountInfo.data;
  console.log(`Data length: ${data.length} bytes`);

  // Step 3: Scan for plausible activeId values
  // Active bin IDs for Meteora pools are typically i32 values in range [-500000, 500000]
  console.log('\nScanning all 4-byte aligned offsets for plausible activeId values:\n');

  const candidates = [];
  for (let offset = 8; offset <= data.length - 4; offset += 1) {
    const val = data.readInt32LE(offset);
    // Active bin IDs are typically in a reasonable range and non-zero
    if (val > 1000 && val < 100000) {
      candidates.push({ offset, val });
    }
  }

  // Print candidates, highlighting the most likely ones
  console.log(`Found ${candidates.length} candidates with value in [1000, 100000]:\n`);
  for (const { offset, val } of candidates) {
    // Updated offset to match geyser-subscriber.ts OFFSET_ACTIVE_ID (76)
    const isTarget = offset === 76;
    console.log(`  offset ${String(offset).padStart(4)}: ${val}${isTarget ? '  ← CURRENT CONSTANT (76)' : ''}`);
  }

  // Check specifically at offset 76 (verified against Meteora DLMM IDL + geyser-subscriber.ts)
  const CURRENT_OFFSET = 76;
  if (data.length >= CURRENT_OFFSET + 4) {
    const valAtOffset = data.readInt32LE(CURRENT_OFFSET);
    console.log(`\n--- Value at current ACTIVE_ID_OFFSET (${CURRENT_OFFSET}): ${valAtOffset} ---`);
    if (valAtOffset > 1000 && valAtOffset < 100000) {
      console.log('This looks like a plausible active bin ID.');
      console.log('Cross-check: visit app.meteora.ag and find this pool to confirm the active bin.');
    } else {
      console.log('This does NOT look like an active bin ID.');
      console.log('The constant likely needs updating.');
    }
  }

  console.log(`\nPool address for manual verification: ${lbPairAddress.toBase58()}`);
  console.log('Visit app.meteora.ag to cross-check the active bin ID.');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
