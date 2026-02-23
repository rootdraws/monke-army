/**
 * monke.army — Application Logic
 *
 * Merges:
 * - frame.html scaffold geometry (arc-tracing range panels, pixel-based sliders)
 * - App UI logic (pool loading, position creation, monke dashboard, rover bribes)
 * - SDK integration (transaction.js, meteora.js, bins.js, zap.js, useWallet.js)
 *
 * On-chain calls are structured correctly for immediate swap to real RPCs
 * once programs are deployed. Until then, demo mode simulates responses.
 */

// Codama-generated clients (bundled by esbuild)
import { address } from '@solana/kit';
import {
  getOpenPositionV2InstructionAsync,
  getUserCloseInstructionAsync,
  getClaimFeesInstruction,
  getHarvestBinsInstructionAsync,
  getSweepRoverInstructionAsync,
  decodePosition, decodeConfig,
  BIN_FARM_PROGRAM_ADDRESS, Side,
} from '../src/generated/bin-farm/index.js';
import {
  getFeedMonkeInstructionAsync,
  getClaimInstructionAsync,
  getDepositSolInstructionAsync,
  decodeMonkeBurn, decodeMonkeState,
  MONKE_BANANAS_PROGRAM_ADDRESS,
} from '../src/generated/monke-bananas/index.js';

// ============================================================
// CONFIG — matches .env.example
// ============================================================

const CONFIG = {
  RPC_URL: 'https://api.mainnet-beta.solana.com',
  FEE_BPS: 30,
  CORE_PROGRAM_ID: '8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia',
  MONKE_BANANAS_PROGRAM_ID: 'myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH',
  BANANAS_MINT: 'ABj8RJzGHxbLoB8JBea8kvBx626KwSfvbpce9xVfkK7w',
  SMB_COLLECTION: 'SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W',
  BIRDEYE_API_KEY: '',
  DEFAULT_POOL: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  DEBUG: false,
};

// Runtime config injection — override defaults from /config.json
async function loadConfig() {
  try {
    const resp = await fetch('/config.json');
    if (resp.ok) {
      const json = await resp.json();
      Object.assign(CONFIG, json);
    }
  } catch {
    // Use hardcoded defaults (dev mode)
  }
  // Expose CONFIG globally so enlist.js (bundled separately) can read it
  window.CONFIG = CONFIG;
}

// ============================================================
// CODAMA ADAPTERS — bridge @solana/kit types ↔ @solana/web3.js
// ============================================================

/** Convert @solana/kit Instruction -> @solana/web3.js TransactionInstruction */
function kitIxToWeb3(ix) {
  return new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(ix.programAddress),
    keys: ix.accounts.map(m => ({
      pubkey: new solanaWeb3.PublicKey(m.address),
      isSigner: (m.role & 2) !== 0,
      isWritable: (m.role & 1) !== 0,
    })),
    data: new Uint8Array(ix.data),
  });
}

/** Wrap a web3.js PublicKey as a @solana/kit TransactionSigner shim */
function asSigner(pubkeyOrAddress) {
  const addr = typeof pubkeyOrAddress === 'string'
    ? pubkeyOrAddress : pubkeyOrAddress.toBase58();
  return {
    address: address(addr),
    signTransactions: async () => { throw new Error('use web3.js for signing'); },
  };
}

/** Wrap RPC account data as an EncodedAccount for Codama decoders */
function toEncodedAccount(pubkeyOrStr, data, programAddr) {
  return {
    address: typeof pubkeyOrStr === 'string' ? pubkeyOrStr
      : pubkeyOrStr.toBase58 ? pubkeyOrStr.toBase58() : String(pubkeyOrStr),
    data: new Uint8Array(data),
    executable: false,
    lamports: 0n,
    programAddress: programAddr || BIN_FARM_PROGRAM_ADDRESS,
  };
}

// Read fee_bps from on-chain Config (falls back to config.json value if RPC fails)
async function loadOnChainFeeBps() {
  try {
    if (!state.connection) return;
    const [configPDA] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('config')],
      new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
    );
    const accountInfo = await state.connection.getAccountInfo(configPDA);
    if (accountInfo && accountInfo.data.length >= 138) {
      const decoded = decodeConfig(toEncodedAccount(configPDA, accountInfo.data, BIN_FARM_PROGRAM_ADDRESS));
      const feeBps = decoded.data.feeBps;
      if (feeBps > 0 && feeBps <= 1000) {
        CONFIG.FEE_BPS = feeBps;
        console.log('On-chain fee_bps loaded:', feeBps);
      }
    }
  } catch {
    // Fall back to config.json value silently
  }
}

// ============================================================
// BOT RELAY — WebSocket + REST connection to the LaserStream relay
// ============================================================

let relayWs = null;
let relayConnected = false;

function connectRelay() {
  const url = CONFIG.BOT_RELAY_URL;
  if (!url) return;

  try {
    relayWs = new WebSocket(url + '/ws');

    relayWs.onopen = () => {
      relayConnected = true;
      if (CONFIG.DEBUG) console.log('[relay] Connected to bot relay');
      const statusEl = document.getElementById('opsBotStatus');
      if (statusEl) statusEl.textContent = 'connected';
    };

    relayWs.onclose = () => {
      relayConnected = false;
      if (CONFIG.DEBUG) console.log('[relay] Disconnected — reconnecting in 5s');
      const statusEl = document.getElementById('opsBotStatus');
      if (statusEl) statusEl.textContent = 'offline';
      setTimeout(connectRelay, 5000);
    };

    relayWs.onerror = () => {
      relayConnected = false;
    };

    relayWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRelayEvent(msg);
      } catch {}
    };
  } catch {
    setTimeout(connectRelay, 5000);
  }
}

function handleRelayEvent(msg) {
  switch (msg.type) {
    case 'activeBinChanged':
      // Update price if we're watching this pool
      if (state.poolAddress && msg.data.lbPair === state.poolAddress) {
        const newPrice = binToPrice(msg.data.newActiveId, state.binStep);
        state.currentPrice = newPrice;
        state.activeBin = msg.data.newActiveId;
        const priceEl = document.getElementById('currentPrice');
        if (priceEl) priceEl.textContent = '$' + formatPrice(newPrice);
        vizState.activeBin = msg.data.newActiveId;
        renderBinViz();
      }
      break;

    case 'harvestExecuted':
    case 'positionClosed':
    case 'harvestNeeded':
    case 'positionChanged':
    case 'roverTvlUpdated':
      // Feed to Ops activity log
      addFeedEvent(formatRelayEvent(msg));
      break;

    case 'feedHistory':
      // Catch-up events on WebSocket connect
      if (msg.data && Array.isArray(msg.data)) {
        for (const evt of msg.data) {
          addFeedEvent(formatRelayEvent(evt));
        }
      }
      break;
  }
}

function formatRelayEvent(msg) {
  const d = msg.data || {};
  switch (msg.type) {
    case 'harvestExecuted':
      return `harvested ${d.binCount || '?'} bins on ${(d.lbPair || '').slice(0, 8)}... → ${(d.owner || '').slice(0, 6)}...`;
    case 'positionClosed':
      return `position closed ${(d.lbPair || '').slice(0, 8)}... → ${(d.owner || '').slice(0, 6)}...`;
    case 'harvestNeeded':
      return `${d.safeBinCount || '?'} bins ready on ${(d.lbPair || '').slice(0, 8)}...`;
    case 'positionChanged':
      return `position ${d.action || '?'}: ${(d.positionPDA || '').slice(0, 8)}...`;
    case 'activeBinChanged':
      return `price moved on ${(d.lbPair || '').slice(0, 8)}... → bin ${d.newActiveId}`;
    case 'roverTvlUpdated':
      return `rover TVL updated: ${d.count || 0} pools, $${d.totalTvl || 0}`;
    default:
      return `${msg.type}: ${JSON.stringify(d).slice(0, 80)}`;
  }
}

async function relayFetch(path) {
  if (!CONFIG.BOT_RELAY_URL) return null;
  const baseUrl = CONFIG.BOT_RELAY_URL.replace('ws://', 'http://').replace('wss://', 'https://');
  try {
    const resp = await fetch(baseUrl + path);
    if (resp.ok) return resp.json();
  } catch {}
  return null;
}

// ============================================================
// SDK INLINE — key functions from our fixed SDK files
// ============================================================

/** Bin <-> Price math (from bins.js) */
function binToPrice(binId, binStep) {
  return Math.pow(1 + binStep / 10000, binId);
}

function priceToBin(price, binStep, roundDown = true) {
  if (price <= 0) return NaN;
  const binId = Math.log(price) / Math.log(1 + binStep / 10000);
  return roundDown ? Math.floor(binId) : Math.ceil(binId);
}

function formatPrice(price) {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toExponential(2);
}

/** Fee calculation (from transaction.js) */
function calculateFee(amount) {
  return Math.floor(amount * CONFIG.FEE_BPS / 10000);
}

function calculateAmounts(amount) {
  const fee = calculateFee(amount);
  return { fee, net: amount - fee, feePercent: CONFIG.FEE_BPS / 100 };
}

/** PDA derivation — core program */
function getConfigPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('config')],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

function getPositionPDA(meteoraPosition) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('position'), meteoraPosition.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

function getVaultPDA(meteoraPosition) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('vault'), meteoraPosition.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

function getRoverAuthorityPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('rover_authority')],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

/** PDA derivation — monke_bananas program */
function getMonkeStatePDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('monke_state')],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

function getMonkeBurnPDA(nftMint) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('monke_burn'), nftMint.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

function getDistPoolPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('dist_pool')],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

function getProgramVaultPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('program_vault')],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

/** PDA derivation — Metaplex Token Metadata */
const METAPLEX_PROGRAM_ID = new solanaWeb3.PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

function getMetadataPDA(nftMint) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('metadata'), METAPLEX_PROGRAM_ID.toBytes(), nftMint.toBytes()],
    METAPLEX_PROGRAM_ID
  );
}


const PRECISION = 1_000_000_000_000n;

/** Compute pending SOL claim for a MonkeBurn given MonkeState accumulator */
function computePendingClaim(burn, monkeState) {
  if (!burn || !monkeState || burn.shareWeight === 0n) return 0n;
  const pending = (burn.shareWeight * monkeState.accumulatedSolPerShare / PRECISION) - burn.rewardDebt;
  return pending > 0n ? pending : 0n;
}

/** Token program constants */
const TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new solanaWeb3.PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SPL_MEMO_PROGRAM_ID = new solanaWeb3.PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SYSVAR_RENT_PUBKEY = new solanaWeb3.PublicKey('SysvarRent111111111111111111111111111111111');
const NATIVE_MINT = new solanaWeb3.PublicKey('So11111111111111111111111111111111111111112');

/** Derive Associated Token Address (pure PDA, no SDK needed) */
function getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve = false, tokenProgramId = TOKEN_PROGRAM_ID) {
  const [ata] = solanaWeb3.PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgramId.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

/** Build create-ATA instruction */
function createAssociatedTokenAccountIx(payer, ata, owner, mint, tokenProgramId = TOKEN_PROGRAM_ID) {
  return new solanaWeb3.TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array(0),
  });
}


/** SPL Token SyncNative instruction (index 17) — syncs WSOL ATA balance after SOL transfer */
function createSyncNativeIx(nativeAccount) {
  return new solanaWeb3.TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: nativeAccount, isSigner: false, isWritable: true }],
    data: new Uint8Array([17]),
  });
}

/** Build SystemProgram transfer without Buffer dependency */
function buildSystemTransferIx(from, to, lamports) {
  const amount = typeof lamports === 'bigint' ? lamports : BigInt(lamports);
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // transfer instruction index = 2
  view.setBigUint64(4, amount, true);
  return new solanaWeb3.TransactionInstruction({
    programId: solanaWeb3.SystemProgram.programId,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Wrap SOL: transfer lamports to WSOL ATA + sync native */
function buildWrapSolIxs(from, wsolAta, lamports) {
  return [
    buildSystemTransferIx(from, wsolAta, lamports),
    createSyncNativeIx(wsolAta),
  ];
}

/** Derive Meteora bin array PDA */
function deriveBinArrayPDA(lbPairPubkey, arrayIndex, dlmmProgramId) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, BigInt(arrayIndex), true);
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('bin_array'), lbPairPubkey.toBytes(), new Uint8Array(buf)],
    dlmmProgramId
  );
  return pda;
}

/** Derive Meteora event authority PDA */
function deriveEventAuthorityPDA(dlmmProgramId) {
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('__event_authority')],
    dlmmProgramId
  );
  return pda;
}

/** Derive Meteora bin array bitmap extension PDA */
function deriveBitmapExtPDA(lbPairPubkey, dlmmProgramId) {
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('bitmap'), lbPairPubkey.toBytes()],
    dlmmProgramId
  );
  return pda;
}

/** Compute bin array index from bin ID (matches Meteora SDK binIdToBinArrayIndex) */
function binIdToBinArrayIndex(binId) {
  return Math.floor(binId / 70);
}

/**
 * Build Meteora initializeBinArray instruction.
 * Discriminator from IDL: [35, 86, 19, 185, 78, 212, 75, 211]
 */
function buildInitBinArrayIx(lbPairPubkey, binArrayPDA, funderPubkey, arrayIndex, dlmmProgramId) {
  const disc = new Uint8Array([35, 86, 19, 185, 78, 212, 75, 211]);
  const argBuf = new ArrayBuffer(8);
  new DataView(argBuf).setBigInt64(0, BigInt(arrayIndex), true);
  const data = new Uint8Array(disc.length + 8);
  data.set(disc, 0);
  data.set(new Uint8Array(argBuf), disc.length);

  return new solanaWeb3.TransactionInstruction({
    programId: dlmmProgramId,
    keys: [
      { pubkey: lbPairPubkey, isSigner: false, isWritable: false },
      { pubkey: binArrayPDA, isSigner: false, isWritable: true },
      { pubkey: funderPubkey, isSigner: true, isWritable: true },
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Check bin arrays for the given range and return init instructions for any missing ones.
 */
async function ensureBinArraysExist(lbPairPubkey, minBinId, maxBinId, funder, dlmmProgramId) {
  const conn = state.connection;
  const indices = new Set();
  indices.add(binIdToBinArrayIndex(minBinId));
  indices.add(binIdToBinArrayIndex(maxBinId));
  const sorted = [...indices].sort((a, b) => a - b);

  const ixs = [];
  for (const idx of sorted) {
    const pda = deriveBinArrayPDA(lbPairPubkey, idx, dlmmProgramId);
    const info = await conn.getAccountInfo(pda);
    if (!info) {
      ixs.push(buildInitBinArrayIx(lbPairPubkey, pda, funder, idx, dlmmProgramId));
    }
  }
  return ixs;
}

/**
 * Resolve all Meteora CPI accounts needed for open_position.
 * Reads LbPair on-chain for reserves/mints/program flags.
 */
async function resolveMeteoraCPIAccounts(poolAddress, minBinId, maxBinId) {
  const lbPairPubkey = new solanaWeb3.PublicKey(poolAddress);
  const dlmmProgramId = new solanaWeb3.PublicKey(METEORA_DLMM_PROGRAM);
  const conn = state.connection;

  const pool = await parseLbPairFull(poolAddress);

  const lowerIdx = binIdToBinArrayIndex(minBinId);
  const upperIdx = binIdToBinArrayIndex(maxBinId);
  const binArrayLower = deriveBinArrayPDA(lbPairPubkey, lowerIdx, dlmmProgramId);
  const binArrayUpper = deriveBinArrayPDA(lbPairPubkey, upperIdx, dlmmProgramId);

  const eventAuthority = deriveEventAuthorityPDA(dlmmProgramId);

  const bitmapExtPDA = deriveBitmapExtPDA(lbPairPubkey, dlmmProgramId);
  let binArrayBitmapExt;
  try {
    const bitmapInfo = await conn.getAccountInfo(bitmapExtPDA);
    binArrayBitmapExt = bitmapInfo ? bitmapExtPDA : dlmmProgramId;
  } catch {
    binArrayBitmapExt = dlmmProgramId;
  }

  return {
    lbPair: lbPairPubkey,
    binArrayBitmapExt,
    binArrayLower,
    binArrayUpper,
    reserveX: pool.reserveX,
    reserveY: pool.reserveY,
    tokenXMint: pool.tokenXMint,
    tokenYMint: pool.tokenYMint,
    eventAuthority,
    dlmmProgram: dlmmProgramId,
    tokenXProgramId: pool.tokenXProgramFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    tokenYProgramId: pool.tokenYProgramFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  };
}

/** Fill percent */
function getFillPercent(currentAmount, initialAmount) {
  if (initialAmount === 0) return 0;
  const converted = initialAmount - currentAmount;
  if (converted < 0) return 0;
  const fillBps = Math.floor((converted * 10000) / initialAmount);
  return Math.min(fillBps / 10000, 1.0);
}

/** HTML escape to prevent XSS from on-chain data */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/** Read mint decimals at runtime */
async function getMintDecimals(mintAddress) {
  try {
    const pubkey = new solanaWeb3.PublicKey(mintAddress);
    const info = await state.connection.getParsedAccountInfo(pubkey);
    return info.value?.data?.parsed?.info?.decimals ?? 9;
  } catch {
    return 9;
  }
}

// ============================================================
// MOCK DATA
// ============================================================

// Mock data removed — live data flows from bot relay + on-chain reads

// ============================================================
// STATE
// ============================================================

const state = {
  // Wallet
  connected: false,
  publicKey: null,
  wallet: null,
  walletName: null,
  connection: null,

  // Pool
  poolAddress: null,
  activeBin: null,
  binStep: 10,
  currentPrice: null,
  tokenXSymbol: 'TOKEN',
  tokenYSymbol: 'SOL',
  tokenXMint: null,
  tokenYMint: null,
  tokenXDecimals: 9,
  tokenYDecimals: 9,

  // Side
  side: 'buy',

  // Positions (fetched from chain in prod, mock for demo)
  positions: [],

  // Navigation
  currentPage: 0,
  currentSubPage: 'monke',
  activePoolOrbital: 0,
};

// ============================================================
// PERCENTAGE RANGE — bin math from user-entered percentages
// ============================================================

function percentToPrice(pct, side) {
  if (!state.currentPrice) return 0;
  if (side === 'buy') return state.currentPrice * (1 - pct / 100);
  return state.currentPrice * (1 + pct / 100);
}

function getRangeBins() {
  const near = parseFloat(document.getElementById('rangeNear')?.value) || 0;
  const far = parseFloat(document.getElementById('rangeFar')?.value) || 0;
  const nearPrice = percentToPrice(near, state.side);
  const farPrice = percentToPrice(far, state.side);
  // For buy: far is lower price (more bins below), near is higher
  // For sell: near is lower price, far is higher
  const minBin = priceToBin(Math.min(nearPrice, farPrice), state.binStep);
  const maxBin = priceToBin(Math.max(nearPrice, farPrice), state.binStep, false);
  return { minBin, maxBin };
}

// ============================================================
// UI UPDATES
// ============================================================


function updateSide(newSide) {
  state.side = newSide;
  document.querySelectorAll('.side-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.side-tab.${newSide}`)?.classList.add('active');

  const btn = document.getElementById('actionBtn');
  if (btn) {
    btn.className = 'action-btn ' + newSide;
    btn.textContent = newSide === 'buy' ? 'buy' : 'sell';
  }

  const tok = document.getElementById('amountToken');
  if (tok) tok.textContent = newSide === 'buy' ? state.tokenYSymbol : state.tokenXSymbol;

  // Update range suffix text and default values
  const suffix = newSide === 'buy' ? '% below' : '% above';
  const suffixEl = document.getElementById('rangeSuffix');
  const suffixFarEl = document.getElementById('rangeSuffixFar');
  if (suffixEl) suffixEl.textContent = suffix;
  if (suffixFarEl) suffixFarEl.textContent = suffix;

  const nearInput = document.getElementById('rangeNear');
  const farInput = document.getElementById('rangeFar');
  if (nearInput) nearInput.value = newSide === 'buy' ? '5' : '5';
  if (farInput) farInput.value = newSide === 'buy' ? '35' : '35';

  updateFee();
  updateBinStrip();
}

async function updateFee() {
  const el = document.getElementById('feeAmount');
  if (!el) return;

  if (!state.connected || !state.connection || !state.publicKey) {
    el.textContent = `${CONFIG.FEE_BPS / 100}% on output`;
    return;
  }

  try {
    let balanceStr;
    if (state.side === 'buy') {
      const lamports = await state.connection.getBalance(state.publicKey);
      balanceStr = (lamports / 1e9).toFixed(4) + ' ' + (state.tokenYSymbol || 'SOL');
    } else if (state.tokenXMint) {
      const mintPk = new solanaWeb3.PublicKey(state.tokenXMint);
      const atas = await state.connection.getTokenAccountsByOwner(state.publicKey, { mint: mintPk });
      let total = 0;
      for (const { account } of atas.value) {
        total += Number(account.data.readBigUInt64LE(64));
      }
      const symbol = state.tokenXSymbol || 'TOKEN';
      balanceStr = (total / 1e9).toFixed(4) + ' ' + symbol;
    } else {
      el.textContent = `${CONFIG.FEE_BPS / 100}% on output`;
      return;
    }
    el.textContent = `balance: ${balanceStr}`;
  } catch {
    el.textContent = `${CONFIG.FEE_BPS / 100}% on output`;
  }
}

function updateBinStrip() {
  if (!state.currentPrice || !state.activeBin) return;

  const near = parseFloat(document.getElementById('rangeNear')?.value) || 0;
  const far = parseFloat(document.getElementById('rangeFar')?.value) || 0;

  const rangeEl = document.getElementById('binStripRange');
  const activeEl = document.getElementById('binStripActive');
  const nearLabel = document.getElementById('binStripNear');
  const farLabel = document.getElementById('binStripFar');
  const currentLabel = document.getElementById('binStripCurrent');
  if (!rangeEl || !activeEl) return;

  const maxPct = Math.max(far, near) * 1.3;
  if (maxPct <= 0) return;

  if (state.side === 'buy') {
    const rangeLeft = (1 - far / maxPct) * 100;
    const rangeWidth = ((far - near) / maxPct) * 100;
    const activePos = (1 - 0 / maxPct) * 100;
    rangeEl.style.left = rangeLeft + '%';
    rangeEl.style.width = Math.max(rangeWidth, 1) + '%';
    rangeEl.style.background = 'var(--mint-faint)';
    activeEl.style.left = Math.min(activePos, 99) + '%';
    if (nearLabel) nearLabel.textContent = '-' + near + '%';
    if (farLabel) farLabel.textContent = '-' + far + '%';
  } else {
    const rangeLeft = (near / maxPct) * 100;
    const rangeWidth = ((far - near) / maxPct) * 100;
    const activePos = 0;
    rangeEl.style.left = rangeLeft + '%';
    rangeEl.style.width = Math.max(rangeWidth, 1) + '%';
    rangeEl.style.background = 'var(--sell-faint)';
    activeEl.style.left = activePos + '%';
    if (nearLabel) nearLabel.textContent = '+' + near + '%';
    if (farLabel) farLabel.textContent = '+' + far + '%';
  }

  if (currentLabel) currentLabel.textContent = '$' + formatPrice(state.currentPrice);
}

// ============================================================
// WALLET — multi-wallet support
// ============================================================

const WALLETS = {
  phantom: {
    name: 'Phantom',
    check: () => window.solana?.isPhantom,
    get: () => window.solana,
  },
  solflare: {
    name: 'Solflare',
    check: () => window.solflare?.isSolflare,
    get: () => window.solflare,
  },
  backpack: {
    name: 'Backpack',
    check: () => window.backpack,
    get: () => window.backpack,
  },
};

function detectWallets() {
  const available = [];
  Object.entries(WALLETS).forEach(([id, w]) => {
    const option = document.querySelector(`.wallet-option[data-wallet="${id}"]`);
    if (option) {
      if (w.check()) {
        option.style.display = 'flex';
        available.push(id);
      } else {
        option.style.display = 'none';
      }
    }
  });
  return available;
}

function toggleWalletMenu() {
  const menu = document.getElementById('walletOptions');
  if (!menu) return;

  if (state.connected) {
    disconnectWallet();
    return;
  }

  const available = detectWallets();

  if (available.length === 0) {
    showToast('No wallets detected. Install Phantom, Solflare, or Backpack.', 'error');
    window.open('https://phantom.app/', '_blank');
    return;
  }

  if (available.length === 1) {
    connectWallet(available[0]);
    return;
  }

  menu.classList.toggle('visible');
}

async function connectWallet(walletId) {
  const menu = document.getElementById('walletOptions');
  if (menu) menu.classList.remove('visible');

  const w = WALLETS[walletId];
  if (!w || !w.check()) {
    showToast(`${w?.name || walletId} not found`, 'error');
    return;
  }

  const btn = document.getElementById('connectWallet');
  if (btn) btn.textContent = 'connecting...';

  try {
    const provider = w.get();
    const resp = await provider.connect();
    const pubkey = resp.publicKey || provider.publicKey;

    state.wallet = provider;
    state.walletName = walletId;
    state.publicKey = pubkey;
    state.connected = true;
    state.connection = new solanaWeb3.Connection(
      CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed'
    );

    // Bridge wallet state for enlist.js and other bundled modules
    window.__monkeWallet = { publicKey: pubkey, adapter: provider };
    window.dispatchEvent(new Event('monke:walletChanged'));

    await loadOnChainFeeBps();

    const short = pubkey.toString().slice(0, 4) + '...' + pubkey.toString().slice(-4);
    if (btn) {
      btn.textContent = short;
      btn.classList.add('connected');
    }

    showToast(`Connected via ${w.name}`, 'success');
    refreshPositionsList();
    renderMonkeList();
    updateEnlistBalance();
    updateFee();
  } catch (err) {
    console.error('Wallet connection failed:', err);
    if (btn) btn.textContent = 'connect wallet';
    showToast('Connection failed', 'error');
  }
}

async function disconnectWallet() {
  try {
    if (state.wallet?.disconnect) await state.wallet.disconnect();
  } catch (_) {}

  state.connected = false;
  state.publicKey = null;
  state.wallet = null;
  state.walletName = null;

  // Clear wallet bridge
  window.__monkeWallet = null;
  window.dispatchEvent(new Event('monke:walletChanged'));

  const btn = document.getElementById('connectWallet');
  if (btn) {
    btn.textContent = 'connect wallet';
    btn.classList.remove('connected');
  }
  showToast('Disconnected');
  updatePositionsList();
  renderMonkeList();
  const p1Wrap = document.getElementById('enlistPhase1BalanceWrap');
  if (p1Wrap) p1Wrap.style.display = 'none';
}

document.addEventListener('click', e => {
  const menu = document.getElementById('walletOptions');
  const btn = document.getElementById('connectWallet');
  if (menu && !menu.contains(e.target) && e.target !== btn) {
    menu.classList.remove('visible');
  }
});

// ============================================================
// POOL LOADING
// ============================================================

const LBPAIR_EXPECTED_SIZE = 904;
const LBPAIR_OFFSETS = {
  ACTIVE_ID: 76,       // i32
  BIN_STEP: 80,        // u16
  TOKEN_X_MINT: 88,    // pubkey (32 bytes)
  TOKEN_Y_MINT: 120,   // pubkey (32 bytes)
  RESERVE_X: 152,      // pubkey (32 bytes)
  RESERVE_Y: 184,      // pubkey (32 bytes)
  TOKEN_X_PROG_FLAG: 880, // u8 (0=SPL, 1=Token-2022)
  TOKEN_Y_PROG_FLAG: 881, // u8
};

const KNOWN_TOKENS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'jitoSOL',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'ABj8RJzGHxbLoB8JBea8kvBx626KwSfvbpce9xVfkK7w': 'BANANAS',
};

async function parseLbPair(address) {
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const pubkey = new solanaWeb3.PublicKey(address);

  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const accountInfo = await conn.getAccountInfo(pubkey);

  if (!accountInfo) throw new Error('Account not found — check the address');
  if (accountInfo.data.length !== LBPAIR_EXPECTED_SIZE) {
    throw new Error(`Not a DLMM pool (expected ${LBPAIR_EXPECTED_SIZE} bytes, got ${accountInfo.data.length})`);
  }

  const data = accountInfo.data;
  const activeId = data.readInt32LE(LBPAIR_OFFSETS.ACTIVE_ID);
  const binStep = data.readUInt16LE(LBPAIR_OFFSETS.BIN_STEP);

  if (binStep === 0 || binStep > 500) {
    throw new Error(`Invalid bin_step ${binStep} — account may not be an LbPair`);
  }

  const tokenXMint = new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_X_MINT, LBPAIR_OFFSETS.TOKEN_X_MINT + 32));
  const tokenYMint = new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_Y_MINT, LBPAIR_OFFSETS.TOKEN_Y_MINT + 32));

  return { activeId, binStep, tokenXMint, tokenYMint };
}

async function parseLbPairFull(address) {
  const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
  const pubkey = new solanaWeb3.PublicKey(address);
  const accountInfo = await conn.getAccountInfo(pubkey);
  if (!accountInfo) throw new Error('Account not found');
  if (accountInfo.data.length !== LBPAIR_EXPECTED_SIZE) throw new Error('Not a DLMM pool');
  const data = accountInfo.data;
  return {
    activeId: data.readInt32LE(LBPAIR_OFFSETS.ACTIVE_ID),
    binStep: data.readUInt16LE(LBPAIR_OFFSETS.BIN_STEP),
    tokenXMint: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_X_MINT, LBPAIR_OFFSETS.TOKEN_X_MINT + 32)),
    tokenYMint: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_Y_MINT, LBPAIR_OFFSETS.TOKEN_Y_MINT + 32)),
    reserveX: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.RESERVE_X, LBPAIR_OFFSETS.RESERVE_X + 32)),
    reserveY: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.RESERVE_Y, LBPAIR_OFFSETS.RESERVE_Y + 32)),
    tokenXProgramFlag: data.readUInt8(LBPAIR_OFFSETS.TOKEN_X_PROG_FLAG),
    tokenYProgramFlag: data.readUInt8(LBPAIR_OFFSETS.TOKEN_Y_PROG_FLAG),
  };
}

async function resolveTokenSymbol(mintPubkey) {
  const addr = mintPubkey.toBase58();
  if (KNOWN_TOKENS[addr]) return KNOWN_TOKENS[addr];

  try {
    const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAsset',
        params: { id: addr },
      }),
    });
    const json = await resp.json();
    const symbol = json?.result?.content?.metadata?.symbol;
    if (symbol) {
      KNOWN_TOKENS[addr] = symbol;
      return symbol;
    }
  } catch {}

  return addr.slice(0, 4) + '...' + addr.slice(-4);
}

async function loadPool() {
  const addr = document.getElementById('poolAddress')?.value.trim();
  if (!addr) { showToast('Enter a DLMM pool address', 'error'); return; }

  const btn = document.getElementById('loadPool');
  if (btn) { btn.textContent = 'loading...'; btn.disabled = true; }

  try {
    try { new solanaWeb3.PublicKey(addr); }
    catch { throw new Error('Invalid Solana address'); }

    // Try bot relay first (LaserStream-backed, sub-second data)
    const relayData = await relayFetch(`/api/pools/${addr}`);
    if (relayData && relayData.activeId !== undefined) {
      state.poolAddress = addr;
      state.activeBin = relayData.activeId;
      state.binStep = relayData.binStep;
      state.currentPrice = binToPrice(relayData.activeId, relayData.binStep);
      state.tokenXSymbol = relayData.tokenXSymbol || 'TOKEN';
      state.tokenYSymbol = relayData.tokenYSymbol || 'SOL';
      // Relay may not carry mints — fill from on-chain if missing
      if (relayData.tokenXMint) {
        state.tokenXMint = relayData.tokenXMint;
        state.tokenYMint = relayData.tokenYMint;
      } else {
        const poolData = await parseLbPairFull(addr);
        state.tokenXMint = poolData.tokenXMint.toBase58();
        state.tokenYMint = poolData.tokenYMint.toBase58();
      }
    } else {
      // Fallback: direct RPC — parse raw lb_pair account bytes
      const pool = await parseLbPair(addr);
      const [symX, symY] = await Promise.all([
        resolveTokenSymbol(pool.tokenXMint),
        resolveTokenSymbol(pool.tokenYMint),
      ]);

      state.poolAddress = addr;
      state.activeBin = pool.activeId;
      state.binStep = pool.binStep;
      state.currentPrice = binToPrice(pool.activeId, pool.binStep);
      state.tokenXSymbol = symX;
      state.tokenYSymbol = symY;
      state.tokenXMint = pool.tokenXMint.toBase58();
      state.tokenYMint = pool.tokenYMint.toBase58();
    }

    // Fetch decimals for deposit amount calculation
    if (state.tokenXMint && state.connection) {
      const [dX, dY] = await Promise.all([
        getMintDecimals(state.tokenXMint),
        getMintDecimals(state.tokenYMint),
      ]);
      state.tokenXDecimals = dX;
      state.tokenYDecimals = dY;
    }

    document.getElementById('poolName').textContent = `${state.tokenXSymbol}/${state.tokenYSymbol}`;
    document.getElementById('currentPrice').textContent = '$' + formatPrice(state.currentPrice);
    document.getElementById('poolInfo').classList.add('visible');

    updateSide(state.side);
    showToast('Pool loaded', 'success');
    loadBinVizData();
    if (state.connected) refreshPositionsList();
  } catch (err) {
    console.error('Failed to load pool:', err);
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.textContent = 'load'; btn.disabled = false; }
  }
}

// ============================================================
// BIN VISUALIZATION — on-chain liquidity + preview
// ============================================================

const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const BINS_PER_ARRAY = 70;

// BinArray layout verified against Meteora DLMM IDL (idl.json):
//
// BinArray header (repr C, bytemuck):
//   8  discriminator
//   8  index (i64)
//   1  version (u8)
//   7  _padding_1 ([u8; 7])
//   32 lb_pair (pubkey)
//   = 56 bytes header
//
// Bin struct (repr C, bytemuck), 70 per array:
//   8   amount_x (u64)          offset 0
//   8   amount_y (u64)          offset 8
//   16  price (u128)            offset 16
//   16  liquidity_supply (u128) offset 32
//   32  function_bytes ([u128; 2])
//   16  fee_amount_x_per_token_stored (u128)
//   16  fee_amount_y_per_token_stored (u128)
//   16  _padding_0 (u128)
//   16  _padding_1 (u128)
//   = 144 bytes per bin
const BIN_ARRAY_HEADER = 56;
const BIN_SIZE = 144;
const BIN_AMOUNT_X_OFFSET = 0;
const BIN_AMOUNT_Y_OFFSET = 8;

function binIdToArrayIndex(binId) {
  if (binId >= 0) return Math.floor(binId / BINS_PER_ARRAY);
  return Math.floor((binId - (BINS_PER_ARRAY - 1)) / BINS_PER_ARRAY);
}

async function fetchBinArrays(poolAddress, centerBin, visibleRange) {
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const poolPubkey = new solanaWeb3.PublicKey(poolAddress);
  const dlmmProgram = new solanaWeb3.PublicKey(METEORA_DLMM_PROGRAM);

  const lowBin = centerBin - visibleRange;
  const highBin = centerBin + visibleRange;
  const lowIdx = binIdToArrayIndex(lowBin);
  const highIdx = binIdToArrayIndex(highBin);

  const pdas = [];
  for (let i = lowIdx; i <= highIdx; i++) {
    // Encode i64 LE using BigInt for correct two's complement
    const signed = BigInt(i);
    const unsigned = signed < 0n ? signed + (1n << 64n) : signed;
    const buf = new Uint8Array(8);
    for (let byte = 0; byte < 8; byte++) {
      buf[byte] = Number((unsigned >> BigInt(byte * 8)) & 0xFFn);
    }
    const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('bin_array'), poolPubkey.toBytes(), buf],
      dlmmProgram
    );
    pdas.push({ pda, arrayIndex: i });
  }

  const accounts = await conn.getMultipleAccountsInfo(pdas.map(p => p.pda));

  const bins = new Map();
  for (let a = 0; a < accounts.length; a++) {
    const acct = accounts[a];
    if (!acct) continue;
    const data = acct.data;

    // Read the actual index from the account (i64 LE at offset 8, after 8-byte discriminator)
    const idxLo = data.readInt32LE(8);
    const idxHi = data.readInt32LE(12);
    const actualIndex = idxHi * 0x100000000 + (idxLo >>> 0);
    const baseBinId = actualIndex * BINS_PER_ARRAY;

    const expectedBinDataSize = BIN_ARRAY_HEADER + BINS_PER_ARRAY * BIN_SIZE;
    if (data.length < expectedBinDataSize) {
      if (CONFIG.DEBUG) console.warn(`BinArray ${actualIndex} unexpected size: ${data.length} (expected ${expectedBinDataSize})`);
      continue;
    }

    for (let b = 0; b < BINS_PER_ARRAY; b++) {
      const offset = BIN_ARRAY_HEADER + b * BIN_SIZE;
      const amountX = Number(data.readBigUInt64LE(offset + BIN_AMOUNT_X_OFFSET));
      const amountY = Number(data.readBigUInt64LE(offset + BIN_AMOUNT_Y_OFFSET));
      const binId = baseBinId + b;
      if (binId >= lowBin && binId <= highBin && (amountX > 0 || amountY > 0)) {
        bins.set(binId, { amountX, amountY });
      }
    }
  }
  return bins;
}

function computeBidAskPreview(amount, minBin, maxBin, activeBin) {
  const numBins = maxBin - minBin + 1;
  if (numBins <= 0 || amount <= 0) return new Map();

  // BidAsk: linear ramp — weight increases with distance from active bin
  const weights = [];
  let totalWeight = 0;
  for (let bin = minBin; bin <= maxBin; bin++) {
    const dist = Math.abs(bin - activeBin);
    const w = Math.max(1, dist);
    weights.push({ bin, w });
    totalWeight += w;
  }

  const preview = new Map();
  for (const { bin, w } of weights) {
    const share = (w / totalWeight) * amount;
    preview.set(bin, share);
  }
  return preview;
}

async function fetchUserPositions(poolAddress) {
  if (!state.connected || !state.publicKey) return [];
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const programId = new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID);

  try {
    const accounts = await conn.getProgramAccounts(programId, {
      filters: [
        { dataSize: 138 }, // Position::SIZE = 8+32+32+32+1+4+4+8+8+8+1 = 138
        { memcmp: { offset: 8, bytes: state.publicKey.toBase58() } },
        { memcmp: { offset: 40, bytes: poolAddress } },
      ],
    });

    return accounts.map(({ pubkey, account }) => {
      const pos = decodePosition(toEncodedAccount(pubkey, account.data, BIN_FARM_PROGRAM_ADDRESS)).data;
      return {
        pubkey,
        meteoraPosition: new solanaWeb3.PublicKey(pos.meteoraPosition),
        side: pos.side === Side.Buy ? 'buy' : 'sell',
        minBinId: pos.minBinId,
        maxBinId: pos.maxBinId,
        initialAmount: Number(pos.initialAmount),
        harvestedAmount: Number(pos.harvestedAmount),
      };
    });
  } catch (err) {
    if (CONFIG.DEBUG) console.error('Failed to fetch user positions:', err);
    return [];
  }
}

async function fetchAllUserPositions() {
  if (!state.connected || !state.publicKey) return [];
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const programId = new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID);

  try {
    const accounts = await conn.getProgramAccounts(programId, {
      filters: [
        { dataSize: 138 },
        { memcmp: { offset: 8, bytes: state.publicKey.toBase58() } },
      ],
    });

    return accounts.map(({ pubkey, account }) => {
      const pos = decodePosition(toEncodedAccount(pubkey, account.data, BIN_FARM_PROGRAM_ADDRESS)).data;
      return {
        pubkey,
        lbPair: pos.lbPair,
        meteoraPosition: new solanaWeb3.PublicKey(pos.meteoraPosition),
        side: pos.side === Side.Buy ? 'buy' : 'sell',
        minBinId: pos.minBinId,
        maxBinId: pos.maxBinId,
        initialAmount: Number(pos.initialAmount),
        harvestedAmount: Number(pos.harvestedAmount),
        createdAt: Number(pos.createdAt),
      };
    });
  } catch (err) {
    if (CONFIG.DEBUG) console.error('Failed to fetch all positions:', err);
    return [];
  }
}

async function renderPositionsPage() {
  const listEl = document.getElementById('allPositionsList');
  const countEl = document.getElementById('posPageCount');
  const depositEl = document.getElementById('posPageDeposited');
  const harvestEl = document.getElementById('posPageHarvested');
  const avgFillEl = document.getElementById('posPageAvgFill');
  if (!listEl) return;

  if (!state.connected) {
    listEl.innerHTML = '<div class="empty-state">connect wallet to view positions</div>';
    return;
  }

  listEl.innerHTML = '<div class="empty-state">loading...</div>';
  let positions;
  try {
    positions = await fetchAllUserPositions();
  } catch (err) {
    console.error('[monke] Failed to load positions:', err);
    listEl.innerHTML = '<div class="empty-state">failed to load positions — RPC may be unavailable</div>';
    return;
  }

  if (positions.length === 0) {
    listEl.innerHTML = '<div class="empty-state">no positions</div>';
    if (countEl) countEl.textContent = '0';
    if (depositEl) depositEl.textContent = '0 SOL';
    if (harvestEl) harvestEl.textContent = '0 SOL';
    if (avgFillEl) avgFillEl.textContent = '0%';
    return;
  }

  let totalDeposited = 0;
  let totalHarvested = 0;

  // Resolve pool names for unique lb_pairs
  const uniquePools = [...new Set(positions.map(p => p.lbPair))];
  const poolNames = {};
  for (const pool of uniquePools) {
    try {
      const info = await parseLbPair(pool);
      const [symX, symY] = await Promise.all([
        resolveTokenSymbol(info.tokenXMint),
        resolveTokenSymbol(info.tokenYMint),
      ]);
      poolNames[pool] = `${symX}/${symY}`;
    } catch {
      poolNames[pool] = pool.slice(0, 4) + '...' + pool.slice(-4);
    }
  }

  let html = '';
  for (const pos of positions) {
    totalDeposited += pos.initialAmount;
    totalHarvested += pos.harvestedAmount;
    const fillPct = pos.initialAmount > 0 ? Math.min(100, Math.round((pos.harvestedAmount / pos.initialAmount) * 100)) : 0;
    const poolName = poolNames[pos.lbPair] || pos.lbPair.slice(0, 8) + '...';
    const status = fillPct >= 100 ? 'harvested' : 'active';

    html += `<div class="pos-page-row">
      <span class="pos-pool">${escapeHtml(poolName)}</span>
      <span class="pos-side ${pos.side}">${pos.side}</span>
      <span class="pos-range">${pos.minBinId} → ${pos.maxBinId}</span>
      <span class="pos-filled">${fillPct}%<div class="pos-fill-bar"><div class="pos-fill-bar-inner ${pos.side}" style="width:${fillPct}%"></div></div></span>
      <span class="pos-amount">${(pos.initialAmount / 1e9).toFixed(4)}</span>
      <span class="pos-status ${status}">${status}</span>
      <button class="claim-fees-btn action-btn-sm" data-pubkey="${pos.pubkey.toBase58()}" data-lbpair="${pos.lbPair}" data-metpos="${pos.meteoraPosition.toBase58()}" data-min="${pos.minBinId}" data-max="${pos.maxBinId}">fees</button>
      <button class="close-btn" data-pubkey="${pos.pubkey.toBase58()}" data-lbpair="${pos.lbPair}" data-metpos="${pos.meteoraPosition.toBase58()}" data-min="${pos.minBinId}" data-max="${pos.maxBinId}">close</button>
    </div>`;
  }

  listEl.innerHTML = html;
  if (countEl) countEl.textContent = positions.length;
  if (depositEl) depositEl.textContent = (totalDeposited / 1e9).toFixed(4) + ' SOL';
  if (harvestEl) harvestEl.textContent = (totalHarvested / 1e9).toFixed(4) + ' SOL';
  const avgFill = positions.reduce((sum, p) => sum + (p.initialAmount > 0 ? p.harvestedAmount / p.initialAmount : 0), 0) / positions.length;
  if (avgFillEl) avgFillEl.textContent = Math.round(avgFill * 100) + '%';

  listEl.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pubkey = new solanaWeb3.PublicKey(btn.dataset.pubkey);
      const meteoraPosition = new solanaWeb3.PublicKey(btn.dataset.metpos);
      const lbPair = btn.dataset.lbpair;
      const minBin = parseInt(btn.dataset.min);
      const maxBin = parseInt(btn.dataset.max);
      btn.textContent = 'closing...'; btn.disabled = true;
      try {
        const pos = { pubkey, meteoraPosition, poolAddress: lbPair, minBin, maxBin };
        await closePositionDirect(pos);
        showToast('Position closed', 'success');
        renderPositionsPage();
      } catch (err) {
        console.error('Close failed:', err);
        showToast('Close failed: ' + (err?.message || err), 'error');
        btn.textContent = 'close'; btn.disabled = false;
      }
    });
  });

  listEl.querySelectorAll('.claim-fees-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pubkey = new solanaWeb3.PublicKey(btn.dataset.pubkey);
      const meteoraPosition = new solanaWeb3.PublicKey(btn.dataset.metpos);
      const lbPair = btn.dataset.lbpair;
      const minBin = parseInt(btn.dataset.min);
      const maxBin = parseInt(btn.dataset.max);
      btn.textContent = 'claiming...'; btn.disabled = true;
      try {
        const pos = { pubkey, meteoraPosition, poolAddress: lbPair, minBin, maxBin };
        await claimFeesDirect(pos);
        showToast('Fees claimed', 'success');
        renderPositionsPage();
      } catch (err) {
        console.error('Claim fees failed:', err);
        showToast('Claim fees failed: ' + (err?.message || err), 'error');
        btn.textContent = 'fees'; btn.disabled = false;
      }
    });
  });
}

function aggregateUserBins(positions, activeBin) {
  const bins = new Map();
  for (const pos of positions) {
    const preview = computeBidAskPreview(
      pos.initialAmount, pos.minBinId, pos.maxBinId, activeBin
    );
    for (const [binId, amount] of preview) {
      bins.set(binId, (bins.get(binId) || 0) + amount);
    }
  }
  return bins;
}

// Canvas rendering state
const vizState = {
  poolBins: new Map(),
  userBins: new Map(),
  previewBins: new Map(),
  activeBin: 0,
  binStep: 0,
  visibleRange: 40,
};

function renderBinViz() {
  const canvas = document.getElementById('binVizCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  ctx.clearRect(0, 0, W, H);

  const { poolBins, userBins, previewBins, activeBin, binStep, visibleRange } = vizState;
  if (!binStep) {
    ctx.fillStyle = 'rgba(58, 90, 140, 0.2)';
    ctx.font = '300 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('load a pool to see liquidity', W / 2, H / 2);
    return;
  }

  const lowBin = activeBin - visibleRange;
  const highBin = activeBin + visibleRange;
  const totalBins = highBin - lowBin + 1;

  // Normalize pool and user/preview independently (different scales)
  let maxPoolLiq = 0;
  let maxUserLiq = 0;
  for (let bin = lowBin; bin <= highBin; bin++) {
    const pool = poolBins.get(bin);
    const poolTotal = pool ? pool.amountX + pool.amountY : 0;
    const user = userBins.get(bin) || 0;
    const preview = previewBins.get(bin) || 0;
    maxPoolLiq = Math.max(maxPoolLiq, poolTotal);
    maxUserLiq = Math.max(maxUserLiq, user + preview);
  }
  if (maxPoolLiq === 0) maxPoolLiq = 1;
  if (maxUserLiq === 0) maxUserLiq = 1;

  const yMargin = 24;
  const xLabelWidth = 72;
  const barAreaW = W - xLabelWidth - 12;
  const barAreaH = H - yMargin * 2;
  const rowH = barAreaH / totalBins;
  const barH = Math.max(1, rowH * 0.8);
  const halfBar = barH / 2;

  const poolBuyColor = 'rgba(74, 222, 128, 0.35)';
  const poolSellColor = 'rgba(239, 68, 68, 0.35)';
  const poolNeutralColor = 'rgba(58, 90, 140, 0.4)';
  const userBuyColor = 'rgba(74, 222, 128, 0.7)';
  const userSellColor = 'rgba(239, 68, 68, 0.7)';
  const previewBuyColor = 'rgba(74, 222, 128, 0.25)';
  const previewSellColor = 'rgba(239, 68, 68, 0.25)';

  for (let bin = lowBin; bin <= highBin; bin++) {
    const idx = bin - lowBin;
    const yCenter = yMargin + barAreaH - (idx + 0.5) * rowH;

    const pool = poolBins.get(bin);
    const poolTotal = pool ? pool.amountX + pool.amountY : 0;
    const user = userBins.get(bin) || 0;
    const preview = previewBins.get(bin) || 0;

    const colW = barAreaW * 0.46;

    // Pool bar (left column) — colored by buy/sell side
    if (poolTotal > 0) {
      const barW = (poolTotal / maxPoolLiq) * colW;
      if (bin < activeBin) {
        ctx.fillStyle = poolBuyColor;
      } else if (bin > activeBin) {
        ctx.fillStyle = poolSellColor;
      } else {
        ctx.fillStyle = poolNeutralColor;
      }
      ctx.fillRect(xLabelWidth, yCenter - halfBar, barW, barH);
    }

    // User + preview bars (right column)
    const userX = xLabelWidth + barAreaW * 0.54;
    const isSell = bin > activeBin;

    if (user > 0) {
      const barW = (user / maxUserLiq) * colW;
      ctx.fillStyle = isSell ? userSellColor : userBuyColor;
      ctx.fillRect(userX, yCenter - halfBar, barW, barH);
    }

    if (preview > 0) {
      const existingW = user > 0 ? (user / maxUserLiq) * colW : 0;
      const previewW = (preview / maxUserLiq) * colW;
      ctx.fillStyle = isSell ? previewSellColor : previewBuyColor;
      ctx.fillRect(userX + existingW, yCenter - halfBar, previewW, barH);
    }
  }

  // Divider line between pool and user columns
  ctx.strokeStyle = 'rgba(58, 90, 140, 0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  const divX = xLabelWidth + barAreaW * 0.5;
  ctx.beginPath();
  ctx.moveTo(divX, yMargin);
  ctx.lineTo(divX, H - yMargin);
  ctx.stroke();
  ctx.setLineDash([]);

  // Column labels
  ctx.font = '300 8px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(58, 90, 140, 0.4)';
  ctx.fillText('pool', xLabelWidth + barAreaW * 0.24, yMargin - 6);
  ctx.fillText('yours', xLabelWidth + barAreaW * 0.76, yMargin - 6);

  // Active price line
  const activeIdx = activeBin - lowBin;
  if (activeIdx >= 0 && activeIdx < totalBins) {
    const activeY = yMargin + barAreaH - (activeIdx + 0.5) * rowH;
    ctx.strokeStyle = 'rgba(200, 210, 230, 0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(xLabelWidth, activeY);
    ctx.lineTo(W - 8, activeY);
    ctx.stroke();

    ctx.fillStyle = 'rgba(200, 210, 230, 0.8)';
    ctx.font = '300 9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    const priceLabel = '$' + formatPrice(binToPrice(activeBin, binStep));
    ctx.fillText(priceLabel, xLabelWidth - 6, activeY + 3);
  }

  // Y-axis price labels (every ~10 bins)
  ctx.fillStyle = 'rgba(58, 90, 140, 0.44)';
  ctx.font = '300 8px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  const labelInterval = Math.max(5, Math.round(totalBins / 10));
  for (let bin = lowBin; bin <= highBin; bin += labelInterval) {
    if (bin === activeBin) continue;
    const idx = bin - lowBin;
    const y = yMargin + barAreaH - (idx + 0.5) * rowH;
    const price = binToPrice(bin, binStep);
    ctx.fillText('$' + formatPrice(price), xLabelWidth - 6, y + 3);
  }

  // Update header meta
  const metaEl = document.getElementById('binVizMeta');
  if (metaEl && binStep) {
    metaEl.textContent = `bin step ${binStep} · ${totalBins} bins`;
  }
}

function updateBinVizPreview() {
  if (!state.poolAddress || state.activeBin == null || !state.binStep) return;

  vizState.activeBin = state.activeBin;
  vizState.binStep = state.binStep;

  const amount = parseFloat(document.getElementById('amount')?.value) || 0;
  const { minBin, maxBin } = getRangeBins();
  const amountLamports = amount * 1e9;

  vizState.previewBins = computeBidAskPreview(amountLamports, minBin, maxBin, state.activeBin);
  renderBinViz();
}

async function loadBinVizData() {
  if (!state.poolAddress || !state.activeBin || !state.binStep) return;

  vizState.activeBin = state.activeBin;
  vizState.binStep = state.binStep;

  try {
    vizState.poolBins = await fetchBinArrays(state.poolAddress, state.activeBin, vizState.visibleRange);
  } catch (err) {
    if (CONFIG.DEBUG) console.error('Failed to fetch bin arrays:', err);
    vizState.poolBins = new Map();
  }

  try {
    const positions = await fetchUserPositions(state.poolAddress);
    vizState.userBins = aggregateUserBins(positions, state.activeBin);
  } catch {
    vizState.userBins = new Map();
  }

  updateBinVizPreview();
}

// ============================================================
// POSITION CREATION
// ============================================================

async function createPosition() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  if (!state.poolAddress) { showToast('Load a pool first', 'error'); return; }

  const amount = parseFloat(document.getElementById('amount')?.value);
  if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }

  const { minBin, maxBin } = getRangeBins();

  if (state.side === 'buy' && maxBin >= state.activeBin) {
    showToast('Buy range must be below current price', 'error'); return;
  }
  if (state.side === 'sell' && minBin <= state.activeBin) {
    showToast('Sell range must be above current price', 'error'); return;
  }

  const btn = document.getElementById('actionBtn');
  const original = btn?.textContent;
  if (btn) { btn.textContent = 'creating...'; btn.disabled = true; }

  try {
    showToast('Building transaction...', 'info');

    const decimals = state.side === 'sell' ? state.tokenXDecimals : state.tokenYDecimals;
    const depositAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));
    const numBins = maxBin - minBin + 1;

    if (CONFIG.DEBUG) {
      console.log(`[monke] Create ${state.side} position`);
      console.log(`  Amount: ${amount} (${depositAmount} lamports, ${decimals} decimals)`);
      console.log(`  Bins: ${minBin} -> ${maxBin} (${numBins} bins)`);
    }

    const conn = state.connection;
    const user = state.publicKey;
    const coreProgramId = new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID);

    // Resolve all Meteora CPI accounts from on-chain pool data
    showToast('Resolving accounts...', 'info');
    const cpi = await resolveMeteoraCPIAccounts(state.poolAddress, minBin, maxBin);

    // Deposit token: sell = token X, buy = token Y (SOL)
    const depositMint = state.side === 'sell' ? cpi.tokenXMint : cpi.tokenYMint;
    const depositTokenProgramId = state.side === 'sell' ? cpi.tokenXProgramId : cpi.tokenYProgramId;

    const meteoraPositionKeypair = solanaWeb3.Keypair.generate();
    const [configPDA] = getConfigPDA();
    const [positionPDA] = getPositionPDA(meteoraPositionKeypair.publicKey);
    const [vaultPDA] = getVaultPDA(meteoraPositionKeypair.publicKey);

    const userTokenAccount = getAssociatedTokenAddressSync(depositMint, user, false, depositTokenProgramId);

    const tx = new solanaWeb3.Transaction();

    const initBinArrayIxs = await ensureBinArraysExist(cpi.lbPair, minBin, maxBin, user, cpi.dlmmProgram);
    for (const ix of initBinArrayIxs) tx.add(ix);

    const isNativeSol = depositMint.equals(NATIVE_MINT);
    const userAtaInfo = await conn.getAccountInfo(userTokenAccount);
    if (!userAtaInfo) {
      tx.add(createAssociatedTokenAccountIx(user, userTokenAccount, user, depositMint, depositTokenProgramId));
    }
    if (isNativeSol) {
      for (const ix of buildWrapSolIxs(user, userTokenAccount, depositAmount)) tx.add(ix);
    }

    const slippage = state.binStep >= 80 ? 15 : 5;
    const bitmapExtWritable = !cpi.binArrayBitmapExt.equals(cpi.dlmmProgram);

    const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
    const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);

    for (const [mint, ata, prog] of [
      [cpi.tokenXMint, vaultTokenX, cpi.tokenXProgramId],
      [cpi.tokenYMint, vaultTokenY, cpi.tokenYProgramId],
    ]) {
      const info = await conn.getAccountInfo(ata);
      if (!info) tx.add(createAssociatedTokenAccountIx(user, ata, vaultPDA, mint, prog));
    }

    if (CONFIG.DEBUG) console.log('[monke] Open position V2:', { amount: depositAmount.toString(), minBin, maxBin });

    const openIx = await getOpenPositionV2InstructionAsync({
      user: asSigner(user),
      lbPair: address(cpi.lbPair.toBase58()),
      meteoraPosition: asSigner(meteoraPositionKeypair.publicKey),
      binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
      reserveX: address(cpi.reserveX.toBase58()),
      reserveY: address(cpi.reserveY.toBase58()),
      userTokenAccount: address(userTokenAccount.toBase58()),
      vaultTokenX: address(vaultTokenX.toBase58()),
      vaultTokenY: address(vaultTokenY.toBase58()),
      tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
      tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
      binArrayLower: address(cpi.binArrayLower.toBase58()),
      binArrayUpper: address(cpi.binArrayUpper.toBase58()),
      eventAuthority: address(cpi.eventAuthority.toBase58()),
      dlmmProgram: address(cpi.dlmmProgram.toBase58()),
      tokenXMint: address(cpi.tokenXMint.toBase58()),
      tokenYMint: address(cpi.tokenYMint.toBase58()),
      amount: BigInt(depositAmount.toString()),
      minBinId: minBin,
      maxBinId: maxBin,
      side: state.side === 'buy' ? Side.Buy : Side.Sell,
      maxActiveBinSlippage: slippage,
    });
    tx.add(kitIxToWeb3(openIx));

    // Set tx metadata
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = user;

    // Position keypair must sign (Meteora requires it for initialize_position)
    tx.partialSign(meteoraPositionKeypair);

    // Simulate first to get detailed error logs before wallet popup
    const simResult = await conn.simulateTransaction(tx);
    if (simResult.value.err) {
      console.error('[monke] Simulation failed:', simResult.value.err);
      console.error('[monke] Logs:', simResult.value.logs);
      const lastLog = simResult.value.logs?.filter(l => l.includes('Error') || l.includes('failed') || l.includes('error')).pop()
        || simResult.value.logs?.pop() || JSON.stringify(simResult.value.err);
      throw new Error('Simulation: ' + lastLog);
    }
    if (CONFIG.DEBUG) console.log('[monke] Simulation OK:', simResult.value.logs);

    showToast('Approve in wallet...', 'info');
    const signed = await state.wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    showToast('Confirming...', 'info');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

    showToast('Position created!', 'success');
    if (CONFIG.DEBUG) console.log(`[monke] Position tx: ${sig}`);

    // Refresh positions list + chart from on-chain
    await refreshPositionsList();
    loadBinVizData();
  } catch (err) {
    console.error('Position creation failed:', err);
    showToast('Failed: ' + (err?.message || err), 'error');
  } finally {
    if (btn) { btn.textContent = original; btn.disabled = false; }
  }
}

// ============================================================
// POSITIONS LIST
// ============================================================

async function refreshPositionsList() {
  if (!state.connected || !state.poolAddress) return;
  try {
    const positions = await fetchUserPositions(state.poolAddress);
    state.positions = positions.map(p => {
      const decimals = p.side === 'sell' ? state.tokenXDecimals : state.tokenYDecimals;
      const fillPct = p.initialAmount > 0 ? Math.min(100, Math.round((p.harvestedAmount / p.initialAmount) * 100)) : 0;
      return {
        pubkey: p.pubkey,
        meteoraPosition: p.meteoraPosition,
        pool: `${state.tokenXSymbol}/${state.tokenYSymbol}`,
        poolAddress: state.poolAddress,
        side: p.side,
        minBin: p.minBinId,
        maxBin: p.maxBinId,
        minPrice: binToPrice(p.minBinId, state.binStep),
        maxPrice: binToPrice(p.maxBinId, state.binStep),
        filled: fillPct,
        amount: p.initialAmount / Math.pow(10, decimals),
        initialAmount: p.initialAmount,
        lpFees: 0,
      };
    });
  } catch (err) {
    if (CONFIG.DEBUG) console.error('Failed to refresh positions:', err);
  }
  updatePositionsList();
}

function updatePositionsList() {
  const container = document.getElementById('positionsList');
  if (!container) return;

  if (!state.connected) {
    container.innerHTML = '<div class="empty-state">connect wallet to view positions</div>';
    return;
  }

  if (state.positions.length === 0) {
    container.innerHTML = '<div class="empty-state">no positions yet</div>';
    return;
  }

  container.innerHTML = state.positions.map((p, i) => `
    <div class="position-row">
      <span>${escapeHtml(p.pool)}</span>
      <span class="position-side ${escapeHtml(p.side)}">${escapeHtml(p.side)}</span>
      <span>${typeof p.filled === 'number' ? p.filled : 0}%</span>
      <button class="close-btn" data-idx="${i}">close</button>
      <button class="action-btn-sm share-btn" data-idx="${i}">share</button>
    </div>
  `).join('');

  container.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', () => closePosition(parseInt(btn.dataset.idx)));
  });
  container.querySelectorAll('.share-btn').forEach(btn => {
    btn.addEventListener('click', () => showPnlModal(parseInt(btn.dataset.idx)));
  });
}

async function closePosition(index) {
  const pos = state.positions[index];
  if (!pos) { showToast('Position not found', 'error'); return; }
  if (!pos.pubkey || !pos.meteoraPosition) {
    showToast('Missing position data — reload page', 'error');
    return;
  }

  const closeBtn = document.querySelectorAll('.close-btn')[index];
  if (closeBtn) { closeBtn.textContent = 'closing...'; closeBtn.disabled = true; }

  try {
    showToast('Building close transaction...', 'info');

    const conn = state.connection;
    const user = state.publicKey;
    const coreProgramId = new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID);

    const poolAddr = pos.poolAddress || state.poolAddress;
    const cpi = await resolveMeteoraCPIAccounts(poolAddr, pos.minBin, pos.maxBin);

    const [configPDA] = getConfigPDA();
    const [positionPDA] = getPositionPDA(pos.meteoraPosition);
    const [vaultPDA] = getVaultPDA(pos.meteoraPosition);
    const [roverAuthorityPDA] = getRoverAuthorityPDA();

    const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
    const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);
    const userTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, user, false, cpi.tokenXProgramId);
    const userTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, user, false, cpi.tokenYProgramId);
    const roverFeeTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, roverAuthorityPDA, true, cpi.tokenXProgramId);
    const roverFeeTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, roverAuthorityPDA, true, cpi.tokenYProgramId);

    const tx = new solanaWeb3.Transaction();

    // Ensure user ATAs exist
    const [userXInfo, userYInfo] = await Promise.all([
      conn.getAccountInfo(userTokenX),
      conn.getAccountInfo(userTokenY),
    ]);
    if (!userXInfo) tx.add(createAssociatedTokenAccountIx(user, userTokenX, user, cpi.tokenXMint, cpi.tokenXProgramId));
    if (!userYInfo) tx.add(createAssociatedTokenAccountIx(user, userTokenY, user, cpi.tokenYMint, cpi.tokenYProgramId));

    const closeIx = await getUserCloseInstructionAsync({
      user: asSigner(user),
      position: address(pos.pubkey.toBase58()),
      vault: address(vaultPDA.toBase58()),
      meteoraPosition: address(pos.meteoraPosition.toBase58()),
      lbPair: address(cpi.lbPair.toBase58()),
      binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
      binArrayLower: address(cpi.binArrayLower.toBase58()),
      binArrayUpper: address(cpi.binArrayUpper.toBase58()),
      reserveX: address(cpi.reserveX.toBase58()),
      reserveY: address(cpi.reserveY.toBase58()),
      tokenXMint: address(cpi.tokenXMint.toBase58()),
      tokenYMint: address(cpi.tokenYMint.toBase58()),
      eventAuthority: address(cpi.eventAuthority.toBase58()),
      dlmmProgram: address(cpi.dlmmProgram.toBase58()),
      vaultTokenX: address(vaultTokenX.toBase58()),
      vaultTokenY: address(vaultTokenY.toBase58()),
      userTokenX: address(userTokenX.toBase58()),
      userTokenY: address(userTokenY.toBase58()),
      roverFeeTokenX: address(roverFeeTokenX.toBase58()),
      roverFeeTokenY: address(roverFeeTokenY.toBase58()),
      tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
      tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
      memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
    });
    tx.add(kitIxToWeb3(closeIx));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = user;

    showToast('Approve in wallet...', 'info');
    const signed = await state.wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    showToast('Confirming...', 'info');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

    showToast('Position closed', 'success');
    if (CONFIG.DEBUG) console.log(`[monke] Close tx: ${sig}`);

    await refreshPositionsList();
    loadBinVizData();
  } catch (err) {
    console.error('Close failed:', err);
    showToast('Close failed: ' + (err?.message || err), 'error');
  } finally {
    if (closeBtn) { closeBtn.textContent = 'close'; closeBtn.disabled = false; }
  }
}

/** Close a position by direct data (used by positions page). */
async function closePositionDirect(pos) {
  if (!state.connected) throw new Error('Connect wallet first');
  const conn = state.connection;
  const user = state.publicKey;

  const cpi = await resolveMeteoraCPIAccounts(pos.poolAddress, pos.minBin, pos.maxBin);

  const [positionPDA] = getPositionPDA(pos.meteoraPosition);
  const [vaultPDA] = getVaultPDA(pos.meteoraPosition);
  const [roverAuthorityPDA] = getRoverAuthorityPDA();

  const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
  const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);
  const userTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, user, false, cpi.tokenXProgramId);
  const userTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, user, false, cpi.tokenYProgramId);
  const roverFeeTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, roverAuthorityPDA, true, cpi.tokenXProgramId);
  const roverFeeTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, roverAuthorityPDA, true, cpi.tokenYProgramId);

  const tx = new solanaWeb3.Transaction();
  const [userXInfo, userYInfo] = await Promise.all([conn.getAccountInfo(userTokenX), conn.getAccountInfo(userTokenY)]);
  if (!userXInfo) tx.add(createAssociatedTokenAccountIx(user, userTokenX, user, cpi.tokenXMint, cpi.tokenXProgramId));
  if (!userYInfo) tx.add(createAssociatedTokenAccountIx(user, userTokenY, user, cpi.tokenYMint, cpi.tokenYProgramId));

  const closeIx = await getUserCloseInstructionAsync({
    user: asSigner(user),
    position: address(pos.pubkey.toBase58()),
    vault: address(vaultPDA.toBase58()),
    meteoraPosition: address(pos.meteoraPosition.toBase58()),
    lbPair: address(cpi.lbPair.toBase58()),
    binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
    binArrayLower: address(cpi.binArrayLower.toBase58()),
    binArrayUpper: address(cpi.binArrayUpper.toBase58()),
    reserveX: address(cpi.reserveX.toBase58()),
    reserveY: address(cpi.reserveY.toBase58()),
    tokenXMint: address(cpi.tokenXMint.toBase58()),
    tokenYMint: address(cpi.tokenYMint.toBase58()),
    eventAuthority: address(cpi.eventAuthority.toBase58()),
    dlmmProgram: address(cpi.dlmmProgram.toBase58()),
    vaultTokenX: address(vaultTokenX.toBase58()),
    vaultTokenY: address(vaultTokenY.toBase58()),
    userTokenX: address(userTokenX.toBase58()),
    userTokenY: address(userTokenY.toBase58()),
    roverFeeTokenX: address(roverFeeTokenX.toBase58()),
    roverFeeTokenY: address(roverFeeTokenY.toBase58()),
    tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
    tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
    memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
  });
  tx.add(kitIxToWeb3(closeIx));

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;

  showToast('Approve in wallet...', 'info');
  const signed = await state.wallet.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  showToast('Confirming...', 'info');
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (CONFIG.DEBUG) console.log(`[monke] Close tx: ${sig}`);
}

async function claimFeesDirect(pos) {
  if (!state.connected) throw new Error('Connect wallet first');
  const conn = state.connection;
  const user = state.publicKey;

  const cpi = await resolveMeteoraCPIAccounts(pos.poolAddress, pos.minBin, pos.maxBin);

  const [positionPDA] = getPositionPDA(pos.meteoraPosition);
  const [vaultPDA] = getVaultPDA(pos.meteoraPosition);

  const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
  const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);
  const userTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, user, false, cpi.tokenXProgramId);
  const userTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, user, false, cpi.tokenYProgramId);

  const tx = new solanaWeb3.Transaction();
  const [userXInfo, userYInfo] = await Promise.all([conn.getAccountInfo(userTokenX), conn.getAccountInfo(userTokenY)]);
  if (!userXInfo) tx.add(createAssociatedTokenAccountIx(user, userTokenX, user, cpi.tokenXMint, cpi.tokenXProgramId));
  if (!userYInfo) tx.add(createAssociatedTokenAccountIx(user, userTokenY, user, cpi.tokenYMint, cpi.tokenYProgramId));

  const claimFeesIx = getClaimFeesInstruction({
    user: asSigner(user),
    position: address(positionPDA.toBase58()),
    vault: address(vaultPDA.toBase58()),
    meteoraPosition: address(pos.meteoraPosition.toBase58()),
    lbPair: address(cpi.lbPair.toBase58()),
    binArrayLower: address(cpi.binArrayLower.toBase58()),
    binArrayUpper: address(cpi.binArrayUpper.toBase58()),
    reserveX: address(cpi.reserveX.toBase58()),
    reserveY: address(cpi.reserveY.toBase58()),
    tokenXMint: address(cpi.tokenXMint.toBase58()),
    tokenYMint: address(cpi.tokenYMint.toBase58()),
    eventAuthority: address(cpi.eventAuthority.toBase58()),
    dlmmProgram: address(cpi.dlmmProgram.toBase58()),
    vaultTokenX: address(vaultTokenX.toBase58()),
    vaultTokenY: address(vaultTokenY.toBase58()),
    userTokenX: address(userTokenX.toBase58()),
    userTokenY: address(userTokenY.toBase58()),
    tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
    tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
    memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
  });
  tx.add(kitIxToWeb3(claimFeesIx));

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;

  showToast('Approve in wallet...', 'info');
  const signed = await state.wallet.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  showToast('Confirming fee claim...', 'info');
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (CONFIG.DEBUG) console.log(`[monke] Claim fees tx: ${sig}`);
}

// ============================================================
// RANK PAGE — Monke + Roster (stub — wired to live data in later phase)
// ============================================================

function renderCarouselFrame(nfts, idx) {
  const frame = document.getElementById('nftFrame');
  const counter = document.getElementById('nftCounter');
  const prevBtn = document.getElementById('nftPrev');
  const nextBtn = document.getElementById('nftNext');
  if (!frame) return;

  const nft = nfts[idx];
  const weightLabel = nft.weight > 0 ? `wt: ${nft.weight}` : '';
  const claimLabel = nft.pendingSol > 0n ? `${(Number(nft.pendingSol) / 1e9).toFixed(4)} SOL` : '';
  frame.innerHTML = `
    <img src="${escapeHtml(nft.image || '')}" alt="${escapeHtml(nft.name || 'monke')}" loading="lazy" onerror="this.style.display='none'">
    <span class="nft-gen-tag ${nft.gen === 2 ? 'gen2' : 'gen3'}">${nft.gen === 2 ? 'g2' : 'g3'}</span>
    ${weightLabel || claimLabel ? `<span class="nft-burn-info">${weightLabel}${weightLabel && claimLabel ? ' · ' : ''}${claimLabel}</span>` : ''}`;

  if (counter) counter.textContent = nfts.length > 1 ? `${idx + 1} / ${nfts.length}` : '';
  if (prevBtn) prevBtn.style.display = nfts.length > 1 ? '' : 'none';
  if (nextBtn) nextBtn.style.display = nfts.length > 1 ? '' : 'none';

  selectMonke(nft);
}

async function enrichNftsWithBurnData(nfts) {
  if (!state.connection || nfts.length === 0) return;
  try {
    const burnPDAs = nfts.map(nft => getMonkeBurnPDA(new solanaWeb3.PublicKey(nft.mint))[0]);
    const [monkeStateInfo, ...burnInfos] = await state.connection.getMultipleAccountsInfo([
      getMonkeStatePDA()[0], ...burnPDAs
    ]);

    const monkeState = monkeStateInfo ? decodeMonkeState(toEncodedAccount(getMonkeStatePDA()[0], monkeStateInfo.data, MONKE_BANANAS_PROGRAM_ADDRESS)).data : null;
    state.monkeStateData = monkeState;

    nfts.forEach((nft, i) => {
      const info = burnInfos[i];
      if (info) {
        const burn = decodeMonkeBurn(toEncodedAccount(burnPDAs[i], info.data, MONKE_BANANAS_PROGRAM_ADDRESS)).data;
        if (burn) {
          nft.weight = Number(burn.shareWeight);
          nft.pendingSol = monkeState ? computePendingClaim(burn, monkeState) : 0n;
          nft.claimable = (Number(nft.pendingSol) / 1e9).toFixed(4);
          nft.hasBurn = true;
          return;
        }
      }
      nft.weight = 0;
      nft.pendingSol = 0n;
      nft.claimable = '0';
      nft.hasBurn = false;
    });
  } catch (err) {
    console.warn('[monke] MonkeBurn fetch failed:', err.message);
  }
}

async function renderMonkeList() {
  const container = document.getElementById('monkeList');
  const frame = document.getElementById('nftFrame');
  const counter = document.getElementById('nftCounter');
  const prevBtn = document.getElementById('nftPrev');
  const nextBtn = document.getElementById('nftNext');
  if (!container) return;

  const hideCarouselNav = () => {
    if (counter) counter.textContent = '';
    if (prevBtn) prevBtn.style.display = 'none';
    if (nextBtn) nextBtn.style.display = 'none';
  };

  if (!state.connected) {
    container.innerHTML = '<div class="empty-state">connect wallet to view your monkes</div>';
    if (frame) frame.innerHTML = '<div class="empty-state" style="padding:20px;">connect wallet</div>';
    hideCarouselNav();
    return;
  }

  container.innerHTML = '<div class="empty-state">scanning for SMB monkes...</div>';
  if (frame) frame.innerHTML = '<div class="empty-state" style="padding:20px;">scanning...</div>';
  hideCarouselNav();

  const nfts = await fetchSMBNfts();
  await enrichNftsWithBurnData(nfts);
  state.monkeNfts = nfts;

  if (nfts.length === 0) {
    container.innerHTML = '<div class="empty-state">no SMB Gen2/Gen3 NFTs found — <a href="https://magiceden.us/marketplace/solana_monkey_business" target="_blank" rel="noopener" style="color:var(--bananas);text-decoration:none;">buy Gen2</a> · <a href="https://magiceden.us/marketplace/smb_gen3" target="_blank" rel="noopener" style="color:var(--bananas);text-decoration:none;">buy Gen3</a></div>';
    if (frame) frame.innerHTML = '<div class="empty-state" style="padding:20px;">no monkes</div>';
    hideCarouselNav();
    return;
  }

  state.currentNftIndex = 0;
  renderCarouselFrame(nfts, 0);

  if (prevBtn) {
    prevBtn.onclick = () => {
      if (state.currentNftIndex > 0) {
        state.currentNftIndex--;
        renderCarouselFrame(nfts, state.currentNftIndex);
      }
    };
  }
  if (nextBtn) {
    nextBtn.onclick = () => {
      if (state.currentNftIndex < nfts.length - 1) {
        state.currentNftIndex++;
        renderCarouselFrame(nfts, state.currentNftIndex);
      }
    };
  }

  // Populate list (right panel)
  container.innerHTML = nfts.map((nft, i) => `
    <div class="monke-row">
      <span>${escapeHtml(nft.name || nft.mint.slice(0, 8) + '...')}</span>
      <span class="gen-badge ${nft.gen === 2 ? 'gen2' : 'gen3'}">gen${nft.gen}</span>
      <span>${nft.weight || 0}</span>
      <span class="claimable">${nft.claimable || '0'} SOL</span>
      <button class="action-btn-sm" data-mint="${escapeHtml(nft.mint)}" data-action="claim">claim</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-action="claim"]').forEach(btn => {
    btn.addEventListener('click', () => handleClaimMonke(btn.dataset.mint));
  });
}

function selectMonke(nft) {
  const nameEl = document.getElementById('nftSelectedName');
  const genEl = document.getElementById('nftSelectedGen');
  const infoEl = document.getElementById('nftSelectedInfo');
  if (infoEl) infoEl.style.display = '';
  if (nameEl) nameEl.textContent = nft.name || nft.mint.slice(0, 12) + '...';
  if (genEl) genEl.textContent = 'gen' + nft.gen + (nft.gen === 2 ? ' (2x weight)' : ' (1x weight)');
  state.selectedMonkeMint = nft.mint;
}

async function fetchSMBNfts() {
  if (!state.connection || !state.publicKey) return [];
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;

  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'monke-nfts', method: 'getAssetsByOwner',
        params: {
          ownerAddress: state.publicKey.toString(),
          page: 1, limit: 100,
          displayOptions: { showCollectionMetadata: true },
        },
      }),
    });
    const data = await resp.json();
    const items = data?.result?.items || [];

    const gen2Collection = CONFIG.SMB_COLLECTION;
    const gen3Collection = CONFIG.SMB_GEN3_COLLECTION;
    const monkes = [];

    for (const item of items) {
      const collection = item.grouping?.find(g => g.group_key === 'collection')?.group_value;
      let gen = 0;
      if (collection === gen2Collection) gen = 2;
      else if (collection === gen3Collection) gen = 3;
      if (gen === 0) continue;

      monkes.push({
        mint: item.id,
        name: item.content?.metadata?.name || '',
        image: item.content?.links?.image || item.content?.files?.[0]?.uri || '',
        gen,
        weight: 0,
        claimable: '0',
      });
    }

    return monkes;
  } catch (err) {
    console.warn('[monke] NFT fetch failed:', err.message);
    return [];
  }
}

async function renderGlobalStats() {
  try {
    const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
    const [monkeStatePDA] = getMonkeStatePDA();
    const info = await conn.getAccountInfo(monkeStatePDA);
    if (!info) return;
    const ms = decodeMonkeState(toEncodedAccount(monkeStatePDA, info.data, MONKE_BANANAS_PROGRAM_ADDRESS)).data;
    if (!ms) return;
    const el = id => document.getElementById(id);
    if (el('globalBananasBurned')) el('globalBananasBurned').textContent = (Number(ms.totalBananasBurned) / 1e6).toLocaleString() + ' $BANANAS';
    if (el('globalTotalWeight')) el('globalTotalWeight').textContent = Number(ms.totalShareWeight).toLocaleString();
    if (el('globalSolDistributed')) el('globalSolDistributed').textContent = (Number(ms.totalSolDistributed) / 1e9).toFixed(4) + ' SOL';
  } catch (err) {
    console.warn('[monke] Global stats fetch failed:', err.message);
  }
}

async function renderRoster() {
  const container = document.getElementById('rosterList');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">loading roster...</div>';

  try {
    const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
    const monkeBananasProgramId = new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID);
    const MONKE_BURN_DISC_B58 = 'HSeFS7MzwFQ';

    const accounts = await conn.getProgramAccounts(monkeBananasProgramId, {
      filters: [{ memcmp: { offset: 0, bytes: MONKE_BURN_DISC_B58 } }],
    });

    if (accounts.length === 0) {
      container.innerHTML = '<div class="empty-state">no monkes have been fed yet</div>';
      return;
    }

    const entries = accounts.map(({ pubkey, account }) => {
      const burn = decodeMonkeBurn(toEncodedAccount(pubkey, account.data, MONKE_BANANAS_PROGRAM_ADDRESS)).data;
      if (!burn) return null;
      return { mint: burn.nftMint, weight: Number(burn.shareWeight), claimed: Number(burn.claimedSol) / 1e9 };
    }).filter(Boolean).sort((a, b) => b.weight - a.weight);

    container.innerHTML = entries.map((e, i) => `
      <div class="roster-row">
        <span class="roster-rank">${i + 1}</span>
        <span class="roster-mint">${e.mint.slice(0, 4)}...${e.mint.slice(-4)}</span>
        <span class="roster-weight">${e.weight}</span>
        <span class="roster-claimed">${e.claimed.toFixed(4)} SOL</span>
      </div>
    `).join('');
  } catch (err) {
    console.warn('[monke] Roster fetch failed:', err.message);
    container.innerHTML = '<div class="empty-state">failed to load roster</div>';
  }
}

function handleMonkeBurnLookup() {
  const mint = document.getElementById('monkeBurnLookup')?.value.trim();
  const container = document.getElementById('monkeBurnResult');
  if (!container) return;
  if (!mint) { container.innerHTML = ''; return; }
  container.innerHTML = '<div class="empty-state">MonkeBurn lookup requires deployed programs</div>';
}

// ============================================================
// RANK ACTIONS — feed_monke, claim, claim_all
// ============================================================

async function handleFeedMonke(nftMintStr) {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const conn = state.connection;
  const user = state.publicKey;
  const nftMint = new solanaWeb3.PublicKey(nftMintStr);
  const bananasMint = new solanaWeb3.PublicKey(CONFIG.BANANAS_MINT);

  try {
    const [metadataPDA] = getMetadataPDA(nftMint);
    const userNftAccount = getAssociatedTokenAddressSync(nftMint, user);
    const userBananasAccount = getAssociatedTokenAddressSync(bananasMint, user);

    const tx = new solanaWeb3.Transaction();
    const feedIx = await getFeedMonkeInstructionAsync({
      user: asSigner(user),
      nftMint: address(nftMint.toBase58()),
      nftMetadata: address(metadataPDA.toBase58()),
      userNftAccount: address(userNftAccount.toBase58()),
      userBananasAccount: address(userBananasAccount.toBase58()),
      bananasMint: address(bananasMint.toBase58()),
    });
    tx.add(kitIxToWeb3(feedIx));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = user;

    showToast('Approve in wallet...', 'info');
    const signed = await state.wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    showToast('Confirming burn...', 'info');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    showToast('1M $BANANAS burned to your Monke!', 'success');
    renderMonkeList();
  } catch (err) {
    console.error('[monke] feed_monke failed:', err);
    showToast('Feed failed: ' + (err?.message || err), 'error');
  }
}

async function handleClaimMonke(nftMintStr) {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const conn = state.connection;
  const user = state.publicKey;
  const nftMint = new solanaWeb3.PublicKey(nftMintStr);

  try {
    const [monkeBurnPDA] = getMonkeBurnPDA(nftMint);
    const userNftAccount = getAssociatedTokenAddressSync(nftMint, user);

    const tx = new solanaWeb3.Transaction();
    const claimIx = await getClaimInstructionAsync({
      user: asSigner(user),
      monkeBurn: address(monkeBurnPDA.toBase58()),
      userNftAccount: address(userNftAccount.toBase58()),
    });
    tx.add(kitIxToWeb3(claimIx));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = user;

    showToast('Approve in wallet...', 'info');
    const signed = await state.wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    showToast('Confirming claim...', 'info');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    showToast('SOL claimed!', 'success');
    renderMonkeList();
  } catch (err) {
    console.error('[monke] claim failed:', err);
    showToast('Claim failed: ' + (err?.message || err), 'error');
  }
}

async function handleClaimAll() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const conn = state.connection;
  const user = state.publicKey;
  const claimable = (state.monkeNfts || []).filter(n => n.hasBurn && n.pendingSol > 0n);
  if (claimable.length === 0) { showToast('Nothing to claim', 'info'); return; }

  try {
    const tx = new solanaWeb3.Transaction();
    for (const nft of claimable) {
      const nftMint = new solanaWeb3.PublicKey(nft.mint);
      const [monkeBurnPDA] = getMonkeBurnPDA(nftMint);
      const userNftAccount = getAssociatedTokenAddressSync(nftMint, user);
      const claimIx = await getClaimInstructionAsync({
        user: asSigner(user),
        monkeBurn: address(monkeBurnPDA.toBase58()),
        userNftAccount: address(userNftAccount.toBase58()),
      });
      tx.add(kitIxToWeb3(claimIx));
    }

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = user;

    showToast('Approve in wallet...', 'info');
    const signed = await state.wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    showToast('Confirming claims...', 'info');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    showToast(`Claimed from ${claimable.length} monke${claimable.length > 1 ? 's' : ''}!`, 'success');
    renderMonkeList();
  } catch (err) {
    console.error('[monke] claim_all failed:', err);
    showToast('Claim all failed: ' + (err?.message || err), 'error');
  }
}

// ============================================================
// RECON PAGE — rover TVL leaderboard + bribe deposit
// ============================================================

function renderReconPools() {
  const container = document.getElementById('reconPoolList');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">no rover positions yet — data loads from bot relay</div>';
}

function renderReconTop5() {
  const container = document.getElementById('reconTop5Cards');
  if (!container) return;
  container.innerHTML = '';
}

async function handleRoverDeposit() {
  const mintAddress = document.getElementById('roverTokenMint')?.value.trim();
  const amount = parseFloat(document.getElementById('roverAmount')?.value);
  if (!mintAddress) { showToast('Enter a token mint address', 'error'); return; }
  if (!amount || amount <= 0) { showToast('Enter an amount', 'error'); return; }
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  showToast('Bribe deposit requires deployed programs', 'info');
}

// ============================================================
// OPS PAGE — activity feed + bounty board + permissionless crank
// ============================================================

async function renderOpsStats() {
  const el = id => document.getElementById(id);
  try {
    const [stats, pending] = await Promise.all([
      relayFetch('/api/stats'),
      relayFetch('/api/pending-harvests'),
    ]);
    if (stats) {
      if (el('opsPositionCount')) el('opsPositionCount').textContent = stats.positionCount || 0;
      if (el('opsTotalHarvested')) el('opsTotalHarvested').textContent = (stats.totalHarvests || 0) + ' txs';
      if (el('opsBotStatus')) el('opsBotStatus').textContent = stats.grpcConnected ? 'connected' : 'offline';
    } else {
      if (el('opsBotStatus')) el('opsBotStatus').textContent = 'offline';
    }
    if (pending) {
      if (el('opsPendingCount')) el('opsPendingCount').textContent = pending.count || 0;
    }
  } catch {
    if (el('opsBotStatus')) el('opsBotStatus').textContent = 'offline';
  }

  // SOL balances for fee pipeline visibility
  try {
    if (state.connection) {
      const roverAuthority = getRoverAuthorityPDA()[0];
      const distPool = getDistPoolPDA()[0];
      const [roverBal, distBal] = await Promise.all([
        state.connection.getBalance(roverAuthority),
        state.connection.getBalance(distPool),
      ]);
      if (el('opsSweepBalance')) el('opsSweepBalance').textContent = (roverBal / 1e9).toFixed(4) + ' SOL';
      if (el('opsDepositBalance')) el('opsDepositBalance').textContent = (distBal / 1e9).toFixed(4) + ' SOL';
    }
  } catch {}
}

async function renderBountyBoard() {
  const container = document.getElementById('bountyBoard');
  if (!container) return;

  try {
    const data = await relayFetch('/api/pending-harvests');
    if (!data || !data.pending || data.pending.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:16px;">no pending harvests</div>';
      return;
    }

    container.innerHTML = data.pending.map(p => `
      <div class="bounty-row">
        <span>${(p.lbPair || '').slice(0, 4)}...${(p.lbPair || '').slice(-4)}</span>
        <span>${p.safeBinCount} / ${p.totalBins}</span>
        <span>${p.side}</span>
        <span>${p.safeBinCount > 0 ? 'ready' : ''}</span>
        <button class="action-btn-sm harvest-btn" data-pda="${p.positionPDA}" data-lbpair="${p.lbPair}" data-owner="${p.owner}" data-side="${p.side}">harvest</button>
      </div>
    `).join('');

    container.querySelectorAll('.harvest-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.textContent = '...'; btn.disabled = true;
        handleHarvestPosition(btn.dataset.pda, btn.dataset.lbpair, btn.dataset.owner, btn.dataset.side)
          .then(() => { showToast('Harvested!', 'success'); renderBountyBoard(); renderOpsStats(); })
          .catch(err => { showToast('Harvest failed: ' + (err?.message || err), 'error'); btn.textContent = 'harvest'; btn.disabled = false; });
      });
    });
  } catch {
    container.innerHTML = '<div class="empty-state" style="padding:16px;">relay offline</div>';
  }
}

function addFeedEvent(text) {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  const emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const event = document.createElement('div');
  event.className = 'feed-event';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  event.innerHTML = `${escapeHtml(text)} <span class="event-time">${time}</span>`;
  feed.insertBefore(event, feed.firstChild);

  while (feed.children.length > 100) {
    feed.removeChild(feed.lastChild);
  }
}

async function handleCrankSweep() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const conn = state.connection;
  const user = state.publicKey;

  try {
    const [distPoolPDA] = getDistPoolPDA();

    const [configPDA] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('config')],
      new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
    );
    const configInfo = await conn.getAccountInfo(configPDA);
    if (!configInfo) { showToast('Config account not found', 'error'); return; }
    const configDecoded = decodeConfig(toEncodedAccount(configPDA, configInfo.data, BIN_FARM_PROGRAM_ADDRESS));
    const botAddress = configDecoded.data.bot;

    const tx = new solanaWeb3.Transaction();
    const sweepIx = await getSweepRoverInstructionAsync({
      caller: asSigner(user),
      revenueDest: address(distPoolPDA.toBase58()),
      botDest: botAddress,
    });
    tx.add(kitIxToWeb3(sweepIx));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = user;

    showToast('Approve sweep...', 'info');
    const signed = await state.wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    showToast('Confirming sweep...', 'info');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    showToast('Swept SOL — 50% to dist pool, 50% to bot!', 'success');
    renderOpsStats();
  } catch (err) {
    console.error('[monke] sweep_rover failed:', err);
    showToast('Sweep failed: ' + (err?.message || err), 'error');
  }
}

async function handleCrankDistribute() {
  return handleCrankDeposit();
}

async function handleCrankDeposit() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const conn = state.connection;
  const user = state.publicKey;

  try {
    const tx = new solanaWeb3.Transaction();
    const depositIx = await getDepositSolInstructionAsync({
      caller: asSigner(user),
    });
    tx.add(kitIxToWeb3(depositIx));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = user;

    showToast('Approve deposit...', 'info');
    const signed = await state.wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    showToast('Confirming deposit...', 'info');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    showToast('SOL deposited to program vault!', 'success');
    renderOpsStats();
  } catch (err) {
    console.error('[monke] deposit_sol failed:', err);
    showToast('Deposit failed: ' + (err?.message || err), 'error');
  }
}

async function handleHarvestPosition(positionPDAStr, lbPairStr, ownerStr, side) {
  if (!state.connected) throw new Error('Connect wallet first');
  const conn = state.connection;
  const user = state.publicKey;

  const positionPubkey = new solanaWeb3.PublicKey(positionPDAStr);
  const posInfo = await conn.getAccountInfo(positionPubkey);
  if (!posInfo) throw new Error('Position not found');
  const posDecoded = decodePosition(toEncodedAccount(positionPubkey, posInfo.data, BIN_FARM_PROGRAM_ADDRESS)).data;
  const meteoraPosition = new solanaWeb3.PublicKey(posDecoded.meteoraPosition);
  const minBinId = posDecoded.minBinId;
  const maxBinId = posDecoded.maxBinId;
  const owner = new solanaWeb3.PublicKey(ownerStr);

  const cpi = await resolveMeteoraCPIAccounts(lbPairStr, minBinId, maxBinId);

  // Compute safe bin_ids from active_id
  const lbPairPubkey = new solanaWeb3.PublicKey(lbPairStr);
  const lbPairInfo = await conn.getAccountInfo(lbPairPubkey);
  const lbData = new Uint8Array(lbPairInfo.data);
  const lbView = new DataView(lbData.buffer, lbData.byteOffset);
  const activeId = lbView.getInt32(76, true);

  const binIds = [];
  const sideEnum = side === 'Sell' || side === 'sell' ? 1 : 0;
  for (let b = minBinId; b <= maxBinId; b++) {
    if (sideEnum === 1 && b < activeId) binIds.push(b);
    else if (sideEnum === 0 && b > activeId) binIds.push(b);
  }
  if (binIds.length === 0) throw new Error('No safe bins to harvest');
  if (binIds.length > 70) binIds.length = 70;

  const [vaultPDA] = getVaultPDA(meteoraPosition);
  const [roverAuthorityPDA] = getRoverAuthorityPDA();

  const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
  const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);
  const ownerTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, owner, false, cpi.tokenXProgramId);
  const ownerTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, owner, false, cpi.tokenYProgramId);
  const roverFeeTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, roverAuthorityPDA, true, cpi.tokenXProgramId);
  const roverFeeTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, roverAuthorityPDA, true, cpi.tokenYProgramId);

  const tx = new solanaWeb3.Transaction();
  const harvestIx = await getHarvestBinsInstructionAsync({
    bot: asSigner(user),
    position: address(positionPubkey.toBase58()),
    vault: address(vaultPDA.toBase58()),
    owner: address(owner.toBase58()),
    meteoraPosition: address(meteoraPosition.toBase58()),
    lbPair: address(cpi.lbPair.toBase58()),
    binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
    binArrayLower: address(cpi.binArrayLower.toBase58()),
    binArrayUpper: address(cpi.binArrayUpper.toBase58()),
    reserveX: address(cpi.reserveX.toBase58()),
    reserveY: address(cpi.reserveY.toBase58()),
    tokenXMint: address(cpi.tokenXMint.toBase58()),
    tokenYMint: address(cpi.tokenYMint.toBase58()),
    eventAuthority: address(cpi.eventAuthority.toBase58()),
    dlmmProgram: address(cpi.dlmmProgram.toBase58()),
    vaultTokenX: address(vaultTokenX.toBase58()),
    vaultTokenY: address(vaultTokenY.toBase58()),
    ownerTokenX: address(ownerTokenX.toBase58()),
    ownerTokenY: address(ownerTokenY.toBase58()),
    roverFeeTokenX: address(roverFeeTokenX.toBase58()),
    roverFeeTokenY: address(roverFeeTokenY.toBase58()),
    tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
    tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
    memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
    binIds: binIds,
  });
  tx.add(kitIxToWeb3(harvestIx));

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = user;

  showToast('Approve harvest...', 'info');
  const signed = await state.wallet.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  showToast('Confirming harvest...', 'info');
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
}

async function handleHarvestAll() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  try {
    const data = await relayFetch('/api/pending-harvests');
    if (!data || !data.pending || data.pending.length === 0) { showToast('Nothing to harvest', 'info'); return; }
    for (const p of data.pending) {
      await handleHarvestPosition(p.positionPDA, p.lbPair, p.owner, p.side);
    }
    showToast(`Harvested ${data.pending.length} position(s)!`, 'success');
    renderBountyBoard();
    renderOpsStats();
  } catch (err) {
    console.error('[monke] harvest_all failed:', err);
    showToast('Harvest all failed: ' + (err?.message || err), 'error');
  }
}

// ============================================================
// PNL CARD — Canvas rendering with scaffold vocabulary
// ============================================================

function renderPnlCard(position) {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const w = 1200, h = 675;
  canvas.width = w;
  canvas.height = h;

  // Background
  ctx.fillStyle = '#0F1A3A';
  ctx.fillRect(0, 0, w, h);

  // Frame: dashed quarter-arcs in corners (scaffold vocabulary)
  const arcR = 60;
  const margin = 30;
  ctx.strokeStyle = '#3A5A28';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);

  // Top-left arc
  ctx.beginPath();
  ctx.arc(margin + arcR, margin + arcR, arcR, Math.PI, Math.PI * 1.5);
  ctx.stroke();
  // Top-right arc
  ctx.beginPath();
  ctx.arc(w - margin - arcR, margin + arcR, arcR, Math.PI * 1.5, Math.PI * 2);
  ctx.stroke();
  // Bottom-left arc
  ctx.beginPath();
  ctx.arc(margin + arcR, h - margin - arcR, arcR, Math.PI * 0.5, Math.PI);
  ctx.stroke();
  // Bottom-right arc
  ctx.beginPath();
  ctx.arc(w - margin - arcR, h - margin - arcR, arcR, 0, Math.PI * 0.5);
  ctx.stroke();

  ctx.setLineDash([]);

  // Determine profit/loss
  const pnl = position.amount * (position.filled / 100) + (position.lpFees || 0) - position.amount;
  const isProfit = pnl >= 0;
  const accentColor = isProfit ? '#9DE5B5' : '#8B4513';

  // Accent: colored inner arcs
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  const innerR = 40;
  ctx.beginPath();
  ctx.arc(margin + arcR, margin + arcR, innerR, Math.PI, Math.PI * 1.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(w - margin - arcR, margin + arcR, innerR, Math.PI * 1.5, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(margin + arcR, h - margin - arcR, innerR, Math.PI * 0.5, Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(w - margin - arcR, h - margin - arcR, innerR, 0, Math.PI * 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  // Typography — all JetBrains Mono
  const fontBase = "'JetBrains Mono', monospace";

  // Pool pair — top left
  ctx.font = `200 26px ${fontBase}`;
  ctx.fillStyle = '#C4CFCB';
  ctx.textAlign = 'left';
  ctx.fillText(position.pool, margin + 20, margin + 70);

  // Side
  ctx.font = `300 14px ${fontBase}`;
  ctx.fillStyle = position.side === 'buy' ? '#9DE5B5' : '#8B4513';
  ctx.fillText(position.side.toUpperCase(), margin + 20, margin + 100);

  // Price range — center left
  ctx.font = `300 16px ${fontBase}`;
  ctx.fillStyle = '#607080';
  ctx.fillText(`$${formatPrice(position.minPrice)} - $${formatPrice(position.maxPrice)}`, margin + 20, h / 2 - 20);

  // Fill %
  ctx.font = `300 14px ${fontBase}`;
  ctx.fillStyle = '#607080';
  ctx.fillText(`${position.filled}% filled`, margin + 20, h / 2 + 10);

  // LP Fees
  ctx.fillText(`LP fees: ${(position.lpFees || 0).toFixed(4)} SOL`, margin + 20, h / 2 + 40);

  // P/L — right-aligned, large, weight 400 (the ONE use)
  ctx.font = `400 48px ${fontBase}`;
  ctx.fillStyle = accentColor;
  ctx.textAlign = 'right';
  const pnlText = (isProfit ? '+' : '') + pnl.toFixed(4) + ' SOL';
  ctx.fillText(pnlText, w - margin - 20, h / 2 + 15);

  // P/L label
  ctx.font = `300 12px ${fontBase}`;
  ctx.fillStyle = '#607080';
  ctx.fillText('net p/l', w - margin - 20, h / 2 - 30);

  // Watermark — bottom center
  ctx.font = `300 10px ${fontBase}`;
  ctx.fillStyle = '#607080';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '2px';
  ctx.fillText('harvested by monke.army', w / 2, h - margin - 10);
}

function showPnlModal(positionIndex) {
  const position = state.positions[positionIndex];
  if (!position) return;

  renderPnlCard(position);

  const modal = document.getElementById('pnlModal');
  if (modal) modal.classList.add('visible');
}

function closePnlModal() {
  const modal = document.getElementById('pnlModal');
  if (modal) modal.classList.remove('visible');
}

async function downloadPnlCard() {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;

  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'monke-pnl.png';
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

async function copyPnlCard() {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;

  try {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (blob) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Copied to clipboard', 'success');
    }
  } catch {
    showToast('Copy failed — try download instead', 'error');
  }
}

// ============================================================
// UNCLAIMED SOL WARNING
// ============================================================

function showUnclaimedWarning(amount) {
  const modal = document.getElementById('unclaimedWarning');
  const amountEl = document.getElementById('unclaimedAmount');
  if (amountEl) amountEl.textContent = amount.toFixed(4) + ' SOL';
  if (modal) modal.classList.add('visible');
}

function closeUnclaimedWarning() {
  const modal = document.getElementById('unclaimedWarning');
  if (modal) modal.classList.remove('visible');
}

// ============================================================
// SUB-TAB NAVIGATION (within mushrooms page)
// ============================================================

function showSubPage(subName) {
  state.currentSubPage = subName;
  // Toggle orbital active state in top-left corner
  document.querySelectorAll('.orbital').forEach(o => {
    o.classList.toggle('sub-active', o.dataset.sub === subName);
  });
  // Toggle content visibility
  document.querySelectorAll('.sub-content').forEach(c => {
    c.classList.toggle('active', c.dataset.sub === subName);
  });
  // Show active sigil at low opacity (ambient), others hidden
  document.querySelectorAll('.orbital-sigil').forEach(g => {
    g.setAttribute('opacity', g.dataset.sub === subName ? '0.4' : '0');
  });
}

// ============================================================
// NAVIGATION — bottom panel tabs + dots
// ============================================================

const PAGE_IDS = ['page-enlist', 'page-trade', 'page-positions', 'page-rank', 'page-ops', 'page-recon'];
const PAGE_BODY_CLASSES = ['on-enlist', 'on-trade', 'on-positions', 'on-rank', 'on-ops', 'on-recon'];
const PAGE_ACCENT = ['#F2D662', '#9DE5B5', '#9DE5B5', '#F2D662', '#C4CFCB', '#9DE5B5'];

function showPage(idx) {
  state.currentPage = idx;

  // Toggle site-page visibility
  PAGE_IDS.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', i === idx);
  });

  // Toggle body class for corner/tangent-ray repositioning
  PAGE_BODY_CLASSES.forEach((cls, i) => {
    document.body.classList.toggle(cls, i === idx);
  });

  // Sigil navigator: orbits + dots with per-page accent color
  const accent = PAGE_ACCENT[idx];
  document.querySelectorAll('.sigil-orbit').forEach(o => {
    const isActive = parseInt(o.dataset.page) === idx;
    o.classList.toggle('active', isActive);
    if (isActive) {
      o.setAttribute('stroke', accent);
    } else {
      o.setAttribute('stroke', 'var(--faint)');
    }
  });
  document.querySelectorAll('.sigil-dot').forEach(d => {
    const isActive = parseInt(d.dataset.page) === idx;
    d.classList.toggle('active', isActive);
    if (isActive) {
      d.setAttribute('fill', accent);
    } else {
      d.setAttribute('fill', 'var(--faint)');
    }
  });

  // Nav arrows: show dot on boundaries, arrow when navigable
  const leftArrow = document.getElementById('navLeft');
  const rightArrow = document.getElementById('navRight');
  if (leftArrow) {
    if (idx === 0) {
      leftArrow.innerHTML = '<svg width="40" height="56" viewBox="0 0 40 56"><circle cx="20" cy="28" r="3" fill="var(--scaffold)"/></svg>';
      leftArrow.style.cursor = 'default';
    } else {
      leftArrow.innerHTML = '<svg width="40" height="56" viewBox="0 0 40 56"><path d="M 18 28 Q 24 26, 34 18 Q 28 28, 34 38 Q 24 30, 18 28 Z" fill="var(--scaffold)"/></svg>';
      leftArrow.style.cursor = 'pointer';
    }
  }
  if (rightArrow) {
    if (idx === PAGE_IDS.length - 1) {
      rightArrow.innerHTML = '<svg width="40" height="56" viewBox="0 0 40 56"><circle cx="20" cy="28" r="3" fill="var(--scaffold)"/></svg>';
      rightArrow.style.cursor = 'default';
    } else {
      rightArrow.innerHTML = '<svg width="40" height="56" viewBox="0 0 40 56"><path d="M 22 28 Q 16 26, 6 18 Q 12 28, 6 38 Q 16 30, 22 28 Z" fill="var(--scaffold)"/></svg>';
      rightArrow.style.cursor = 'pointer';
    }
  }

  // Highlight active pool orbital on Trade page (now idx 1)
  if (idx === 1) {
    const orbitals = document.querySelectorAll('.orbital');
    orbitals.forEach((o, i) => o.classList.toggle('sub-active', i === state.activePoolOrbital));
    setTimeout(renderBinViz, 50);
  }

  // Positions page
  if (idx === 2) {
    renderPositionsPage();
  }

  // Activate/deactivate orbital sub-nav based on page (Rank = idx 3)
  if (idx === 3) {
    showSubPage(state.currentSubPage);
  } else {
    // Off Rank page: clear all orbital highlights + sigils
    document.querySelectorAll('.orbital').forEach(o => o.classList.remove('sub-active'));
    document.querySelectorAll('.orbital-sigil').forEach(g => g.setAttribute('opacity', '0'));
  }
}

// ============================================================
// TOAST
// ============================================================

function showToast(msg, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
window.showToast = showToast;

// ============================================================
// ENLIST CURVE ESTIMATION — DAMM v2 constant-product virtual reserves
// ============================================================

const CURVE = {
  TOTAL_SUPPLY: 1_000_000_000,
  INIT_PRICE: 0.000001,
  get VIRTUAL_SOL() { return this.TOTAL_SUPPLY * this.INIT_PRICE; }, // 1000
  get K() { return this.TOTAL_SUPPLY * this.VIRTUAL_SOL; },          // 1e12
};

function estimateVaultBuy(solDeposited) {
  const effectiveSOL = Math.min(solDeposited, 420);
  const newVSOL = CURVE.VIRTUAL_SOL + effectiveSOL;
  const newTokens = CURVE.K / newVSOL;
  const bought = CURVE.TOTAL_SUPPLY - newTokens;
  const avgPrice = effectiveSOL / bought;
  const pctSupply = (bought / CURVE.TOTAL_SUPPLY) * 100;
  const priceImpact = ((avgPrice / CURVE.INIT_PRICE) - 1) * 100;
  return { bought, avgPrice, pctSupply, priceImpact };
}

function updateEnlistEstimates(totalDepositSOL, userDepositSOL) {
  const est = estimateVaultBuy(totalDepositSOL || 0);

  const priceEl = document.getElementById('enlistEstPrice');
  const tokensEl = document.getElementById('enlistEstTokens');
  const impactEl = document.getElementById('enlistPriceImpact');

  if (priceEl) priceEl.textContent = est.avgPrice > 0
    ? est.avgPrice.toFixed(10) + ' SOL'
    : CURVE.INIT_PRICE.toFixed(6) + ' SOL';

  if (impactEl) {
    const impact = isFinite(est.priceImpact) ? est.priceImpact : 0;
    impactEl.textContent = '+' + impact.toFixed(1) + '%';
    impactEl.style.color = impact > 20 ? 'var(--sell)' : 'var(--dim)';
  }

  if (tokensEl && userDepositSOL > 0 && totalDepositSOL > 0) {
    const userShare = userDepositSOL / totalDepositSOL;
    const userTokens = Math.floor(est.bought * userShare);
    tokensEl.textContent = userTokens.toLocaleString() + ' $BANANAS';
  } else if (tokensEl) {
    tokensEl.textContent = '—';
  }
}

// Expose so enlist.js bundle can call it after fetching vault stats
window.updateEnlistEstimates = updateEnlistEstimates;

// Static fallback — show init price before vault stats load
updateEnlistEstimates(0, 0);

// ============================================================
// INITIALIZATION
// ============================================================

// ============================================================
// ENLIST WALLET BALANCE (Phase 1 — before bundle loads deposit form)
// ============================================================

async function updateEnlistBalance() {
  if (!state.connected || !state.connection || !state.publicKey) return;
  try {
    const balance = await state.connection.getBalance(state.publicKey);
    const sol = (balance / 1e9).toFixed(4);
    const wrap = document.getElementById('enlistPhase1BalanceWrap');
    const el = document.getElementById('enlistPhase1Balance');
    if (wrap) wrap.style.display = '';
    if (el) el.textContent = sol;
    // Also update Phase 2 element if it exists (covers enlist.js lag)
    const el2 = document.getElementById('enlistWalletBalance');
    if (el2) el2.textContent = sol;
  } catch {}
}

// ============================================================
// ENLIST COUNTDOWN (runs from app.js — no bundle dependency)
// ============================================================

async function initEnlistCountdown() {
  const depositOpensAt = CONFIG.DEPOSIT_OPENS_AT || 0;
  let activationPoint = CONFIG.ACTIVATION_POINT || 0;

  // Read activation point from the Alpha Vault account on-chain
  if (CONFIG.ALPHA_VAULT_ADDRESS) {
    try {
      const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
      const conn = new solanaWeb3.Connection(rpcUrl, 'confirmed');
      const vaultPubkey = new solanaWeb3.PublicKey(CONFIG.ALPHA_VAULT_ADDRESS);

      // The vault stores the pool address at bytes 9-41 (after 8-byte discriminator + 1-byte poolType).
      // We fetch the pool account and read activationPoint from it.
      // But simpler: the DAMM v2 pool stores activationPoint as i64 at a known offset.
      // The pool is in config. Read its activationPoint directly.
      // DAMM v2 pool: activationPoint is i64 at byte offset 472
      const poolPubkey = new solanaWeb3.PublicKey(CONFIG.DAMM_V2_POOL);
      const poolInfo = await conn.getAccountInfo(poolPubkey);
      if (poolInfo && poolInfo.data.length >= 480) {
        const dv = new DataView(poolInfo.data.buffer, poolInfo.data.byteOffset);
        const val = Number(dv.getBigInt64(472, true));
        if (val > 1700000000 && val < 2000000000) {
          activationPoint = val;
          console.log('[enlist] Activation point from on-chain:', val, '=', new Date(val * 1000).toISOString());
        }
      }
    } catch (err) {
      console.warn('[enlist] On-chain activation read failed, using config fallback:', err.message);
    }
  }

  function enlistPhase() {
    const now = Math.floor(Date.now() / 1000);
    if (depositOpensAt <= 0) return 'countdown';
    if (now < depositOpensAt) return 'countdown';
    if (activationPoint > 0 && now < activationPoint) return 'deposit';
    if (activationPoint > 0) return 'claim';
    return 'deposit';
  }

  function showEnlistPhase(phase) {
    const ids = {
      countdown: 'enlistPhaseCountdown',
      deposit: 'enlistPhaseDeposit',
      claim: 'enlistPhaseClaim',
    };
    Object.values(ids).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    const active = document.getElementById(ids[phase]);
    if (active) active.style.display = '';
  }

  function updateEnlistCountdown() {
    const now = Math.floor(Date.now() / 1000);
    const phase = enlistPhase();
    showEnlistPhase(phase);

    let target = 0;
    if (phase === 'countdown') target = depositOpensAt;
    else if (phase === 'deposit') target = activationPoint;
    else return;

    const diff = Math.max(0, target - now);
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    const secs = diff % 60;
    const pad = (n) => String(n).padStart(2, '0');

    if (phase === 'countdown') {
      const el = (id) => document.getElementById(id);
      if (el('countdownDays')) el('countdownDays').textContent = pad(days);
      if (el('countdownHours')) el('countdownHours').textContent = pad(hours);
      if (el('countdownMins')) el('countdownMins').textContent = pad(mins);
      if (el('countdownSecs')) el('countdownSecs').textContent = pad(secs);
    } else if (phase === 'deposit') {
      const el = (id) => document.getElementById(id);
      if (el('activationDays')) el('activationDays').textContent = pad(days);
      if (el('activationHours')) el('activationHours').textContent = pad(hours);
      if (el('activationMins')) el('activationMins').textContent = pad(mins);
      if (el('activationSecs')) el('activationSecs').textContent = pad(secs);
    }
  }

  // Show $BANANAS address
  const addrEl = document.getElementById('enlistBananasAddress');
  if (addrEl && CONFIG.BANANAS_MINT) {
    const mint = CONFIG.BANANAS_MINT;
    const short = mint.slice(0, 6) + '...' + mint.slice(-4);
    addrEl.innerHTML = '<a href="https://solscan.io/token/' + mint + '" target="_blank" rel="noopener" style="color:var(--bananas);text-decoration:none;">' + short + '</a>';
  }

  // Show DAMM v2 pool link
  const poolLinkEl = document.getElementById('enlistPoolLink');
  if (poolLinkEl && CONFIG.DAMM_V2_POOL) {
    const pool = CONFIG.DAMM_V2_POOL;
    const shortPool = pool.slice(0, 6) + '...' + pool.slice(-4);
    poolLinkEl.innerHTML = '<a href="https://app.meteora.ag/pools/' + pool + '" target="_blank" rel="noopener" style="color:var(--mint);text-decoration:none;">' + shortPool + '</a> <span style="color:var(--dim);font-size:8px;">meteora</span>';
  }

  // Run immediately + every second
  updateEnlistCountdown();
  setInterval(updateEnlistCountdown, 1000);
}

async function init() {
  await loadConfig();

  // Start enlist countdown immediately (no bundle needed)
  initEnlistCountdown();

  // Connect to bot relay (LaserStream WebSocket + REST)
  connectRelay();

  // Demo mode banner
  if (CONFIG.CORE_PROGRAM_ID.includes('1111111111')) {
    const banner = document.createElement('div');
    banner.textContent = 'DEMO MODE — no real transactions';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:var(--sell);color:white;text-align:center;padding:4px;z-index:9999;font-size:11px;font-family:inherit;letter-spacing:1px;';
    document.body.prepend(banner);
  }

  // Wallet
  document.getElementById('connectWallet')?.addEventListener('click', toggleWalletMenu);
  document.querySelectorAll('.wallet-option').forEach(opt => {
    opt.addEventListener('click', () => connectWallet(opt.dataset.wallet));
  });

  // Pool
  document.getElementById('loadPool')?.addEventListener('click', loadPool);
  document.getElementById('poolAddress')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') loadPool();
  });

  // Zoom controls
  const ZOOM_STEPS = [10, 20, 40, 80, 120, 200];
  document.getElementById('zoomIn')?.addEventListener('click', () => {
    const curIdx = ZOOM_STEPS.indexOf(vizState.visibleRange);
    const newIdx = Math.max(0, (curIdx >= 0 ? curIdx : 2) - 1);
    vizState.visibleRange = ZOOM_STEPS[newIdx];
    document.getElementById('zoomLevel').textContent = '±' + vizState.visibleRange;
    loadBinVizData();
  });
  document.getElementById('zoomOut')?.addEventListener('click', () => {
    const curIdx = ZOOM_STEPS.indexOf(vizState.visibleRange);
    const newIdx = Math.min(ZOOM_STEPS.length - 1, (curIdx >= 0 ? curIdx : 2) + 1);
    vizState.visibleRange = ZOOM_STEPS[newIdx];
    document.getElementById('zoomLevel').textContent = '±' + vizState.visibleRange;
    loadBinVizData();
  });

  // Side tabs
  document.querySelectorAll('.side-tab').forEach(tab => {
    tab.addEventListener('click', () => { updateSide(tab.dataset.side); updateBinVizPreview(); });
  });

  // Range inputs → update bin strip
  document.getElementById('rangeNear')?.addEventListener('input', () => { updateBinStrip(); updateBinVizPreview(); });
  document.getElementById('rangeFar')?.addEventListener('input', () => { updateBinStrip(); updateBinVizPreview(); });

  // Amount
  document.getElementById('amount')?.addEventListener('input', () => { updateFee(); updateBinVizPreview(); });

  // Action
  document.getElementById('actionBtn')?.addEventListener('click', createPosition);

  // Sigil navigator: orbits + dots are clickable
  document.querySelectorAll('.sigil-orbit').forEach(o => {
    o.addEventListener('click', () => showPage(parseInt(o.dataset.page)));
  });
  document.querySelectorAll('.sigil-dot').forEach(d => {
    d.addEventListener('click', () => showPage(parseInt(d.dataset.page)));
  });

  // Nav arrows
  document.getElementById('navLeft')?.addEventListener('click', () => {
    if (state.currentPage > 0) showPage(state.currentPage - 1);
  });
  document.getElementById('navRight')?.addEventListener('click', () => {
    if (state.currentPage < PAGE_IDS.length - 1) showPage(state.currentPage + 1);
  });

  // Enlist page buttons
  document.getElementById('enlistGoToRank')?.addEventListener('click', () => showPage(3));
  document.getElementById('enlistConnectBtn')?.addEventListener('click', () => {
    document.getElementById('connectWallet')?.click();
  });
  document.getElementById('enlistHelpBtn')?.addEventListener('click', () => {
    document.getElementById('enlistHelpModal')?.classList.add('visible');
  });
  document.getElementById('enlistHelpClose')?.addEventListener('click', () => {
    document.getElementById('enlistHelpModal')?.classList.remove('visible');
  });

  // Arrow hover highlights target orbit
  const sigDots = document.querySelectorAll('.sigil-dot');
  const leftArrow = document.getElementById('navLeft');
  const rightArrow = document.getElementById('navRight');
  if (leftArrow) {
    leftArrow.addEventListener('mouseenter', () => {
      const prev = sigDots[Math.max(0, state.currentPage - 1)];
      if (prev) prev.classList.add('hover');
    });
    leftArrow.addEventListener('mouseleave', () => sigDots.forEach(d => d.classList.remove('hover')));
  }
  if (rightArrow) {
    rightArrow.addEventListener('mouseenter', () => {
      const next = sigDots[Math.min(4, state.currentPage + 1)];
      if (next) next.classList.add('hover');
    });
    rightArrow.addEventListener('mouseleave', () => sigDots.forEach(d => d.classList.remove('hover')));
  }

  // Orbital nav (top-left corner circles) — dual purpose
  const orbitals = document.querySelectorAll('.orbital');
  const orbitalArray = Array.from(orbitals);
  orbitals.forEach((o, i) => {
    o.addEventListener('click', () => {
      if (state.currentPage === 3 && o.dataset.sub) {
        showSubPage(o.dataset.sub);
      }
    });
    // Reactive sigil on hover (Rank page)
    o.addEventListener('mouseenter', () => {
      if (state.currentPage === 3 && o.dataset.sub) {
        document.querySelectorAll('.orbital-sigil').forEach(g => {
          g.setAttribute('opacity', g.dataset.sub === o.dataset.sub ? '1' : '0');
        });
      }
    });
    o.addEventListener('mouseleave', () => {
      if (state.currentPage === 3) {
        document.querySelectorAll('.orbital-sigil').forEach(g => {
          g.setAttribute('opacity', g.dataset.sub === state.currentSubPage ? '0.4' : '0');
        });
      }
    });
  });

  // Rank: feed + claim
  document.getElementById('feedMonkeBtn')?.addEventListener('click', () => {
    if (state.selectedMonkeMint) handleFeedMonke(state.selectedMonkeMint);
    else showToast('Select a monke first', 'error');
  });
  document.getElementById('claimAllBtn')?.addEventListener('click', handleClaimAll);

  // Rank: MonkeBurn lookup
  document.getElementById('monkeBurnSearchBtn')?.addEventListener('click', handleMonkeBurnLookup);
  document.getElementById('monkeBurnLookup')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') handleMonkeBurnLookup();
  });

  // Recon: bribe deposit
  document.getElementById('roverDepositBtn')?.addEventListener('click', handleRoverDeposit);

  // Ops: crank buttons
  document.getElementById('crankSweep')?.addEventListener('click', handleCrankSweep);
  document.getElementById('crankDistribute')?.addEventListener('click', handleCrankDistribute);
  document.getElementById('crankDeposit')?.addEventListener('click', handleCrankDeposit);
  document.getElementById('harvestAllBtn')?.addEventListener('click', handleHarvestAll);

  // PNL modal
  document.getElementById('pnlClose')?.addEventListener('click', closePnlModal);
  document.getElementById('pnlDownload')?.addEventListener('click', downloadPnlCard);
  document.getElementById('pnlCopy')?.addEventListener('click', copyPnlCard);

  // Unclaimed warning modal
  document.getElementById('warningClaimBtn')?.addEventListener('click', () => {
    closeUnclaimedWarning();
    handleClaimAll();
  });
  document.getElementById('warningDismissBtn')?.addEventListener('click', closeUnclaimedWarning);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('visible');
    });
  });

  // Render pages
  renderMonkeList();
  renderRoster();
  renderGlobalStats();
  renderOpsStats();
  renderBountyBoard();
  renderReconPools();
  renderReconTop5();

  if (CONFIG.DEFAULT_POOL) {
    const poolInput = document.getElementById('poolAddress');
    if (poolInput) {
      poolInput.value = CONFIG.DEFAULT_POOL;
      loadPool();
    }
  }

  // Initial render
  requestAnimationFrame(() => {
    showPage(0);
  });

  // Auto-connect if wallet was previously connected
  setTimeout(() => {
    for (const [id, w] of Object.entries(WALLETS)) {
      try {
        if (w.check() && w.get().isConnected) {
          connectWallet(id);
          break;
        }
      } catch (_) {}
    }
  }, 500);
}

// Canvas resize handler
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderBinViz, 100);
});

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
