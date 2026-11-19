import { useMemo } from 'react'
import type { Station, StationsFile } from '../data'
import { layoutSchematic, type TrainPos } from '../trains'
import { letterOf } from './Board'

type Props = {
  net: StationsFile
  stationsById: Map<string, Station>
  selected: string
  activeBranch: number
  trains: TrainPos[]
  onSelect: (id: string) => void
  onBranch: (i: number) => void
}

// The whole line as a network: branches fork and merge, every train glides along it.
export function Schematic({ net, stationsById, selected, activeBranch, trains, onSelect, onBranch }: Props) {
  const lay = useMemo(() => layoutSchematic(net, { dx: 30, dy: 40, pad: 40 }), [net])
  const ends = useMemo(() => {
    const s = new Set<string>()
    net.branches.forEach((b) => { s.add(b.stations[0]); s.add(b.stations[b.stations.length - 1]) })
    return s
  }, [net])
  const sel = lay.pos.get(selected)
  const W = lay.width + 90
  const H = lay.height + 30

  return (
    <svg className="schem" viewBox={`0 0 ${W} ${H}`} width={W} style={{ minWidth: '100%' }} role="group" aria-label={`${net.name} network diagram with trains`}>
      {net.branches.map((b, bi) => {
        const d = b.stations.map((s, i) => { const p = lay.pos.get(s)!; return `${i ? 'L' : 'M'}${p.x},${p.y}` }).join(' ')
        const on = bi === activeBranch
        return (
          <g key={b.id} style={{ cursor: 'pointer' }} onClick={() => onBranch(bi)}>
            <path d={d} fill="none" stroke="var(--panel)" strokeWidth={12} strokeLinejoin="round" strokeLinecap="round" />
            <path d={d} fill="none" stroke="var(--line)" strokeWidth={on ? 7 : 5} strokeOpacity={on ? 1 : 0.55} strokeLinejoin="round" strokeLinecap="round" style={{ transition: 'stroke-width .3s, stroke-opacity .3s' }}>
              <title>{b.name}</title>
            </path>
          </g>
        )
      })}
      {[...lay.pos.entries()].map(([id, p]) => {
        const s = stationsById.get(id)
        const isSel = id === selected
        return (
          <g key={id} className="stn" tabIndex={-1} onClick={() => onSelect(id)}>
            <circle cx={p.x} cy={p.y} r={isSel ? 7 : ends.has(id) ? 4.5 : 3} fill="#fff" stroke={isSel ? 'var(--sign)' : 'var(--line)'} strokeWidth={isSel ? 3.5 : 1.8} />
            <circle cx={p.x} cy={p.y} r={10} fill="transparent"><title>{s?.name ?? id}</title></circle>
          </g>
        )
      })}
      {net.branches.length > 1 && net.branches.map((b) => {
        const last = lay.pos.get(b.stations[b.stations.length - 1])!
        return (
          <text key={b.id} className="term" x={last.x + 10} y={last.y + 4}>
            {b.letter ? `${b.letter} · ` : ''}{stationsById.get(b.stations[b.stations.length - 1])?.name}
          </text>
        )
      })}
      {(() => {
        const heads = new Set(net.branches.map((b) => b.stations[0]))
        return [...heads].map((h) => {
          const p = lay.pos.get(h)!
          return <text key={h} className="term" x={p.x} y={p.y - 12} textAnchor="middle">{stationsById.get(h)?.name}</text>
        })
      })()}

      {trains.map((t) => {
        const [x, y] = lay.place(t.branch, t.idx)
        const late = t.delay != null && t.delay > 300
        return (
          <g key={t.trip} transform={`translate(${x} ${y})`} aria-hidden>
            <circle r={7} fill={late ? 'var(--actual)' : 'var(--blue-deep)'} opacity={0.22} />
            <circle r={3.6} fill={late ? 'var(--actual)' : 'var(--blue-deep)'} stroke="#fff" strokeWidth={1.4} />
            {letterOf(t.route) && <text y={-8} textAnchor="middle" fontSize={8} fontWeight={800} fill="var(--ink-2)">{letterOf(t.route)}</text>}
          </g>
        )
      })}
      {sel && (
        <text className="sel-label" x={sel.x} y={sel.y + 24} textAnchor="middle">{stationsById.get(selected)?.name}</text>
      )}
    </svg>
  )
}
