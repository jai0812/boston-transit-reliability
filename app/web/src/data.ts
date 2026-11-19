// Data contracts for the static release under /api/v1 and helpers to decode it.

export type LineId = 'Blue' | 'Red' | 'Green' | string

export type Platform = { stop_id: string; dir: number; route_id: string }

export type Station = {
  id: string
  name: string
  lat: number
  lon: number
  directions: number[]
  routes: string[]
  platforms: Platform[]
}

export type Branch = {
  id: string
  route_id: string
  name: string
  letter: string | null
  stations: string[]
  shape: number[][]
}

export type StationsFile = {
  line_id: LineId
  name: string
  color: string
  directions: Record<string, string>
  order_direction: number
  stations: Station[]
  branches: Branch[]
}

export type Preset = {
  line_id: LineId
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
  events?: number
  observed?: number
  source_gap: boolean
  weekday: string
}

export type LineMeta = {
  id: LineId
  name: string
  color: string
  routes: string[]
  directions: Record<string, string>
  featured_system: string
  replay_dates: ReplayDate[]
  presets: Preset[]
  branches: { id: string; name: string; letter: string | null }[]
  headline: { mae_min: number; coverage: number; width_min: number; n: number }
}

export type Release = {
  release_id: string
  code_commit: string
  generated_at: string
  timezone: string
  forecast_origin_rule: string
  displayed_model: string
  nominal_coverage: number
  splits: Record<string, [string, string]>
  lines: LineMeta[]
  replay_dates: ReplayDate[]
  snapshot_status: string
  retrospective_notes: string[]
  sources: { name: string; url: string }[]
  disclaimer: string
  inputs: { lamp_files: number; gtfs_feeds: number }
}

export type Interval = { p50: number | null; lo: number | null; hi: number | null }

export type Trip = { id: string; dir: number; headsign: string; route: string; branch: number }

export type ReplayEvent = {
  id: string
  trip: number
  tripId: string
  dir: number
  headsign: string
  route: string
  branch: number
  stop: string
  station: string
  sched: number // seconds since service-day base
  obs: number | null
  status: string
  model: Interval // absolute offsets, not delays
  hist: Interval
}

export type Replay = {
  line_id: LineId
  service_date: string
  release_id: string
  base_epoch: number
  forecast_origin_at: string
  nominal_coverage: number
  events: ReplayEvent[]
  trips: Trip[]
}

type Num = number | null
type RawReplay = {
  line_id: string
  service_date: string
  release_id: string
  base_epoch: number
  forecast_origin_at: string
  nominal_coverage: number
  platforms: { stop_id: string[]; station: string[] }
  trips: { id: string[]; dir: number[]; headsign: string[]; route: string[]; branch: number[] }
  events: {
    trip: number[]; plat: number[]; sched: number[]; obs: Num[]; status: number[]
    m_p50: Num[]; m_lo: Num[]; m_hi: Num[]; h_p50: Num[]; h_lo: Num[]; h_hi: Num[]
  }
  status_codes: string[]
}

const BASE = `${import.meta.env.BASE_URL}api/v1`

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}/${path}`)
  if (!r.ok) throw new Error(`${path} returned ${r.status}`)
  return r.json() as Promise<T>
}

const cache = new Map<string, Promise<unknown>>()
function cached<T>(key: string, f: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) {
    const p = f()
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return cache.get(key) as Promise<T>
}

export const loadRelease = () => cached('release', () => getJSON<Release>('release.json'))
export const loadStations = (line: LineId) =>
  cached(`st:${line}`, () => getJSON<StationsFile>(`lines/${line}/stations.json`))
export const loadMetrics = (line: LineId) =>
  cached(`m:${line}`, () => getJSON<Metrics>(`lines/${line}/metrics.json`))
export const loadSummary = () => cached('summary', () => getJSON<Summary>('metrics.json'))
export const loadReplay = (line: LineId, date: string) =>
  cached(`r:${line}:${date}`, () => getJSON<RawReplay>(`lines/${line}/replay/${date}.json`).then(decode))

function decode(r: RawReplay): Replay {
  const e = r.events
  const add = (base: number, d: Num) => (d == null ? null : base + d)
  const trips: Trip[] = r.trips.id.map((id, i) => ({
    id, dir: r.trips.dir[i], headsign: r.trips.headsign[i], route: r.trips.route[i], branch: r.trips.branch[i],
  }))
  const events: ReplayEvent[] = e.trip.map((t, i) => {
    const tr = trips[t]
    const s = e.sched[i]
    const stop = r.platforms.stop_id[e.plat[i]]
    return {
      id: `${tr.id}:${stop}`,
      trip: t,
      tripId: tr.id,
      dir: tr.dir,
      headsign: tr.headsign,
      route: tr.route,
      branch: tr.branch,
      stop,
      station: r.platforms.station[e.plat[i]],
      sched: s,
      obs: e.obs[i],
      status: r.status_codes[e.status[i]],
      model: { p50: add(s, e.m_p50[i]), lo: add(s, e.m_lo[i]), hi: add(s, e.m_hi[i]) },
      hist: { p50: add(s, e.h_p50[i]), lo: add(s, e.h_lo[i]), hi: add(s, e.h_hi[i]) },
    }
  })
  return {
    line_id: r.line_id, service_date: r.service_date, release_id: r.release_id,
    base_epoch: r.base_epoch, forecast_origin_at: r.forecast_origin_at,
    nominal_coverage: r.nominal_coverage, events, trips,
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

type Decision = {
  beats_historical_mae: boolean
  coverage_in_band: boolean
  interval_score_better_than_historical: boolean
  promote_lightgbm: boolean
  featured_system: string
  criteria: { coverage_band: [number, number] }
}
type Counts = {
  test_days: number
  source_gap_days: string[]
  eligible_events: number
  usable_events: number
  observation_coverage: number
  status_counts: Record<string, number>
}
type Boot = Record<string, { mae_diff_vs_historical_min: number; ci95: [number, number] }>

export type Summary = {
  lines: Record<string, { systems: Record<string, string>; all: Record<string, Score>; bootstrap: Boot; counts: Counts; decision: Decision }>
}

export type Metrics = {
  line_id: LineId
  systems: Record<string, string>
  segments: string[]
  results: Record<string, Record<string, Score>>
  bootstrap: Boot
  counts: Counts
  decision: Decision
  nominal_coverage: number
  small_group_threshold: number
  calibration: Record<string, { adjustment_s: number; n_calibration: number; calibration_coverage_before: number }>
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

// ---------------------------------------------------------------- time + format

const TZ = 'America/New_York'
const fmtClock = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
const fmtClockSec = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' })
const fmtDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })

export const toDate = (base: number, off: number) => new Date((base + off) * 1000)
export const clock = (base: number, off: number) => fmtClock.format(toDate(base, off))
export const clockSec = (base: number, off: number) => fmtClockSec.format(toDate(base, off))
export const dateLabel = (d: string) => fmtDate.format(new Date(`${d}T00:00:00Z`))

export function signedMin(sec: number | null, digits = 1): string {
  if (sec == null) return '—'
  const m = sec / 60
  const s = m.toFixed(digits)
  return m > 0.05 ? `+${s}` : m < -0.05 ? s.replace('-', '−') : '0'
}

export const pct = (x: number | undefined, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`)
