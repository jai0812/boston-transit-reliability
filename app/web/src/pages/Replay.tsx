import { useEffect, useMemo, useRef, useState } from 'react'
import { Board } from '../components/Board'
import { EventTable } from '../components/EventTable'
import { LineStrip } from '../components/LineStrip'
import { MapView } from '../components/MapView'
import { Timeline } from '../components/Timeline'
import {
  clock, clockSec, dateLabel, loadReplay, pct,
  type Interval, type Release, type Replay as ReplayData, type ReplayEvent, type StationsFile,
} from '../data'
import { makeTracker } from '../trains'

type Props = { release: Release; stations: StationsFile; query: URLSearchParams }
type ModelKey = 'model' | 'hist'
const SPEEDS = [30, 60, 120, 300]

export function Replay({ release, stations, query }: Props) {
  const preset = release.presets.find((p) => p.kind === 'typical') ?? release.presets[0]
  const validDates = release.replay_dates.filter((d) => !d.source_gap)
  const [date, setDate] = useState(query.get('d') ?? preset?.service_date ?? validDates[0].service_date)
  const [station, setStation] = useState(query.get('s') ?? preset?.station_id ?? stations.stations[5].id)
  const [dir, setDir] = useState(Number(query.get('dir') ?? preset?.direction_id ?? 0))
  const [modelKey, setModelKey] = useState<ModelKey>('model')
  const [t, setT] = useState(Number(query.get('t') ?? (preset ? preset.start_offset - 600 : 7 * 3600)))
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(60)
  const [data, setData] = useState<ReplayData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setError(null)
    loadReplay(date, stations.stations)
      .then((r) => live && setData(r))
      .catch((e) => live && setError(String(e.message ?? e)))
    return () => { live = false }
  }, [date, stations])

  const st = stations.stations.find((s) => s.id === station) ?? stations.stations[0]
  useEffect(() => {
    if (!st.directions.includes(dir)) setDir(st.directions[0])
  }, [st, dir])

  // Keep the URL shareable without adding history entries on every frame.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const q = new URLSearchParams({ d: date, s: station, dir: String(dir), t: String(Math.round(t)) })
      history.replaceState(null, '', `#/replay?${q}`)
    }, 400)
    return () => window.clearTimeout(id)
  }, [date, station, dir, t])

  const ready = data?.service_date === date ? data : null
  const range = useMemo(() => {
    if (!ready) return [5 * 3600, 25 * 3600]
    const s = ready.events.map((e) => e.sched)
    return [Math.min(...s) - 900, Math.max(...s) + 900]
  }, [ready])

  const last = useRef<number | null>(null)
  useEffect(() => {
    if (!playing) { last.current = null; return }
    let raf = 0
    const tick = (now: number) => {
      const dt = last.current == null ? 0 : (now - last.current) / 1000
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

  const pick = useMemo(
    () => (modelKey === 'model' ? (e: ReplayEvent): Interval => e.model : (e: ReplayEvent): Interval => e.hist),
    [modelKey],
  )
  const platform = st.platforms[String(dir)]
  const events = useMemo(
    () => (ready ? ready.events.filter((e) => e.stop === platform).sort((a, b) => a.sched - b.sched) : []),
    [ready, platform],
  )
  const tracker = useMemo(() => (ready ? makeTracker(ready, stations.stations.length) : null), [ready, stations])
  const trains = tracker?.observed(t) ?? []
  const ghosts = tracker && modelKey === 'model' ? tracker.forecast(t) : []

  const sofar = events.filter((e) => e.obs != null && e.obs <= t && pick(e).lo != null)
  const inside = sofar.filter((e) => e.obs! >= pick(e).lo! && e.obs! <= pick(e).hi!).length

  const applyPreset = (p: Release['presets'][number]) => {
    setDate(p.service_date)
    setStation(p.station_id)
    setDir(p.direction_id)
    setT(p.start_offset - 600)
    setPlaying(true)
  }

  const base = ready?.base_epoch ?? 0
  const originText = ready
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ready.forecast_origin_at))
    : ''

  return (
    <>
      <section className="sign" aria-labelledby="station-name">
        <div className="wrap">
          <div>
            <h1 className="sign-name" id="station-name">{st.name}</h1>
            <div className="sign-sub">
              <span className="pill-dir">{dir === 1 ? 'Eastbound → Wonderland' : '← Westbound to Bowdoin'}</span>
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
              <select id="station" value={station} onChange={(e) => setStation(e.target.value)}>
                {stations.stations.slice().sort((a, b) => a.order - b.order).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="lbl" id="dir-l">Direction</span>
              <div className="seg" role="group" aria-labelledby="dir-l">
                <button aria-pressed={dir === 0} disabled={!st.directions.includes(0)} onClick={() => setDir(0)}>← Bowdoin</button>
                <button aria-pressed={dir === 1} disabled={!st.directions.includes(1)} onClick={() => setDir(1)}>Wonderland →</button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="date">Service date</label>
              <select id="date" value={date} onChange={(e) => setDate(e.target.value)}>
                {release.replay_dates.map((d) => (
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
            {release.presets.map((p) => (
              <button key={p.kind} className="preset" data-kind={p.kind} onClick={() => applyPreset(p)}>
                <i>{p.kind === 'handled_well' ? 'Handled well' : p.kind === 'missed' ? 'Missed' : 'Typical'}</i>
                <b>{p.station_name} · {p.direction_id === 1 ? 'to Wonderland' : 'to Bowdoin'}</b>
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
            <div className="hscroll"><LineStrip stations={stations.stations} selected={station} direction={dir} trains={trains} ghosts={ghosts} onSelect={setStation} /></div>
          )}
          <div className="transport">
            <button className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause replay' : 'Play replay'}>
              {playing ? (
                <svg viewBox="0 0 20 20" aria-hidden><rect x="4" y="3" width="4" height="14" fill="currentColor" /><rect x="12" y="3" width="4" height="14" fill="currentColor" /></svg>
              ) : (
                <svg viewBox="0 0 20 20" aria-hidden><path d="M5 3 L17 10 L5 17 Z" fill="currentColor" /></svg>
              )}
            </button>
            <div className="speed" role="group" aria-label="Replay speed">
              {SPEEDS.map((s) => (
                <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>
              ))}
            </div>
            <input
              className="scrub" type="range" min={range[0]} max={range[1]} step={30} value={t}
              aria-label="Replay clock" aria-valuetext={ready ? clock(base, t) : undefined}
              onChange={(e) => setT(Number(e.target.value))}
            />
            <div className="now" aria-live="off">
              {ready ? clockSec(base, t) : '—'}
              <small>Boston time</small>
            </div>
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
              <span><i className="key band" /> 80% forecast range</span>
              <span><i className="key med" /> Median forecast</span>
              <span><i className="key obs" /> Recorded arrival</span>
            </div>
          </section>
          <section className="panel" aria-labelledby="map-h">
            <div className="panel-h">
              <h2 id="map-h">Map</h2>
              <p>Click a station to select it.</p>
            </div>
            <MapView data={stations} selected={station} trains={trains} onSelect={setStation} />
          </section>
        </div>

        {ready && <EventTable events={events} t={t} base={base} pick={pick} />}
        {ready && (
          <p style={{ color: 'var(--ink-3)', fontSize: 13, margin: 0 }}>
            Forecast issued {originText} (day before). Times shown in Boston time; API timestamps are UTC.
            Release <code>{release.release_id}</code>.
          </p>
        )}
      </main>
    </>
  )
}
