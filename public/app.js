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

// ============================================================
// CONFIG — matches .env.example
// ============================================================

const CONFIG = {
  RPC_URL: 'https://api.mainnet-beta.solana.com',
  FEE_BPS: 30,
  CORE_PROGRAM_ID: 'BINFARM1111111111111111111111111111111111111',
  MONKE_BANANAS_PROGRAM_ID: 'TBD',
  BANANAS_MINT: '',
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

// Read fee_bps from on-chain Config (falls back to config.json value if RPC fails)
async function loadOnChainFeeBps() {
  try {
    if (!state.connection) return;
    const [configPDA] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('config')],
      new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
    );
    const accountInfo = await state.connection.getAccountInfo(configPDA);
    if (accountInfo && accountInfo.data.length >= 8 + 32 + 32 + 32 + 32 + 2 + 2) {
      const feeBps = accountInfo.data.readUInt16LE(136);
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
    [new TextEncoder().encode('position'), meteoraPosition.toBuffer()],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

function getVaultPDA(meteoraPosition) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('vault'), meteoraPosition.toBuffer()],
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
    [new TextEncoder().encode('monke_burn'), nftMint.toBuffer()],
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
  tokenXSymbol: 'SOL',
  tokenYSymbol: 'TOKEN',

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
  if (tok) tok.textContent = newSide === 'buy' ? state.tokenXSymbol : state.tokenYSymbol;

  // Update range suffix text and default values
  const suffix = newSide === 'buy' ? '% below' : '% above';
  const suffixEl = document.getElementById('rangeSuffix');
  const suffixFarEl = document.getElementById('rangeSuffixFar');
  if (suffixEl) suffixEl.textContent = suffix;
  if (suffixFarEl) suffixFarEl.textContent = suffix;

  const nearInput = document.getElementById('rangeNear');
  const farInput = document.getElementById('rangeFar');
  if (nearInput) nearInput.value = newSide === 'buy' ? '5' : '10';
  if (farInput) farInput.value = newSide === 'buy' ? '50' : '200';

  updateFee();
}

function updateFee() {
  const el = document.getElementById('feeAmount');
  if (el) el.textContent = `${CONFIG.FEE_BPS / 100}% on output`;
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
    state.connection = new solanaWeb3.Connection(CONFIG.RPC_URL, 'confirmed');

    await loadOnChainFeeBps();

    const short = pubkey.toString().slice(0, 4) + '...' + pubkey.toString().slice(-4);
    if (btn) {
      btn.textContent = short;
      btn.classList.add('connected');
    }

    showToast(`Connected via ${w.name}`, 'success');
    updatePositionsList();
    renderMonkeList();
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

  const btn = document.getElementById('connectWallet');
  if (btn) {
    btn.textContent = 'connect wallet';
    btn.classList.remove('connected');
  }
  showToast('Disconnected');
  updatePositionsList();
  renderMonkeList();
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

// Known pools and featured pools removed — live data from bot relay

async function loadPool() {
  const addr = document.getElementById('poolAddress')?.value.trim();
  if (!addr) { showToast('Enter a pool address', 'error'); return; }

  const btn = document.getElementById('loadPool');
  if (btn) { btn.textContent = 'loading...'; btn.disabled = true; }

  try {
    // Validate as real Solana address
    try { new solanaWeb3.PublicKey(addr); }
    catch { throw new Error('Invalid address'); }

    // Try bot relay first (LaserStream-backed, sub-second data)
    const relayData = await relayFetch(`/api/pools/${addr}`);
    if (relayData && relayData.activeId !== undefined) {
      state.poolAddress = addr;
      state.activeBin = relayData.activeId;
      state.binStep = relayData.binStep;
      state.currentPrice = binToPrice(relayData.activeId, relayData.binStep);
      state.tokenXSymbol = 'X'; // TODO: resolve token symbols from mint addresses
      state.tokenYSymbol = 'Y';
    } else {
      // Fallback: direct RPC via Meteora DLMM SDK (requires npm bundle)
      // For now, show a message
      if (!state.connection) {
        throw new Error('Connect wallet to load pools');
      }
      throw new Error('Pool not found on bot relay. Live DLMM SDK loading coming soon.');
    }

    document.getElementById('poolName').textContent = `${state.tokenXSymbol}/${state.tokenYSymbol}`;
    document.getElementById('currentPrice').textContent = '$' + formatPrice(state.currentPrice);
    document.getElementById('poolInfo').classList.add('visible');

    updateSide(state.side);
    showToast('Pool loaded', 'success');
  } catch (err) {
    console.error('Failed to load pool:', err);
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.textContent = 'load'; btn.disabled = false; }
  }
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

    const { fee, net } = calculateAmounts(amount * 1e9);
    const numBins = maxBin - minBin + 1;

    if (CONFIG.DEBUG) {
      console.log(`[monke] Create ${state.side} position`);
      console.log(`  Amount: ${amount} ${state.side === 'buy' ? state.tokenXSymbol : state.tokenYSymbol}`);
      console.log(`  Bins: ${minBin} -> ${maxBin} (${numBins} bins)`);
    }

    /*
     * PRODUCTION PATH (once programs deployed):
     *
     * const positionKeypair = solanaWeb3.Keypair.generate();
     * const slippage = state.binStep >= 80 ? 15 : 5;
     * const tx = await buildOpenPositionTx(
     *   state.connection, state.publicKey,
     *   new solanaWeb3.PublicKey(state.poolAddress),
     *   positionKeypair,
     *   new BN(net), minBin, maxBin,
     *   state.side, slippage, tokenMint, meteoraAccounts
     * );
     * const signed = await state.wallet.signTransaction(tx);
     * const sig = await state.connection.sendRawTransaction(signed.serialize());
     * await state.connection.confirmTransaction(sig, 'confirmed');
     */

    // DEMO MODE — simulated position (remove once programs deployed and production path above is enabled)
    await new Promise(r => setTimeout(r, 1200));

    state.positions.push({
      pool: `${state.tokenXSymbol}/${state.tokenYSymbol}`,
      side: state.side,
      minPrice: binToPrice(minBin, state.binStep),
      maxPrice: binToPrice(maxBin, state.binStep),
      filled: Math.floor(Math.random() * 20),
      amount: net / 1e9,
      lpFees: Math.random() * 0.05,
    });

    showToast('Position created!', 'success');
    updatePositionsList();
  } catch (err) {
    console.error('Position creation failed:', err);
    showToast('Failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.textContent = original; btn.disabled = false; }
  }
}

// ============================================================
// POSITIONS LIST
// ============================================================

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
      <span>${escapeHtml(p.filled)}%</span>
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
  showToast('Closing position...', 'info');

  /*
   * PRODUCTION:
   * const tx = await buildUserCloseTx(connection, user, positionPDA, positionData, meteoraAccounts);
   * const signed = await state.wallet.signTransaction(tx);
   * await state.connection.sendRawTransaction(signed.serialize());
   */

  // DEMO MODE — simulated close (remove once programs deployed and production path above is enabled)
  await new Promise(r => setTimeout(r, 800));
  state.positions.splice(index, 1);
  showToast('Position closed', 'success');
  updatePositionsList();
}

// ============================================================
// RANK PAGE — Monke + Roster (stub — wired to live data in later phase)
// ============================================================

function renderMonkeList() {
  const container = document.getElementById('monkeList');
  if (!container) return;

  if (!state.connected) {
    container.innerHTML = '<div class="empty-state">connect wallet to view your monkes</div>';
    return;
  }

  container.innerHTML = '<div class="empty-state">no SMB Gen2/Gen3 NFTs found — feed a monke to start earning</div>';
}

function renderRoster() {
  const container = document.getElementById('rosterList');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">loading roster...</div>';
}

function handleMonkeBurnLookup() {
  const mint = document.getElementById('monkeBurnLookup')?.value.trim();
  const container = document.getElementById('monkeBurnResult');
  if (!container) return;
  if (!mint) { container.innerHTML = ''; return; }
  container.innerHTML = '<div class="empty-state">MonkeBurn lookup requires deployed programs</div>';
}

// ============================================================
// RANK ACTIONS — stubs for feed_monke + claim (need deployed programs + IDL)
// ============================================================

async function handleFeedMonke(nftMint) {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  showToast('Feed monke requires deployed programs', 'info');
}

async function handleClaimMonke(nftMint) {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  showToast('Claim requires deployed programs', 'info');
}

async function handleClaimAll() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  showToast('Claim all requires deployed programs', 'info');
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

function renderOpsStats() {
  const el = id => document.getElementById(id);
  if (el('opsBotStatus')) el('opsBotStatus').textContent = 'offline';
}

function renderBountyBoard() {
  const container = document.getElementById('bountyBoard');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">no pending harvests — data loads from bot relay</div>';
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
  showToast('sweep_rover requires deployed programs', 'info');
}

async function handleCrankDistribute() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  showToast('distribute requires deployed programs', 'info');
}

async function handleCrankDeposit() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  showToast('deposit_sol requires deployed programs', 'info');
}

async function handleCrankCompost() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  showToast('compost_monke requires deployed programs', 'info');
}

async function handleHarvestAll() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  showToast('Bulk harvest requires deployed programs', 'info');
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

const PAGE_IDS = ['page-enlist', 'page-trade', 'page-rank', 'page-ops', 'page-recon'];
const PAGE_BODY_CLASSES = ['on-enlist', 'on-trade', 'on-rank', 'on-ops', 'on-recon'];
const PAGE_ACCENT = ['#F2D662', '#9DE5B5', '#F2D662', '#C4CFCB', '#9DE5B5'];

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

  // Highlight active pool orbital on Trade page (now idx 1)
  if (idx === 1) {
    const orbitals = document.querySelectorAll('.orbital');
    orbitals.forEach((o, i) => o.classList.toggle('sub-active', i === state.activePoolOrbital));
  }

  // Activate/deactivate orbital sub-nav based on page (Rank = idx 2)
  if (idx === 2) {
    // On Rank page: show active orbital (monke/roster)
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
// INITIALIZATION
// ============================================================

async function init() {
  await loadConfig();

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

  // Side tabs
  document.querySelectorAll('.side-tab').forEach(tab => {
    tab.addEventListener('click', () => updateSide(tab.dataset.side));
  });

  // Amount
  document.getElementById('amount')?.addEventListener('input', updateFee);

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
    if (state.currentPage < 4) showPage(state.currentPage + 1);
  });

  // Enlist page buttons
  document.getElementById('enlistGoToRank')?.addEventListener('click', () => showPage(2));
  document.getElementById('enlistConnectBtn')?.addEventListener('click', () => {
    document.getElementById('connectWallet')?.click();
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
      if (state.currentPage === 2 && o.dataset.sub) {
        showSubPage(o.dataset.sub);
      }
    });
    // Reactive sigil on hover (Rank page)
    o.addEventListener('mouseenter', () => {
      if (state.currentPage === 2 && o.dataset.sub) {
        document.querySelectorAll('.orbital-sigil').forEach(g => {
          g.setAttribute('opacity', g.dataset.sub === o.dataset.sub ? '1' : '0');
        });
      }
    });
    o.addEventListener('mouseleave', () => {
      if (state.currentPage === 2) {
        document.querySelectorAll('.orbital-sigil').forEach(g => {
          g.setAttribute('opacity', g.dataset.sub === state.currentSubPage ? '0.4' : '0');
        });
      }
    });
  });

  // Rank: claim all
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
  document.getElementById('crankCompost')?.addEventListener('click', handleCrankCompost);
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
  renderOpsStats();
  renderBountyBoard();
  renderReconPools();
  renderReconTop5();

  // Set default pool address (if configured) but don't auto-load
  if (CONFIG.DEFAULT_POOL) {
    const poolInput = document.getElementById('poolAddress');
    if (poolInput) poolInput.value = CONFIG.DEFAULT_POOL;
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

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
