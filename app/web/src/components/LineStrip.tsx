import { useMemo } from 'react'
import type { Branch, Station } from '../data'
import type { TrainPos } from '../trains'

type Props = {
  branch: Branch
  branchIndex: number
  stationsById: Map<string, Station>
  selected: string
  direction: number
  orderDirection: number
  directions: Record<string, string>
  trains: TrainPos[]
  ghosts: TrainPos[]
  convert: (from: number, idx: number, to: number) => number | null
  onSelect: (id: string) => void
}

const H = 236
const X0 = 70
const LINE_Y = 84
const LANE_OFF = 30

// The strip map above the train doors, for one branch, with every train on it moving in
// replay time. Trains from other branches appear while they share this branch's track.
export function LineStrip(p: Props) {
  const n = p.branch.stations.length
  const step = n > 24 ? 40 : n > 14 ? 58 : 92
  const W = X0 + step * (n - 1) + 150
  const x = (pos: number) => X0 + step * pos
  // Trains heading in the strip's reading direction ride the lower lane.
  const laneY = (dir: number) => (dir === p.orderDirection ? LINE_Y + LANE_OFF : LINE_Y - LANE_OFF)
  const rotate = n > 24 ? 50 : n > 14 ? 38 : 28

  const place = (list: TrainPos[]) =>
    list.flatMap((t) => {
      const i = p.convert(t.branch, t.idx, p.branchIndex)
      return i == null ? [] : [{ ...t, i }]
    })
  const trains = place(p.trains)
  const ghosts = place(p.ghosts)
  const fwd = p.directions[String(p.orderDirection)] ?? ''
  const back = p.directions[String(1 - p.orderDirection)] ?? ''

  const stations = useMemo(() => p.branch.stations.map((id, i) => ({ id, i, s: p.stationsById.get(id) })), [p.branch, p.stationsById])

  return (
    <svg className="strip" viewBox={`0 0 ${W} ${H}`} width={W} style={{ minWidth: '100%' }} role="group" aria-label={`${p.branch.name} strip map with trains in replay time`}>
      <text className="lane-label" x={X0 - 52} y={laneY(1 - p.orderDirection) + 4}>←</text>
      <text className="lane-label" x={X0 - 52} y={laneY(p.orderDirection) + 4}>→</text>
      <text className="lane-label" x={x(n - 1) + 34} y={laneY(1 - p.orderDirection) + 4}>{shorten(back)}</text>
      <text className="lane-label" x={x(n - 1) + 34} y={laneY(p.orderDirection) + 4}>{shorten(fwd)}</text>
      <rect x={X0 - 8} y={LINE_Y - 7} width={x(n - 1) - X0 + 16} height={14} rx={7} fill="var(--line)" />

      {ghosts.map((g) => (
        <Train key={`g${g.trip}`} x={x(g.i)} y={laneY(g.dir)} forward={g.dir === p.orderDirection} ghost active={g.dir === p.direction} />
      ))}
      {trains.map((t) => (
        <Train key={`t${t.trip}`} x={x(t.i)} y={laneY(t.dir)} forward={t.dir === p.orderDirection} late={t.delay != null && t.delay > 300} dwelling={t.dwelling} active={t.dir === p.direction} />
      ))}

      {stations.map(({ id, i, s }) => {
        const sel = id === p.selected
        const cx = x(i)
        return (
          <g
            key={id}
            className="stn"
            tabIndex={0}
            role="button"
            aria-pressed={sel}
            aria-label={`Select ${s?.name ?? id}`}
            onClick={() => p.onSelect(id)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), p.onSelect(id))}
          >
            <circle cx={cx} cy={LINE_Y} r={18} fill="transparent" />
            <circle className="ring" cx={cx} cy={LINE_Y} r={sel ? 11 : 6.5} fill="#fff" stroke={sel ? 'var(--sign)' : 'var(--line)'} strokeWidth={sel ? 4 : 3}>
              {sel && <animate attributeName="r" values="11;13.5;11" dur="2.4s" repeatCount="indefinite" />}
            </circle>
            <text className={`stn-name${sel ? ' sel' : ''}`} transform={`translate(${cx - 4} ${LINE_Y + 56}) rotate(${rotate})`}>
              {s?.name ?? id}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

const shorten = (s: string) => s.replace(/^(Westbound|Eastbound|Southbound|Northbound) to /, 'to ')

function Train({ x, y, forward, ghost, late, active, dwelling }: { x: number; y: number; forward: boolean; ghost?: boolean; late?: boolean; active: boolean; dwelling?: boolean }) {
  const w = 30
  const h = 14
  const nose = forward
    ? `M ${-w / 2} ${-h / 2} H ${w / 2 - 6} L ${w / 2} 0 L ${w / 2 - 6} ${h / 2} H ${-w / 2} Z`
    : `M ${w / 2} ${-h / 2} H ${-w / 2 + 6} L ${-w / 2} 0 L ${-w / 2 + 6} ${h / 2} H ${w / 2} Z`
  return (
    <g transform={`translate(${x} ${y})`} opacity={active ? 1 : 0.4} aria-hidden>
      {ghost ? (
        <path d={nose} fill="none" stroke="var(--blue)" strokeWidth={1.5} strokeDasharray="3 2" />
      ) : (
        <>
          <path d={nose} fill={late ? 'var(--actual)' : 'var(--blue-deep)'} />
          <g className={dwelling ? 'doors' : undefined} fill="#fff" opacity={0.9}>
            <rect x={-9} y={-3} width={4} height={6} />
            <rect x={-2} y={-3} width={4} height={6} />
            <rect x={5} y={-3} width={4} height={6} transform={forward ? undefined : 'translate(-14 0)'} />
          </g>
          {/* headlight */}
          <circle cx={forward ? w / 2 - 3 : -w / 2 + 3} cy={0} r={1.6} fill="#fff7cc" />
        </>
      )}
    </g>
  )
}
