import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const conn = new Connection('https://mainnet.helius-rpc.com/?api-key=3ed2a463-fd75-4c6b-921c-6b0d67f43aa1', 'confirmed');

const vaultAddress = new PublicKey('3Xv442KEA3kkAAaRbPH9YPt3XCsJ8EjjZisGjvgksXd5');
const tokenVault = new PublicKey('AbC5nniE5vnuBCMLY1hPHgETMXsGVqiUv9hxDL7PizY4');
const tokenOutVault = new PublicKey('5V4XNofpempuyVvv8qMpGMTeY6CwD7dwvXBuZBZf1a7S');

// Check vault account SOL balance (rent)
const vaultBal = await conn.getBalance(vaultAddress);
console.log('Vault account SOL (rent):', vaultBal / LAMPORTS_PER_SOL, 'SOL');

// Check tokenVault (WSOL — where deposits go)
const tvInfo = await conn.getParsedAccountInfo(tokenVault);
const tvToken = tvInfo.value?.data?.parsed?.info;
console.log('\ntokenVault (WSOL deposits):');
console.log('  Owner:', tvToken?.owner);
console.log('  Mint:', tvToken?.mint);
console.log('  Balance:', tvToken?.tokenAmount?.uiAmountString, 'SOL');
console.log('  Raw:', tvToken?.tokenAmount?.amount, 'lamports');

// Check tokenOutVault (where bought tokens go after swap)
const toInfo = await conn.getParsedAccountInfo(tokenOutVault);
const toToken = toInfo.value?.data?.parsed?.info;
console.log('\ntokenOutVault (BANANAS out):');
if (toToken) {
  console.log('  Owner:', toToken?.owner);
  console.log('  Mint:', toToken?.mint);
  console.log('  Balance:', toToken?.tokenAmount?.uiAmountString);
} else {
  console.log('  Account not found or not initialized');
}

// Check escrows — find all escrow accounts for this vault
// The escrow PDA is derived from [vault, owner]
// Let's check the vault's total state via SDK
const AlphaVault = (await import('@meteora-ag/alpha-vault')).default;
const vault = await AlphaVault.create(conn, vaultAddress);
const v = vault.vault;

console.log('\n--- Vault state ---');
console.log('totalDeposit:', v.totalDeposit?.toString(), '=', Number(v.totalDeposit) / LAMPORTS_PER_SOL, 'SOL');
console.log('totalEscrow:', v.totalEscrow?.toString());
console.log('swappedAmount:', v.swappedAmount?.toString());
console.log('boughtToken:', v.boughtToken?.toString());
console.log('totalRefund:', v.totalRefund?.toString());

// Check if deposits are still open (compare depositingPoint to now)
const now = Math.floor(Date.now() / 1000);
const depositingPoint = Number(v.depositingPoint);
const activationPoint = Number(v.startVestingPoint);
console.log('\nTiming:');
console.log('  depositingPoint:', depositingPoint, '=', new Date(depositingPoint * 1000).toISOString());
console.log('  activationPoint:', activationPoint, '=', new Date(activationPoint * 1000).toISOString());
console.log('  now:', now, '=', new Date(now * 1000).toISOString());
console.log('  deposit phase open?', now >= depositingPoint && now < activationPoint);
console.log('  deposit phase ended?', now >= activationPoint);
