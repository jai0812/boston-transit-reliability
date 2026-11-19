import type { Station } from '../data'
import type { TrainPos } from '../trains'

type Props = {
  stations: Station[]
  selected: string
  direction: number
  trains: TrainPos[]
  ghosts: TrainPos[]
  onSelect: (id: string) => void
}

const W = 1200
const H = 232
const X0 = 70
const X1 = W - 130
const LINE_Y = 84
const LANE = { 0: LINE_Y - 30, 1: LINE_Y + 30 } as Record<number, number>

// The strip map above the train doors, with every train on the line moving in replay time.
export function LineStrip({ stations, selected, direction, trains, ghosts, onSelect }: Props) {
  const n = stations.length
  const x = (pos: number) => X0 + ((X1 - X0) * pos) / (n - 1)
  const sorted = stations.slice().sort((a, b) => a.order - b.order)

  return (
    <svg className="strip" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Blue Line strip map with trains in replay time">
      <text className="lane-label" x={X0 - 50} y={LANE[0] + 4}>←</text>
      <text className="lane-label" x={X0 - 50} y={LANE[1] + 4}>→</text>
      <text className="lane-label" x={X1 + 40} y={LANE[0] + 4}>to Bowdoin</text>
      <text className="lane-label" x={X1 + 40} y={LANE[1] + 4}>to Wonderland</text>
      <rect x={X0 - 8} y={LINE_Y - 7} width={X1 - X0 + 16} height={14} rx={7} fill="var(--blue)" />

      {ghosts.map((g) => (
        <Train key={`g${g.trip}`} x={x(g.pos)} y={LANE[g.dir]} dir={g.dir} ghost active={g.dir === direction} />
      ))}
      {trains.map((t) => (
        <Train key={`t${t.trip}`} x={x(t.pos)} y={LANE[t.dir]} dir={t.dir} late={t.delay != null && t.delay > 300} active={t.dir === direction} />
      ))}

      {sorted.map((s) => {
        const sel = s.id === selected
        const cx = x(s.order)
        return (
          <g
            key={s.id}
            className="stn"
            tabIndex={0}
            role="button"
            aria-pressed={sel}
            aria-label={`Select ${s.name}`}
            onClick={() => onSelect(s.id)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(s.id))}
          >
            <circle cx={cx} cy={LINE_Y} r={20} fill="transparent" />
            <circle className="ring" cx={cx} cy={LINE_Y} r={sel ? 11 : 7} fill="#fff" stroke={sel ? 'var(--sign)' : 'var(--blue)'} strokeWidth={sel ? 4 : 3}>
              {sel && <animate attributeName="r" values="11;13;11" dur="2.4s" repeatCount="indefinite" />}
            </circle>
            <text
              className={`stn-name${sel ? ' sel' : ''}`}
              transform={`translate(${cx - 4} ${LINE_Y + 56}) rotate(28)`}
            >
              {s.name}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function Train({ x, y, dir, ghost, late, active }: { x: number; y: number; dir: number; ghost?: boolean; late?: boolean; active: boolean }) {
  const w = 30
  const h = 14
  // Nose points the way the train is heading.
  const nose = dir === 1
    ? `M ${-w / 2} ${-h / 2} H ${w / 2 - 6} L ${w / 2} 0 L ${w / 2 - 6} ${h / 2} H ${-w / 2} Z`
    : `M ${w / 2} ${-h / 2} H ${-w / 2 + 6} L ${-w / 2} 0 L ${-w / 2 + 6} ${h / 2} H ${w / 2} Z`
  return (
    <g transform={`translate(${x} ${y})`} opacity={active ? 1 : 0.45} aria-hidden>
      {ghost ? (
        <path d={nose} fill="none" stroke="var(--blue)" strokeWidth={1.5} strokeDasharray="3 2" />
      ) : (
        <>
          <path d={nose} fill={late ? 'var(--actual)' : 'var(--blue-deep)'} />
          <rect x={-8} y={-3} width={4} height={4} fill="#fff" opacity={0.85} />
          <rect x={-1} y={-3} width={4} height={4} fill="#fff" opacity={0.85} />
          <rect x={6} y={-3} width={4} height={4} fill="#fff" opacity={0.85} transform={dir === 0 ? 'translate(-16 0)' : undefined} />
        </>
      )}
    </g>
  )
}
