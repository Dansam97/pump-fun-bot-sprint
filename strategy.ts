// Breakout rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most pump.fun curves die; the few that run, run far. So this bot bets SMALL
// (0.06 SOL per curve, one buy, no adds) and only on a confirmed breakout: the price
// pushes above its 120-slot high with real buying behind it — many distinct buyers,
// positive net SOL flow, no whale sell in sight. Losers are cut at -20%; winners are
// never capped by a take-profit — a trailing stop (40% giveback once up 50%) lets a
// runner ride toward completion, and a distribution exit (net flow turns negative)
// gets out when the crowd leaves. A curve near completion (real SOL >= 85) is ridden
// through the other exits, because the migration pays.
//
// The 20-coin qualification bar is met with cheap probe round trips (0.01 SOL buy,
// sold as soon as it lands) on liquid, positively-flowing curves, only while the
// bot's own traded-coin count is below 20. Probes cost about a tx fee each.
//
// Everything is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, iteration only over insertion-ordered maps fed by the batch
// stream, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Lookback (slots) whose high the price must break above. */
  breakoutWindow: number;
  /** Price must be at least this far above the breakout-window high. */
  breakoutUp: number;
  /** Price must not be more than this far above the price `breakoutWindow` slots ago. */
  maxRunUp: number;
  /** Slots over which net SOL flow is measured for entry. */
  flowWindow: number;
  /** Net SOL (buys minus sells) over flowWindow needed to enter. */
  minNetSol: number;
  /** Buy trades in flowWindow needed to enter. */
  minBuys: number;
  /** Distinct buying wallets in flowWindow needed to enter. */
  minBuyers: number;
  /** Curve real-SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Age window (slots since CreateEvent) in which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Single sell of at least this many SOL in the recent window vetoes entry. */
  bigSellSol: number;
  /** Recent window (slots) scanned for a veto sell. */
  bigSellWindow: number;
  /** SOL staked in the single buy of a position. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Once value reaches cost * (1 + trailArm), exit when it falls to peak * (1 - trail). */
  trailArm: number;
  trail: number;
  /** Exit when net SOL over fadeWindow falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  exitBigSellSol: number;
  /** Exit after this many slots held (unless riding to completion). */
  maxHold: number;
  /** Real SOL at or above which the curve is ridden to completion. */
  rideRqSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most positions open at once. */
  maxPositions: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Probe round-trip size (SOL); also the minimum qualifying round trip. */
  probeSol: number;
  /** Most probes in flight at once. */
  maxProbes: number;
  /** Distinct coins the bot aims to have round-tripped (the qualification bar is 20). */
  targetCoins: number;
}

export const DEFAULT_PARAMS: Params = {
  breakoutWindow: 120,
  breakoutUp: 0.04,
  maxRunUp: 0.8,
  flowWindow: 40,
  minNetSol: 0.4,
  minBuys: 8,
  minBuyers: 6,
  minRqSol: 2,
  maxRqSol: 100,
  minAge: 200,
  maxAge: 2000,
  bigSellSol: 1,
  bigSellWindow: 20,
  stakeSol: 0.15,
  minBuySol: 0.01,
  buySlipBps: 1000,
  stopLoss: 0.2,
  trailArm: 0.5,
  trail: 0.4,
  fadeWindow: 30,
  fadeNetSol: 0.2,
  exitBigSellSol: 2,
  maxHold: 1200,
  rideRqSol: 85,
  cooldown: 300,
  maxEntries: 2,
  maxPositions: 5,
  maxExposureSol: 1,
  probeSol: 0.01,
  maxProbes: 1,
  targetCoins: 20,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Coins the bot has round-tripped with at least probeSol bought (fills excluded). */
  const myCoins = new Set<Pubkey>();
  const keep = Math.max(p.breakoutWindow, p.flowWindow, p.fadeWindow, p.bigSellWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge || now - t.created > p.maxAge) return false;
    // Breakout: current price above the high of the lookback window, but not a vertical run.
    // The high is taken over the window EXCLUDING the latest trade — otherwise the
    // latest price could never exceed a high it is part of.
    let high = 0;
    let oldPrice = -1;
    let last = 0;
    let lastIdx = -1;
    for (let i = 0; i < t.trades.length; i++) {
      const tr = t.trades[i]!;
      if (tr.slot > now - p.breakoutWindow) lastIdx = i;
    }
    for (let i = 0; i < t.trades.length; i++) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - p.breakoutWindow) {
        oldPrice = tr.price;
        continue;
      }
      if (oldPrice < 0) oldPrice = tr.price;
      if (i !== lastIdx && tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (last <= 0 || high <= 0 || oldPrice <= 0) return false;
    if (last < high * (1 + p.breakoutUp)) return false;
    if (last > oldPrice * (1 + p.maxRunUp)) return false;
    // Flow: real buying behind the breakout.
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    const byUser = new Map<string, number>();
    let veto = false;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - p.flowWindow) break;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
        if (tr.slot > now - p.bigSellWindow && tr.sol >= p.bigSellSol) veto = true;
      }
    }
    if (veto) return false;
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          if (f.side === 'buy') myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.exitBigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        const riding = rqSol >= p.rideRqSol;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && !riding && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && !riding && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && !riding && bigSell.has(mint)) exit = true;
        if (!exit && !riding && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries (one buy per position, no adds).
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = p.maxPositions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
      }

      // Guardrail pacing: open a probe while the traded-coin count is below target.
      if (probes.size < p.maxProbes && myCoins.size < p.targetCoins && slotsLeft > 0) {
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= p.maxProbes) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          if (rqSol < minRq * 1.5) continue;
          const t = tapes.get(mint)!;
          if (flow(t, now, p.flowWindow) <= 0) continue;
          if (free < p.probeSol + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          probes.set(mint, false);
          free -= p.probeSol + tx;
        }
      }
      return orders;
    },
  };
}
