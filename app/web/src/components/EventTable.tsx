import { clock, signedMin, type Interval, type ReplayEvent } from '../data'

type Props = { events: ReplayEvent[]; t: number; base: number; pick: (e: ReplayEvent) => Interval }

const STATUS_TEXT: Record<string, string> = {
  observed: 'Recorded',
  unobserved: 'No record',
  missing_timestamp: 'No timestamp',
  conflict_schedule: 'Schedule conflict',
  conflict_direction: 'Direction conflict',
  suspicious: 'Excluded (implausible)',
  source_gap: 'Day missing from source',
}

// Keyboard- and screen-reader-friendly version of the timeline. Recorded arrivals stay
// hidden until the replay clock reaches them, matching the chart.
export function EventTable({ events, t, base, pick }: Props) {
  return (
    <details className="panel tbl">
      <summary>Arrival table · {events.length} scheduled trains (Boston time)</summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Scheduled</th>
              <th>To</th>
              <th>Forecast</th>
              <th>80% range</th>
              <th>Recorded</th>
              <th className="num">Late vs schedule (min)</th>
              <th className="num">Forecast miss (min)</th>
              <th>Inside range</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const iv = pick(e)
              const seen = e.obs != null && t >= e.obs
              const done = seen || (iv.hi ?? e.sched) < t
              const inside = seen && iv.lo != null && iv.hi != null && e.obs! >= iv.lo && e.obs! <= iv.hi
              return (
                <tr key={e.id} className={done ? 'past' : 'future'}>
                  <td>{clock(base, e.sched)}</td>
                  <td>{e.route.startsWith('Green-') ? `${e.route.slice(6)} · ` : ''}{e.headsign}</td>
                  <td>{iv.p50 != null ? clock(base, iv.p50) : 'No estimate'}</td>
                  <td>{iv.lo != null && iv.hi != null ? `${clock(base, iv.lo)}–${clock(base, iv.hi)}` : '—'}</td>
                  <td>{seen ? clock(base, e.obs!) : done ? STATUS_TEXT[e.status] ?? e.status : 'Not yet'}</td>
                  <td className="num">{seen ? signedMin(e.obs! - e.sched) : '—'}</td>
                  <td className="num">{seen && iv.p50 != null ? signedMin(e.obs! - iv.p50) : '—'}</td>
                  <td>{seen && iv.lo != null ? <span className={inside ? 'hit' : 'missd'}>{inside ? 'Yes' : 'No'}</span> : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </details>
  )
}
