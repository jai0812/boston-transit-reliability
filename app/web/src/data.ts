// Data contracts for the static release under /api/v1 and helpers to decode it.

export type Station = {
  id: string
  name: string
  order: number
  lat: number
  lon: number
  platforms: Record<string, string>
  directions: number[]
}

export type StationsFile = {
  stations: Station[]
  line: { type: 'Feature'; properties: Record<string, unknown>; geometry: { type: 'LineString'; coordinates: number[][] } }
  directions: Record<string, string>
}

export type Preset = {
  kind: 'handled_well' | 'typical' | 'missed'
  service_date: string
  station_id: string
  station_name: string
  direction_id: number
  bucket: string
  n: number
  coverage: number
  mae_min: number
  median_delay_min: number
  start_offset: number
  blurb: string
}

export type ReplayDate = {
  service_date: string
  events: number
  observed: number
  source_gap: boolean
  weekday: string
}

export type Release = {
  release_id: string
  code_commit: string
  generated_at: string
  timezone: string
  forecast_origin_rule: string
  featured_system: string
  displayed_model: string
  nominal_coverage: number
  splits: Record<string, [string, string]>
  replay_dates: ReplayDate[]
  presets: Preset[]
  snapshot_status: string
  retrospective_notes: string[]
  sources: { name: string; url: string }[]
  disclaimer: string
  inputs: { lamp_files: number; gtfs_feeds: number }
}

export type Interval = { p50: number | null; lo: number | null; hi: number | null }

export type ReplayEvent = {
  id: string
  trip: number
  tripId: string
  dir: number
  headsign: string
  stop: string
  station: string
  order: number
  sched: number // seconds since service-day base
  obs: number | null
  status: string
  model: Interval // absolute offsets, not delays
  hist: Interval
}

export type Replay = {
  service_date: string
  release_id: string
  base_epoch: number
  forecast_origin_at: string
  nominal_coverage: number
  events: ReplayEvent[]
  trips: { id: string; dir: number; headsign: string }[]
}

type RawReplay = {
  service_date: string
  release_id: string
  base_epoch: number
  forecast_origin_at: string
  nominal_coverage: number
  trips: { id: string[]; dir: number[]; headsign: string[] }
  events: {
    trip: number[]
    stop: string[]
    sched: number[]
    obs: (number | null)[]
    status: number[]
    m_p50: (number | null)[]
    m_lo: (number | null)[]
    m_hi: (number | null)[]
    h_p50: (number | null)[]
    h_lo: (number | null)[]
    h_hi: (number | null)[]
  }
  status_codes: string[]
}

const BASE = `${import.meta.env.BASE_URL}api/v1`

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/${path}`)
  if (!r.ok) throw new Error(`${path} returned ${r.status}`)
  return r.json() as Promise<T>
}

export const loadRelease = () => getJSON<Release>('release.json')
export const loadStations = () => getJSON<StationsFile>('stations.json')
export const loadMetrics = () => getJSON<Metrics>('metrics.json')

const replayCache = new Map<string, Promise<Replay>>()

export function loadReplay(date: string, stations: Station[]): Promise<Replay> {
  if (!replayCache.has(date)) {
    replayCache.set(date, getJSON<RawReplay>(`replay/${date}.json`).then((r) => decode(r, stations)))
  }
  return replayCache.get(date)!
}

function decode(r: RawReplay, stations: Station[]): Replay {
  const byStop = new Map<string, Station>()
  for (const s of stations) for (const p of Object.values(s.platforms)) byStop.set(p, s)
  const e = r.events
  const add = (base: number, d: number | null) => (d == null ? null : base + d)
  const events: ReplayEvent[] = e.trip.map((t, i) => {
    const st = byStop.get(e.stop[i])
    const s = e.sched[i]
    return {
      id: `${r.trips.id[t]}:${e.stop[i]}`,
      trip: t,
      tripId: r.trips.id[t],
      dir: r.trips.dir[t],
      headsign: r.trips.headsign[t],
      stop: e.stop[i],
      station: st?.id ?? e.stop[i],
      order: st?.order ?? -1,
      sched: s,
      obs: e.obs[i],
      status: r.status_codes[e.status[i]],
      model: { p50: add(s, e.m_p50[i]), lo: add(s, e.m_lo[i]), hi: add(s, e.m_hi[i]) },
      hist: { p50: add(s, e.h_p50[i]), lo: add(s, e.h_lo[i]), hi: add(s, e.h_hi[i]) },
    }
  })
  return {
    service_date: r.service_date,
    release_id: r.release_id,
    base_epoch: r.base_epoch,
    forecast_origin_at: r.forecast_origin_at,
    nominal_coverage: r.nominal_coverage,
    events,
    trips: r.trips.id.map((id, i) => ({ id, dir: r.trips.dir[i], headsign: r.trips.headsign[i] })),
  }
}

// ---------------------------------------------------------------- metrics

export type Score = {
  n: number
  mae_min?: number
  bias_min?: number
  coverage?: number
  width_min?: number
  interval_score_min?: number
  late_miss_rate?: number
  early_miss_rate?: number
  pinball_s?: Record<string, number>
}

export type Metrics = {
  systems: Record<string, string>
  segments: string[]
  results: Record<string, Record<string, Score>>
  bootstrap: Record<string, { mae_diff_vs_historical_min: number; ci95: [number, number] }>
  counts: {
    test_days: number
    source_gap_days: string[]
    eligible_events: number
    usable_events: number
    observation_coverage: number
    status_counts: Record<string, number>
  }
  decision: {
    beats_historical_mae: boolean
    coverage_in_band: boolean
    interval_score_better_than_historical: boolean
    promote_lightgbm: boolean
    featured_system: string
    criteria: { coverage_band: [number, number] }
  }
  nominal_coverage: number
  small_group_threshold: number
  calibration: Record<string, { adjustment_s: number; n_calibration: number; calibration_coverage_before: number }>
  training: Record<string, { columns: string[]; best_iteration: Record<string, number>; validation_crossing_rate: number; selected_params: Record<string, unknown>; trials: { params: Record<string, unknown>; mean_val_pinball: number }[] }>
  training_manifest: Record<string, unknown>
  data_quality: {
    service_date: string
    direction_id: number
    planned_events: number
    observed: number
    unobserved: number
    source_gap: number
    added_trip_rows: number | null
    match_rate: number | null
    split: string | null
  }[]
}

// ---------------------------------------------------------------- time

const TZ = 'America/New_York'
const fmtClock = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
const fmtClockSec = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit',
})
const fmtDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
})

export const toDate = (base: number, off: number) => new Date((base + off) * 1000)
export const clock = (base: number, off: number) => fmtClock.format(toDate(base, off))
export const clockSec = (base: number, off: number) => fmtClockSec.format(toDate(base, off))
export const dateLabel = (d: string) => fmtDate.format(new Date(`${d}T00:00:00Z`))
export const utcIso = (base: number, off: number) => toDate(base, off).toISOString()

export function signedMin(sec: number | null, digits = 1): string {
  if (sec == null) return '—'
  const m = sec / 60
  const s = m.toFixed(digits)
  return m > 0.05 ? `+${s}` : m < -0.05 ? s.replace('-', '−') : '0'
}

export const pct = (x: number | undefined, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`)
