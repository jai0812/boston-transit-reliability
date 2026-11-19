import { useEffect, useMemo, useRef, useState } from 'react'
import { clock, dateLabel, loadReplay, loadSummary, type Release, type Replay, type StationsFile, type Summary } from '../data'
import { makeShapePlacer, makeTracker } from '../trains'

type Props = { release: Release; nets: StationsFile[]; onLine: (id: string) => void }

const LOOP_FROM = 6.75 * 3600
const LOOP_TO = 9.5 * 3600
const SPEED = 110 // replay seconds per real second

export function Home({ release, nets, onLine }: Props) {
  const [sum, setSum] = useState<Summary | null>(null)
  useEffect(() => { loadSummary().then(setSum).catch(() => setSum(null)) }, [])
  const heroDate = useMemo(() => {
    const ok = (d: string) => release.lines.every((l) => l.replay_dates.some((x) => x.service_date === d && !x.source_gap))
    const pref = release.lines.flatMap((l) => l.presets.filter((p) => p.kind === 'typical').map((p) => p.service_date))
    return pref.find(ok) ?? release.replay_dates.find((d) => !d.source_gap && ok(d.service_date))?.service_date ?? release.replay_dates[0].service_date
  }, [release])

  return (
    <>
      <section className="home-hero">
        <div className="wrap home-hero-grid">
          <div className="home-copy">
            <p className="eyebrow">Boston subway · Blue, Red and Green Lines</p>
            <h1 className="home-title">Every train time is a guess. <span>This shows how good the guess was.</span></h1>
            <p className="home-lede">
              We replayed four weeks of real MBTA service. For every scheduled train, a forecast was written the night before:
              not one time, but a <b>likely range</b>. Then we checked when each train actually arrived.
            </p>
            <div className="home-ctas">
              <a className="btn primary" href="#/replay">Replay a commute</a>
              <a className="btn ghost" href="#/results">See how accurate it was</a>
            </div>
          </div>
          <HeroMap nets={nets} date={heroDate} />
        </div>
      </section>

      <main className="home-main">
        <section className="wrap home-sec">
          <h2 className="sec-title">What you'll see on every screen</h2>
          <p className="sec-lede">Each train gets three marks. Watch one play out:</p>
          <RangeExplainer />
        </section>

        <section className="wrap home-sec">
          <h2 className="sec-title">How the forecast works</h2>
          <ol className="steps">
            <li>
              <span className="step-time">8:00 PM, the night before</span>
              <b>The forecast is locked in.</b>
              <p>A model looks at the timetable and how similar trains behaved over the past months: same station, same time of day, same day of the week. It writes down a range for every train tomorrow.</p>
            </li>
            <li>
              <span className="step-time">The next day</span>
              <b>Trains run for real.</b>
              <p>MBTA sensors record when each train actually stopped at each platform. Nobody touches the forecast.</p>
            </li>
            <li>
              <span className="step-time">Afterwards</span>
              <b>We keep score.</b>
              <p>If the range was honest, about 80 of every 100 trains should land inside it. Narrower is better, as long as it still holds.</p>
            </li>
          </ol>
        </section>

        <section className="wrap home-sec">
          <h2 className="sec-title">How did it do?</h2>
          <p className="sec-lede">Out of every 100 trains in the four test weeks, this many arrived inside their forecast range.</p>
          <div className="score-grid">
            {release.lines.map((l) => {
              const s = sum?.lines[l.id]?.all.lgbm_schedule_cal
              const caught = s?.coverage != null ? Math.round(s.coverage * 100) : null
              return (
                <button key={l.id} className="score" style={{ ['--c' as string]: l.color }} onClick={() => { onLine(l.id); location.hash = `#/replay?line=${l.id}` }}>
                  <header><span className="line-dot" aria-hidden>{l.id[0]}</span>{l.name}</header>
                  <DotGrid filled={caught ?? 0} />
                  <p className="score-big">{caught ?? '—'}<small> of 100 trains</small></p>
                  <p className="score-sub">
                    {s?.width_min != null ? <>Ranges averaged <b>{s.width_min.toFixed(0)} minutes</b> wide. </> : null}
                    {s?.mae_min != null ? <>The middle of the range missed by <b>{s.mae_min.toFixed(1)} min</b> on average.</> : null}
                  </p>
                  <span className="score-go">Replay the {l.name} →</span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="wrap home-sec two-col">
          <div>
            <h2 className="sec-title">Why are the ranges so wide?</h2>
            <p className="sec-p">
              Boston's subway runs on <em>frequency</em> ("a train every 6 minutes") more than on an exact timetable. When one train
              starts late, the next scheduled slot can be filled minutes later by a different train. Measured against a printed
              schedule, that looks like a big delay, even if riders barely waited.
            </p>
            <p className="sec-p">
              An honest forecast has to admit that. A range that says "4 to 28 minutes" is less satisfying than "6 minutes", but it is
              right far more often.
            </p>
          </div>
          <div>
            <h2 className="sec-title">What this is not</h2>
            <ul className="plain-list">
              <li>Not live: it replays past days, from {dateLabel(release.splits.test[0])} to {dateLabel(release.splits.test[1])}.</li>
              <li>Not an official MBTA tool. It uses MBTA's public performance data and published schedules.</li>
              <li>Not a trip planner. It asks one question: how much should you trust a predicted arrival time?</li>
            </ul>
            <p className="sec-p"><a href="#/method">Read the full method</a> for the data, model and caveats.</p>
          </div>
        </section>
      </main>
    </>
  )
}

// ---------------------------------------------------------------- hero map

function HeroMap({ nets, date }: { nets: StationsFile[]; date: string }) {
  const [reps, setReps] = useState<Record<string, Replay>>({})
  const [t, setT] = useState(LOOP_FROM)
  useEffect(() => {
    let live = true
    for (const n of nets) loadReplay(n.line_id, date).then((r) => live && setReps((x) => ({ ...x, [n.line_id]: r }))).catch(() => {})
    return () => { live = false }
  }, [nets, date])

  const reduce = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (reduce.current) { setT(8 * 3600); return }
    let raf = 0
    let last: number | null = null
    const tick = (now: number) => {
      const dt = last == null ? 0 : Math.min(0.1, (now - last) / 1000)
      last = now
      setT((v) => (v + dt * SPEED > LOOP_TO ? LOOP_FROM : v + dt * SPEED))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const W = 560
  const H = 600
  const proj = useMemo(() => {
    const pts = nets.flatMap((n) => n.stations.map((s) => [s.lon, s.lat]))
    const lons = pts.map((p) => p[0])
    const lats = pts.map((p) => p[1])
    const [x0, x1, y0, y1] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)]
    const kx = Math.cos(((y0 + y1) / 2) * (Math.PI / 180))
    // Leave room on the right for terminal labels such as "Wonderland".
    const s = Math.min((W - 130) / ((x1 - x0) * kx), (H - 60) / (y1 - y0))
    const ox = 24 + (W - 130 - (x1 - x0) * kx * s) / 2
    const oy = (H - (y1 - y0) * s) / 2
    return ([lon, lat]: number[]) => [ox + (lon - x0) * kx * s, oy + (y1 - lat) * s] as [number, number]
  }, [nets])

  const layers = useMemo(() => nets.map((n) => {
    const st = new Map(n.stations.map((s) => [s.id, s]))
    return {
      net: n,
      paths: n.branches.map((b) => b.shape.map((c, i) => `${i ? 'L' : 'M'}${proj(c).map((v) => v.toFixed(1)).join(',')}`).join('')),
      placers: n.branches.map((b) => makeShapePlacer(b, st)),
    }
  }), [nets, proj])
  const trackers = useMemo(() => Object.fromEntries(nets.map((n) => [n.line_id, reps[n.line_id] ? makeTracker(reps[n.line_id], n) : null])), [nets, reps])
  const base = Object.values(reps)[0]?.base_epoch
  const count = layers.reduce((a, l) => a + (trackers[l.net.line_id]?.observed(t).length ?? 0), 0)

  return (
    <figure className="hero-map" aria-label={`Animated map of Blue, Red and Green Line trains on the morning of ${dateLabel(date)}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden>
        <defs>
          <radialGradient id="hm-glow"><stop offset="0" stopColor="#fff" stopOpacity="0.9" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
        </defs>
        {layers.map((l) => l.paths.map((d, i) => (
          <path key={`${l.net.line_id}${i}`} d={d} className="hm-line" stroke={l.net.color} style={{ animationDelay: `${i * 80}ms` }} />
        )))}
        {layers.map((l) => l.net.stations.map((s) => {
          const [x, y] = proj([s.lon, s.lat])
          return <circle key={`${l.net.line_id}${s.id}`} cx={x} cy={y} r={2.4} className="hm-stn" />
        }))}
        {layers.map((l) => (trackers[l.net.line_id]?.observed(t) ?? []).map((tr) => {
          const [x, y] = proj(l.placers[tr.branch](tr.idx))
          const late = tr.delay != null && tr.delay > 300
          return (
            <g key={`${l.net.line_id}${tr.trip}`} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
              <circle r={8} fill={late ? '#ED8B00' : l.net.color} opacity={0.25} />
              <circle r={3.6} fill={late ? '#ED8B00' : '#fff'} stroke={l.net.color} strokeWidth={1.8} />
            </g>
          )
        }))}
        {[['Alewife', 'place-alfcl'], ['Wonderland', 'place-wondl'], ['Ashmont', 'place-asmnl'], ['Braintree', 'place-brntn'], ['Riverside', 'place-river'], ['Medford/Tufts', 'place-mdftf'], ['Downtown', 'place-dwnxg']].map(([name, id]) => {
          const s = nets.flatMap((n) => n.stations).find((x) => x.id === id)
          if (!s) return null
          const [x, y] = proj([s.lon, s.lat])
          return <text key={id} x={x + 8} y={y + 4} className="hm-label">{name}</text>
        })}
      </svg>
      <figcaption>
        <span className="hm-clock">{base != null ? clock(base, t) : '—'}</span>
        <span>{dateLabel(date)} · {count} trains moving · recorded positions, sped up {SPEED}×</span>
      </figcaption>
    </figure>
  )
}

// ---------------------------------------------------------------- explainer

const STAGES = [
  { k: 'sched', text: 'The timetable says the train is due at 8:15.' },
  { k: 'range', text: 'The night before, the forecast said: most likely 8:17, and 8 times out of 10 between 8:14 and 8:21.' },
  { k: 'obs', text: 'It actually arrived at 8:19, inside the range. The forecast was honest about its uncertainty.' },
]

function RangeExplainer() {
  const [stage, setStage] = useState(0)
  const [paused, setPaused] = useState(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (paused) return
    const id = window.setInterval(() => setStage((s) => (s + 1) % 4), 2600)
    return () => window.clearInterval(id)
  }, [paused])
  const shown = paused ? 3 : stage
  const x = (min: number) => 40 + ((min - 10) / 14) * 620 // 8:10 .. 8:24
  return (
    <div className="explainer">
      <svg viewBox="0 0 700 150" role="img" aria-label="Example: scheduled 8:15, forecast range 8:14 to 8:21 with 8:17 most likely, actual arrival 8:19.">
        {[10, 12, 14, 16, 18, 20, 22, 24].map((m) => (
          <g key={m} transform={`translate(${x(m)} 0)`}>
            <line y1={30} y2={120} stroke="var(--rule)" />
            <text y={140} textAnchor="middle" className="ex-tick">8:{String(m).padStart(2, '0')}</text>
          </g>
        ))}
        <g className={`ex-mark ${shown >= 1 ? 'on' : ''}`}>
          <rect x={x(14)} y={58} width={x(21) - x(14)} height={30} rx={8} fill="var(--blue-wash)" stroke="var(--blue)" strokeWidth={1.5} className="ex-band" />
          <rect x={x(17) - 2} y={52} width={4} height={42} fill="var(--blue)" />
          <text x={x(17)} y={44} textAnchor="middle" className="ex-lbl" fill="var(--blue)">forecast</text>
        </g>
        <g className={`ex-mark ${shown >= 0 ? 'on' : ''}`}>
          <circle cx={x(15)} cy={73} r={9} fill="var(--panel)" stroke="var(--sched)" strokeWidth={3} />
          <text x={x(15)} y={112} textAnchor="middle" className="ex-lbl" fill="var(--sched)">scheduled</text>
        </g>
        <g className={`ex-mark drop ${shown >= 2 ? 'on' : ''}`} transform={`translate(${x(19)} 73)`}>
          <rect x={-9} y={-9} width={18} height={18} transform="rotate(45)" fill="var(--actual)" stroke="var(--panel)" strokeWidth={2} />
          <text y={39} textAnchor="middle" className="ex-lbl" fill="var(--actual)">arrived</text>
        </g>
      </svg>
      <div className="ex-legend" role="list">
        {STAGES.map((s, i) => (
          <button key={s.k} role="listitem" className={`ex-step ${shown >= i ? 'on' : ''} ${shown === i ? 'cur' : ''}`} onClick={() => { setPaused(true); setStage(i) }}>
            <i className={`key ${s.k === 'sched' ? 'sched' : s.k === 'range' ? 'band-k' : 'obs'}`} />
            <span>{s.text}</span>
          </button>
        ))}
      </div>
      <p className="ex-note">Example with round numbers. Real replays use MBTA's recorded arrivals.</p>
    </div>
  )
}

function DotGrid({ filled }: { filled: number }) {
  return (
    <svg className="dots" viewBox="0 0 200 200" aria-hidden>
      {Array.from({ length: 100 }, (_, i) => {
        const on = i < filled
        return (
          <circle key={i} cx={10 + (i % 10) * 20} cy={10 + Math.floor(i / 10) * 20} r={7}
            fill={on ? 'var(--c)' : 'none'} stroke={on ? 'none' : 'var(--rule)'} strokeWidth={1.5}
            style={{ animationDelay: `${i * 9}ms` }} className="dot" />
        )
      })}
    </svg>
  )
}
