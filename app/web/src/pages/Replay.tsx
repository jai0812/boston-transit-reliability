import { useEffect, useMemo, useRef, useState } from 'react'
import { Board } from '../components/Board'
import { EventTable } from '../components/EventTable'
import { LineStrip } from '../components/LineStrip'
import { MapView, type Arrival } from '../components/MapView'
import { Schematic } from '../components/Schematic'
import { Timeline } from '../components/Timeline'
import {
  clock, clockSec, dateLabel, loadReplay, pct,
  type Interval, type LineMeta, type Release, type Replay as ReplayData, type ReplayEvent, type StationsFile,
} from '../data'
import { makeConverter, makeTracker } from '../trains'

type Props = { release: Release; line: LineMeta; nets: StationsFile[]; query: URLSearchParams }
type ModelKey = 'model' | 'hist'
const SPEEDS = [30, 60, 120, 300]

export function Replay(props: Props) {
  // Remount per line so every piece of state starts from that line's own defaults.
  return <LineReplay key={props.line.id} {...props} />
}

function LineReplay({ release, line, nets, query }: Props) {
  const net = nets.find((n) => n.line_id === line.id)!
  const stationsById = useMemo(() => new Map(net.stations.map((s) => [s.id, s])), [net])
  const fromUrl = query.get('line') === line.id
  const preset = line.presets.find((p) => p.kind === 'typical') ?? line.presets[0]
  const validDates = line.replay_dates.filter((d) => !d.source_gap)
  const [date, setDate] = useState((fromUrl && query.get('d')) || preset?.service_date || validDates[0].service_date)
  const [station, setStation] = useState((fromUrl && query.get('s')) || preset?.station_id || net.stations[0].id)
  const [dir, setDir] = useState(Number((fromUrl && query.get('dir')) ?? preset?.direction_id ?? 0))
  const [modelKey, setModelKey] = useState<ModelKey>('model')
  const [t, setT] = useState(Number((fromUrl && query.get('t')) || (preset ? preset.start_offset - 600 : 7 * 3600)))
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(60)
  const [data, setData] = useState<ReplayData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const st = stationsById.get(station) ?? net.stations[0]
  const branchOf = (sid: string, prefer?: number) => {
    if (prefer != null && net.branches[prefer]?.stations.includes(sid)) return prefer
    return Math.max(0, net.branches.findIndex((b) => b.stations.includes(sid)))
  }
  const [branch, setBranch] = useState(() => branchOf(station))

  useEffect(() => {
    let live = true
    setError(null)
    loadReplay(line.id, date).then((r) => live && setData(r)).catch((e) => live && setError(String(e.message ?? e)))
    return () => { live = false }
  }, [line.id, date])

  useEffect(() => { if (!st.directions.includes(dir)) setDir(st.directions[0]) }, [st, dir])

  const selectStation = (id: string) => {
    setStation(id)
    setBranch((b) => branchOf(id, b))
  }

  useEffect(() => {
    const id = window.setTimeout(() => {
      const q = new URLSearchParams({ line: line.id, d: date, s: station, dir: String(dir), t: String(Math.round(t)) })
      history.replaceState(null, '', `#/replay?${q}`)
    }, 400)
    return () => window.clearTimeout(id)
  }, [line.id, date, station, dir, t])

  const ready = data?.service_date === date && data.line_id === line.id ? data : null
  const range = useMemo(() => {
    if (!ready) return [5 * 3600, 25 * 3600]
    let lo = Infinity
    let hi = -Infinity
    for (const e of ready.events) { if (e.sched < lo) lo = e.sched; if (e.sched > hi) hi = e.sched }
    return [lo - 900, hi + 900]
  }, [ready])

  const last = useRef<number | null>(null)
  useEffect(() => {
    if (!playing) { last.current = null; return }
    let raf = 0
    const tick = (now: number) => {
      const dt = last.current == null ? 0 : Math.min(0.25, (now - last.current) / 1000)
      last.current = now
      setT((v) => {
        const nv = v + dt * speed
        if (nv >= range[1]) { setPlaying(false); return range[1] }
        return nv
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, range])

  // Space toggles play, arrows nudge the clock by a minute.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p) }
      if (e.key === 'ArrowRight') setT((v) => v + 60)
      if (e.key === 'ArrowLeft') setT((v) => v - 60)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const pick = useMemo(
    () => (modelKey === 'model' ? (e: ReplayEvent): Interval => e.model : (e: ReplayEvent): Interval => e.hist),
    [modelKey],
  )
  const events = useMemo(
    () => (ready ? ready.events.filter((e) => e.station === station && e.dir === dir).sort((a, b) => a.sched - b.sched) : []),
    [ready, station, dir],
  )
  const tracker = useMemo(() => (ready ? makeTracker(ready, net) : null), [ready, net])
  const convert = useMemo(() => makeConverter(net), [net])
  const trains = tracker?.observed(t) ?? []
  const ghosts = tracker && modelKey === 'model' ? tracker.forecast(t) : []

  const arrivals: Arrival[] = events
    .filter((e) => e.obs != null && e.status === 'observed' && t >= e.obs && t - e.obs < 30)
    .map((e) => ({ key: e.id, lon: st.lon, lat: st.lat }))

  const sofar = events.filter((e) => e.obs != null && e.obs <= t && pick(e).lo != null)
  const inside = sofar.filter((e) => e.obs! >= pick(e).lo! && e.obs! <= pick(e).hi!).length

  const applyPreset = (p: LineMeta['presets'][number]) => {
    setDate(p.service_date)
    selectStation(p.station_id)
    setDir(p.direction_id)
    setT(p.start_offset - 600)
    setPlaying(true)
  }

  const base = ready?.base_epoch ?? 0
  const originText = ready
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ready.forecast_origin_at))
    : ''
  const dirLabel = (d: number) => line.directions[String(d)] ?? (d ? 'Direction 1' : 'Direction 0')
  const routesHere = st.routes.filter((r) => r.startsWith('Green-')).map((r) => r.slice(6))

  return (
    <>
      <section className="sign" aria-labelledby="station-name">
        <div className="sign-train" key={`${line.id}:${station}`} aria-hidden><i /></div>
        <div className="wrap">
          <div style={{ minWidth: 0 }}>
            <h1 className="sign-name" id="station-name" key={`n:${line.id}:${station}`} aria-label={st.name}>
              {st.name.split(' ').map((word, wi, words) => {
                const start = words.slice(0, wi).join(' ').length + (wi ? 1 : 0)
                return (
                  <span className="word" key={wi} aria-hidden>
                    {[...word].map((c, i) => <span className="ch" style={{ ['--i' as string]: start + i }} key={i}>{c}</span>)}
                    {wi < words.length - 1 ? ' ' : ''}
                  </span>
                )
              })}
            </h1>
            <div className="sign-sub">
              <span className="route-chip">{line.name}{routesHere.length ? ` · ${routesHere.join(' ')}` : ''}</span>
              <span className="pill-dir">{dirLabel(dir)}</span>
              <span>{dateLabel(date)}</span>
              <span className="tag-hist">Historical replay</span>
            </div>
          </div>
          {ready && <Board events={events} t={t} pick={pick} />}
        </div>
      </section>

      <main className="wrap grid">
        <section className="panel" aria-labelledby="pick-h">
          <div className="panel-h">
            <h2 id="pick-h">Pick a commute</h2>
            <p>Test weeks only: the model never saw these days. Forecasts were fixed at 8 PM the night before.</p>
          </div>
          <div className="controls">
            <div className="field">
              <label htmlFor="station">Station</label>
              <select id="station" value={station} onChange={(e) => selectStation(e.target.value)}>
                {net.branches.length > 1
                  ? net.branches.map((b, bi) => (
                      <optgroup key={b.id} label={b.name}>
                        {b.stations.filter((sid) => stationsById.has(sid) && (bi === branchOf(sid) )).map((sid) => (
                          <option key={sid} value={sid}>{stationsById.get(sid)!.name}</option>
                        ))}
                      </optgroup>
                    ))
                  : net.branches[0].stations.filter((sid) => stationsById.has(sid)).map((sid) => (
                      <option key={sid} value={sid}>{stationsById.get(sid)!.name}</option>
                    ))}
              </select>
            </div>
            <div className="field">
              <span className="lbl" id="dir-l">Direction</span>
              <div className="seg" role="group" aria-labelledby="dir-l">
                {[0, 1].map((d) => (
                  <button key={d} aria-pressed={dir === d} disabled={!st.directions.includes(d)} onClick={() => setDir(d)}>
                    {dirLabel(d).replace(/^(Westbound|Eastbound|Southbound|Northbound) to /, '→ ')}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="date">Service date</label>
              <select id="date" value={date} onChange={(e) => setDate(e.target.value)}>
                {line.replay_dates.map((d) => (
                  <option key={d.service_date} value={d.service_date} disabled={d.source_gap}>
                    {dateLabel(d.service_date)}{d.source_gap ? ' — no MBTA data' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="lbl" id="model-l">Forecast</span>
              <div className="seg" role="group" aria-labelledby="model-l">
                <button aria-pressed={modelKey === 'model'} onClick={() => setModelKey('model')}>LightGBM</button>
                <button aria-pressed={modelKey === 'hist'} onClick={() => setModelKey('hist')}>Historical</button>
              </div>
            </div>
          </div>
          <div className="presets">
            {line.presets.map((p) => (
              <button key={p.kind} className="preset" data-kind={p.kind} onClick={() => applyPreset(p)}>
                <i>{p.kind === 'handled_well' ? 'Handled well' : p.kind === 'missed' ? 'Missed' : 'Typical'}</i>
                <b>{p.station_name} · {dirLabel(p.direction_id).replace(/^(Westbound|Eastbound|Southbound|Northbound) /, '')}</b>
                <span>{dateLabel(p.service_date)}, {p.bucket === 'am_peak' ? 'morning' : 'evening'} rush. {p.blurb}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel" aria-labelledby="line-h">
          <div className="panel-h">
            <h2 id="line-h">The whole line</h2>
            <p>Solid trains are recorded positions; dashed outlines are where the forecast expected them. Orange means 5+ minutes late.</p>
          </div>
          {error ? (
            <div className="state"><b>This day didn't load</b>{error}. Pick another date.</div>
          ) : !ready ? (
            <div className="loading-line" role="status" aria-label="Loading replay" />
          ) : (
            <>
              {net.branches.length > 1 && (
                <div className="hscroll" style={{ padding: '6px 10px 0' }}>
                  <Schematic net={net} stationsById={stationsById} selected={station} activeBranch={branch} trains={trains} onSelect={selectStation} onBranch={setBranch} />
                </div>
              )}
              {net.branches.length > 1 && (
                <div className="chips" role="group" aria-label="Branch shown on the strip map">
                  <span className="lbl" style={{ marginRight: 4 }}>Strip map</span>
                  {net.branches.map((b, i) => (
                    <button key={b.id} className="chip" aria-pressed={i === branch} onClick={() => setBranch(i)}>
                      {b.letter && <b>{b.letter}</b>}{b.letter ? b.name.split(' · ')[1] : b.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="hscroll">
                <LineStrip
                  branch={net.branches[branch]} branchIndex={branch} stationsById={stationsById} selected={station}
                  direction={dir} orderDirection={net.order_direction} directions={line.directions}
                  trains={trains} ghosts={ghosts} convert={convert} onSelect={selectStation}
                />
              </div>
            </>
          )}
          <div className="transport">
            <button className={`play${playing ? ' on' : ''}`} onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause replay' : 'Play replay'} title="Space">
              {playing ? (
                <svg viewBox="0 0 20 20" aria-hidden><rect x="4" y="3" width="4" height="14" fill="currentColor" /><rect x="12" y="3" width="4" height="14" fill="currentColor" /></svg>
              ) : (
                <svg viewBox="0 0 20 20" aria-hidden><path d="M5 3 L17 10 L5 17 Z" fill="currentColor" /></svg>
              )}
            </button>
            <div className="speed" role="group" aria-label="Replay speed">
              {SPEEDS.map((s) => <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
            </div>
            <input
              className="scrub" type="range" min={range[0]} max={range[1]} step={30} value={t}
              aria-label="Replay clock" aria-valuetext={ready ? clock(base, t) : undefined}
              onChange={(e) => setT(Number(e.target.value))}
            />
            <div className="now">{ready ? clockSec(base, t) : '—'}<small>Boston time</small></div>
          </div>
        </section>

        <div className="grid two">
          <section className="panel" aria-labelledby="tl-h">
            <div className="panel-h">
              <h2 id="tl-h">Forecast vs. what happened</h2>
              <p>{sofar.length ? `${inside} of ${sofar.length} arrivals so far landed inside the range (${pct(inside / sofar.length)}).` : 'Press play to reveal recorded arrivals.'}</p>
            </div>
            {ready && <div className="hscroll"><Timeline events={events} t={t} base={base} pick={pick} /></div>}
            <div className="legend">
              <span><i className="key sched" /> Scheduled</span>
              <span><i className="key band-k" /> 80% forecast range</span>
              <span><i className="key med" /> Median forecast</span>
              <span><i className="key obs" /> Recorded arrival</span>
            </div>
          </section>
          <section className="panel" aria-labelledby="map-h">
            <div className="panel-h">
              <h2 id="map-h">System map</h2>
              <p>All three lines; the {line.name} is live. Click a station.</p>
            </div>
            <MapView nets={nets} active={line.id} selected={station} trains={trains} t={t} arrivals={arrivals} onSelect={selectStation} />
          </section>
        </div>

        {ready && <EventTable events={events} t={t} base={base} pick={pick} />}
        {ready && (
          <p style={{ color: 'var(--ink-3)', fontSize: 13, margin: 0 }}>
            Forecast issued {originText} (day before). Times in Boston time; API timestamps are UTC. Space plays and pauses; ← → move a minute.
            Release <code>{release.release_id}</code>.
          </p>
        )}
      </main>
    </>
  )
}
