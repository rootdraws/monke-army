import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import AV from '@meteora-ag/alpha-vault';
const AlphaVault = AV.default;

const conn = new Connection('https://mainnet.helius-rpc.com/?api-key=3ed2a463-fd75-4c6b-921c-6b0d67f43aa1', 'confirmed');
const vaultAddress = new PublicKey('3Xv442KEA3kkAAaRbPH9YPt3XCsJ8EjjZisGjvgksXd5');

const vault = await AlphaVault.create(conn, vaultAddress);

// List all available methods on the vault object
console.log('=== Alpha Vault SDK methods ===');
const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(vault))
  .filter(n => typeof vault[n] === 'function' && n !== 'constructor');
console.log(methods.join('\n'));

// Check vault state
const v = vault.vault;
console.log('\n=== Vault state ===');
console.log('totalDeposit:', v.totalDeposit?.toString(), '=', Number(v.totalDeposit) / LAMPORTS_PER_SOL, 'SOL');
console.log('maxBuyingCap:', v.maxBuyingCap?.toString(), '=', Number(v.maxBuyingCap) / LAMPORTS_PER_SOL, 'SOL');
console.log('vaultMode:', v.vaultMode);
console.log('poolType:', v.poolType);

// Check timing
const now = Math.floor(Date.now() / 1000);
const depositingPoint = Number(v.depositingPoint);
const activationPoint = Number(v.startVestingPoint);
console.log('\n=== Timing ===');
console.log('depositingPoint:', new Date(depositingPoint * 1000).toISOString());
console.log('activationPoint:', new Date(activationPoint * 1000).toISOString());
console.log('now:', new Date(now * 1000).toISOString());
console.log('deposits open?', now >= depositingPoint);
console.log('before activation?', now < activationPoint);
console.log('withdrawal should work?', now >= depositingPoint && now < activationPoint);

// Try to find the escrow for a known depositor
// The vault has 1 escrow — let's find it via getProgramAccounts
const ALPHA_VAULT_PROGRAM = vault.program?.programId || new PublicKey('vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2');
console.log('\n=== Searching for escrow accounts ===');
console.log('Program:', ALPHA_VAULT_PROGRAM.toString());

const accounts = await conn.getProgramAccounts(ALPHA_VAULT_PROGRAM, {
  filters: [
    { memcmp: { offset: 8, bytes: vaultAddress.toBase58() } },
    { dataSize: 192 }, // typical escrow size, may vary
  ],
});

if (accounts.length === 0) {
  // Try different sizes
  for (const size of [128, 160, 176, 192, 200, 208, 224, 256]) {
    const accs = await conn.getProgramAccounts(ALPHA_VAULT_PROGRAM, {
      filters: [
        { memcmp: { offset: 8, bytes: vaultAddress.toBase58() } },
        { dataSize: size },
      ],
    });
    if (accs.length > 0) {
      console.log(`Found ${accs.length} escrow(s) at dataSize ${size}`);
      for (const a of accs) {
        console.log('  Pubkey:', a.pubkey.toString());
        console.log('  Data length:', a.account.data.length);
        const dv = new DataView(a.account.data.buffer, a.account.data.byteOffset);
        // Try reading the owner pubkey (usually after discriminator + vault pubkey = offset 40)
        const ownerPk = new PublicKey(a.account.data.slice(40, 72));
        console.log('  Owner (depositor):', ownerPk.toString());
        // Try reading deposit amount
        for (const off of [72, 80, 88, 96]) {
          try {
            const val = dv.getBigUint64(off, true);
            if (val > 0n && val < 10000000000000n) {
              console.log(`  Offset ${off}: ${val.toString()} (${Number(val) / LAMPORTS_PER_SOL} SOL)`);
            }
          } catch {}
        }
      }
      break;
    }
  }
} else {
  console.log(`Found ${accounts.length} escrow(s)`);
  for (const a of accounts) {
    console.log('  Pubkey:', a.pubkey.toString());
  }
}
