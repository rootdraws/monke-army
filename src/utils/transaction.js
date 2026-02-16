/**
 * Transaction builder utilities for monke.army
 * 
 * Two modes:
 * 1. Via Core Contract (recommended): User → Core → Meteora
 *    - Fees handled by contract
 *    - Position tracked on-chain
 *    - Bot can auto-close
 * 
 * 2. Direct to Meteora (advanced): User → Meteora directly
 *    - No fee (but no auto-close)
 *    - For power users
 *
 * Changes applied:
 * I17: getVaultPDA uses meteoraPosition (per-position vault, not per-pool)
 * I18: Instruction data serialization via Anchor discriminator + borsh
 * I19: ASSOCIATED_TOKEN_PROGRAM_ID added to account lists
 * G7:  estimateTxFee uses getRecentPrioritizationFees instead of hardcoded
 */

import { 
  Transaction, 
  PublicKey, 
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { 
  createTransferInstruction, 
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,  // I19
  NATIVE_MINT
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';  // I18
import BN from 'bn.js';

// Rent sysvar (required by Meteora initialize_position V1)
const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');

// Token-2022 program ID for open_position_v2
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Program IDs (update after deployment)
export const CORE_PROGRAM_ID = new PublicKey(
  process.env.VITE_CORE_PROGRAM_ID || 'BINFARM1111111111111111111111111111111111111'
);

// Fee in basis points (30 = 0.3%)
// This is read from env at build time only. If admin calls
// update_fee on-chain, this display value will diverge. Full fix requires
// reading fee_bps from the on-chain Config account at runtime (deferred until
// programs are deployed).
export const FEE_BPS = parseInt(process.env.VITE_FEE_BPS || '30');

// Warn if using placeholder program IDs — transactions will fail
if (CORE_PROGRAM_ID.toBase58().includes('1111111111')) {
  console.warn('WARNING: Using placeholder CORE_PROGRAM_ID (BINFARM1111...) — transactions will fail. Set VITE_CORE_PROGRAM_ID.');
}

// ============ I18: ANCHOR INSTRUCTION HELPERS ============

/**
 * Get Anchor instruction discriminator (first 8 bytes of sha256("global:<name>"))
 * @param {string} instructionName - e.g. 'open_position', 'user_close'
 * @returns {Buffer}
 */
function getDiscriminator(instructionName) {
  const hash = sha256(`global:${instructionName}`);
  return Buffer.from(hash.slice(0, 8));
}

/**
 * Serialize open_position instruction data
 * Layout: discriminator(8) + amount(8) + minBinId(4) + maxBinId(4) + side(1) + maxActiveBinSlippage(4)
 * max_active_bin_slippage is now a parameter (was hardcoded 5 on-chain).
 * Default 5 for stable pools. Use 10-15 for volatile meme/pump.fun pools.
 */
function serializeOpenPosition(amount, minBinId, maxBinId, side, maxActiveBinSlippage = 5, instructionName = 'open_position') {
  const disc = getDiscriminator(instructionName);
  const args = Buffer.alloc(21);
  args.writeBigUInt64LE(BigInt(new BN(amount).toString()), 0);
  args.writeInt32LE(minBinId, 8);
  args.writeInt32LE(maxBinId, 12);
  args.writeUInt8(side === 'buy' ? 0 : 1, 16);
  args.writeInt32LE(maxActiveBinSlippage, 17);
  return Buffer.concat([disc, args]);
}

/**
 * Serialize a no-arg instruction (user_close, claim_fees)
 */
function serializeNoArgs(instructionName) {
  return getDiscriminator(instructionName);
}

// ============ FEE UTILITIES ============

/**
 * Calculate fee amount
 * Uses BN math to avoid precision loss for amounts > 2^53 (memecoins)
 * @param {number|BN} amount 
 * @returns {BN}
 */
export function calculateFee(amount) {
  const amountBN = BN.isBN(amount) ? amount : new BN(amount.toString());
  return amountBN.muln(FEE_BPS).divn(10000);
}

/**
 * Calculate net amount after fee
 * Uses BN math throughout for precision
 * @param {number|BN} amount 
 * @returns {{ fee: BN, net: BN, feePercent: number }}
 */
export function calculateAmounts(amount) {
  const amountBN = BN.isBN(amount) ? amount : new BN(amount.toString());
  const fee = calculateFee(amountBN);
  return {
    fee,
    net: amountBN.sub(fee),
    feePercent: FEE_BPS / 100,
  };
}

// ============ PDA DERIVATION ============

/**
 * Derive core program config PDA
 */
export function getConfigPDA() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    CORE_PROGRAM_ID
  );
}

/**
 * Derive position PDA from Meteora position pubkey
 * @param {PublicKey} meteoraPosition 
 */
export function getPositionPDA(meteoraPosition) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), meteoraPosition.toBuffer()],
    CORE_PROGRAM_ID
  );
}

/**
 * I17: Derive vault PDA per-position (not per-pool).
 * Each position gets its own vault for clean token isolation.
 * @param {PublicKey} meteoraPosition - Meteora position public key
 */
export function getVaultPDA(meteoraPosition) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), meteoraPosition.toBuffer()],
    CORE_PROGRAM_ID
  );
}


// ============ TRANSACTION BUILDERS ============

/**
 * Build open position transaction via Core Contract
 * 
 * This is the recommended flow:
 * 1. User approves transaction
 * 2. Core contract takes 0.3% fee (SOL → rover sweep, tokens → rover recycling)
 * 3. Core CPIs to Meteora to create position
 * 4. Position is tracked, enabling bot auto-close
 * 
 * I17: Uses per-position vault (meteoraPositionKeypair.publicKey)
 * I18: Serialized instruction data (discriminator + args)
 * I19: Includes ASSOCIATED_TOKEN_PROGRAM_ID in account list
 * 
 * @param {Connection} connection
 * @param {PublicKey} user - User's wallet
 * @param {PublicKey} lbPair - Meteora pool address
 * @param {Keypair} meteoraPositionKeypair - New position keypair
 * @param {BN|number} amount - Amount to deposit (fee will be deducted)
 * @param {number} minBinId - Minimum bin ID
 * @param {number} maxBinId - Maximum bin ID
 * @param {'buy'|'sell'} side
 * @param {PublicKey} tokenMint - Token mint (WSOL for buy, token for sell)
 * @param {object} meteoraAccounts - Meteora-specific accounts: { binArrayBitmapExt, reserve, binArrayLower, binArrayUpper, eventAuthority, dlmmProgram }
 * @param {object} [options] - Optional: { tokenProgram, maxActiveBinSlippage }
 *   tokenProgram: PublicKey — TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID. Auto-detected if not provided.
 *   maxActiveBinSlippage: number — default 5, use 10-15 for volatile meme pools.
 * @returns {Promise<Transaction>}
 */
export async function buildOpenPositionTx(
  connection,
  user,
  lbPair,
  meteoraPositionKeypair,
  amount,
  minBinId,
  maxBinId,
  side,
  tokenMint,
  meteoraAccounts,
  options = {}
) {
  const tx = new Transaction();
  const maxSlippage = options.maxActiveBinSlippage ?? 5; // Configurable slippage

  // Detect Token-2022 mint by checking account owner
  let tokenProgramId = options.tokenProgram;
  if (!tokenProgramId) {
    const mintInfo = await connection.getAccountInfo(tokenMint);
    if (mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      tokenProgramId = TOKEN_2022_PROGRAM_ID;
    } else {
      tokenProgramId = TOKEN_PROGRAM_ID;
    }
  }
  const isToken2022 = tokenProgramId.equals(TOKEN_2022_PROGRAM_ID);
  
  // Get PDAs
  const [configPDA] = getConfigPDA();
  const [positionPDA] = getPositionPDA(meteoraPositionKeypair.publicKey);
  // I17: Vault PDA per-position, not per-pool
  const [vaultPDA] = getVaultPDA(meteoraPositionKeypair.publicKey);
  
  // Get token accounts (using correct program for Token-2022)
  const userTokenAccount = await getAssociatedTokenAddress(tokenMint, user, false, tokenProgramId);
  const vaultTokenAccount = await getAssociatedTokenAddress(tokenMint, vaultPDA, true, tokenProgramId);
  
  // Create vault token account if needed
  const vaultAccountInfo = await connection.getAccountInfo(vaultTokenAccount);
  if (!vaultAccountInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        user,
        vaultTokenAccount,
        vaultPDA,
        tokenMint,
        tokenProgramId
      )
    );
  }
  
  // I18: Serialize instruction data. Use open_position_v2 for Token-2022.
  const instructionName = isToken2022 ? 'open_position_v2' : 'open_position';
  const data = serializeOpenPosition(amount, minBinId, maxBinId, side, maxSlippage, instructionName);
  
  // Account layout matches on-chain OpenPosition / OpenPositionV2 struct.
  // OpenPositionV2 uses /// CHECK: token_program instead of Program<'info, Token>.
  const openPositionIx = new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },                                       // user
      { pubkey: configPDA, isSigner: false, isWritable: true },                                  // config (mut — writes total_positions + total_volume)
      { pubkey: lbPair, isSigner: false, isWritable: true },                                     // lb_pair
      { pubkey: meteoraPositionKeypair.publicKey, isSigner: true, isWritable: true },             // meteora_position
      { pubkey: meteoraAccounts.binArrayBitmapExt, isSigner: false, isWritable: true },           // bin_array_bitmap_ext
      { pubkey: meteoraAccounts.reserve, isSigner: false, isWritable: true },                     // reserve
      { pubkey: meteoraAccounts.binArrayLower, isSigner: false, isWritable: true },               // bin_array_lower
      { pubkey: meteoraAccounts.binArrayUpper, isSigner: false, isWritable: true },               // bin_array_upper
      { pubkey: meteoraAccounts.eventAuthority, isSigner: false, isWritable: false },             // event_authority
      { pubkey: meteoraAccounts.dlmmProgram, isSigner: false, isWritable: false },                // dlmm_program
      { pubkey: positionPDA, isSigner: false, isWritable: true },                                 // position (init)
      { pubkey: vaultPDA, isSigner: false, isWritable: true },                                    // vault (init)
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },                            // user_token_account
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },                           // vault_token_account
      { pubkey: tokenMint, isSigner: false, isWritable: false },                                  // token_mint
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },                             // token_program (SPL or Token-2022)
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                // associated_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },                    // system_program
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },                         // rent
    ],
    data,
  });
  
  tx.add(openPositionIx);
  
  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  
  return tx;
}

/**
 * Build close position transaction (user-initiated)
 * 
 * I17: Uses per-position vault
 * I18: Serialized instruction data
 * I19: Includes ASSOCIATED_TOKEN_PROGRAM_ID
 * 
 * @param {Connection} connection
 * @param {PublicKey} user
 * @param {PublicKey} positionPDA - Our position account
 * @param {object} positionData - Position account data
 * @param {object} meteoraAccounts - { meteoraPosition, lbPair, binArrayBitmapExt, binArrayLower, binArrayUpper, reserveX, reserveY, eventAuthority, dlmmProgram, tokenXProgram, tokenYProgram, memoProgram }
 * @returns {Promise<Transaction>}
 */
export async function buildUserCloseTx(
  connection,
  user,
  positionPDA,
  positionData,
  meteoraAccounts
) {
  const tx = new Transaction();
  
  const [configPDA] = getConfigPDA();
  // I17: Vault PDA per-position
  const [vaultPDA] = getVaultPDA(positionData.meteoraPosition);
  
  // Get token accounts
  const vaultTokenX = await getAssociatedTokenAddress(positionData.tokenXMint, vaultPDA, true);
  const vaultTokenY = await getAssociatedTokenAddress(positionData.tokenYMint, vaultPDA, true);
  const userTokenX = await getAssociatedTokenAddress(positionData.tokenXMint, user);
  const userTokenY = await getAssociatedTokenAddress(positionData.tokenYMint, user);
  // Rover authority PDA + fee token ATAs (required by on-chain UserClose struct)
  // All fees route through rover_authority for DLMM recycling
  const [roverAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('rover_authority')], CORE_PROGRAM_ID
  );
  const roverFeeTokenX = await getAssociatedTokenAddress(positionData.tokenXMint, roverAuthorityPda, true);
  const roverFeeTokenY = await getAssociatedTokenAddress(positionData.tokenYMint, roverAuthorityPda, true);
  
  // Create user token accounts if needed
  const userXInfo = await connection.getAccountInfo(userTokenX);
  if (!userXInfo) {
    tx.add(createAssociatedTokenAccountInstruction(user, userTokenX, user, positionData.tokenXMint));
  }
  const userYInfo = await connection.getAccountInfo(userTokenY);
  if (!userYInfo) {
    tx.add(createAssociatedTokenAccountInstruction(user, userTokenY, user, positionData.tokenYMint));
  }
  
  const data = serializeNoArgs('user_close');
  
  // Account layout matches on-chain UserClose struct EXACTLY.
  // Order: user, config, position, vault, meteora_position, lb_pair,
  //   bin_array_bitmap_ext, bin_array_lower, bin_array_upper, reserve_x, reserve_y,
  //   token_x_mint, token_y_mint, event_authority, dlmm_program,
  //   vault_token_x, vault_token_y, user_token_x, user_token_y,
  //   rover_fee_token_y, rover_authority, rover_fee_token_x,
  //   token_program, token_x_program, token_y_program, memo_program, system_program
  const userCloseIx = new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },                                         // user
      { pubkey: configPDA, isSigner: false, isWritable: true },                                    // config (mut — writes total_harvested)
      { pubkey: positionPDA, isSigner: false, isWritable: true },                                  // position (close=user)
      { pubkey: vaultPDA, isSigner: false, isWritable: true },                                     // vault
      { pubkey: meteoraAccounts.meteoraPosition, isSigner: false, isWritable: true },              // meteora_position
      { pubkey: meteoraAccounts.lbPair, isSigner: false, isWritable: true },                       // lb_pair
      { pubkey: meteoraAccounts.binArrayBitmapExt, isSigner: false, isWritable: true },            // bin_array_bitmap_ext
      { pubkey: meteoraAccounts.binArrayLower, isSigner: false, isWritable: true },                // bin_array_lower
      { pubkey: meteoraAccounts.binArrayUpper, isSigner: false, isWritable: true },                // bin_array_upper
      { pubkey: meteoraAccounts.reserveX, isSigner: false, isWritable: true },                     // reserve_x
      { pubkey: meteoraAccounts.reserveY, isSigner: false, isWritable: true },                     // reserve_y
      { pubkey: positionData.tokenXMint, isSigner: false, isWritable: false },                     // token_x_mint
      { pubkey: positionData.tokenYMint, isSigner: false, isWritable: false },                     // token_y_mint
      { pubkey: meteoraAccounts.eventAuthority, isSigner: false, isWritable: false },              // event_authority
      { pubkey: meteoraAccounts.dlmmProgram, isSigner: false, isWritable: false },                 // dlmm_program
      { pubkey: vaultTokenX, isSigner: false, isWritable: true },                                  // vault_token_x
      { pubkey: vaultTokenY, isSigner: false, isWritable: true },                                  // vault_token_y
      { pubkey: userTokenX, isSigner: false, isWritable: true },                                   // user_token_x
      { pubkey: userTokenY, isSigner: false, isWritable: true },                                   // user_token_y
      { pubkey: roverFeeTokenY, isSigner: false, isWritable: true },                               // rover_fee_token_y
      { pubkey: roverAuthorityPda, isSigner: false, isWritable: false },                           // rover_authority
      { pubkey: roverFeeTokenX, isSigner: false, isWritable: true },                               // rover_fee_token_x
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                            // token_program
      { pubkey: meteoraAccounts.tokenXProgram, isSigner: false, isWritable: false },               // token_x_program
      { pubkey: meteoraAccounts.tokenYProgram, isSigner: false, isWritable: false },               // token_y_program
      { pubkey: meteoraAccounts.memoProgram, isSigner: false, isWritable: false },                 // memo_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },                     // system_program
    ],
    data,
  });
  
  tx.add(userCloseIx);
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  
  return tx;
}

/**
 * Build claim fees transaction
 * 
 * I17: Uses per-position vault
 * I18: Serialized instruction data
 * 
 * @param {Connection} connection
 * @param {PublicKey} user
 * @param {PublicKey} positionPDA
 * @param {object} positionData
 * @param {object} meteoraAccounts - { meteoraPosition, lbPair, binArrayLower, binArrayUpper, reserveX, reserveY, eventAuthority, dlmmProgram, tokenXProgram, tokenYProgram, memoProgram }
 * @returns {Promise<Transaction>}
 */
export async function buildClaimFeesTx(
  connection,
  user,
  positionPDA,
  positionData,
  meteoraAccounts
) {
  const tx = new Transaction();
  
  // I17: Vault PDA per-position
  const [vaultPDA] = getVaultPDA(positionData.meteoraPosition);
  
  const vaultTokenX = await getAssociatedTokenAddress(positionData.tokenXMint, vaultPDA, true);
  const vaultTokenY = await getAssociatedTokenAddress(positionData.tokenYMint, vaultPDA, true);
  const userTokenX = await getAssociatedTokenAddress(positionData.tokenXMint, user);
  const userTokenY = await getAssociatedTokenAddress(positionData.tokenYMint, user);
  
  const data = serializeNoArgs('claim_fees');
  
  // Account layout matches on-chain ClaimFees struct EXACTLY.
  // Order: user, position, vault, meteora_position, lb_pair,
  //   bin_array_lower, bin_array_upper, reserve_x, reserve_y,
  //   token_x_mint, token_y_mint, event_authority, dlmm_program,
  //   vault_token_x, vault_token_y, user_token_x, user_token_y,
  //   token_program, token_x_program, token_y_program, memo_program
  const claimFeesIx = new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },                                          // user
      { pubkey: positionPDA, isSigner: false, isWritable: false },                                  // position
      { pubkey: vaultPDA, isSigner: false, isWritable: false },                                     // vault
      { pubkey: meteoraAccounts.meteoraPosition, isSigner: false, isWritable: true },               // meteora_position
      { pubkey: meteoraAccounts.lbPair, isSigner: false, isWritable: true },                        // lb_pair
      { pubkey: meteoraAccounts.binArrayLower, isSigner: false, isWritable: true },                 // bin_array_lower
      { pubkey: meteoraAccounts.binArrayUpper, isSigner: false, isWritable: true },                 // bin_array_upper
      { pubkey: meteoraAccounts.reserveX, isSigner: false, isWritable: true },                      // reserve_x
      { pubkey: meteoraAccounts.reserveY, isSigner: false, isWritable: true },                      // reserve_y
      { pubkey: positionData.tokenXMint, isSigner: false, isWritable: false },                      // token_x_mint
      { pubkey: positionData.tokenYMint, isSigner: false, isWritable: false },                      // token_y_mint
      { pubkey: meteoraAccounts.eventAuthority, isSigner: false, isWritable: false },               // event_authority
      { pubkey: meteoraAccounts.dlmmProgram, isSigner: false, isWritable: false },                  // dlmm_program
      { pubkey: vaultTokenX, isSigner: false, isWritable: true },                                   // vault_token_x
      { pubkey: vaultTokenY, isSigner: false, isWritable: true },                                   // vault_token_y
      { pubkey: userTokenX, isSigner: false, isWritable: true },                                    // user_token_x
      { pubkey: userTokenY, isSigner: false, isWritable: true },                                    // user_token_y
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                             // token_program
      { pubkey: meteoraAccounts.tokenXProgram, isSigner: false, isWritable: false },                // token_x_program
      { pubkey: meteoraAccounts.tokenYProgram, isSigner: false, isWritable: false },                // token_y_program
      { pubkey: meteoraAccounts.memoProgram, isSigner: false, isWritable: false },                  // memo_program
    ],
    data,
  });
  
  tx.add(claimFeesIx);
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;
  
  return tx;
}

// ============ DISPLAY UTILITIES ============

/**
 * Format fee for display
 * @param {number|BN} amount 
 * @returns {{ fee: string, feePercent: string, netAmount: string }}
 */
export function formatFeeDisplay(amount, decimals = 9) {
  const { fee, net, feePercent } = calculateAmounts(amount);
  const divisorBN = new BN(10).pow(new BN(decimals));
  
  // Divide in BN space first to avoid .toNumber() overflow for memecoins > 2^53.
  // Whole part is safe to convert to Number; fractional part is formatted from the remainder.
  const feeWhole = fee.div(divisorBN).toString();
  const feeRemainder = fee.mod(divisorBN).toString().padStart(decimals, '0');
  const netWhole = net.div(divisorBN).toString();
  const netRemainder = net.mod(divisorBN).toString().padStart(decimals, '0');
  
  const truncDecimals = decimals > 6 ? 6 : decimals;
  return {
    fee: `${feeWhole}.${feeRemainder.slice(0, truncDecimals)}`,
    feePercent: `${feePercent}%`,
    netAmount: `${netWhole}.${netRemainder.slice(0, truncDecimals)}`,
  };
}

/**
 * G7: Estimate transaction fee using recent prioritization fees from the network.
 * Falls back to hardcoded 10000 lamports if RPC call fails.
 * 
 * @param {Connection} connection 
 * @param {Transaction} tx 
 * @returns {Promise<number>} Estimated fee in SOL
 */
export async function estimateTxFee(connection, tx) {
  const signatures = tx.signatures.length || 1;
  const baseFee = signatures * 5000;

  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length === 0) {
      return (baseFee + 10000) / LAMPORTS_PER_SOL;
    }
    const sorted = fees.sort((a, b) => a.prioritizationFee - b.prioritizationFee);
    const priorityFee = sorted[Math.floor(sorted.length / 2)]?.prioritizationFee || 10000;
    return (baseFee + priorityFee) / LAMPORTS_PER_SOL;
  } catch {
    // Fallback to hardcoded estimate
    return (baseFee + 10000) / LAMPORTS_PER_SOL;
  }
}