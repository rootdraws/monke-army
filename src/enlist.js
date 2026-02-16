/**
 * enlist.js — Alpha Vault SDK integration for the Enlist page.
 *
 * Bundled via esbuild (src/enlist.js → dist/enlist.bundle.js).
 * Manages three phases: countdown, deposit, claim.
 *
 * Dependencies: @meteora-ag/alpha-vault, @solana/web3.js (from CDN global)
 */

import AlphaVault from '@meteora-ag/alpha-vault';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

// Read config from the global CONFIG object set by app.js,
// or fall back to fetching config.json directly
async function getConfig() {
  if (window.CONFIG) return window.CONFIG;
  try {
    const resp = await fetch('config.json');
    return await resp.json();
  } catch {
    return {};
  }
}

// ═══ STATE ═══

const enlistState = {
  phase: 'loading',       // 'countdown' | 'deposit' | 'claim' | 'ended'
  connection: null,
  vault: null,            // AlphaVault instance
  vaultAddress: null,
  depositOpensAt: 0,      // Unix timestamp (seconds)
  activationPoint: 0,     // Unix timestamp (seconds)
  userDeposit: 0,         // lamports
  totalDeposit: 0,        // lamports
  maxBuyingCap: 420,      // SOL
  countdownInterval: null,
  statsInterval: null,
};

// ═══ PHASE MANAGEMENT ═══

function showPhase(phase) {
  enlistState.phase = phase;
  const phases = {
    countdown: document.getElementById('enlistPhaseCountdown'),
    deposit: document.getElementById('enlistPhaseDeposit'),
    claim: document.getElementById('enlistPhaseClaim'),
  };
  Object.values(phases).forEach(el => { if (el) el.style.display = 'none'; });
  if (phases[phase]) phases[phase].style.display = '';
}

function detectPhase() {
  const now = Math.floor(Date.now() / 1000);

  if (enlistState.depositOpensAt <= 0) {
    // Timestamps not set yet — show countdown with placeholder
    showPhase('countdown');
    return;
  }

  if (now < enlistState.depositOpensAt) {
    showPhase('countdown');
  } else if (enlistState.activationPoint > 0 && now < enlistState.activationPoint) {
    showPhase('deposit');
  } else if (enlistState.activationPoint > 0) {
    showPhase('claim');
  } else {
    showPhase('deposit');
  }
}

// ═══ COUNTDOWN ═══

function updateCountdown() {
  const now = Math.floor(Date.now() / 1000);
  let target, prefix;

  if (enlistState.phase === 'countdown') {
    target = enlistState.depositOpensAt;
    prefix = '';
  } else if (enlistState.phase === 'deposit') {
    target = enlistState.activationPoint;
    prefix = 'activation';
  } else {
    return;
  }

  const diff = Math.max(0, target - now);
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  const secs = diff % 60;

  const pad = (n) => String(n).padStart(2, '0');

  if (enlistState.phase === 'countdown') {
    const el = (id) => document.getElementById(id);
    if (el('countdownDays')) el('countdownDays').textContent = pad(days);
    if (el('countdownHours')) el('countdownHours').textContent = pad(hours);
    if (el('countdownMins')) el('countdownMins').textContent = pad(mins);
    if (el('countdownSecs')) el('countdownSecs').textContent = pad(secs);
  } else if (enlistState.phase === 'deposit') {
    const el = (id) => document.getElementById(id);
    if (el('activationDays')) el('activationDays').textContent = pad(days);
    if (el('activationHours')) el('activationHours').textContent = pad(hours);
    if (el('activationMins')) el('activationMins').textContent = pad(mins);
    if (el('activationSecs')) el('activationSecs').textContent = pad(secs);
  }

  // Auto-transition when countdown reaches zero
  if (diff === 0) {
    detectPhase();
  }
}

// ═══ VAULT INTERACTION ═══

async function initVault(config) {
  const rpcUrl = config.RPC_URL || 'https://api.mainnet-beta.solana.com';
  enlistState.connection = new Connection(rpcUrl, 'confirmed');

  const vaultAddr = config.ALPHA_VAULT_ADDRESS;
  if (!vaultAddr) {
    console.log('[enlist] No ALPHA_VAULT_ADDRESS configured — running in preview mode');
    return;
  }

  try {
    enlistState.vaultAddress = new PublicKey(vaultAddr);
    enlistState.vault = await AlphaVault.create(enlistState.connection, enlistState.vaultAddress);
    console.log('[enlist] Alpha Vault loaded:', vaultAddr);
  } catch (err) {
    console.warn('[enlist] Failed to load Alpha Vault:', err.message);
  }
}

async function fetchVaultStats() {
  if (!enlistState.vault) return;

  try {
    // Refresh vault state
    const vaultState = enlistState.vault;
    const totalDeposit = vaultState.vault?.totalDeposit?.toNumber?.() || 0;
    enlistState.totalDeposit = totalDeposit;

    const totalSol = (totalDeposit / LAMPORTS_PER_SOL).toFixed(2);
    const el = (id) => document.getElementById(id);
    if (el('enlistTotalDeposited')) el('enlistTotalDeposited').textContent = `${totalSol} SOL`;
    if (el('enlistCapacity')) el('enlistCapacity').textContent = `${totalSol} / ${enlistState.maxBuyingCap} SOL`;

    // User deposit (if wallet connected)
    await fetchUserDeposit();
  } catch (err) {
    console.warn('[enlist] Stats fetch error:', err.message);
  }
}

async function fetchUserDeposit() {
  const wallet = getWallet();
  if (!wallet || !enlistState.vault) return;

  try {
    const escrow = await enlistState.vault.getEscrow(wallet);
    if (escrow) {
      const deposit = escrow.totalDeposit?.toNumber?.() || 0;
      enlistState.userDeposit = deposit;

      const depositSol = (deposit / LAMPORTS_PER_SOL).toFixed(4);
      const el = (id) => document.getElementById(id);
      if (el('enlistYourDeposit')) el('enlistYourDeposit').textContent = `${depositSol} SOL`;
      if (el('enlistClaimDeposit')) el('enlistClaimDeposit').textContent = `${depositSol} SOL`;

      // Pro-rata allocation estimate
      if (enlistState.totalDeposit > 0) {
        const ratio = deposit / enlistState.totalDeposit;
        const pct = (ratio * 100).toFixed(2);
        if (el('enlistAllocation')) el('enlistAllocation').textContent = `${pct}%`;
      }

      // Show withdraw button if user has deposit
      const withdrawBtn = document.getElementById('enlistWithdrawBtn');
      if (withdrawBtn) withdrawBtn.style.display = deposit > 0 ? '' : 'none';
    }
  } catch {
    // No escrow = no deposit yet
  }
}

function getWallet() {
  // Read from app.js global state
  if (window.solana?.publicKey) return window.solana.publicKey;
  if (window.phantom?.solana?.publicKey) return window.phantom.solana.publicKey;
  return null;
}

async function getWalletAdapter() {
  if (window.phantom?.solana) return window.phantom.solana;
  if (window.solana) return window.solana;
  return null;
}

async function updateWalletBalance() {
  const wallet = getWallet();
  if (!wallet || !enlistState.connection) return;

  try {
    const balance = await enlistState.connection.getBalance(wallet);
    const el = document.getElementById('enlistWalletBalance');
    if (el) el.textContent = (balance / LAMPORTS_PER_SOL).toFixed(4);
  } catch {
    // ignore
  }
}

// ═══ DEPOSIT ═══

async function handleDeposit() {
  const input = document.getElementById('enlistAmountInput');
  if (!input) return;

  const amount = parseFloat(input.value);
  if (!amount || amount <= 0) {
    showToast('enter a valid SOL amount');
    return;
  }

  const wallet = await getWalletAdapter();
  if (!wallet) {
    showToast('connect your wallet first');
    return;
  }

  if (!enlistState.vault) {
    showToast('vault not loaded — check config');
    return;
  }

  try {
    const depositTx = await enlistState.vault.deposit(
      wallet.publicKey,
      BigInt(Math.floor(amount * LAMPORTS_PER_SOL))
    );
    const signed = await wallet.signTransaction(depositTx);
    const sig = await enlistState.connection.sendRawTransaction(signed.serialize());
    await enlistState.connection.confirmTransaction(sig, 'confirmed');

    showToast(`deposited ${amount} SOL`);
    input.value = '';
    await fetchVaultStats();
    await updateWalletBalance();
  } catch (err) {
    console.error('[enlist] Deposit error:', err);
    showToast(`deposit failed: ${err.message?.slice(0, 60)}`);
  }
}

// ═══ WITHDRAW / CLAIM ═══

async function handleWithdraw() {
  const wallet = await getWalletAdapter();
  if (!wallet || !enlistState.vault) return;

  try {
    const withdrawTx = await enlistState.vault.withdraw(
      wallet.publicKey,
      BigInt(enlistState.userDeposit)
    );
    const signed = await wallet.signTransaction(withdrawTx);
    const sig = await enlistState.connection.sendRawTransaction(signed.serialize());
    await enlistState.connection.confirmTransaction(sig, 'confirmed');

    showToast('withdrawal complete');
    await fetchVaultStats();
    await updateWalletBalance();
  } catch (err) {
    console.error('[enlist] Withdraw error:', err);
    showToast(`withdraw failed: ${err.message?.slice(0, 60)}`);
  }
}

async function handleClaim() {
  const wallet = await getWalletAdapter();
  if (!wallet || !enlistState.vault) return;

  try {
    const claimTx = await enlistState.vault.withdraw(wallet.publicKey, BigInt(0));
    const signed = await wallet.signTransaction(claimTx);
    const sig = await enlistState.connection.sendRawTransaction(signed.serialize());
    await enlistState.connection.confirmTransaction(sig, 'confirmed');

    showToast('$BANANAS claimed!');
    await fetchVaultStats();
  } catch (err) {
    console.error('[enlist] Claim error:', err);
    showToast(`claim failed: ${err.message?.slice(0, 60)}`);
  }
}

// ═══ TOAST (reuse app.js toast if available) ═══

function showToast(msg) {
  if (window.showToast) {
    window.showToast(msg);
    return;
  }
  console.log('[enlist]', msg);
}

// ═══ MAX BUTTON ═══

async function handleMax() {
  const wallet = getWallet();
  if (!wallet || !enlistState.connection) return;

  try {
    const balance = await enlistState.connection.getBalance(wallet);
    const maxSol = Math.max(0, (balance / LAMPORTS_PER_SOL) - 0.01); // leave 0.01 for rent/fees
    const input = document.getElementById('enlistAmountInput');
    if (input) input.value = maxSol.toFixed(4);
  } catch {
    // ignore
  }
}

// ═══ INIT ═══

async function initEnlist() {
  const config = await getConfig();

  // Read timing from config
  enlistState.depositOpensAt = config.DEPOSIT_OPENS_AT || 0;
  // activationPoint will come from vault state once loaded, or estimate from config
  enlistState.maxBuyingCap = 420;

  // Initialize vault connection
  await initVault(config);

  // Detect initial phase
  detectPhase();

  // Start countdown
  enlistState.countdownInterval = setInterval(() => {
    updateCountdown();
  }, 1000);

  // Start stats polling (every 30s)
  enlistState.statsInterval = setInterval(() => {
    if (enlistState.phase === 'deposit' || enlistState.phase === 'claim') {
      fetchVaultStats();
      updateWalletBalance();
    }
  }, 30000);

  // Wire up buttons
  document.getElementById('enlistDepositBtn')?.addEventListener('click', handleDeposit);
  document.getElementById('enlistWithdrawBtn')?.addEventListener('click', handleWithdraw);
  document.getElementById('enlistClaimBtn')?.addEventListener('click', handleClaim);
  document.getElementById('enlistMaxBtn')?.addEventListener('click', handleMax);

  // Initial data fetch
  if (enlistState.vault) {
    await fetchVaultStats();
  }
  await updateWalletBalance();

  // Listen for wallet connection changes
  if (window.phantom?.solana) {
    window.phantom.solana.on('connect', () => {
      fetchVaultStats();
      updateWalletBalance();
    });
  }

  console.log('[enlist] initialized — phase:', enlistState.phase);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEnlist);
} else {
  initEnlist();
}
