import { scaleLinear } from 'd3-scale'
import { useEffect, useState } from 'react'
import { dateLabel, loadMetrics, pct, type Metrics, type Release, type StationsFile } from '../data'

type Props = { release: Release; stations: StationsFile }

const ORDER = ['schedule', 'historical', 'lgbm_schedule_raw', 'lgbm_schedule_cal', 'lgbm_schedule_history_raw', 'lgbm_schedule_history_cal']
const f = (x: number | undefined, d = 2) => (x == null ? '—' : x.toFixed(d))

export function Results({ release, stations }: Props) {
  const [m, setM] = useState<Metrics | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { loadMetrics().then(setM).catch((e) => setErr(String(e.message ?? e))) }, [])
  if (err) return <main className="wrap"><div className="state"><b>Results didn't load</b>{err}</div></main>
  if (!m) return <main className="wrap"><div className="loading-line" role="status" aria-label="Loading results" /></main>

  const R = m.results
  const lg = R.lgbm_schedule_cal.all
  const hist = R.historical.all
  const boot = m.bootstrap.lgbm_schedule_cal
  const featured = m.decision.featured_system
  const systems = ORDER.filter((k) => R[k])
  const names = Object.fromEntries(stations.stations.map((s) => [s.id, s.name]))
  const ordered = stations.stations.slice().sort((a, b) => a.order - b.order)

  return (
    <main className="wrap">
      <p className="lbl">Blue Line · test weeks {dateLabel(release.splits.test[0])} – {dateLabel(release.splits.test[1])}</p>
      <h1 className="page-title">Did the forecast earn its range?</h1>
      <p className="lede">
        Every system below was scored once, on four later weeks it never trained on, against the same {m.counts.usable_events.toLocaleString()} recorded
        arrivals. A good range is narrow <em>and</em> holds about {pct(m.nominal_coverage)} of arrivals.
      </p>

      <div className="verdict">
        <div>
          <span className="lbl">Typical miss of the median</span>
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
          ? `LightGBM met both pre-registered criteria (lower MAE than the historical baseline, coverage inside the band) and is the featured forecast.${boot && boot.ci95[1] > 0 ? ' But the MAE gain is within noise: its 95% interval crosses zero, so treat the two as tied on accuracy. The model’s edge is slightly better-placed ranges, not sharper ones.' : ''}`
          : `LightGBM did not meet the pre-registered criteria (${!m.decision.beats_historical_mae ? 'MAE not below historical baseline' : ''}${!m.decision.beats_historical_mae && !m.decision.coverage_in_band ? '; ' : ''}${!m.decision.coverage_in_band ? 'coverage outside the band' : ''}). The historical baseline is the featured system; the replay still shows both.`}
      </p>

      <section className="panel" style={{ marginTop: 22 }} aria-labelledby="bench-h">
        <div className="panel-h"><h2 id="bench-h">Benchmark</h2><p>Minutes. Lower is better except coverage.</p></div>
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
            * Uses recent-delay history. MBTA regenerated its archive in Oct 2026, so this is a retrospective sensitivity check, not a claim about what was knowable on the day.
            Interval score = width + 10 × distance outside the range (α = 0.2).
          </p>
        </div>
      </section>

      <div className="grid two" style={{ marginTop: 18 }}>
        <section className="panel" aria-labelledby="st-h">
          <div className="panel-h"><h2 id="st-h">Coverage by station</h2><p>Dot = calibrated LightGBM, ring = historical. Bar = mean width.</p></div>
          <StationChart m={m} order={ordered.map((s) => s.id)} names={names} />
        </section>
        <section className="panel" aria-labelledby="wk-h">
          <div className="panel-h"><h2 id="wk-h">Coverage by week</h2><p>Did calibration from May survive into June?</p></div>
          <WeekChart m={m} />
        </section>
      </div>

      <section className="panel" style={{ marginTop: 18 }} aria-labelledby="dq-h">
        <div className="panel-h"><h2 id="dq-h">How much of the schedule could be checked</h2><p>Share of scheduled arrivals matched to a recorded arrival, every day of the study.</p></div>
        <MatchStrip m={m} />
      </section>

      <section className="panel" style={{ marginTop: 18 }} aria-labelledby="seg-h">
        <details>
          <summary style={{ padding: '14px 18px', cursor: 'pointer' }}><span id="seg-h" style={{ font: '800 13px var(--display)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>All segments</span></summary>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Segment</th><th className="num">n</th><th className="num">Hist MAE</th><th className="num">LGBM MAE</th><th className="num">Hist cov.</th><th className="num">LGBM cov.</th><th className="num">LGBM width</th></tr></thead>
              <tbody>
                {m.segments.map((s) => {
                  const a = R.historical[s]
                  const b = R.lgbm_schedule_cal[s]
                  const label = s.startsWith('station_') ? names[s.slice(8)] ?? s : s.replace(/_/g, ' ')
                  return (
                    <tr key={s}>
                      <td>{label}{b.n < m.small_group_threshold ? ' (small)' : ''}</td>
                      <td className="num">{b.n.toLocaleString()}</td>
                      <td className="num">{f(a.mae_min)}</td><td className="num">{f(b.mae_min)}</td>
                      <td className="num">{pct(a.coverage, 1)}</td><td className="num">{pct(b.coverage, 1)}</td>
                      <td className="num">{f(b.width_min)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </main>
  )
}

function StationChart({ m, order, names }: { m: Metrics; order: string[]; names: Record<string, string> }) {
  const rows = order.filter((id) => m.results.lgbm_schedule_cal[`station_${id}`]?.n)
  const W = 560, ROW = 26, L = 150, H = 40 + rows.length * ROW
  const x = scaleLinear().domain([0.5, 1]).range([L, W - 20]).clamp(true)
  const maxW = Math.max(...rows.map((id) => m.results.lgbm_schedule_cal[`station_${id}`].width_min ?? 0), 1)
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Interval coverage by station; the segments table lists exact values.">
      {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((v) => (
        <g key={v} transform={`translate(${x(v)} 0)`}>
          <line y1={22} y2={H - 6} stroke={v === 0.8 ? 'var(--ink)' : 'var(--rule)'} strokeDasharray={v === 0.8 ? '4 3' : undefined} />
          <text y={14} textAnchor="middle">{v * 100}%</text>
        </g>
      ))}
      {rows.map((id, i) => {
        const a = m.results.lgbm_schedule_cal[`station_${id}`]
        const h = m.results.historical[`station_${id}`]
        const y = 36 + i * ROW
        return (
          <g key={id}>
            <text x={L - 10} y={y + 4} textAnchor="end" style={{ fill: 'var(--ink-2)', fontFamily: 'var(--body)', fontSize: 12 }}>{names[id]}</text>
            <rect x={L} y={y + 7} width={((W - 20 - L) * (a.width_min ?? 0)) / maxW} height={3} fill="var(--blue-wash)" />
            {h.coverage != null && <circle cx={x(h.coverage)} cy={y} r={5} fill="none" stroke="var(--sched)" strokeWidth={2} />}
            {a.coverage != null && <circle cx={x(a.coverage)} cy={y} r={5.5} fill="var(--blue)" />}
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
  const y = scaleLinear().domain([0.5, 1]).range([H - B, 16]).clamp(true)
  const line = (k: string) => weeks.map((w, i) => `${i ? 'L' : 'M'}${x(i)},${y(m.results[k][w].coverage ?? 0)}`).join(' ')
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly coverage for calibrated LightGBM and the historical baseline.">
      {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((v) => (
        <g key={v}>
          <line x1={L} x2={W - 10} y1={y(v)} y2={y(v)} stroke={v === 0.8 ? 'var(--ink)' : 'var(--rule)'} strokeDasharray={v === 0.8 ? '4 3' : undefined} />
          <text x={L - 6} y={y(v) + 4} textAnchor="end">{v * 100}%</text>
        </g>
      ))}
      <path d={line('historical')} fill="none" stroke="var(--sched)" strokeWidth={2} strokeDasharray="5 3" />
      <path d={line('lgbm_schedule_cal')} fill="none" stroke="var(--blue)" strokeWidth={3} />
      {weeks.map((w, i) => (
        <g key={w}>
          <circle cx={x(i)} cy={y(m.results.lgbm_schedule_cal[w].coverage ?? 0)} r={4.5} fill="var(--blue)" />
          <text x={x(i)} y={H - 12} textAnchor="middle">wk of {w.slice(10)}</text>
        </g>
      ))}
      <text x={W - 70} y={y(m.results.lgbm_schedule_cal[weeks[weeks.length - 1]].coverage ?? 0) + 4} textAnchor="end" style={{ fill: 'var(--blue)', fontWeight: 600 }}>LightGBM</text>
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
  const color: Record<string, string> = { train: 'var(--sched)', validation: '#5b7fbf', calibration: 'var(--actual)', test: 'var(--blue)' }
  const firsts = new Map<string, number>()
  list.forEach(([, d], i) => { if (d.split && !firsts.has(d.split)) firsts.set(d.split, i) })
  return (
    <div style={{ padding: '10px 18px 16px' }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily match rate across the study period">
        {list.map(([day, d], i) => {
          const r = d.plan ? d.obs / d.plan : 0
          const h = (H - B - 6) * r
          return (
            <rect key={day} x={i * bw} y={H - B - h} width={Math.max(bw - 0.6, 0.6)} height={d.gap ? H - B - 6 : h}
              fill={d.gap ? 'var(--rule)' : d.split ? color[d.split] : 'var(--rule)'}>
              <title>{day}: {d.gap ? 'missing from MBTA files' : pct(r, 1)}</title>
            </rect>
          )
        })}
        {[...firsts.entries()].map(([s, i]) => (
          <text key={s} x={i * bw + 2} y={H - 8} style={{ fill: color[s] }}>{s}</text>
        ))}
      </svg>
    </div>
  )
}
