/**
 * test-close-position.ts
 *
 * Standalone test: close position 3qQGCmDY directly with full error output.
 * No DLMM SDK — resolves all accounts from raw on-chain data.
 * Usage: npx tsx scripts/test-close-position.ts
 */

import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  Connection,
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

dotenv.config({ path: path.join(__dirname, '..', 'bot', '.env') });

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const CORE = new PublicKey(process.env.CORE_PROGRAM_ID!);

const POSITION_PDA = '3qQGCmDYzyybSt7sfZTMQB9SJp3Fav5ph24uDgvjt3Uo';
const LB_PAIR = 'ABdAmqgz3CNvU9kjn5fAtnFurvBvgs6PP7ksTb3VfzQM';

// LbPair byte offsets (from geyser-subscriber.ts — verified against live mainnet accounts)
const OFFSET_ACTIVE_ID = 76;
const OFFSET_TOKEN_X_MINT = 88;
const OFFSET_TOKEN_Y_MINT = 120;
const OFFSET_RESERVE_X = 152;
const OFFSET_RESERVE_Y = 184;
const OFFSET_TOKEN_X_PROG_FLAG = 880;
const OFFSET_TOKEN_Y_PROG_FLAG = 881;

const keypairJson = JSON.parse(readFileSync(process.env.BOT_KEYPAIR_PATH!, 'utf-8'));
const botKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
const connection = new Connection(process.env.RPC_URL!, 'confirmed');
const provider = new AnchorProvider(connection, new Wallet(botKeypair), { commitment: 'confirmed' });
const idl = JSON.parse(readFileSync(path.join(__dirname, '..', 'bot', 'idl', 'bin_farm.json'), 'utf-8'));
const program = new Program(idl, provider);

async function main() {
  console.log('=== Test Close Position (no DLMM SDK) ===\n');

  // 1. Read Position PDA
  const posInfo = await connection.getAccountInfo(new PublicKey(POSITION_PDA));
  if (!posInfo) { console.log('Position PDA not found — already closed!'); return; }
  const owner = new PublicKey(posInfo.data.slice(8, 40));
  const lbPairKey = new PublicKey(posInfo.data.slice(40, 72));
  const meteoraPosKey = new PublicKey(posInfo.data.slice(72, 104));
  console.log('Owner:', owner.toBase58());
  console.log('MeteoraPos:', meteoraPosKey.toBase58());
  console.log('LbPair:', lbPairKey.toBase58());

  // 2. Read LbPair raw bytes
  const lbPairInfo = await connection.getAccountInfo(lbPairKey);
  if (!lbPairInfo) throw new Error('LbPair not found');
  const lbData = lbPairInfo.data;
  const tokenXMint = new PublicKey(lbData.slice(OFFSET_TOKEN_X_MINT, OFFSET_TOKEN_X_MINT + 32));
  const tokenYMint = new PublicKey(lbData.slice(OFFSET_TOKEN_Y_MINT, OFFSET_TOKEN_Y_MINT + 32));
  const reserveX = new PublicKey(lbData.slice(OFFSET_RESERVE_X, OFFSET_RESERVE_X + 32));
  const reserveY = new PublicKey(lbData.slice(OFFSET_RESERVE_Y, OFFSET_RESERVE_Y + 32));
  const activeId = lbData.readInt32LE(OFFSET_ACTIVE_ID);
  console.log('\nTokenX mint:', tokenXMint.toBase58());
  console.log('TokenY mint:', tokenYMint.toBase58());
  console.log('ActiveId:', activeId);

  // 3. Detect token programs from LbPair flags (same as geyser-subscriber)
  const tokenXProgFlag = lbData.readUInt8(OFFSET_TOKEN_X_PROG_FLAG);
  const tokenYProgFlag = lbData.readUInt8(OFFSET_TOKEN_Y_PROG_FLAG);
  const tokenXProg = tokenXProgFlag === 1 ? TOKEN_2022 : TOKEN_PROGRAM_ID;
  const tokenYProg = tokenYProgFlag === 1 ? TOKEN_2022 : TOKEN_PROGRAM_ID;
  console.log('TokenX program:', tokenXProgFlag === 1 ? 'Token-2022' : 'SPL Token', `(flag=${tokenXProgFlag})`);
  console.log('TokenY program:', tokenYProgFlag === 1 ? 'Token-2022' : 'SPL Token', `(flag=${tokenYProgFlag})`);

  // 4. PDAs
  const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('config')], CORE);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), meteoraPosKey.toBuffer()], CORE);
  const [roverAuth] = PublicKey.findProgramAddressSync([Buffer.from('rover_authority')], CORE);
  const [eventAuth] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], DLMM_PROGRAM);

  // Bin array bitmap extension — check if account exists
  const [bitmapExtPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('bitmap'), lbPairKey.toBuffer()],
    DLMM_PROGRAM
  );
  const bitmapExtInfo = await connection.getAccountInfo(bitmapExtPDA);
  const bitmapExt = bitmapExtInfo ? bitmapExtPDA : DLMM_PROGRAM;

  // 5. ATAs
  const ownerTokenX = getAssociatedTokenAddressSync(tokenXMint, owner, true, tokenXProg);
  const ownerTokenY = getAssociatedTokenAddressSync(tokenYMint, owner, true, tokenYProg);
  const vaultTokenX = getAssociatedTokenAddressSync(tokenXMint, vaultPda, true, tokenXProg);
  const vaultTokenY = getAssociatedTokenAddressSync(tokenYMint, vaultPda, true, tokenYProg);
  const roverFeeX = getAssociatedTokenAddressSync(tokenXMint, roverAuth, true, tokenXProg);
  const roverFeeY = getAssociatedTokenAddressSync(tokenYMint, roverAuth, true, tokenYProg);

  console.log('\n--- ATAs ---');
  for (const [label, addr] of Object.entries({ ownerTokenX, ownerTokenY, vaultTokenX, vaultTokenY, roverFeeX, roverFeeY })) {
    const info = await connection.getAccountInfo(addr as PublicKey);
    console.log(`${label}: ${(addr as PublicKey).toBase58()} ${info ? `OK (owner: ${info.owner.toBase58().slice(0,12)}...)` : '** MISSING **'}`);
  }

  // 6. Bin arrays — use position min/max bin from our PDA
  // Position layout: discriminator(8) + owner(32) + lb_pair(32) + meteora_position(32) + side(1) + min_bin(4) + max_bin(4) + bump(1)
  const side = posInfo.data.readUInt8(104);
  const minBin = posInfo.data.readInt32LE(105);
  const maxBin = posInfo.data.readInt32LE(109);
  console.log(`\nSide: ${side === 0 ? 'Buy' : 'Sell'}, Bins: ${minBin} → ${maxBin}`);

  const allBinIds: number[] = [];
  for (let b = minBin; b <= maxBin; b++) allBinIds.push(b);

  const arrayIndices = [...new Set(allBinIds.map(id => Math.floor(id / 70)))].sort((a, b) => a - b);
  const deriveBinArray = (idx: number) => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(idx), 0);
    return PublicKey.findProgramAddressSync([Buffer.from('bin_array'), lbPairKey.toBuffer(), buf], DLMM_PROGRAM)[0];
  };
  const binArrayLower = deriveBinArray(arrayIndices[0] ?? 0);
  const binArrayUpper = deriveBinArray(arrayIndices[arrayIndices.length - 1] ?? 0);

  // 7. Build + send
  console.log('\n[SEND] close_position...');
  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    createAssociatedTokenAccountIdempotentInstruction(botKeypair.publicKey, ownerTokenX, owner, tokenXMint, tokenXProg),
    createAssociatedTokenAccountIdempotentInstruction(botKeypair.publicKey, ownerTokenY, owner, tokenYMint, tokenYProg),
    createAssociatedTokenAccountIdempotentInstruction(botKeypair.publicKey, roverFeeX, roverAuth, tokenXMint, tokenXProg),
    createAssociatedTokenAccountIdempotentInstruction(botKeypair.publicKey, roverFeeY, roverAuth, tokenYMint, tokenYProg),
  ];

  try {
    const sig = await program.methods
      .closePosition()
      .accounts({
        bot: botKeypair.publicKey,
        config: configPDA,
        position: new PublicKey(POSITION_PDA),
        vault: vaultPda,
        owner,
        meteoraPosition: meteoraPosKey,
        lbPair: lbPairKey,
        binArrayBitmapExt: bitmapExt,
        binArrayLower,
        binArrayUpper,
        reserveX,
        reserveY,
        tokenXMint,
        tokenYMint,
        eventAuthority: eventAuth,
        dlmmProgram: DLMM_PROGRAM,
        vaultTokenX,
        vaultTokenY,
        ownerTokenX,
        ownerTokenY,
        roverAuthority: roverAuth,
        roverFeeTokenX: roverFeeX,
        roverFeeTokenY: roverFeeY,
        tokenXProgram: tokenXProg,
        tokenYProgram: tokenYProg,
        memoProgram: MEMO,
        systemProgram: new PublicKey('11111111111111111111111111111111'),
      })
      .preInstructions(preIxs)
      .signers([botKeypair])
      .rpc();

    console.log('\n=== SUCCESS ===');
    console.log('Signature:', sig);
  } catch (err: any) {
    console.error('\n=== FAILED ===');
    console.error('Error:', err.message);
    if (err.logs) {
      console.error('\nProgram Logs:');
      for (const log of err.logs) console.error(' ', log);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
