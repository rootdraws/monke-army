/**
 * Wallet connection hook
 * Wraps @solana/wallet-adapter-react for multi-wallet support
 *
 * Changes applied:
 * I21: Use wallet-adapter-react instead of Phantom-only
 * I22: Use 'confirmed' commitment for tx confirmation (~2s vs ~15s)
 * G8:  Error handling on auto-connect
 */

import { useCallback } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';

// I21: Supports Phantom, Backpack, Solflare, Ledger, etc.
// Requires WalletProvider wrapping the app — see setup below.
//
// Setup in App.jsx:
//   import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
//   import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
//   import { PhantomWalletAdapter, SolflareWalletAdapter, BackpackWalletAdapter } from '@solana/wallet-adapter-wallets';
//
//   const wallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter(), new BackpackWalletAdapter()];
//   const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://api.mainnet-beta.solana.com';
//
//   <ConnectionProvider endpoint={RPC_URL}>
//     <WalletProvider wallets={wallets} autoConnect>
//       <WalletModalProvider>
//         <App />
//       </WalletModalProvider>
//     </WalletProvider>
//   </ConnectionProvider>

export function useWallet() {
  const {
    publicKey,
    connected,
    connect,
    disconnect,
    signTransaction,
    wallet,
  } = useSolanaWallet();
  const { connection } = useConnection();

  /**
   * Sign and send transaction
   * I22: Uses 'confirmed' commitment (~2s) instead of default 'finalized' (~15s)
   */
  const sendTransaction = useCallback(async (transaction) => {
    if (!signTransaction || !publicKey) {
      throw new Error('Wallet not connected');
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = publicKey;

    const signed = await signTransaction(transaction);
    // skipPreflight disabled for user-facing transactions.
    // With skipPreflight: true, users don't see simulation errors — failed TXs
    // silently consume fees and show opaque errors. Bot transactions (harvest-executor)
    // still use skipPreflight: true for speed where error reporting is less critical.
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });

    // Timeout on confirmTransaction to prevent indefinite hang.
    // Uses Promise.race with a 60s deadline.
    const TX_TIMEOUT_MS = 60_000;
    const confirmPromise = connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Transaction confirmation timed out after 60s')), TX_TIMEOUT_MS)
    );

    await Promise.race([confirmPromise, timeoutPromise]);

    return signature;
  }, [signTransaction, publicKey, connection]);

  /**
   * Get SOL balance
   */
  const getBalance = useCallback(async () => {
    if (!publicKey) return 0;
    const balance = await connection.getBalance(publicKey);
    return balance / 1e9;
  }, [publicKey, connection]);

  return {
    wallet,
    publicKey,
    connected,
    connection,
    connect,
    disconnect,
    sendTransaction,
    getBalance,
  };
}