import type { Interval, ReplayEvent } from '../data'

type Props = {
  events: ReplayEvent[] // one platform, sorted by schedule
  t: number
  pick: (e: ReplayEvent) => Interval
}

const SHOW_ARRIVED = 45

// A countdown sign that tells the truth about uncertainty: a range, not a single minute.
export function Board({ events, t, pick }: Props) {
  const rows = events
    .filter((e) => {
      const iv = pick(e)
      if (e.obs != null) return e.obs + SHOW_ARRIVED >= t
      const end = iv.hi ?? e.sched
      return end + 60 >= t
    })
    .sort((a, b) => (pick(a).p50 ?? a.sched) - (pick(b).p50 ?? b.sched))
    .slice(0, 3)

  return (
    <div className="board" role="img" aria-label={describe(rows, t, pick)}>
      {[0, 1, 2].map((i) => {
        const e = rows[i]
        if (!e) return <div className="board-row dim" key={i}><span>{i === 0 ? 'No more trains' : ' '}</span><span /></div>
        const { text, flash } = label(e, t, pick(e))
        return (
          <div className={`board-row${flash ? ' flash' : ''}`} key={e.id}>
            <span>{e.headsign}</span>
            <span className="time">{text}</span>
          </div>
        )
      })}
      <div className="board-foot">
        <span>Day-ahead forecast · 80% range</span>
        <span>Historical replay</span>
      </div>
    </div>
  )
}

function label(e: ReplayEvent, t: number, iv: Interval): { text: string; flash: boolean } {
  if (e.obs != null && t >= e.obs) {
    const d = Math.round((e.obs - e.sched) / 60)
    return { text: d > 0 ? `ARR +${d}` : d < 0 ? `ARR ${d}` : 'ARR', flash: t - e.obs < 3 }
  }
  if (iv.lo == null || iv.hi == null) {
    const m = Math.ceil((e.sched - t) / 60)
    return { text: m <= 0 ? 'DUE' : `${m} min`, flash: false }
  }
  const lo = Math.max(0, Math.floor((iv.lo - t) / 60))
  const hi = Math.ceil((iv.hi - t) / 60)
  if (hi <= 0) return { text: e.obs == null ? 'NO DATA' : 'DUE', flash: false }
  if (hi <= 1) return { text: 'DUE', flash: false }
  if (lo === 0) return { text: `≤${hi} min`, flash: false }
  return { text: `${lo}–${hi} min`, flash: false }
}

function describe(rows: ReplayEvent[], t: number, pick: Props['pick']) {
  if (!rows.length) return 'Countdown sign: no more trains'
  return 'Countdown sign: ' + rows.map((e) => `${e.headsign} ${label(e, t, pick(e)).text}`).join('; ')
}
