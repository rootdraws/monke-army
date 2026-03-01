/**
 * enlist.js — Alpha Vault SDK integration for the Enlist page.
 *
 * Bundled via esbuild (src/enlist.js → public/enlist.bundle.js).
 * Manages three phases: countdown, deposit, claim.
 *
 * Dependencies: @meteora-ag/alpha-vault, @solana/web3.js, @coral-xyz/anchor (BN)
 */

import AlphaVault, { deriveEscrow, getOrCreateATAInstruction, unwrapSOLInstruction } from '@meteora-ag/alpha-vault';
import { Connection, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';

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
  const rpcUrl = config.HELIUS_RPC_URL || config.RPC_URL || 'https://api.mainnet-beta.solana.com';
  enlistState.connection = new Connection(rpcUrl, 'confirmed');

  const vaultAddr = config.ALPHA_VAULT_ADDRESS;
  if (!vaultAddr) {
    console.log('[enlist] No ALPHA_VAULT_ADDRESS configured — running in preview mode');
    return;
  }

  try {
    enlistState.vaultAddress = new PublicKey(vaultAddr);
    enlistState.vault = await AlphaVault.create(enlistState.connection, enlistState.vaultAddress);

    // Read activation point from vault (BN → seconds)
    if (enlistState.vault.activationPoint) {
      enlistState.activationPoint = enlistState.vault.activationPoint.toNumber();
    }

    // Read max buying cap from vault state
    if (enlistState.vault.vault?.maxBuyingCap) {
      enlistState.maxBuyingCap = enlistState.vault.vault.maxBuyingCap.toNumber() / LAMPORTS_PER_SOL;
    }

    // Store bananas mint from config for Phase 3
    enlistState.bananasMint = config.BANANAS_MINT || '';

    console.log('[enlist] Alpha Vault loaded:', vaultAddr);
    console.log('[enlist] activationPoint:', enlistState.activationPoint, 'maxBuyingCap:', enlistState.maxBuyingCap, 'SOL');
  } catch (err) {
    console.warn('[enlist] Failed to load Alpha Vault:', err.message);
  }
}

async function fetchVaultStats() {
  if (!enlistState.vault) return;

  try {
    // Refresh vault state from chain
    await enlistState.vault.refreshState();

    const totalDeposit = enlistState.vault.vault?.totalDeposit?.toNumber?.() || 0;
    enlistState.totalDeposit = totalDeposit;

    const totalSol = (totalDeposit / LAMPORTS_PER_SOL).toFixed(2);
    const el = (id) => document.getElementById(id);
    if (el('enlistTotalDeposited')) el('enlistTotalDeposited').textContent = `${totalSol} SOL`;
    if (el('enlistCapacity')) el('enlistCapacity').textContent = `${totalSol} / ${enlistState.maxBuyingCap} SOL`;

    // Re-check phase after refresh (vault state may have changed)
    detectPhase();

    // Update curve estimates
    const totalSolNum = totalDeposit / LAMPORTS_PER_SOL;
    if (window.updateEnlistEstimates) {
      window.updateEnlistEstimates(totalSolNum, enlistState.userDeposit / LAMPORTS_PER_SOL);
    }

    // User deposit + claim info (if wallet connected)
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

      // Phase 2: show withdraw button if user has deposit
      const withdrawBtn = document.getElementById('enlistWithdrawBtn');
      if (withdrawBtn) withdrawBtn.style.display = deposit > 0 ? '' : 'none';

      // Phase 3: show refund button if deposits exceeded cap
      const refundBtn = document.getElementById('enlistRefundBtn');
      if (refundBtn && enlistState.totalDeposit > enlistState.maxBuyingCap * LAMPORTS_PER_SOL) {
        refundBtn.style.display = '';
      }

      // Refresh curve estimates with updated user deposit
      if (window.updateEnlistEstimates && enlistState.totalDeposit > 0) {
        window.updateEnlistEstimates(
          enlistState.totalDeposit / LAMPORTS_PER_SOL,
          deposit / LAMPORTS_PER_SOL
        );
      }

      // If vault was never filled, update claim button to say "withdraw SOL"
      const swapped = enlistState.vault.vault.swappedAmount?.toNumber() || 0;
      if (swapped === 0 && deposit > 0) {
        const claimBtn = document.getElementById('enlistClaimBtn');
        if (claimBtn) claimBtn.textContent = `withdraw ${depositSol} SOL`;
      }

      // Phase 3: claim info (how many $BANANAS the user is allocated)
      const claimInfo = enlistState.vault.getClaimInfo(escrow);
      if (claimInfo && claimInfo.totalAllocated) {
        const allocated = claimInfo.totalAllocated.toNumber?.() || 0;
        const claimed = claimInfo.totalClaimed.toNumber?.() || 0;
        const claimable = claimInfo.totalClaimable.toNumber?.() || 0;
        // $BANANAS has 6 decimals
        const allocatedDisplay = (allocated / 1e6).toLocaleString();
        const claimableDisplay = (claimable / 1e6).toLocaleString();
        if (el('enlistBananasBalance')) {
          el('enlistBananasBalance').textContent = claimed > 0
            ? `${claimableDisplay} claimable`
            : allocatedDisplay;
        }
      }
    }
  } catch {
    // No escrow = no deposit yet
  }
}

async function fetchBananasBalance() {
  const wallet = getWallet();
  if (!wallet || !enlistState.connection || !enlistState.bananasMint) return;

  try {
    const mint = new PublicKey(enlistState.bananasMint);
    const ata = PublicKey.findProgramAddressSync(
      [wallet.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), mint.toBuffer()],
      new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    )[0];
    const balance = await enlistState.connection.getTokenAccountBalance(ata);
    if (balance?.value?.uiAmount !== null) {
      const el = document.getElementById('enlistBananasBalance');
      if (el) el.textContent = Number(balance.value.uiAmount).toLocaleString();
    }
  } catch {
    // No ATA = no balance yet
  }
}

function getWallet() {
  // Read from app.js state bridge (supports Phantom, Solflare, Backpack)
  if (window.__monkeWallet?.publicKey) return window.__monkeWallet.publicKey;
  // Fallback to direct provider checks
  if (window.phantom?.solana?.publicKey) return window.phantom.solana.publicKey;
  if (window.solana?.publicKey) return window.solana.publicKey;
  if (window.solflare?.publicKey) return window.solflare.publicKey;
  if (window.backpack?.publicKey) return window.backpack.publicKey;
  return null;
}

function getWalletAdapter() {
  // Read from app.js state bridge
  if (window.__monkeWallet?.adapter) return window.__monkeWallet.adapter;
  // Fallback to direct provider checks
  if (window.phantom?.solana?.isConnected) return window.phantom.solana;
  if (window.solana?.isConnected) return window.solana;
  if (window.solflare?.isConnected) return window.solflare;
  if (window.backpack?.isConnected) return window.backpack;
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
    showToast('enter a valid SOL amount', 'error');
    return;
  }

  const wallet = getWalletAdapter();
  if (!wallet) {
    showToast('connect your wallet first', 'error');
    return;
  }

  if (!enlistState.vault) {
    showToast('vault not loaded — check config', 'error');
    return;
  }

  const btn = document.getElementById('enlistDepositBtn');
  const originalText = btn?.textContent;
  if (btn) { btn.textContent = 'depositing...'; btn.disabled = true; }

  try {
    const lamports = new BN(Math.floor(amount * LAMPORTS_PER_SOL));
    const depositTx = await enlistState.vault.deposit(lamports, wallet.publicKey);
    const signed = await wallet.signTransaction(depositTx);
    const sig = await enlistState.connection.sendRawTransaction(signed.serialize());
    await enlistState.connection.confirmTransaction(sig, 'confirmed');

    showToast(`deposited ${amount} SOL — solscan.io/tx/${sig}`, 'success');
    input.value = '';
    await fetchVaultStats();
    await updateWalletBalance();
  } catch (err) {
    console.error('[enlist] Deposit error:', err);
    showToast(`deposit failed: ${err.message?.slice(0, 80)}`, 'error');
  } finally {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
  }
}

// ═══ WITHDRAW / CLAIM ═══

async function handleWithdraw() {
  const wallet = getWalletAdapter();
  if (!wallet || !enlistState.vault) return;

  const btn = document.getElementById('enlistWithdrawBtn');
  const originalText = btn?.textContent;
  if (btn) { btn.textContent = 'reading escrow...'; btn.disabled = true; }

  try {
    const escrowAccount = await enlistState.vault.getEscrow(wallet.publicKey);
    const onChainDeposit = escrowAccount?.totalDeposit?.toNumber?.() || 0;
    if (onChainDeposit <= 0) {
      showToast('nothing to withdraw', 'error');
      return;
    }

    if (btn) btn.textContent = 'withdrawing...';
    const amount = new BN(onChainDeposit);
    const av = enlistState.vault;
    const owner = wallet.publicKey;

    // Build withdraw TX manually — the SDK's withdraw() has a bug that wraps
    // the withdrawal amount FROM the user's wallet before the vault transfers.
    // We skip the wrap and only include the unwrap (vault → WSOL ATA → SOL).
    const [escrow] = deriveEscrow(av.pubkey, owner, av.program.programId);
    const { ataPubKey: destinationToken, ix: createDestinationTokenIx } =
      await getOrCreateATAInstruction(
        av.program.provider.connection,
        av.vault.quoteMint, owner, owner,
        av.quoteMintInfo.tokenProgram
      );

    const preInstructions = [];
    if (createDestinationTokenIx) preInstructions.push(createDestinationTokenIx);

    const postInstructions = [];
    if (av.vault.quoteMint.equals(NATIVE_MINT)) {
      postInstructions.push(unwrapSOLInstruction(owner));
    }

    const withdrawIx = await av.program.methods.withdraw(amount).accountsPartial({
      vault: av.pubkey,
      destinationToken,
      escrow,
      owner,
      pool: av.vault.pool,
      tokenVault: av.vault.tokenVault,
      tokenMint: av.vault.quoteMint,
      tokenProgram: av.quoteMintInfo.tokenProgram,
    }).preInstructions(preInstructions).postInstructions(postInstructions).transaction();

    const { blockhash, lastValidBlockHeight } =
      await enlistState.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: owner }).add(withdrawIx);

    const signed = await wallet.signTransaction(tx);
    const sig = await enlistState.connection.sendRawTransaction(signed.serialize());
    await enlistState.connection.confirmTransaction(sig, 'confirmed');

    showToast(`withdrawal complete — solscan.io/tx/${sig}`, 'success');
    await fetchVaultStats();
    await updateWalletBalance();
  } catch (err) {
    console.error('[enlist] Withdraw error:', err);
    showToast(`withdraw failed: ${err.message?.slice(0, 80)}`, 'error');
  } finally {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
  }
}

async function fillVaultDammV2(wallet) {
  const av = enlistState.vault;
  const vault = av.vault;

  const inAmountCap = vault.vaultMode === 0
    ? BN.min(vault.totalDeposit, vault.maxBuyingCap)
    : vault.totalDeposit;

  if (vault.swappedAmount.gte(inAmountCap)) return; // already filled

  const cpAmm = new CpAmm(enlistState.connection);
  const poolState = await cpAmm.fetchPoolState(vault.pool);
  const { tokenAVault, tokenBVault, tokenAMint, tokenBMint, tokenAFlag, tokenBFlag } = poolState;

  const tokenAProgram = tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  const tokenBProgram = tokenBFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  const poolAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('pool_authority')], CP_AMM_PROGRAM_ID
  )[0];

  const dammEventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')], CP_AMM_PROGRAM_ID
  )[0];

  const alphaVaultProgramId = av.program.programId;
  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')], alphaVaultProgramId
  )[0];

  const preInstructions = [];
  const { ataPubKey: tokenOutVault, ix: createTokenOutVaultIx } =
    await getOrCreateATAInstruction(
      enlistState.connection,
      vault.baseMint,
      av.pubkey,
      wallet.publicKey,
      av.baseMintInfo.tokenProgram,
    );
  if (createTokenOutVaultIx) preInstructions.push(createTokenOutVaultIx);

  const ALPHA_VAULT_TREASURY = new PublicKey('BJQbRiRWhJCyTYZcAuAL3ngDCx3AyFQGKDq8zhiZAKUw');
  const [crankFeeWhitelistPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('crank_fee_whitelist'), wallet.publicKey.toBuffer()],
    alphaVaultProgramId,
  );
  const crankFeeWhitelistInfo = await enlistState.connection.getAccountInfo(crankFeeWhitelistPda);

  const fillTx = await av.program.methods
    .fillDammV2(inAmountCap)
    .accountsPartial({
      vault: av.pubkey,
      tokenVault: vault.tokenVault,
      tokenOutVault,
      ammProgram: CP_AMM_PROGRAM_ID,
      poolAuthority,
      pool: vault.pool,
      tokenAVault,
      tokenBVault,
      tokenAMint,
      tokenBMint,
      tokenAProgram,
      tokenBProgram,
      dammEventAuthority,
      crankFeeWhitelist: crankFeeWhitelistInfo ? crankFeeWhitelistPda : alphaVaultProgramId,
      crankFeeReceiver: crankFeeWhitelistInfo ? alphaVaultProgramId : ALPHA_VAULT_TREASURY,
      cranker: wallet.publicKey,
      systemProgram: SystemProgram.programId,
      eventAuthority,
      program: alphaVaultProgramId,
    })
    .preInstructions(preInstructions)
    .transaction();

  const { blockhash, lastValidBlockHeight } =
    await enlistState.connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey })
    .add(fillTx);

  const signed = await wallet.signTransaction(tx);
  const sig = await enlistState.connection.sendRawTransaction(signed.serialize());
  await enlistState.connection.confirmTransaction(sig, 'confirmed');
  console.log('[enlist] Vault filled:', sig);
  showToast('vault filled — now claiming tokens...', 'success');

  await av.refreshState();
}

async function handleClaim() {
  const wallet = getWalletAdapter();
  if (!wallet || !enlistState.vault) return;

  const btn = document.getElementById('enlistClaimBtn');
  const originalText = btn?.textContent;
  if (btn) { btn.textContent = 'claiming...'; btn.disabled = true; }

  try {
    const vault = enlistState.vault.vault;
    const swapped = vault.swappedAmount?.toNumber() || 0;
    const deposited = vault.totalDeposit?.toNumber() || 0;

    // Vault never filled — withdraw SOL directly via withdrawRemainingQuote
    if (swapped === 0 && deposited > 0) {
      if (btn) btn.textContent = 'withdrawing SOL...';
      const refundTx = await enlistState.vault.withdrawRemainingQuote(wallet.publicKey);
      const signed = await wallet.signTransaction(refundTx);
      const sig = await enlistState.connection.sendRawTransaction(signed.serialize());
      await enlistState.connection.confirmTransaction(sig, 'confirmed');

      showToast(`${(deposited / LAMPORTS_PER_SOL).toFixed(4)} SOL withdrawn — solscan.io/tx/${sig}`, 'success');
      await fetchVaultStats();
      await updateWalletBalance();
      return;
    }

    // DAMM v2 vaults: SDK fillVault is unimplemented — fill manually first
    if (vault.poolType === 2) {
      const inAmountCap = vault.vaultMode === 0
        ? BN.min(vault.totalDeposit, vault.maxBuyingCap)
        : vault.totalDeposit;

      if (vault.swappedAmount.lt(inAmountCap)) {
        if (btn) btn.textContent = 'filling vault...';
        await fillVaultDammV2(wallet);
      }
    }

    if (btn) btn.textContent = 'claiming...';
    const claimTx = await enlistState.vault.claimToken(wallet.publicKey);
    const signed = await wallet.signTransaction(claimTx);
    const sig = await enlistState.connection.sendRawTransaction(signed.serialize());
    await enlistState.connection.confirmTransaction(sig, 'confirmed');

    showToast(`$BANANAS claimed! — solscan.io/tx/${sig}`, 'success');
    await fetchVaultStats();
    await fetchBananasBalance();
  } catch (err) {
    console.error('[enlist] Claim error:', err);
    const msg = err.message || '';
    if (msg.includes('NotPermitThisActionInThisTimePoint')) {
      showToast('claim not available yet — trading hasn\'t activated', 'error');
    } else {
      showToast(`claim failed: ${msg.slice(0, 80)}`, 'error');
    }
  } finally {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
  }
}

// ═══ REFUND (excess SOL when deposits > cap) ═══

async function handleRefund() {
  const wallet = getWalletAdapter();
  if (!wallet || !enlistState.vault) return;

  const btn = document.getElementById('enlistRefundBtn');
  const originalText = btn?.textContent;
  if (btn) { btn.textContent = 'withdrawing...'; btn.disabled = true; }

  try {
    const refundTx = await enlistState.vault.withdrawRemainingQuote(wallet.publicKey);
    const signed = await wallet.signTransaction(refundTx);
    const sig = await enlistState.connection.sendRawTransaction(signed.serialize());
    await enlistState.connection.confirmTransaction(sig, 'confirmed');

    showToast(`excess SOL withdrawn — solscan.io/tx/${sig}`, 'success');
    await fetchVaultStats();
    await updateWalletBalance();
  } catch (err) {
    console.error('[enlist] Refund error:', err);
    showToast(`refund failed: ${err.message?.slice(0, 80)}`, 'error');
  } finally {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
  }
}

// ═══ TOAST (reuse app.js toast if available) ═══

function showToast(msg, type) {
  if (window.showToast) {
    window.showToast(msg, type);
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

// ═══ $BANANAS ADDRESS DISPLAY ═══

function displayBananasAddress() {
  const el = document.getElementById('enlistBananasAddress');
  if (!el || !enlistState.bananasMint) return;

  const mint = enlistState.bananasMint;
  const short = mint.slice(0, 6) + '...' + mint.slice(-4);
  el.innerHTML = `<a href="https://solscan.io/token/${mint}" target="_blank" rel="noopener" style="color:var(--bananas);text-decoration:none;">${short}</a>`;
  el.title = mint;
  el.style.cursor = 'pointer';
  el.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') return;
    navigator.clipboard.writeText(mint).then(() => showToast('address copied', 'info'));
  });
}

// ═══ WALLET CHANGE LISTENER ═══

function onWalletChanged() {
  fetchVaultStats();
  updateWalletBalance();
  if (enlistState.phase === 'claim') fetchBananasBalance();
}

// ═══ INIT ═══

async function initEnlist() {
  // Wire up buttons FIRST — before any async work that could fail/hang
  document.getElementById('enlistDepositBtn')?.addEventListener('click', handleDeposit);
  document.getElementById('enlistWithdrawBtn')?.addEventListener('click', handleWithdraw);
  document.getElementById('enlistClaimBtn')?.addEventListener('click', handleClaim);
  document.getElementById('enlistRefundBtn')?.addEventListener('click', handleRefund);
  document.getElementById('enlistMaxBtn')?.addEventListener('click', handleMax);

  // Listen for wallet connection changes from all providers
  const providers = [
    window.phantom?.solana,
    window.solana,
    window.solflare,
    window.backpack,
  ].filter(Boolean);
  const seen = new Set();
  for (const provider of providers) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    try { provider.on('connect', onWalletChanged); } catch {}
    try { provider.on('disconnect', onWalletChanged); } catch {}
  }
  window.addEventListener('monke:walletChanged', onWalletChanged);

  // Now do async init — if this fails, buttons still work (show toast errors)
  try {
    const config = await getConfig();
    enlistState.depositOpensAt = config.DEPOSIT_OPENS_AT || 0;

    await initVault(config);
    detectPhase();
    displayBananasAddress();

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

    // Initial data fetch
    if (enlistState.vault) {
      await fetchVaultStats();
    }
    await updateWalletBalance();
  } catch (err) {
    console.error('[enlist] Init failed:', err);
    showToast('vault initialization failed — check console', 'error');
  }

  console.log('[enlist] initialized — phase:', enlistState.phase);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEnlist);
} else {
  initEnlist();
}
