/**
 * Meteora DLMM SDK wrapper for monke.army
 * Single-sided bin positions with auto-close capability
 *
 * This module wraps @meteora-ag/dlmm for direct SDK access.
 * Frontend MUST use transaction.js (which goes through core.rs) for all
 * user-facing operations. This module is for:
 *   - Read-only position queries (getPositions, getActiveBin, getBins)
 *   - Fill percentage calculation (getFillPercent)
 *   - Bot-internal position data inspection
 * Do NOT use this for creating, harvesting, or closing positions from the
 * frontend — those must go through core.rs via transaction.js to apply
 * the performance fee and maintain vault PDA custody.
 *
 * Changes applied:
 * I16: getFillPercent uses BN math to avoid precision loss on large token amounts
 * H-18: getFillPercent clamped to 1.0
 * H-15: Debug logging gated behind process.env.DEBUG
 * H-20: This documentation block
 */

import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import BN from 'bn.js';

export { StrategyType };

export class MonkeArmy {
  constructor(connection, poolAddress) {
    this.connection = connection;
    this.poolAddress = new PublicKey(poolAddress);
    this.dlmm = null;
    this.tokenX = null; // Usually SOL (base token)
    this.tokenY = null; // The quote token
    this.lbPair = null;
  }

  /**
   * Initialize - fetch pool data from chain
   */
  async init() {
    this.dlmm = await DLMM.create(this.connection, this.poolAddress);
    this.tokenX = this.dlmm.tokenX;
    this.tokenY = this.dlmm.tokenY;
    this.lbPair = this.dlmm.lbPair;
    
    // Gate debug logging behind env flag
    if (process.env.DEBUG === 'true') {
      console.log('monke.army initialized for pool:', this.poolAddress.toString());
      console.log('Token X (base):', this.tokenX.publicKey.toString());
      console.log('Token Y (quote):', this.tokenY.publicKey.toString());
      console.log('Bin step:', this.lbPair.binStep);
    }
    
    return this;
  }

  /**
   * Refresh pool state from chain
   */
  async refresh() {
    await this.dlmm.refetchStates();
    this.lbPair = this.dlmm.lbPair;
  }

  /**
   * Get current price and active bin
   * @returns {{ binId: number, price: string, pricePerToken: string }}
   */
  async getActiveBin() {
    const activeBin = await this.dlmm.getActiveBin();
    return {
      binId: activeBin.binId,
      price: activeBin.price,
      pricePerToken: activeBin.pricePerToken
    };
  }

  /**
   * Convert price to bin ID
   * @param {number} price - Price in human readable format
   * @param {boolean} roundDown - Round down if true, up if false
   * @returns {number} Bin ID
   */
  getBinIdFromPrice(price, roundDown = true) {
    return this.dlmm.getBinIdFromPrice(price, roundDown);
  }

  /**
   * Convert bin ID to price
   * @param {number} binId 
   * @returns {string} Price as string
   */
  getPriceFromBinId(binId) {
    return this.dlmm.getPriceOfBinByBinId(binId);
  }

  /**
   * Get price display from lamport price
   * @param {number} pricePerLamport 
   * @returns {string}
   */
  fromPricePerLamport(pricePerLamport) {
    return this.dlmm.fromPricePerLamport(pricePerLamport);
  }

  /**
   * Create buy bins (single-sided SOL/base position below current price)
   * When price drops to your bins, arbs will sell token to you for SOL
   * 
   * @param {PublicKey} userPubkey - User's wallet
   * @param {BN|number} solAmount - Amount of SOL in lamports
   * @param {number} minBinId - Lowest bin (furthest from current price)
   * @param {number} maxBinId - Highest bin (closest to current price)
   * @returns {{ positionKeypair: Keypair, transaction: Transaction }}
   */
  async createBuyPosition(userPubkey, solAmount, minBinId, maxBinId) {
    const activeBin = await this.getActiveBin();
    
    // Validate bins are below current price
    if (maxBinId >= activeBin.binId) {
      throw new Error(`Buy bins must be below current price. maxBinId=${maxBinId}, activeBin=${activeBin.binId}`);
    }

    const positionKeypair = Keypair.generate();
    const totalXAmount = new BN(solAmount);
    const totalYAmount = new BN(0); // Single-sided, no token

    const transaction = await this.dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: userPubkey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId,
        maxBinId,
        strategyType: StrategyType.Spot
      }
    });

    return {
      positionKeypair,
      transaction,
      side: 'buy',
      initialAmount: totalXAmount,
      minBinId,
      maxBinId
    };
  }

  /**
   * Create sell bins (single-sided token/quote position above current price)
   * When price rises to your bins, arbs will buy token from you with SOL
   * 
   * @param {PublicKey} userPubkey - User's wallet
   * @param {BN|number} tokenAmount - Amount of token in smallest units
   * @param {number} minBinId - Lowest bin (closest to current price)
   * @param {number} maxBinId - Highest bin (furthest from current price)
   * @returns {{ positionKeypair: Keypair, transaction: Transaction }}
   */
  async createSellPosition(userPubkey, tokenAmount, minBinId, maxBinId) {
    const activeBin = await this.getActiveBin();
    
    // Validate bins are above current price
    if (minBinId <= activeBin.binId) {
      throw new Error(`Sell bins must be above current price. minBinId=${minBinId}, activeBin=${activeBin.binId}`);
    }

    const positionKeypair = Keypair.generate();
    const totalXAmount = new BN(0); // Single-sided, no SOL
    const totalYAmount = new BN(tokenAmount);

    const transaction = await this.dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: userPubkey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId,
        maxBinId,
        strategyType: StrategyType.Spot
      }
    });

    return {
      positionKeypair,
      transaction,
      side: 'sell',
      initialAmount: totalYAmount,
      minBinId,
      maxBinId
    };
  }

  /**
   * Get user's positions for this pool
   * @param {PublicKey} userPubkey 
   * @returns {Promise<{ activeBin: object, userPositions: LbPosition[] }>}
   */
  async getPositions(userPubkey) {
    return await this.dlmm.getPositionsByUserAndLbPair(userPubkey);
  }

  /**
   * Get detailed position data including balances and fees
   * @param {LbPosition} position 
   * @returns {PositionData}
   */
  getPositionData(position) {
    return position.positionData;
  }

  /**
   * I16: Calculate fill percentage using BN math to avoid precision loss.
   * BN.toNumber() loses precision for values > 2^53 (common with memecoin amounts).
   * Instead, compute fillBps = (initial - current) * 10000 / initial in BN space,
   * then convert the small bps result to a float.
   * 
   * Buy position: Started with SOL (X), filled when converted to token (Y)
   * Sell position: Started with token (Y), filled when converted to SOL (X)
   * 
   * @param {LbPosition} position 
   * @param {'buy'|'sell'} side 
   * @param {BN} initialAmount - The amount deposited initially
   * @returns {number} Fill percentage 0-1
   */
  getFillPercent(position, side, initialAmount) {
    const data = position.positionData;
    const BPS = new BN(10000);

    if (initialAmount.isZero()) return 0;

    if (side === 'buy') {
      const currentSol = new BN(data.totalXAmount);
      const converted = initialAmount.sub(currentSol);
      if (converted.isNeg()) return 0;
      const fillBps = converted.mul(BPS).div(initialAmount);
      // Clamp to 1.0 — LP fees can push balance above initial
      return Math.min(fillBps.toNumber() / 10000, 1.0);
    } else {
      const currentToken = new BN(data.totalYAmount);
      const converted = initialAmount.sub(currentToken);
      if (converted.isNeg()) return 0;
      const fillBps = converted.mul(BPS).div(initialAmount);
      // Clamp to 1.0
      return Math.min(fillBps.toNumber() / 10000, 1.0);
    }
  }

  /**
   * Check if position is filled beyond threshold
   * @param {LbPosition} position 
   * @param {'buy'|'sell'} side 
   * @param {BN} initialAmount 
   * @param {number} threshold - Fill threshold (default 0.95 = 95%)
   * @returns {boolean}
   */
  isFilled(position, side, initialAmount, threshold = 0.95) {
    const fillPercent = this.getFillPercent(position, side, initialAmount);
    return fillPercent >= threshold;
  }

  /**
   * Get unclaimed swap fees for a position
   * @param {LbPosition} position 
   * @returns {{ feeX: BN, feeY: BN }}
   */
  getUnclaimedFees(position) {
    const data = position.positionData;
    return {
      feeX: data.feeX,
      feeY: data.feeY
    };
  }

  /**
   * Claim swap fees from a position
   * @param {PublicKey} owner 
   * @param {LbPosition[]} positions 
   * @returns {Promise<Transaction[]>}
   */
  async claimFees(owner, positions) {
    return await this.dlmm.claimAllSwapFee({
      owner,
      positions
    });
  }

  /**
   * Close position - remove all liquidity, claim fees, and close
   * This is the key function for preventing "backwash"
   * 
   * @param {PublicKey} userPubkey 
   * @param {LbPosition} position 
   * @returns {Promise<Transaction|Transaction[]>}
   */
  async closePosition(userPubkey, position) {
    const data = position.positionData;
    const binIds = data.positionBinData.map(bin => bin.binId);
    
    if (binIds.length === 0) {
      // Position is empty, just close it
      return await this.dlmm.closePosition({
        owner: userPubkey,
        position: position.publicKey
      });
    }

    // Remove all liquidity + claim fees + close position
    const removeTx = await this.dlmm.removeLiquidity({
      position: position.publicKey,
      user: userPubkey,
      fromBinId: binIds[0],
      toBinId: binIds[binIds.length - 1],
      bps: new BN(100 * 100), // 100% in basis points
      shouldClaimAndClose: true
    });

    return removeTx;
  }

  /**
   * Remove partial liquidity from a position
   * @param {PublicKey} userPubkey 
   * @param {LbPosition} position 
   * @param {number} bpsToRemove - Basis points to remove (10000 = 100%)
   * @returns {Promise<Transaction|Transaction[]>}
   */
  async removeLiquidity(userPubkey, position, bpsToRemove) {
    const data = position.positionData;
    const binIds = data.positionBinData.map(bin => bin.binId);

    return await this.dlmm.removeLiquidity({
      position: position.publicKey,
      user: userPubkey,
      fromBinId: binIds[0],
      toBinId: binIds[binIds.length - 1],
      bps: new BN(bpsToRemove),
      shouldClaimAndClose: false
    });
  }

  /**
   * Get bins around the active bin for display
   * @param {number} count - Number of bins on each side
   * @returns {Promise<{ activeBin: number, bins: BinLiquidity[] }>}
   */
  async getBinsAroundActive(count = 20) {
    return await this.dlmm.getBinsAroundActiveBin(count, count);
  }

  /**
   * Get bins between two prices
   * @param {number} minPrice 
   * @param {number} maxPrice 
   * @returns {Promise<{ activeBin: number, bins: BinLiquidity[] }>}
   */
  async getBinsBetweenPrices(minPrice, maxPrice) {
    return await this.dlmm.getBinsBetweenMinAndMaxPrice(minPrice, maxPrice);
  }
}

/**
 * Create a MonkeArmy instance for a pool
 * @param {Connection} connection 
 * @param {string|PublicKey} poolAddress 
 * @returns {Promise<MonkeArmy>}
 */
export async function createMonkeArmy(connection, poolAddress) {
  const farm = new MonkeArmy(connection, poolAddress);
  await farm.init();
  return farm;
}

/**
 * Fetch all DLMM pools (useful for pool selector)
 * @param {Connection} connection 
 * @returns {Promise<LbPairAccount[]>}
 */
export async function getAllPools(connection) {
  return await DLMM.getLbPairs(connection);
}