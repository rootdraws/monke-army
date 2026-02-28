/**
 * relay-server.ts
 *
 * WebSocket + REST relay for monke.army frontend.
 * Exposes the bot's LaserStream-powered in-memory state to the browser.
 *
 * Plugs into the existing HTTP health server (anchor-harvest-bot.ts).
 * No new ports — extends the same :8080 server with:
 *   - WebSocket upgrade at /ws
 *   - REST endpoints at /api/*
 *
 * All data is read-only from the bot's perspective — the relay never
 * modifies subscriber, executor, or keeper state.
 */

import { IncomingMessage, ServerResponse } from 'http';
import WebSocket from 'ws';
const WebSocketServer = WebSocket.Server;
import type { Server as HttpServer } from 'http';
import type { GeyserSubscriber, ActiveBinChangedEvent, HarvestJob, PositionChangedEvent } from './geyser-subscriber';
import type { HarvestExecutor } from './harvest-executor';
import type { MonkeKeeper } from './keeper';
import { logger } from './logger';

// ═══ TYPES ═══

/** Event broadcast to all connected WebSocket clients */
interface RelayEvent {
  type: string;
  data: any;
  timestamp: number;
}

/** Rover TVL entry for the Recon leaderboard */
export interface RoverTvlEntry {
  pool: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tvl: number;
  positionCount: number;
  status: 'active' | 'converting' | 'exhausted';
  /** Top-5 only: enriched analytics */
  analytics?: {
    priceChangesPerHour: number;
    conversionProgress: number;
    estimatedTtcHours: number;
    solGenerated: number;
  };
}

// ═══ RELAY SERVER ═══

/** Fee pipeline state returned by the /api/fees endpoint */
export interface FeePipelineState {
  roverAuthority: { address: string; solBalance: number; wsolBalance: number };
  distPool: { address: string; solBalance: number };
  programVault: { address: string; solBalance: number };
  monkeState: {
    totalShareWeight: string;
    accumulatedSolPerShare: string;
    totalSolDistributed: number;
    totalBananasBurned: string;
  } | null;
  totalInPipeline: number;
  timestamp: number;
}

export class RelayServer {
  private wss: InstanceType<typeof WebSocketServer> | null = null;
  private clients: Set<WebSocket> = new Set();
  private subscriber: GeyserSubscriber;
  private executor: HarvestExecutor;
  private keeper: MonkeKeeper;
  private botWalletProvider: (() => any) | null;
  private feeProvider: (() => Promise<FeePipelineState>) | null;

  // Rover TVL cache (computed by keeper, exposed via REST)
  private roverTvl: Map<string, RoverTvlEntry> = new Map();

  // Activity feed ring buffer (last 200 events)
  private feedEvents: RelayEvent[] = [];
  private static MAX_FEED_EVENTS = 200;

  constructor(
    subscriber: GeyserSubscriber,
    executor: HarvestExecutor,
    keeper: MonkeKeeper,
    botWalletProvider?: () => any,
    feeProvider?: () => Promise<FeePipelineState>,
  ) {
    this.subscriber = subscriber;
    this.executor = executor;
    this.keeper = keeper;
    this.botWalletProvider = botWalletProvider ?? null;
    this.feeProvider = feeProvider ?? null;
  }

  /**
   * Attach to an existing HTTP server.
   * Adds WebSocket upgrade handling + REST route handling.
   */
  attach(server: HttpServer): void {
    // WebSocket server — upgrade at /ws path
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket: any, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      if (url.pathname === '/ws') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      logger.info(`[relay] WebSocket client connected (${this.clients.size} total)`);

      // Send recent feed events on connect (catch-up)
      ws.send(JSON.stringify({
        type: 'feedHistory',
        data: this.feedEvents.slice(-50),
        timestamp: Date.now(),
      }));

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info(`[relay] WebSocket client disconnected (${this.clients.size} total)`);
      });

      ws.on('error', (err) => {
        logger.warn(`[relay] WebSocket error: ${err.message}`);
        this.clients.delete(ws);
      });
    });

    // Wire subscriber events → WebSocket broadcast
    this.subscriber.on('activeBinChanged', (event: ActiveBinChangedEvent) => {
      this.broadcast('activeBinChanged', event);
    });

    this.subscriber.on('harvestNeeded', (job: HarvestJob) => {
      this.broadcast('harvestNeeded', {
        positionPDA: job.positionPDA,
        lbPair: job.lbPair.toBase58(),
        owner: job.owner.toBase58(),
        side: job.side,
        safeBinCount: job.safeBinIds.length,
      });
    });

    this.subscriber.on('positionChanged', (event: PositionChangedEvent) => {
      this.broadcast('positionChanged', event);
    });

    logger.info('[relay] WebSocket relay attached to HTTP server');
  }

  /**
   * Handle REST API requests. Called from the HTTP server's request handler.
   * Returns true if the request was handled, false if it should fall through.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS headers for all API responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (!path.startsWith('/api/')) return false;

    try {
      switch (path) {
        case '/api/pools':
          return this.handlePools(res);
        case '/api/positions':
          return this.handlePositions(res);
        case '/api/pending-harvests':
          return this.handlePendingHarvests(res);
        case '/api/rovers':
          return this.handleRovers(res);
        case '/api/rovers/top5':
          return this.handleRoversTop5(res);
        case '/api/stats':
          return this.handleStats(res);
        case '/api/bot-wallet':
          return this.handleBotWallet(res);
        case '/api/fees':
          this.handleFees(res);
          return true;
        default:
          // Check for /api/pools/{address}
          if (path.startsWith('/api/pools/')) {
            const address = path.slice('/api/pools/'.length);
            return this.handlePoolByAddress(res, address);
          }
          this.json(res, 404, { error: 'Not found' });
          return true;
      }
    } catch (e: any) {
      logger.error(`[relay] REST error: ${e.message}`);
      this.json(res, 500, { error: 'Internal server error' });
      return true;
    }
  }

  // ─── REST HANDLERS ───

  private handlePools(res: ServerResponse): boolean {
    const pools: any[] = [];
    for (const poolKey of this.subscriber.getWatchedPools()) {
      const info = this.subscriber.getPoolInfo(poolKey);
      if (info) {
        pools.push({
          address: poolKey,
          activeId: info.activeId,
          binStep: info.binStep,
          status: info.status,
          tokenXMint: info.tokenXMint.toBase58(),
          tokenYMint: info.tokenYMint.toBase58(),
          reserveX: info.reserveX.toBase58(),
          reserveY: info.reserveY.toBase58(),
          tokenXProgram: info.tokenXProgramFlag === 1 ? 'Token-2022' : 'SPL',
          tokenYProgram: info.tokenYProgramFlag === 1 ? 'Token-2022' : 'SPL',
        });
      }
    }
    this.json(res, 200, { pools, count: pools.length });
    return true;
  }

  private handlePoolByAddress(res: ServerResponse, address: string): boolean {
    const info = this.subscriber.getPoolInfo(address);
    if (!info) {
      this.json(res, 404, { error: 'Pool not watched or not found' });
      return true;
    }
    this.json(res, 200, {
      address,
      activeId: info.activeId,
      binStep: info.binStep,
      status: info.status,
      tokenXMint: info.tokenXMint.toBase58(),
      tokenYMint: info.tokenYMint.toBase58(),
      reserveX: info.reserveX.toBase58(),
      reserveY: info.reserveY.toBase58(),
      tokenXProgram: info.tokenXProgramFlag === 1 ? 'Token-2022' : 'SPL',
      tokenYProgram: info.tokenYProgramFlag === 1 ? 'Token-2022' : 'SPL',
    });
    return true;
  }

  private handlePositions(res: ServerResponse): boolean {
    const positions: any[] = [];
    for (const poolKey of this.subscriber.getWatchedPools()) {
      const poolPositions = this.subscriber.getPositionsForPool(poolKey);
      for (const pos of poolPositions) {
        const info = this.subscriber.getPoolInfo(poolKey);
        const activeId = info?.activeId ?? 0;
        // Compute fill: how many bins have been crossed
        let filledBins = 0;
        const totalBins = pos.maxBinId - pos.minBinId + 1;
        for (let b = pos.minBinId; b <= pos.maxBinId; b++) {
          if (pos.side === 'Sell' && b < activeId) filledBins++;
          if (pos.side === 'Buy' && b > activeId) filledBins++;
        }

        positions.push({
          positionPDA: pos.positionPDA,
          owner: pos.owner.toBase58(),
          lbPair: pos.lbPair.toBase58(),
          side: pos.side,
          minBinId: pos.minBinId,
          maxBinId: pos.maxBinId,
          totalBins,
          filledBins,
          fillPercent: totalBins > 0 ? Math.round((filledBins / totalBins) * 100) : 0,
        });
      }
    }
    this.json(res, 200, { positions, count: positions.length });
    return true;
  }

  private handlePendingHarvests(res: ServerResponse): boolean {
    const pending: any[] = [];
    for (const poolKey of this.subscriber.getWatchedPools()) {
      const info = this.subscriber.getPoolInfo(poolKey);
      if (!info) continue;
      const activeId = info.activeId;
      const poolPositions = this.subscriber.getPositionsForPool(poolKey);

      for (const pos of poolPositions) {
        let safeBins = 0;
        for (let b = pos.minBinId; b <= pos.maxBinId; b++) {
          if (pos.side === 'Sell' && b < activeId) safeBins++;
          if (pos.side === 'Buy' && b > activeId) safeBins++;
        }
        if (safeBins > 0) {
          pending.push({
            positionPDA: pos.positionPDA,
            lbPair: poolKey,
            owner: pos.owner.toBase58(),
            side: pos.side,
            safeBinCount: safeBins,
            totalBins: pos.maxBinId - pos.minBinId + 1,
          });
        }
      }
    }
    this.json(res, 200, { pending, count: pending.length });
    return true;
  }

  private handleRovers(res: ServerResponse): boolean {
    const rovers = [...this.roverTvl.values()]
      .sort((a, b) => b.tvl - a.tvl)
      .map((entry, idx) => ({ rank: idx + 1, ...entry }));
    this.json(res, 200, {
      rovers,
      count: rovers.length,
      totalTvl: rovers.reduce((sum, r) => sum + r.tvl, 0),
    });
    return true;
  }

  private handleRoversTop5(res: ServerResponse): boolean {
    const rovers = [...this.roverTvl.values()]
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 5)
      .map((entry, idx) => ({ rank: idx + 1, ...entry }));
    this.json(res, 200, { top5: rovers });
    return true;
  }

  private handleStats(res: ServerResponse): boolean {
    this.json(res, 200, {
      positionCount: this.subscriber.getPositionCount(),
      watchedPools: this.subscriber.getWatchedPools().length,
      grpcConnected: this.subscriber.isConnected(),
      grpcReconnects: this.subscriber.getReconnectCount(),
      totalHarvests: this.executor.totalHarvests,
      totalCloses: this.executor.totalCloses,
      queueDepth: this.executor.getQueueLength(),
      inflightTxs: this.executor.getInflightCount(),
      roverPoolCount: this.roverTvl.size,
      roverTotalTvl: [...this.roverTvl.values()].reduce((sum, r) => sum + r.tvl, 0),
      wsClients: this.clients.size,
    });
    return true;
  }

  private handleBotWallet(res: ServerResponse): boolean {
    if (!this.botWalletProvider) {
      this.json(res, 503, { error: 'Bot wallet info not available' });
      return true;
    }
    this.json(res, 200, this.botWalletProvider());
    return true;
  }

  private async handleFees(res: ServerResponse): Promise<void> {
    if (!this.feeProvider) {
      this.json(res, 503, { error: 'Fee pipeline info not available' });
      return;
    }
    try {
      const state = await this.feeProvider();
      this.json(res, 200, state);
    } catch (e: any) {
      logger.error(`[relay] Fee pipeline query error: ${e.message}`);
      this.json(res, 500, { error: 'Failed to query fee pipeline' });
    }
  }

  // ─── BROADCAST ───

  /** Broadcast an event to all connected WebSocket clients + store in feed buffer */
  broadcast(type: string, data: any): void {
    const event: RelayEvent = { type, data, timestamp: Date.now() };

    // Store in ring buffer
    this.feedEvents.push(event);
    if (this.feedEvents.length > RelayServer.MAX_FEED_EVENTS) {
      this.feedEvents.shift();
    }

    // Broadcast to connected clients
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // ─── ROVER TVL ───

  /** Called by keeper after computing rover TVL during Saturday cycle */
  updateRoverTvl(entries: RoverTvlEntry[]): void {
    this.roverTvl.clear();
    for (const entry of entries) {
      this.roverTvl.set(entry.pool, entry);
    }
    this.broadcast('roverTvlUpdated', {
      count: entries.length,
      totalTvl: entries.reduce((sum, e) => sum + e.tvl, 0),
    });
  }

  // ─── HELPERS ───

  private json(res: ServerResponse, status: number, body: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
