import { scaleLinear } from 'd3-scale'
import { clock, type Interval, type ReplayEvent } from '../data'
import { letterOf } from './Board'

type Props = {
  events: ReplayEvent[]
  t: number
  base: number
  pick: (e: ReplayEvent) => Interval
}

const W = 760
const ROW = 28
const TOP = 30
const LEFT = 78
const RIGHT = 16
const BEFORE = 25 * 60
const AFTER = 65 * 60

// Each row is one scheduled train at this platform. The window scrolls with the replay clock;
// the orange diamond (what happened) only appears once the clock reaches it.
export function Timeline({ events, t, base, pick }: Props) {
  const lo = t - BEFORE
  const hi = t + AFTER
  const rows = events
    .filter((e) => {
      const iv = pick(e)
      const a = Math.min(e.sched, iv.lo ?? e.sched, e.obs ?? e.sched)
      const b = Math.max(e.sched, iv.hi ?? e.sched, e.obs ?? e.sched)
      return b >= lo && a <= hi
    })
    .slice(0, 14)
  const H = TOP + Math.max(rows.length, 4) * ROW + 10
  const x = scaleLinear().domain([lo, hi]).range([LEFT, W - RIGHT])
  const ticks: number[] = []
  for (let s = Math.ceil(lo / 600) * 600; s <= hi; s += 600) ticks.push(s)

  if (!rows.length) {
    return <div className="state"><b>No trains scheduled in this window</b>Drag the clock or pick another station.</div>
  }

  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Arrival timeline for the selected platform. The table below lists the same data.">
      <defs>
        <clipPath id="tl-clip"><rect x={LEFT} y={0} width={W - LEFT - RIGHT} height={H} /></clipPath>
      </defs>
      <g className="axis">
        {ticks.map((s) => (
          <g key={s} transform={`translate(${x(s)} 0)`}>
            <line y1={TOP - 8} y2={H - 6} stroke="var(--rule)" />
            <text y={14} textAnchor="middle">{clock(base, s)}</text>
          </g>
        ))}
      </g>
      <g clipPath="url(#tl-clip)">
        {rows.map((e, i) => {
          const y = TOP + i * ROW + ROW / 2
          const iv = pick(e)
          const seen = e.obs != null && t >= e.obs
          const inside = seen && iv.lo != null && iv.hi != null && e.obs! >= iv.lo && e.obs! <= iv.hi
          return (
            <g key={e.id}>
              {iv.lo != null && iv.hi != null && (
                <rect className="band" x={x(iv.lo)} y={y - 8} width={Math.max(2, x(iv.hi) - x(iv.lo))} height={16} rx={4} fill="var(--blue-wash)" stroke="var(--blue)" strokeWidth={1} />
              )}
              {iv.p50 != null && <rect x={x(iv.p50) - 1.5} y={y - 10} width={3} height={20} fill="var(--blue)" />}
              <circle cx={x(e.sched)} cy={y} r={5} fill="var(--panel)" stroke="var(--sched)" strokeWidth={2.2} />
              {seen && iv.p50 != null && (
                <line x1={x(iv.p50)} x2={x(e.obs!)} y1={y} y2={y} stroke={inside ? 'var(--actual)' : 'var(--miss)'} strokeWidth={2} strokeDasharray={inside ? undefined : '3 2'} />
              )}
              {seen && (
                <g transform={`translate(${x(e.obs!)} ${y})`}>
                  <g className="obs-pop">
                    <rect x={-6} y={-6} width={12} height={12} transform="rotate(45)" fill={inside ? 'var(--actual)' : 'var(--miss)'} stroke="var(--panel)" strokeWidth={1.5} />
                  </g>
                </g>
              )}
              {e.obs == null && e.status !== 'observed' && iv.hi != null && t > iv.hi && (
                <text x={x(iv.hi) + 8} y={y + 4} fontSize={11} fontFamily="var(--mono)" fill="var(--ink-3)">no recorded arrival</text>
              )}
            </g>
          )
        })}
      </g>
      {rows.map((e, i) => (
        <text key={e.id} className="row-label" x={LEFT - 10} y={TOP + i * ROW + ROW / 2 + 4} textAnchor="end">
          {letterOf(e.route) && <tspan fontWeight={800} fill="var(--blue)">{letterOf(e.route)} </tspan>}
          {clock(base, e.sched)}
        </text>
      ))}
      <g transform={`translate(${x(t)} 0)`}>
        <line y1={TOP - 12} y2={H} stroke="var(--ink)" strokeWidth={2} />
        <rect x={-22} y={TOP - 26} width={44} height={16} rx={8} fill="var(--ink)" />
        <text y={TOP - 14.5} textAnchor="middle" fontSize={10} fontFamily="var(--mono)" fontWeight={600} fill="var(--panel)">NOW</text>
      </g>
    </svg>
  )
}
