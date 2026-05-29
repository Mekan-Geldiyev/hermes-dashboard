'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';
import { PriceSimulator } from '@/lib/simulator';
import { computeMarkov } from '@/lib/markov';
import { runMonteCarlo } from '@/lib/monteCarlo';
import { computeSMC } from '@/lib/smc';
import type { MarkovResult, MCResult, SMCResult, ClaudeDecision, Trade } from '@/lib/types';

// ─── helpers ──────────────────────────────────────────────────────────────────

const fmt  = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct  = (n: number) => (n * 100).toFixed(1) + '%';
const now  = () => new Date().toLocaleTimeString('en-US', { hour12: false });

function sigColor(s: string | null) {
  if (s === 'BULL') return 'text-bull';
  if (s === 'BEAR') return 'text-bear';
  return 'text-gray-500';
}
function sigBg(s: string | null) {
  if (s === 'BULL') return 'bg-bull/10 border-bull/40 text-bull';
  if (s === 'BEAR') return 'bg-bear/10 border-bear/40 text-bear';
  return 'bg-white/5 border-white/10 text-gray-500';
}

// ─── sub-components ───────────────────────────────────────────────────────────

function Badge({ sig }: { sig: string | null }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono font-bold tracking-wider ${sigBg(sig)}`}>
      {sig === 'BULL' ? '▲' : sig === 'BEAR' ? '▼' : '–'} {sig ?? 'NONE'}
    </span>
  );
}

function Card({ title, children, glow }: { title: string; children: React.ReactNode; glow?: 'bull' | 'bear' | null }) {
  const border = glow === 'bull' ? 'border-bull/30 shadow-[0_0_18px_rgba(0,217,135,0.08)]'
               : glow === 'bear' ? 'border-bear/30 shadow-[0_0_18px_rgba(255,60,90,0.08)]'
               : 'border-white/[0.06]';
  return (
    <div className={`rounded-xl border bg-[#0d0d11] p-4 ${border} transition-all duration-500`}>
      <p className="text-[10px] uppercase tracking-[0.2em] text-gray-600 mb-3 font-mono">{title}</p>
      {children}
    </div>
  );
}

// ─── main ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const simRef  = useRef<PriceSimulator | null>(null);
  const claudeThrottleRef = useRef(0);

  const [chartData, setChartData] = useState<{ t: string; p: number }[]>([]);
  const [price, setPrice]   = useState(0);
  const [delta, setDelta]   = useState(0);    // % change from first bar
  const [markov, setMarkov] = useState<MarkovResult | null>(null);
  const [mc, setMC]         = useState<MCResult | null>(null);
  const [smc, setSMC]       = useState<SMCResult | null>(null);
  const [claude, setClaude] = useState<ClaudeDecision>({
    direction: 'NO_TRADE', confidence: 0, reasoning: 'Waiting for signal convergence…', loading: false,
  });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [sessionPnL, setSessionPnL] = useState(0);
  const [convergeFire, setConvergeFire] = useState(false);
  const [tick, setTick] = useState(0);

  // initialise simulator once
  useEffect(() => {
    simRef.current = new PriceSimulator();
  }, []);

  const askClaude = useCallback(async (
    m: MarkovResult, mc_: MCResult, s: SMCResult, p: number
  ) => {
    // throttle: max once per 15 seconds
    if (Date.now() - claudeThrottleRef.current < 15_000) return;
    claudeThrottleRef.current = Date.now();

    setClaude(prev => ({ ...prev, loading: true }));
    try {
      const res = await fetch('/api/hermes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markov: m, mc: mc_, smc: s,
          btcPrice: p, yesPrice: (mc_.bullProb).toFixed(3),
        }),
      });
      const data = await res.json();
      setClaude({ direction: data.direction, confidence: data.confidence, reasoning: data.reasoning, loading: false });

      // record simulated trade when Claude fires
      if (data.direction !== 'NO_TRADE' && data.confidence >= 0.65) {
        setConvergeFire(true);
        setTimeout(() => setConvergeFire(false), 2000);
        const trade: Trade = {
          id: Date.now().toString(),
          timestamp: Date.now(),
          direction: data.direction,
          entryPrice: p,
          confidence: data.confidence,
          status: 'OPEN',
        };
        setTrades(prev => [trade, ...prev].slice(0, 20));

        // Simulate resolution after 15s
        setTimeout(() => {
          const sim = simRef.current;
          if (!sim) return;
          const exitPrice = sim.getPrice();
          const won = trade.direction === 'BULL'
            ? exitPrice > trade.entryPrice
            : exitPrice < trade.entryPrice;
          const pnl = won ? trade.confidence * 50 : -trade.confidence * 30;
          setTrades(prev =>
            prev.map(t => t.id === trade.id
              ? { ...t, exitPrice, pnl, status: won ? 'WIN' : 'LOSS' }
              : t
            )
          );
          setSessionPnL(prev => prev + pnl);
        }, 15_000);
      }
    } catch {
      setClaude(prev => ({ ...prev, loading: false, reasoning: 'API error — check console' }));
    }
  }, []);

  // simulation tick every 2 seconds
  useEffect(() => {
    const id = setInterval(() => {
      const sim = simRef.current;
      if (!sim) return;

      sim.tick();
      const bars   = sim.getBars();
      const prices = sim.getPrices();
      const cur    = sim.getPrice();

      // chart data: last 60 bars
      setChartData(
        bars.slice(-60).map((b, i) => ({
          t: i % 10 === 0 ? new Date(b.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '',
          p: +b.close.toFixed(0),
        }))
      );

      setPrice(cur);
      if (prices.length > 1) {
        setDelta((cur - prices[0]) / prices[0] * 100);
      }

      const m  = computeMarkov(prices);
      const mc_ = runMonteCarlo(m.matrix, m.currentState);
      const s  = computeSMC(bars);

      setMarkov(m);
      setMC(mc_);
      setSMC(s);
      setTick(t => t + 1);

      // Ask Claude when 3 quant signals converge
      const sigs = [m.signal, mc_.signal, s.signal];
      const bulls = sigs.filter(v => v === 'BULL').length;
      const bears = sigs.filter(v => v === 'BEAR').length;
      if (bulls >= 2 || bears >= 2) {
        askClaude(m, mc_, s, cur);
      }
    }, 2000);

    return () => clearInterval(id);
  }, [askClaude]);

  // ── derived ─────────────────────────────────────────────────────────────────
  const allConverge = markov && mc && smc && claude.direction !== 'NO_TRADE' && claude.confidence >= 0.65;
  const priceUp = delta >= 0;
  const chartColor = priceUp ? '#00d987' : '#ff3c5a';

  // MC bar data
  const mcBars = mc ? [
    { name: 'BULL', value: +(mc.bullProb * 100).toFixed(1), fill: '#00d987' },
    { name: 'BEAR', value: +(mc.bearProb * 100).toFixed(1), fill: '#ff3c5a' },
  ] : [];

  // Markov matrix cells
  const mCells = markov ? [
    { label: 'B→B', val: markov.matrix[0][0], dir: 'BEAR' },
    { label: 'B→U', val: markov.matrix[0][1], dir: 'BULL' },
    { label: 'U→B', val: markov.matrix[1][0], dir: 'BEAR' },
    { label: 'U→U', val: markov.matrix[1][1], dir: 'BULL' },
  ] : [];

  return (
    <div className="min-h-screen bg-[#060608] text-gray-200 font-mono p-4 flex flex-col gap-4">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-bull animate-pulse-fast" />
          <span className="text-[11px] text-gray-500 tracking-widest uppercase">Hermes · BTC/USDT · Simulation</span>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-[11px] text-gray-500">{now()} UTC</span>
          <span className={`text-[11px] font-bold ${sessionPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
            Session P&L: {sessionPnL >= 0 ? '+' : ''}${sessionPnL.toFixed(2)}
          </span>
        </div>
      </div>

      {/* ── Price ticker ───────────────────────────────────────────────────── */}
      <div className="flex items-end gap-4">
        <span className={`text-4xl font-bold tracking-tight ${priceUp ? 'text-bull' : 'text-bear'}`}>
          ${fmt(price)}
        </span>
        <span className={`text-lg mb-1 ${priceUp ? 'text-bull' : 'text-bear'}`}>
          {priceUp ? '▲' : '▼'} {Math.abs(delta).toFixed(3)}%
        </span>
        <span className="text-[11px] text-gray-600 mb-1 ml-2">tick #{tick}</span>
      </div>

      {/* ── Main grid ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 flex-1">

        {/* ── Left: Price chart ──────────────────────────────────────────── */}
        <div className="xl:col-span-2 flex flex-col gap-4">
          <Card title="BTC/USDT · 2-second bars">
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={chartColor} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" tick={{ fill: '#555', fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis
                  domain={['auto', 'auto']}
                  tick={{ fill: '#555', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v => `$${(v/1000).toFixed(1)}k`}
                  width={52}
                />
                <Tooltip
                  contentStyle={{ background: '#111', border: '1px solid #222', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#888' }}
                  formatter={(v: number) => [`$${fmt(v)}`, 'BTC']}
                />
                <Area
                  type="monotone"
                  dataKey="p"
                  stroke={chartColor}
                  strokeWidth={1.5}
                  fill="url(#priceGrad)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Card>

          {/* Monte Carlo */}
          <Card title={`Monte Carlo · 500 paths × 10 steps`} glow={mc?.signal as 'bull' | 'bear' | null}>
            <div className="flex items-center gap-4 mb-3">
              <Badge sig={mc?.signal ?? null} />
              {mc && (
                <span className="text-[12px] text-gray-500">
                  Bull: <span className="text-bull">{pct(mc.bullProb)}</span>
                  {'  '}Bear: <span className="text-bear">{pct(mc.bearProb)}</span>
                </span>
              )}
            </div>

            {/* Probability bar */}
            {mc && (
              <div className="relative h-4 rounded-full overflow-hidden bg-white/5 mb-4">
                <div
                  className="absolute left-0 top-0 h-full bg-bull/70 transition-all duration-500"
                  style={{ width: pct(mc.bullProb) }}
                />
                <div
                  className="absolute right-0 top-0 h-full bg-bear/70 transition-all duration-500"
                  style={{ width: pct(mc.bearProb) }}
                />
              </div>
            )}

            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={mcBars} barCategoryGap="30%">
                <XAxis dataKey="name" tick={{ fill: '#555', fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis domain={[0, 100]} tick={{ fill: '#555', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} width={34} />
                <Tooltip
                  contentStyle={{ background: '#111', border: '1px solid #222', borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number) => [`${v}%`]}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {mcBars.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Trade log */}
          <Card title="Simulated trade log">
            <div className="overflow-auto max-h-48">
              {trades.length === 0 && (
                <p className="text-[12px] text-gray-600 text-center py-4">No trades yet — waiting for convergence</p>
              )}
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-gray-600 border-b border-white/[0.05]">
                    <th className="text-left pb-1">Time</th>
                    <th className="text-left pb-1">Dir</th>
                    <th className="text-right pb-1">Entry</th>
                    <th className="text-right pb-1">Exit</th>
                    <th className="text-right pb-1">Conf</th>
                    <th className="text-right pb-1">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map(t => (
                    <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                      <td className="py-1 text-gray-500">{new Date(t.timestamp).toLocaleTimeString('en-US', { hour12: false })}</td>
                      <td className={`py-1 font-bold ${t.direction === 'BULL' ? 'text-bull' : 'text-bear'}`}>
                        {t.direction === 'BULL' ? '▲' : '▼'} {t.direction}
                      </td>
                      <td className="py-1 text-right text-gray-400">${fmt(t.entryPrice)}</td>
                      <td className="py-1 text-right text-gray-400">{t.exitPrice ? `$${fmt(t.exitPrice)}` : '—'}</td>
                      <td className="py-1 text-right text-gray-500">{pct(t.confidence)}</td>
                      <td className={`py-1 text-right font-bold ${
                        t.status === 'OPEN' ? 'text-warn' :
                        t.status === 'WIN'  ? 'text-bull' : 'text-bear'
                      }`}>
                        {t.status === 'OPEN' ? 'OPEN' : t.pnl !== undefined ? `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* ── Right: Signal stack ────────────────────────────────────────── */}
        <div className="flex flex-col gap-4">

          {/* Markov */}
          <Card title={`Markov chain · ${markov?.nSamples ?? 0} samples`} glow={markov?.signal as 'bull' | 'bear' | null}>
            <div className="flex items-center justify-between mb-3">
              <Badge sig={markov?.signal ?? null} />
              <span className="text-[11px] text-gray-600">
                State: <span className={markov?.currentState === 1 ? 'text-bull' : 'text-bear'}>
                  {markov?.currentState === 1 ? 'BULL' : 'BEAR'}
                </span>
              </span>
            </div>

            {/* 2×2 transition matrix */}
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {mCells.map(cell => (
                <div
                  key={cell.label}
                  className={`rounded-lg p-2.5 text-center border ${
                    cell.dir === 'BULL' ? 'border-bull/20' : 'border-bear/20'
                  }`}
                  style={{ background: cell.dir === 'BULL'
                    ? `rgba(0,217,135,${cell.val * 0.18})`
                    : `rgba(255,60,90,${cell.val * 0.18})` }}
                >
                  <div className="text-[9px] text-gray-600 mb-0.5">{cell.label}</div>
                  <div className={`text-[15px] font-bold ${cell.dir === 'BULL' ? 'text-bull' : 'text-bear'}`}>
                    {(cell.val * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-between text-[11px]">
              <span className="text-gray-600">Bull persist.</span>
              <span className={markov && markov.bullPersistence >= 0.87 ? 'text-bull font-bold' : 'text-gray-400'}>
                {markov ? pct(markov.bullPersistence) : '—'}
                {markov && markov.bullPersistence >= 0.87 && ' ✓'}
              </span>
            </div>
            <div className="flex justify-between text-[11px] mt-1">
              <span className="text-gray-600">Bear persist.</span>
              <span className={markov && markov.bearPersistence >= 0.87 ? 'text-bear font-bold' : 'text-gray-400'}>
                {markov ? pct(markov.bearPersistence) : '—'}
                {markov && markov.bearPersistence >= 0.87 && ' ✓'}
              </span>
            </div>
          </Card>

          {/* SMC */}
          <Card title="Smart money concepts" glow={smc?.signal as 'bull' | 'bear' | null}>
            <div className="flex items-center justify-between mb-3">
              <Badge sig={smc?.signal ?? null} />
              <span className="text-[11px] text-gray-600">{smc?.patternsFound ?? 0}/3 active</span>
            </div>
            <div className="space-y-2">
              {[
                { label: 'Break of Structure', val: smc?.bos },
                { label: 'Liquidity Sweep',    val: smc?.liquiditySweep },
                { label: 'Fair Value Gap',      val: smc?.fvg },
              ].map(row => (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">{row.label}</span>
                  <Badge sig={row.val ?? null} />
                </div>
              ))}
            </div>
          </Card>

          {/* Claude */}
          <Card
            title="Claude Opus · Brain"
            glow={claude.direction === 'BULL' ? 'bull' : claude.direction === 'BEAR' ? 'bear' : null}
          >
            <div className="flex items-center justify-between mb-3">
              {claude.loading ? (
                <span className="text-[12px] text-warn animate-pulse">Thinking…</span>
              ) : (
                <Badge sig={claude.direction === 'NO_TRADE' ? null : claude.direction} />
              )}
              {!claude.loading && claude.direction !== 'NO_TRADE' && (
                <span className={`text-[13px] font-bold ${claude.confidence >= 0.72 ? 'text-bull' : 'text-warn'}`}>
                  {pct(claude.confidence)}
                </span>
              )}
            </div>

            {/* Confidence bar */}
            {!claude.loading && claude.confidence > 0 && (
              <div className="h-1.5 bg-white/5 rounded-full mb-3 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    claude.direction === 'BULL' ? 'bg-bull' : 'bg-bear'
                  }`}
                  style={{ width: pct(claude.confidence) }}
                />
              </div>
            )}

            <p className="text-[11px] text-gray-500 leading-relaxed">{claude.reasoning}</p>
          </Card>

          {/* Convergence gate */}
          <div className={`rounded-xl border p-4 transition-all duration-500 ${
            allConverge
              ? `border-warn/40 bg-warn/5 ${convergeFire ? 'animate-fire' : ''}`
              : 'border-white/[0.06] bg-[#0d0d11]'
          }`}>
            <p className="text-[10px] uppercase tracking-[0.2em] text-gray-600 mb-3 font-mono">
              Convergence gate
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Markov',   sig: markov?.signal },
                { label: 'MC',       sig: mc?.signal },
                { label: 'SMC',      sig: smc?.signal },
                { label: 'Claude',   sig: claude.direction === 'NO_TRADE' ? null : claude.direction },
              ].map(row => (
                <div key={row.label} className="flex items-center justify-between bg-white/[0.03] rounded-lg px-2.5 py-2">
                  <span className="text-[10px] text-gray-600">{row.label}</span>
                  <span className={`text-[10px] font-bold ${sigColor(row.sig ?? null)}`}>
                    {row.sig ?? '—'}
                  </span>
                </div>
              ))}
            </div>
            <div className={`mt-3 text-center text-[12px] font-bold tracking-widest ${
              allConverge ? 'text-warn' : 'text-gray-700'
            }`}>
              {allConverge ? `🔥 FIRE — ${claude.direction}` : 'WAITING FOR CONVERGENCE'}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
