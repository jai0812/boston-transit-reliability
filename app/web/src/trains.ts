// Where is each train at replay time t? Positions are fractional station orders (0 = Bowdoin
// end, N-1 = Wonderland end), interpolated between the times a train reached each stop.

import type { Replay, ReplayEvent } from './data'

export type TrainPos = {
  trip: number
  tripId: string
  dir: number
  pos: number // fractional station order
  kind: 'observed' | 'forecast'
  delay: number | null // seconds vs schedule at the last reached stop
}

type Path = { trip: number; tripId: string; dir: number; pts: { t: number; pos: number; delay: number | null }[] }

const DWELL = 25
const LEAD = 140 // seconds the train is drawn leaving its origin terminal before the first stop

function buildPaths(r: Replay, kind: 'observed' | 'forecast', nStations: number): Path[] {
  const byTrip = new Map<number, ReplayEvent[]>()
  for (const e of r.events) {
    if (e.order < 0) continue
    const arr = byTrip.get(e.trip) ?? []
    arr.push(e)
    byTrip.set(e.trip, arr)
  }
  const paths: Path[] = []
  for (const [trip, evs] of byTrip) {
    const pts = evs
      .map((e) => {
        const t = kind === 'observed' ? e.obs : e.model.p50
        return t == null || (kind === 'observed' && e.status !== 'observed')
          ? null
          : { t, pos: e.order, delay: t - e.sched }
      })
      .filter((p): p is { t: number; pos: number; delay: number } => p != null)
      .sort((a, b) => a.t - b.t)
    if (pts.length < 2) continue
    const dir = evs[0].dir
    // Prepend the origin terminal, which has no arrival event.
    const origin = dir === 1 ? 0 : nStations - 1
    if (pts[0].pos !== origin && Math.abs(pts[0].pos - origin) === 1) {
      pts.unshift({ t: pts[0].t - LEAD, pos: origin, delay: pts[0].delay })
    }
    paths.push({ trip, tripId: evs[0].tripId, dir, pts })
  }
  return paths
}

export function makeTracker(r: Replay, nStations: number) {
  const obs = buildPaths(r, 'observed', nStations)
  const fc = buildPaths(r, 'forecast', nStations)
  const at = (paths: Path[], t: number, kind: TrainPos['kind']): TrainPos[] => {
    const out: TrainPos[] = []
    for (const p of paths) {
      const { pts } = p
      if (t < pts[0].t || t > pts[pts.length - 1].t + DWELL) continue
      let i = 0
      while (i < pts.length - 1 && pts[i + 1].t <= t) i++
      const a = pts[i]
      const b = pts[i + 1]
      let pos = a.pos
      if (b && t > a.t + DWELL) {
        const span = b.t - a.t - DWELL
        // Ease in-out between stations so trains brake into platforms.
        const u = span > 0 ? Math.min(1, (t - a.t - DWELL) / span) : 1
        const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2
        pos = a.pos + (b.pos - a.pos) * e
      }
      out.push({ trip: p.trip, tripId: p.tripId, dir: p.dir, pos, kind, delay: a.delay })
    }
    return out
  }
  return {
    observed: (t: number) => at(obs, t, 'observed'),
    forecast: (t: number) => at(fc, t, 'forecast'),
  }
}

// Map a fractional station order onto the line geometry for the map.
export function makeLinePlacer(coords: [number, number][], stations: { order: number; lon: number; lat: number }[]) {
  const cum: number[] = [0]
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1]
    const [x1, y1] = coords[i]
    cum.push(cum[i - 1] + Math.hypot((x1 - x0) * Math.cos((y0 * Math.PI) / 180), y1 - y0))
  }
  const along = stations
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      let best = 0
      let bd = Infinity
      coords.forEach(([x, y], i) => {
        const d = (x - s.lon) ** 2 + (y - s.lat) ** 2
        if (d < bd) { bd = d; best = i }
      })
      return cum[best]
    })
  const pointAt = (dist: number): [number, number] => {
    let i = 1
    while (i < cum.length - 1 && cum[i] < dist) i++
    const seg = cum[i] - cum[i - 1] || 1
    const u = Math.max(0, Math.min(1, (dist - cum[i - 1]) / seg))
    const [x0, y0] = coords[i - 1]
    const [x1, y1] = coords[i]
    return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]
  }
  return (pos: number): [number, number] => {
    const i = Math.max(0, Math.min(along.length - 2, Math.floor(pos)))
    const u = pos - i
    return pointAt(along[i] + (along[i + 1] - along[i]) * u)
  }
}
