// Train positions in replay time, plus layouts for the strip map and the network schematic.
// A position is a fractional index along the trip's own branch (0 = first station of the
// branch as drawn left-to-right). Shared trunk stations let positions move between branches.

import type { Branch, Replay, ReplayEvent, StationsFile } from './data'

export type TrainPos = {
  trip: number
  tripId: string
  dir: number
  branch: number
  route: string
  headsign: string
  idx: number
  kind: 'observed' | 'forecast'
  delay: number | null
  dwelling: boolean
}

type Pt = { t: number; idx: number; delay: number | null }
type Path = { trip: number; tripId: string; dir: number; branch: number; route: string; headsign: string; pts: Pt[] }

const DWELL = 25
const LEAD = 140

function ease(u: number) {
  return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2
}

export function makeTracker(r: Replay, net: StationsFile) {
  const index = net.branches.map((b) => new Map(b.stations.map((s, i) => [s, i])))
  const byTrip = new Map<number, ReplayEvent[]>()
  for (const e of r.events) {
    const a = byTrip.get(e.trip)
    if (a) a.push(e)
    else byTrip.set(e.trip, [e])
  }
  const build = (kind: TrainPos['kind']): Path[] => {
    const out: Path[] = []
    for (const [trip, evs] of byTrip) {
      const tr = r.trips[trip]
      const ix = index[tr.branch]
      if (!ix) continue
      const pts: Pt[] = []
      for (const e of evs) {
        const t = kind === 'observed' ? (e.status === 'observed' ? e.obs : null) : e.model.p50
        const i = ix.get(e.station)
        if (t == null || i == null) continue
        pts.push({ t, idx: i, delay: t - e.sched })
      }
      pts.sort((a, b) => a.t - b.t)
      if (pts.length < 2) continue
      // Drop backwards jumps (bad pings) so trains never teleport against their direction.
      const step = Math.sign(pts[pts.length - 1].idx - pts[0].idx) || 1
      const clean = [pts[0]]
      for (const p of pts.slice(1)) if ((p.idx - clean[clean.length - 1].idx) * step > 0) clean.push(p)
      if (clean.length < 2) continue
      // The origin terminal has no arrival event; start the train there just before its first stop.
      const prev = clean[0].idx - step
      if (prev >= 0 && prev < net.branches[tr.branch].stations.length) {
        clean.unshift({ t: clean[0].t - LEAD, idx: prev, delay: clean[0].delay })
      }
      out.push({ trip, tripId: tr.id, dir: tr.dir, branch: tr.branch, route: tr.route, headsign: tr.headsign, pts: clean })
    }
    return out
  }
  const obs = build('observed')
  const fc = build('forecast')

  const at = (paths: Path[], t: number, kind: TrainPos['kind']): TrainPos[] => {
    const res: TrainPos[] = []
    for (const p of paths) {
      const { pts } = p
      if (t < pts[0].t || t > pts[pts.length - 1].t + DWELL) continue
      let lo = 0
      let hi = pts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (pts[mid].t <= t) lo = mid
        else hi = mid - 1
      }
      const a = pts[lo]
      const b = pts[lo + 1]
      let idx = a.idx
      let dwelling = true
      if (b && t > a.t + DWELL) {
        const span = b.t - a.t - DWELL
        idx = a.idx + (b.idx - a.idx) * ease(span > 0 ? Math.min(1, (t - a.t - DWELL) / span) : 1)
        dwelling = false
      }
      res.push({ trip: p.trip, tripId: p.tripId, dir: p.dir, branch: p.branch, route: p.route, headsign: p.headsign, idx, kind, delay: a.delay, dwelling })
    }
    return res
  }
  return {
    observed: (t: number) => at(obs, t, 'observed'),
    forecast: (t: number) => at(fc, t, 'forecast'),
  }
}

// Convert a fractional index on branch `from` into branch `to`, if that stretch is shared.
export function makeConverter(net: StationsFile) {
  const maps = net.branches.map((from) =>
    net.branches.map((to) => {
      const ix = new Map(to.stations.map((s, i) => [s, i]))
      return from.stations.map((s) => ix.get(s) ?? -1)
    }),
  )
  return (from: number, idx: number, to: number): number | null => {
    if (from === to) return idx
    const m = maps[from]?.[to]
    if (!m) return null
    const i = Math.floor(idx)
    const u = idx - i
    const a = m[i]
    if (a < 0) return null
    if (u < 1e-6) return a
    const b = m[i + 1]
    if (b == null || b < 0 || Math.abs(b - a) !== 1) return null
    return a + (b - a) * u
  }
}

// ---------------------------------------------------------------- schematic layout

export type Schematic = {
  pos: Map<string, { x: number; y: number }>
  width: number
  height: number
  place: (branch: number, idx: number) => [number, number]
}

export function layoutSchematic(net: StationsFile, opts = { dx: 34, dy: 46, pad: 46 }): Schematic {
  const { branches } = net
  const succ = new Map<string, Set<string>>()
  const pred = new Map<string, Set<string>>()
  const all = new Set<string>()
  for (const b of branches) {
    b.stations.forEach((s, i) => {
      all.add(s)
      if (i > 0) {
        const p = b.stations[i - 1]
        if (!succ.has(p)) succ.set(p, new Set())
        if (!pred.has(s)) pred.set(s, new Set())
        succ.get(p)!.add(s)
        pred.get(s)!.add(p)
      }
    })
  }
  // Longest-path layering, then pull branch heads right so they sit next to the trunk.
  const layer = new Map<string, number>()
  const visit = (s: string, seen = new Set<string>()): number => {
    if (layer.has(s)) return layer.get(s)!
    if (seen.has(s)) return 0
    seen.add(s)
    const ps = [...(pred.get(s) ?? [])]
    const v = ps.length ? Math.max(...ps.map((p) => visit(p, seen) + 1)) : 0
    layer.set(s, v)
    return v
  }
  all.forEach((s) => visit(s))
  const heads = [...all].filter((s) => !(pred.get(s)?.size))
  for (let pass = 0; pass < 3; pass++) {
    for (const b of branches) {
      for (let i = b.stations.length - 2; i >= 0; i--) {
        const s = b.stations[i]
        if (!heads.includes(s) && (pred.get(s)?.size ?? 0) > 0) continue
        const next = Math.min(...[...(succ.get(s) ?? [])].map((n) => layer.get(n)!))
        if (Number.isFinite(next)) layer.set(s, next - 1)
      }
    }
  }
  // A station's lane is the mean lane of the branches that serve it.
  const lanes = new Map<string, number[]>()
  branches.forEach((b, li) => b.stations.forEach((s) => {
    if (!lanes.has(s)) lanes.set(s, [])
    lanes.get(s)!.push(li)
  }))
  const minL = Math.min(...layer.values())
  const pos = new Map<string, { x: number; y: number }>()
  let maxX = 0
  for (const s of all) {
    const ls = lanes.get(s)!
    const x = opts.pad + (layer.get(s)! - minL) * opts.dx
    const y = opts.pad + (ls.reduce((a, c) => a + c, 0) / ls.length) * opts.dy
    pos.set(s, { x, y })
    maxX = Math.max(maxX, x)
  }
  const place = (bi: number, idx: number): [number, number] => {
    const st = branches[bi].stations
    const i = Math.max(0, Math.min(st.length - 2, Math.floor(idx)))
    const u = Math.max(0, Math.min(1, idx - i))
    const a = pos.get(st[i])!
    const b = pos.get(st[i + 1]) ?? a
    return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u]
  }
  return { pos, width: maxX + opts.pad + 60, height: opts.pad * 2 + Math.max(0, branches.length - 1) * opts.dy, place }
}

// ---------------------------------------------------------------- geographic placement

export function makeShapePlacer(b: Branch, stations: Map<string, { lon: number; lat: number }>) {
  const coords = b.shape as [number, number][]
  const cum: number[] = [0]
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1]
    const [x1, y1] = coords[i]
    cum.push(cum[i - 1] + Math.hypot((x1 - x0) * Math.cos((y0 * Math.PI) / 180), y1 - y0))
  }
  let last = 0
  const along = b.stations.map((sid) => {
    const s = stations.get(sid)
    if (!s) return cum[last]
    let best = last
    let bd = Infinity
    for (let i = last; i < coords.length; i++) {
      const d = (coords[i][0] - s.lon) ** 2 + (coords[i][1] - s.lat) ** 2
      if (d < bd) { bd = d; best = i }
    }
    last = best
    return cum[best]
  })
  const pointAt = (dist: number): [number, number] => {
    let lo = 1
    let hi = cum.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < dist) lo = mid + 1
      else hi = mid
    }
    const i = lo
    const seg = cum[i] - cum[i - 1] || 1
    const u = Math.max(0, Math.min(1, (dist - cum[i - 1]) / seg))
    const [x0, y0] = coords[i - 1]
    const [x1, y1] = coords[i]
    return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]
  }
  return (idx: number): [number, number] => {
    const i = Math.max(0, Math.min(along.length - 2, Math.floor(idx)))
    const u = idx - i
    return pointAt(along[i] + (along[i + 1] - along[i]) * u)
  }
}
