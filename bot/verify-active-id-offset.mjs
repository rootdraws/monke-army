/**
 * verify-active-id-offset.mjs
 *
 * Verification script for ACTIVE_ID_OFFSET.
 * Plain JS version to avoid ESM/CJS compatibility issues with DLMM SDK.
 *
 * Strategy: Fetch the raw LbPair account data and the deserialized version
 * from the DLMM SDK in CJS mode, then search for the activeId bytes.
 *
 * Usage:
 *   RPC_URL=https://... node bot/verify-active-id-offset.mjs [POOL_ADDRESS]
 */

import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const DEFAULT_POOL = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'; // SOL/USDC

async function main() {
  const poolAddress = process.argv[2] || DEFAULT_POOL;
  const conn = new Connection(RPC_URL, 'confirmed');
  const poolPubkey = new PublicKey(poolAddress);

  console.log(`RPC: ${RPC_URL.slice(0, 50)}...`);
  console.log(`Pool: ${poolAddress}\n`);

  // Step 1: Try to get activeId from DLMM SDK
  let sdkActiveId = null;
  try {
    // Dynamic import — may fail due to ESM issues
    const { default: DLMM } = await import('@meteora-ag/dlmm');
    const dlmm = await DLMM.create(conn, poolPubkey);
    sdkActiveId = dlmm.lbPair.activeId;
    console.log(`SDK activeId: ${sdkActiveId}`);
  } catch (e) {
    console.log(`SDK import failed: ${e.message}`);
    console.log('Falling back to manual byte scanning...\n');
  }

  // Step 2: Get raw account data
  console.log('Fetching raw account data...');
  const accountInfo = await conn.getAccountInfo(poolPubkey);
  if (!accountInfo) {
    console.error('Account not found!');
    process.exit(1);
  }
  const data = accountInfo.data;
  console.log(`Account data: ${data.length} bytes`);
  console.log(`Owner: ${accountInfo.owner.toBase58()}\n`);

  if (sdkActiveId !== null) {
    // Step 3a: Search for the known activeId value
    console.log(`Searching for i32 LE value ${sdkActiveId} in raw bytes...`);
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(sdkActiveId);

    const matches = [];
    for (let offset = 0; offset < data.length - 4; offset++) {
      if (data.slice(offset, offset + 4).equals(buf)) {
        matches.push(offset);
      }
    }

    if (matches.length === 0) {
      console.log('WARNING: Value not found. Active bin may have changed between fetches.');
      console.log('Try running again.\n');
    } else {
      console.log(`Found at ${matches.length} offset(s):\n`);
      for (const offset of matches) {
        const likely = offset >= 100 && offset <= 300;
        console.log(`  offset ${offset}${likely ? '  ← LIKELY (expected struct range)' : ''}`);
      }
    }

    // Step 4: Check against current constant
    const CURRENT_OFFSET = 76;
    console.log(`\nCurrent ACTIVE_ID_OFFSET constant: ${CURRENT_OFFSET}`);

    if (matches.includes(CURRENT_OFFSET)) {
      console.log('✓ Current value (76) is CORRECT — matches a found offset');
    } else if (matches.length > 0) {
      const best = matches.find(o => o >= 100 && o <= 300) || matches[0];
      console.log(`✗ Current value (${CURRENT_OFFSET}) is WRONG`);
      console.log(`→ Recommended: ACTIVE_ID_OFFSET = ${best}`);
      console.log('  Update in bot/geyser-subscriber.ts');
    }
  } else {
    // Step 3b: No SDK — scan for plausible activeId values at likely offsets
    console.log('Scanning likely offsets (100-300) for plausible activeId values:\n');
    for (let offset = 100; offset <= Math.min(300, data.length - 4); offset += 4) {
      const val = data.readInt32LE(offset);
      // Active bin IDs for Meteora are typically in range -100000 to 100000
      if (val > -100000 && val < 100000 && val !== 0) {
        console.log(`  offset ${offset}: activeId = ${val}`);
      }
    }
    console.log('\nCompare these with the actual active bin ID from app.meteora.ag');
    console.log('The correct offset will have the matching value.');
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
