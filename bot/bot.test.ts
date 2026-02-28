/**
 * bot.test.ts
 *
 * Unit tests for pure bot logic — no RPC, no gRPC, no chain dependency.
 *
 * Covers:
 *   - parseLbPairData byte parsing
 *   - getSafeWithdrawBins (subscriber-style: range + side + activeId)
 *   - getSafeWithdrawBins (executor-style: balance-aware)
 *   - Job queue deduplication
 *   - Bin contiguity expansion
 *
 * Run: npx vitest run bot/bot.test.ts
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { parseLbPairData, LbPairInfo } from './geyser-subscriber';

// ═══ HELPERS ═══

/**
 * Subscriber-style safe bin detection (pure range arithmetic).
 * Mirrors GeyserSubscriber.getSafeWithdrawBins (private method).
 */
function subscriberSafeBins(
  side: 'Buy' | 'Sell',
  minBinId: number,
  maxBinId: number,
  activeId: number,
): number[] {
  const safeBins: number[] = [];
  for (let binId = minBinId; binId <= maxBinId; binId++) {
    if (side === 'Sell' && binId < activeId) safeBins.push(binId);
    else if (side === 'Buy' && binId > activeId) safeBins.push(binId);
  }
  return safeBins;
}

/**
 * Executor-style safe bin detection (balance-aware).
 * Mirrors HarvestExecutor.getSafeWithdrawBins (public method).
 */
function executorSafeBins(
  side: 'Buy' | 'Sell',
  activeId: number,
  positionBinData: { binId: number; positionXAmount: string; positionYAmount: string }[],
): number[] {
  const safeBins: number[] = [];
  for (const bin of positionBinData) {
    if (side === 'Sell') {
      if (bin.binId < activeId && BigInt(bin.positionYAmount) > 0n) safeBins.push(bin.binId);
    } else {
      if (bin.binId > activeId && BigInt(bin.positionXAmount) > 0n) safeBins.push(bin.binId);
    }
  }
  return safeBins.sort((a, b) => a - b);
}

/**
 * Bin contiguity expansion — fills gaps so on-chain validation passes.
 * Mirrors the executor's inline logic in executeJob.
 */
function expandContiguous(binIds: number[]): number[] {
  if (binIds.length === 0) return [];
  const sorted = [...binIds].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const expectedLen = max - min + 1;
  if (expectedLen === sorted.length) return sorted;
  const expanded: number[] = [];
  for (let b = min; b <= max; b++) expanded.push(b);
  return expanded;
}

/** Build a minimal 904-byte LbPair buffer with controlled field values */
function buildLbPairBuffer(opts: {
  activeId: number;
  binStep: number;
  status?: number;
  tokenXMint?: PublicKey;
  tokenYMint?: PublicKey;
  reserveX?: PublicKey;
  reserveY?: PublicKey;
  tokenXProgramFlag?: number;
  tokenYProgramFlag?: number;
}): Buffer {
  const buf = Buffer.alloc(904, 0);
  // Offsets from geyser-subscriber.ts (verified from Meteora DLMM IDL)
  buf.writeInt32LE(opts.activeId, 76);       // OFFSET_ACTIVE_ID
  buf.writeUInt16LE(opts.binStep, 80);       // OFFSET_BIN_STEP
  buf.writeUInt8(opts.status ?? 0, 82);      // OFFSET_STATUS

  const xMint = opts.tokenXMint ?? PublicKey.default;
  const yMint = opts.tokenYMint ?? PublicKey.default;
  xMint.toBuffer().copy(buf, 88);            // OFFSET_TOKEN_X_MINT
  yMint.toBuffer().copy(buf, 120);           // OFFSET_TOKEN_Y_MINT

  (opts.reserveX ?? PublicKey.default).toBuffer().copy(buf, 152); // OFFSET_RESERVE_X
  (opts.reserveY ?? PublicKey.default).toBuffer().copy(buf, 184); // OFFSET_RESERVE_Y

  buf.writeUInt8(opts.tokenXProgramFlag ?? 0, 880);  // OFFSET_TOKEN_X_PROG_FLAG
  buf.writeUInt8(opts.tokenYProgramFlag ?? 0, 881);  // OFFSET_TOKEN_Y_PROG_FLAG

  return buf;
}

// ═══ parseLbPairData ═══

describe('parseLbPairData', () => {
  it('parses activeId and binStep from valid buffer', () => {
    const buf = buildLbPairBuffer({ activeId: 12345, binStep: 100 });
    const info = parseLbPairData(buf);
    expect(info.activeId).toBe(12345);
    expect(info.binStep).toBe(100);
  });

  it('parses negative activeId (signed i32)', () => {
    const buf = buildLbPairBuffer({ activeId: -500, binStep: 20 });
    const info = parseLbPairData(buf);
    expect(info.activeId).toBe(-500);
  });

  it('parses token mints correctly', () => {
    const xMint = new PublicKey('So11111111111111111111111111111111111111112');
    const yMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const buf = buildLbPairBuffer({ activeId: 0, binStep: 50, tokenXMint: xMint, tokenYMint: yMint });
    const info = parseLbPairData(buf);
    expect(info.tokenXMint.toBase58()).toBe(xMint.toBase58());
    expect(info.tokenYMint.toBase58()).toBe(yMint.toBase58());
  });

  it('parses token program flags (SPL=0, Token2022=1)', () => {
    const buf = buildLbPairBuffer({ activeId: 0, binStep: 10, tokenXProgramFlag: 1, tokenYProgramFlag: 0 });
    const info = parseLbPairData(buf);
    expect(info.tokenXProgramFlag).toBe(1);
    expect(info.tokenYProgramFlag).toBe(0);
  });

  it('throws on short buffer', () => {
    const buf = Buffer.alloc(100);
    expect(() => parseLbPairData(buf)).toThrow('too short');
  });

  it('throws on invalid binStep = 0', () => {
    const buf = buildLbPairBuffer({ activeId: 100, binStep: 0 });
    // binStep 0 written, but the code forces 0 → still 0 in buffer
    expect(() => parseLbPairData(buf)).toThrow('invalid');
  });

  it('throws on binStep > 500', () => {
    const buf = buildLbPairBuffer({ activeId: 100, binStep: 501 });
    expect(() => parseLbPairData(buf)).toThrow('invalid');
  });

  it('accepts binStep at boundary (1 and 500)', () => {
    expect(parseLbPairData(buildLbPairBuffer({ activeId: 0, binStep: 1 })).binStep).toBe(1);
    expect(parseLbPairData(buildLbPairBuffer({ activeId: 0, binStep: 500 })).binStep).toBe(500);
  });
});

// ═══ Subscriber-style getSafeWithdrawBins ═══

describe('subscriberSafeBins (range-based)', () => {
  it('SELL: returns bins below activeId', () => {
    expect(subscriberSafeBins('Sell', 100, 110, 105)).toEqual([100, 101, 102, 103, 104]);
  });

  it('BUY: returns bins above activeId', () => {
    expect(subscriberSafeBins('Buy', 100, 110, 105)).toEqual([106, 107, 108, 109, 110]);
  });

  it('SELL: no bins when activeId at or below range', () => {
    expect(subscriberSafeBins('Sell', 100, 110, 100)).toEqual([]);
    expect(subscriberSafeBins('Sell', 100, 110, 99)).toEqual([]);
  });

  it('BUY: no bins when activeId at or above range', () => {
    expect(subscriberSafeBins('Buy', 100, 110, 110)).toEqual([]);
    expect(subscriberSafeBins('Buy', 100, 110, 111)).toEqual([]);
  });

  it('SELL: all bins when activeId above range', () => {
    expect(subscriberSafeBins('Sell', 100, 104, 200)).toEqual([100, 101, 102, 103, 104]);
  });

  it('BUY: all bins when activeId below range', () => {
    expect(subscriberSafeBins('Buy', 100, 104, 50)).toEqual([100, 101, 102, 103, 104]);
  });

  it('single-bin position — SELL hit', () => {
    expect(subscriberSafeBins('Sell', 100, 100, 101)).toEqual([100]);
  });

  it('single-bin position — SELL miss', () => {
    expect(subscriberSafeBins('Sell', 100, 100, 100)).toEqual([]);
  });

  it('activeId == binId is never safe (strict inequality)', () => {
    expect(subscriberSafeBins('Sell', 100, 100, 100)).toEqual([]);
    expect(subscriberSafeBins('Buy', 100, 100, 100)).toEqual([]);
  });

  it('handles negative bin IDs', () => {
    expect(subscriberSafeBins('Buy', -10, -5, -8)).toEqual([-7, -6, -5]);
    expect(subscriberSafeBins('Sell', -10, -5, -7)).toEqual([-10, -9, -8]);
  });

  it('wide range (70 bins max)', () => {
    const result = subscriberSafeBins('Sell', 0, 69, 70);
    expect(result.length).toBe(70);
  });
});

// ═══ Executor-style getSafeWithdrawBins (balance-aware) ═══

describe('executorSafeBins (balance-aware)', () => {
  const makeBins = (ids: number[], xAmt: string, yAmt: string) =>
    ids.map(binId => ({ binId, positionXAmount: xAmt, positionYAmount: yAmt }));

  it('SELL: only bins with Y balance count', () => {
    const bins = [
      { binId: 100, positionXAmount: '0', positionYAmount: '1000' },
      { binId: 101, positionXAmount: '0', positionYAmount: '0' },     // empty
      { binId: 102, positionXAmount: '0', positionYAmount: '500' },
    ];
    expect(executorSafeBins('Sell', 105, bins)).toEqual([100, 102]);
  });

  it('BUY: only bins with X balance count', () => {
    const bins = [
      { binId: 100, positionXAmount: '1000', positionYAmount: '0' },
      { binId: 101, positionXAmount: '0', positionYAmount: '0' },
      { binId: 102, positionXAmount: '200', positionYAmount: '0' },
    ];
    // bin 101 has 0 X balance, so it's excluded even though binId > activeId
    expect(executorSafeBins('Buy', 98, bins)).toEqual([100, 102]);
  });

  it('SELL: ignores bins at or above activeId even with balance', () => {
    const bins = [
      { binId: 100, positionXAmount: '0', positionYAmount: '1000' },
      { binId: 105, positionXAmount: '0', positionYAmount: '1000' }, // at activeId
      { binId: 110, positionXAmount: '0', positionYAmount: '1000' }, // above activeId
    ];
    expect(executorSafeBins('Sell', 105, bins)).toEqual([100]);
  });

  it('BUY: ignores bins at or below activeId even with balance', () => {
    const bins = [
      { binId: 95, positionXAmount: '1000', positionYAmount: '0' },
      { binId: 100, positionXAmount: '1000', positionYAmount: '0' },
      { binId: 105, positionXAmount: '1000', positionYAmount: '0' },
    ];
    expect(executorSafeBins('Buy', 100, bins)).toEqual([105]);
  });

  it('returns empty when no balances', () => {
    const bins = makeBins([100, 101, 102], '0', '0');
    expect(executorSafeBins('Sell', 105, bins)).toEqual([]);
  });

  it('returns sorted output regardless of input order', () => {
    const bins = [
      { binId: 103, positionXAmount: '0', positionYAmount: '100' },
      { binId: 100, positionXAmount: '0', positionYAmount: '100' },
      { binId: 101, positionXAmount: '0', positionYAmount: '100' },
    ];
    expect(executorSafeBins('Sell', 105, bins)).toEqual([100, 101, 103]);
  });
});

// ═══ Bin contiguity expansion ═══

describe('expandContiguous', () => {
  it('no-op for already contiguous bins', () => {
    expect(expandContiguous([5, 6, 7, 8])).toEqual([5, 6, 7, 8]);
  });

  it('fills gap in non-contiguous bins', () => {
    expect(expandContiguous([5, 8])).toEqual([5, 6, 7, 8]);
  });

  it('fills multiple gaps', () => {
    expect(expandContiguous([10, 13, 16])).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });

  it('handles single bin', () => {
    expect(expandContiguous([42])).toEqual([42]);
  });

  it('handles empty array', () => {
    expect(expandContiguous([])).toEqual([]);
  });

  it('handles unsorted input', () => {
    expect(expandContiguous([8, 5])).toEqual([5, 6, 7, 8]);
  });

  it('handles negative bin IDs', () => {
    expect(expandContiguous([-3, 0])).toEqual([-3, -2, -1, 0]);
  });
});

// ═══ Job queue deduplication ═══

describe('job queue deduplication', () => {
  /**
   * Minimal in-memory job queue that mirrors HarvestExecutor's dedup logic.
   * We don't instantiate the real executor (needs RPC) — we test the logic.
   */
  class MockJobQueue {
    inflight = new Set<string>();
    jobQueue: { positionPDA: string }[] = [];

    enqueue(positionPDA: string): boolean {
      if (this.inflight.has(positionPDA)) return false;
      if (this.jobQueue.some(j => j.positionPDA === positionPDA)) return false;
      this.jobQueue.push({ positionPDA });
      return true;
    }

    startJob(positionPDA: string) {
      this.inflight.add(positionPDA);
      this.jobQueue = this.jobQueue.filter(j => j.positionPDA !== positionPDA);
    }

    finishJob(positionPDA: string) {
      this.inflight.delete(positionPDA);
    }
  }

  it('allows first enqueue', () => {
    const q = new MockJobQueue();
    expect(q.enqueue('pos_A')).toBe(true);
    expect(q.jobQueue.length).toBe(1);
  });

  it('rejects duplicate in queue', () => {
    const q = new MockJobQueue();
    q.enqueue('pos_A');
    expect(q.enqueue('pos_A')).toBe(false);
    expect(q.jobQueue.length).toBe(1);
  });

  it('rejects duplicate that is inflight', () => {
    const q = new MockJobQueue();
    q.enqueue('pos_A');
    q.startJob('pos_A');
    expect(q.enqueue('pos_A')).toBe(false);
  });

  it('allows re-enqueue after job completes', () => {
    const q = new MockJobQueue();
    q.enqueue('pos_A');
    q.startJob('pos_A');
    q.finishJob('pos_A');
    expect(q.enqueue('pos_A')).toBe(true);
  });

  it('different positions enqueue independently', () => {
    const q = new MockJobQueue();
    expect(q.enqueue('pos_A')).toBe(true);
    expect(q.enqueue('pos_B')).toBe(true);
    expect(q.enqueue('pos_C')).toBe(true);
    expect(q.jobQueue.length).toBe(3);
  });

  it('inflight does not block other positions', () => {
    const q = new MockJobQueue();
    q.enqueue('pos_A');
    q.startJob('pos_A');
    expect(q.enqueue('pos_B')).toBe(true);
    expect(q.enqueue('pos_A')).toBe(false);
  });
});
