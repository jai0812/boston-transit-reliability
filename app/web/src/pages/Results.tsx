import { scaleLinear } from 'd3-scale'
import { useEffect, useState } from 'react'
import { dateLabel, loadMetrics, loadSummary, pct, type LineMeta, type Metrics, type Release, type StationsFile, type Summary } from '../data'

type Props = { release: Release; line: LineMeta; nets: StationsFile[]; onLine: (id: string) => void }

const ORDER = ['schedule', 'historical', 'lgbm_schedule_raw', 'lgbm_schedule_cal', 'lgbm_schedule_history_raw', 'lgbm_schedule_history_cal']
const f = (x: number | undefined, d = 2) => (x == null ? '—' : x.toFixed(d))

export function Results({ release, line, nets, onLine }: Props) {
  const [m, setM] = useState<Metrics | null>(null)
  const [sum, setSum] = useState<Summary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { loadSummary().then(setSum).catch((e) => setErr(String(e.message ?? e))) }, [])
  useEffect(() => {
    setM(null)
    loadMetrics(line.id).then(setM).catch((e) => setErr(String(e.message ?? e)))
  }, [line.id])
  const net = nets.find((n) => n.line_id === line.id)!

  return (
    <main className="wrap">
      <p className="lbl">Test weeks {dateLabel(release.splits.test[0])} – {dateLabel(release.splits.test[1])} · scored once per line</p>
      <h1 className="page-title">Did the forecast earn its range?</h1>
      <p className="lede">
        Each line has its own model, its own calibration and its own score, all on four later weeks the model never trained
        on. A good range is narrow <em>and</em> holds about {pct(release.nominal_coverage)} of arrivals.
      </p>

      {sum && (
        <div className="cards" role="group" aria-label="Lines">
          {release.lines.map((l) => {
            const s = sum.lines[l.id]
            const a = s.all.lgbm_schedule_cal
            const h = s.all.historical
            return (
              <button key={l.id} className="line-card" style={{ ['--c' as string]: l.color }} aria-pressed={l.id === line.id} onClick={() => onLine(l.id)}>
                <header><span>{l.name}</span><span>{s.counts.usable_events.toLocaleString()} arrivals</span></header>
                <dl>
                  <div><dt>Median miss</dt><dd>{f(a.mae_min, 1)}<small style={{ fontSize: 12 }}> min</small></dd></div>
                  <div><dt>In range</dt><dd style={{ color: s.decision.coverage_in_band ? 'var(--hit)' : 'var(--miss)' }}>{pct(a.coverage)}</dd></div>
                  <div><dt>vs historical</dt><dd>{(a.mae_min ?? 0) - (h.mae_min ?? 0) <= 0 ? '−' : '+'}{f(Math.abs((a.mae_min ?? 0) - (h.mae_min ?? 0)), 2)}</dd></div>
                </dl>
              </button>
            )
          })}
        </div>
      )}

      {err && <div className="state"><b>Results didn't load</b>{err}</div>}
      {!m ? <div className="loading-line" role="status" aria-label="Loading results" /> : <LineResults m={m} line={line} net={net} />}
    </main>
  )
}

function LineResults({ m, line, net }: { m: Metrics; line: LineMeta; net: StationsFile }) {
  const R = m.results
  const lg = R.lgbm_schedule_cal.all
  const hist = R.historical.all
  const boot = m.bootstrap.lgbm_schedule_cal
  const featured = m.decision.featured_system
  const systems = ORDER.filter((k) => R[k])
  const names = Object.fromEntries(net.stations.map((s) => [s.id, s.name]))
  const order = net.stations.map((s) => s.id)

  return (
    <>
      <div className="verdict" key={line.id}>
        <div>
          <span className="lbl">{line.name}: typical miss of the median</span>
          <b>{f(lg.mae_min, 2)} min</b>
          <small>
            LightGBM vs {f(hist.mae_min, 2)} min for the historical baseline
            {boot && <> · difference {boot.mae_diff_vs_historical_min > 0 ? '+' : ''}{f(boot.mae_diff_vs_historical_min, 2)} min (95% CI {f(boot.ci95[0], 2)} to {f(boot.ci95[1], 2)}, resampling days)</>}
          </small>
        </div>
        <div>
          <span className="lbl">Range held the arrival</span>
          <b>{pct(lg.coverage, 1)}</b>
          <small>Target 80%, review band {pct(m.decision.criteria.coverage_band[0])}–{pct(m.decision.criteria.coverage_band[1])}. Mean width {f(lg.width_min, 1)} min.</small>
        </div>
        <div>
          <span className="lbl">Scheduled trains with a usable record</span>
          <b>{pct(m.counts.observation_coverage, 1)}</b>
          <small>{m.counts.usable_events.toLocaleString()} of {m.counts.eligible_events.toLocaleString()} eligible. {m.counts.source_gap_days.length} days missing from MBTA's files.</small>
        </div>
      </div>

      <p style={{ marginTop: 14 }}>
        <b>Release decision:</b>{' '}
        {m.decision.promote_lightgbm
          ? `LightGBM met both pre-registered criteria (lower MAE than the historical baseline, coverage inside the band) and is the featured forecast.${boot && boot.ci95[1] > 0 && boot.ci95[0] < 0 ? ' The MAE gain is within noise (its 95% interval crosses zero), so treat the two as tied on accuracy.' : ''}`
          : `LightGBM did not meet the pre-registered criteria (${[!m.decision.beats_historical_mae && 'MAE not below the historical baseline', !m.decision.coverage_in_band && 'coverage outside the band'].filter(Boolean).join('; ')}). The historical baseline is the featured system; the replay still shows both.`}
      </p>

      <section className="panel" style={{ marginTop: 22 }} aria-labelledby="bench-h">
        <div className="panel-h"><h2 id="bench-h">{line.name} benchmark</h2><p>Minutes. Lower is better except coverage.</p></div>
        <div className="table-scroll" style={{ paddingTop: 10 }}>
          <table className="bench">
            <thead>
              <tr>
                <th>System</th><th className="num">MAE</th><th className="num">Bias</th><th className="num">Coverage</th>
                <th className="num">Width</th><th className="num">Interval score</th><th className="num">Late misses</th><th className="num">Early misses</th>
              </tr>
            </thead>
            <tbody>
              {systems.map((k) => {
                const s = R[k].all
                return (
                  <tr key={k} className={k === featured ? 'featured' : undefined}>
                    <td>{m.systems[k]}{k.includes('history') ? ' *' : ''}</td>
                    <td className="num">{f(s.mae_min)}</td>
                    <td className="num">{f(s.bias_min)}</td>
                    <td className="num">{pct(s.coverage, 1)}</td>
                    <td className="num">{f(s.width_min)}</td>
                    <td className="num">{f(s.interval_score_min)}</td>
                    <td className="num">{pct(s.late_miss_rate, 1)}</td>
                    <td className="num">{pct(s.early_miss_rate, 1)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p style={{ color: 'var(--ink-3)', fontSize: 12 }}>
            * Uses recent-delay history. MBTA regenerated its archive in Oct 2026, so this is a retrospective sensitivity check.
            Interval score = width + 10 × distance outside the range (α = 0.2).
          </p>
        </div>
      </section>

      <div className="grid two" style={{ marginTop: 18 }}>
        <section className="panel" aria-labelledby="st-h">
          <div className="panel-h"><h2 id="st-h">Coverage by station</h2><p>Dot = calibrated LightGBM, ring = historical. Bar = mean width.</p></div>
          <div style={{ maxHeight: 620, overflowY: 'auto' }}><StationChart m={m} order={order} names={names} /></div>
        </section>
        <section className="panel" aria-labelledby="wk-h">
          <div className="panel-h"><h2 id="wk-h">Coverage by week</h2><p>Did calibration from May survive into June?</p></div>
          <WeekChart m={m} />
          {m.segments.some((s) => s.startsWith('route_')) && (
            <>
              <div className="panel-h"><h2>By branch</h2></div>
              <div className="table-scroll" style={{ paddingTop: 8 }}>
                <table>
                  <thead><tr><th>Branch</th><th className="num">n</th><th className="num">MAE</th><th className="num">Coverage</th><th className="num">Width</th></tr></thead>
                  <tbody>
                    {m.segments.filter((s) => s.startsWith('route_')).map((s) => {
                      const b = R.lgbm_schedule_cal[s]
                      return <tr key={s}><td>{s.slice(6)}</td><td className="num">{b.n.toLocaleString()}</td><td className="num">{f(b.mae_min)}</td><td className="num">{pct(b.coverage, 1)}</td><td className="num">{f(b.width_min)}</td></tr>
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>

      <section className="panel" style={{ marginTop: 18 }} aria-labelledby="dq-h">
        <div className="panel-h"><h2 id="dq-h">How much of the schedule could be checked</h2><p>Share of scheduled arrivals matched to a recorded arrival, every day of the study.</p></div>
        <MatchStrip m={m} />
      </section>
    </>
  )
}

function StationChart({ m, order, names }: { m: Metrics; order: string[]; names: Record<string, string> }) {
  const rows = order.filter((id) => m.results.lgbm_schedule_cal[`station_${id}`]?.n)
  const W = 560, ROW = 24, L = 170, H = 40 + rows.length * ROW
  const x = scaleLinear().domain([0.4, 1]).range([L, W - 20]).clamp(true)
  const maxW = Math.max(...rows.map((id) => m.results.lgbm_schedule_cal[`station_${id}`].width_min ?? 0), 1)
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Interval coverage by station.">
      {[0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((v) => (
        <g key={v} transform={`translate(${x(v)} 0)`}>
          <line y1={22} y2={H - 6} stroke={v === 0.8 ? 'var(--ink)' : 'var(--rule)'} strokeDasharray={v === 0.8 ? '4 3' : undefined} />
          <text y={14} textAnchor="middle">{Math.round(v * 100)}%</text>
        </g>
      ))}
      {rows.map((id, i) => {
        const a = m.results.lgbm_schedule_cal[`station_${id}`]
        const h = m.results.historical[`station_${id}`]
        const y = 36 + i * ROW
        return (
          <g key={id}>
            <text x={L - 10} y={y + 4} textAnchor="end" style={{ fill: 'var(--ink-2)', fontFamily: 'var(--body)', fontSize: 12 }}>{names[id] ?? id}</text>
            <rect className="bar-in" style={{ ['--i' as string]: i * 6 }} x={L} y={y + 7} width={((W - 20 - L) * (a.width_min ?? 0)) / maxW} height={3} fill="var(--blue-wash)" />
            {h.coverage != null && <circle className="dot-in" style={{ ['--i' as string]: i }} cx={x(h.coverage)} cy={y} r={5} fill="none" stroke="var(--sched)" strokeWidth={2} />}
            {a.coverage != null && <circle className="dot-in" style={{ ['--i' as string]: i }} cx={x(a.coverage)} cy={y} r={5.5} fill="var(--blue)" />}
          </g>
        )
      })}
    </svg>
  )
}

function WeekChart({ m }: { m: Metrics }) {
  const weeks = m.segments.filter((s) => s.startsWith('week_'))
  const W = 560, H = 240, L = 44, B = 34
  const x = scaleLinear().domain([0, Math.max(weeks.length - 1, 1)]).range([L + 36, W - 60])
  const y = scaleLinear().domain([0.4, 1]).range([H - B, 16]).clamp(true)
  const line = (k: string) => weeks.map((w, i) => `${i ? 'L' : 'M'}${x(i)},${y(m.results[k][w].coverage ?? 0)}`).join(' ')
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly coverage for calibrated LightGBM and the historical baseline.">
      {[0.4, 0.6, 0.8, 1].map((v) => (
        <g key={v}>
          <line x1={L} x2={W - 10} y1={y(v)} y2={y(v)} stroke={v === 0.8 ? 'var(--ink)' : 'var(--rule)'} strokeDasharray={v === 0.8 ? '4 3' : undefined} />
          <text x={L - 6} y={y(v) + 4} textAnchor="end">{Math.round(v * 100)}%</text>
        </g>
      ))}
      <path className="draw" d={line('historical')} fill="none" stroke="var(--sched)" strokeWidth={2} strokeDasharray="5 3" />
      <path className="draw" d={line('lgbm_schedule_cal')} fill="none" stroke="var(--blue)" strokeWidth={3} />
      {weeks.map((w, i) => (
        <g key={w}>
          <circle className="dot-in" style={{ ['--i' as string]: i + 4 }} cx={x(i)} cy={y(m.results.lgbm_schedule_cal[w].coverage ?? 0)} r={4.5} fill="var(--blue)" />
          <text x={x(i)} y={H - 12} textAnchor="middle">wk of {w.slice(10)}</text>
        </g>
      ))}
    </svg>
  )
}

function MatchStrip({ m }: { m: Metrics }) {
  const days = new Map<string, { obs: number; plan: number; split: string | null; gap: boolean }>()
  for (const r of m.data_quality) {
    const d = days.get(r.service_date) ?? { obs: 0, plan: 0, split: r.split, gap: false }
    d.obs += r.observed
    d.plan += r.planned_events - r.source_gap
    d.gap = d.gap || r.source_gap > 0
    days.set(r.service_date, d)
  }
  const list = [...days.entries()].sort()
  const W = 1200, H = 120, B = 26
  const bw = W / Math.max(list.length, 1)
  const color: Record<string, string> = { train: 'var(--sched)', validation: 'color-mix(in srgb, var(--blue) 60%, var(--sched))', calibration: 'var(--actual)', test: 'var(--blue)' }
  const firsts = new Map<string, number>()
  list.forEach(([, d], i) => { if (d.split && !firsts.has(d.split)) firsts.set(d.split, i) })
  return (
    <div style={{ padding: '10px 18px 16px' }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily match rate across the study period">
        {list.map(([day, d], i) => {
          const r = d.plan ? d.obs / d.plan : 0
          const h = (H - B - 6) * r
          return (
            <rect className="bar-in" style={{ ['--i' as string]: i }} key={day} x={i * bw} y={H - B - (d.gap ? H - B - 6 : h)} width={Math.max(bw - 0.6, 0.6)} height={d.gap ? H - B - 6 : h}
              fill={d.gap ? 'var(--rule)' : d.split ? color[d.split] : 'var(--rule)'}>
              <title>{day}: {d.gap ? 'missing from MBTA files' : pct(r, 1)}</title>
            </rect>
          )
        })}
        {[...firsts.entries()].map(([s, i]) => <text key={s} x={i * bw + 2} y={H - 8}>{s}</text>)}
      </svg>
    </div>
  )
}
