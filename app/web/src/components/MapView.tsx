import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { StationsFile } from '../data'
import { makeShapePlacer, type TrainPos } from '../trains'

export type Arrival = { key: string; lon: number; lat: number }

type Props = {
  nets: StationsFile[] // every line, for system context
  active: string
  selected: string
  trains: TrainPos[]
  t: number
  arrivals: Arrival[]
  onSelect: (id: string) => void
}

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
const DARK_URL = 'https://tiles.openfreemap.org/styles/dark'
const BLANK: StyleSpecification = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9edf0' } }] }
const TRAIL = 14
const EMPTY = { type: 'FeatureCollection' as const, features: [] }

const darken = (hex: string, k = 0.7) =>
  '#' + hex.slice(1).match(/../g)!.map((h) => Math.round(parseInt(h, 16) * k).toString(16).padStart(2, '0')).join('')

export function MapView({ nets, active, selected, trains, t, arrivals, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = useState(false)
  const [fallback, setFallback] = useState(false)
  const net = nets.find((n) => n.line_id === active) ?? nets[0]
  const placers = useMemo(() => {
    const st = new Map(net.stations.map((s) => [s.id, s]))
    return net.branches.map((b) => makeShapePlacer(b, st))
  }, [net])
  const trails = useRef(new Map<string, [number, number][]>())
  const lastT = useRef(t)
  const markers = useRef(new Map<string, maplibregl.Marker>())
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  // ---- create the map once
  useEffect(() => {
    if (!el.current) return
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const m = new maplibregl.Map({
      container: el.current,
      style: dark ? DARK_URL : STYLE_URL,
      center: [-71.07, 42.35],
      zoom: 10.6,
      attributionControl: { compact: true },
      cooperativeGestures: true,
    })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    let loaded = false
    const timer = window.setTimeout(() => { if (!loaded) { setFallback(true); m.setStyle(BLANK) } }, 8000)
    m.on('error', (e: maplibregl.ErrorEvent) => {
      if (!loaded && /style|tiles/i.test(String(e.error?.message ?? ''))) { loaded = true; setFallback(true); m.setStyle(BLANK) }
    })
    const add = () => {
      loaded = true
      if (m.getSource('lines')) return
      for (const id of ['lines', 'stations', 'trains', 'trails']) m.addSource(id, { type: 'geojson', data: EMPTY })
      m.addLayer({ id: 'lines-casing', type: 'line', source: 'lines', paint: { 'line-color': '#ffffff', 'line-width': ['case', ['get', 'active'], 10, 5], 'line-opacity': ['case', ['get', 'active'], 1, 0.6] }, layout: { 'line-cap': 'round', 'line-join': 'round' } })
      m.addLayer({ id: 'lines', type: 'line', source: 'lines', paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'active'], 6, 3], 'line-opacity': ['case', ['get', 'active'], 1, 0.45] }, layout: { 'line-cap': 'round', 'line-join': 'round' } })
      m.addLayer({ id: 'trails', type: 'line', source: 'trails', paint: { 'line-color': ['case', ['get', 'late'], '#ED8B00', ['get', 'color']], 'line-width': 5, 'line-opacity': 0.35, 'line-blur': 1.5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } })
      m.addLayer({
        id: 'stations', type: 'circle', source: 'stations',
        paint: {
          'circle-radius': ['case', ['get', 'sel'], 9, 4.5],
          'circle-color': '#ffffff',
          'circle-stroke-color': ['case', ['get', 'sel'], '#17181b', ['get', 'color']],
          'circle-stroke-width': ['case', ['get', 'sel'], 4, 2],
        },
      })
      m.addLayer({
        id: 'station-labels', type: 'symbol', source: 'stations',
        layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-font': ['Noto Sans Regular'], 'text-optional': true },
        paint: { 'text-color': '#17181b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
      })
      m.addLayer({ id: 'trains-halo', type: 'circle', source: 'trains', paint: { 'circle-radius': 11, 'circle-color': ['case', ['get', 'late'], '#ED8B00', ['get', 'color']], 'circle-opacity': 0.22, 'circle-blur': 0.4 } })
      m.addLayer({ id: 'trains', type: 'circle', source: 'trains', paint: { 'circle-radius': 5.5, 'circle-color': ['case', ['get', 'late'], '#ED8B00', ['get', 'deep']], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } })
      m.on('click', 'stations', (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id
        if (id) onSelectRef.current(String(id))
      })
      m.on('mouseenter', 'stations', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'stations', () => { m.getCanvas().style.cursor = '' })
      setReady(true)
    }
    m.on('style.load', add)
    const ro = new ResizeObserver(() => m.resize())
    ro.observe(el.current)
    const mk = markers.current
    return () => {
      ro.disconnect(); window.clearTimeout(timer); setReady(false)
      mk.forEach((x) => x.remove()); mk.clear()
      m.remove(); map.current = null
    }
  }, [])

  // ---- lines + stations whenever the active line or selection changes
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    ;(m.getSource('lines') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: nets.flatMap((n) => n.branches.map((b) => ({
        type: 'Feature' as const,
        properties: { color: n.color, active: n.line_id === active },
        geometry: { type: 'LineString' as const, coordinates: b.shape },
      }))).sort((a, b) => Number(a.properties.active) - Number(b.properties.active)),
    })
    ;(m.getSource('stations') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: net.stations.map((s) => ({
        type: 'Feature' as const,
        properties: { id: s.id, name: s.name, color: net.color, sel: s.id === selected },
        geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
      })),
    })
  }, [ready, nets, net, active, selected])

  // ---- camera: frame the line when it changes, glide to the station when it changes
  const framed = useRef<string | null>(null)
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const s = net.stations.find((x) => x.id === selected)
    if (framed.current !== active) {
      const first = framed.current == null
      framed.current = active
      const b = new maplibregl.LngLatBounds()
      net.stations.forEach((x) => b.extend([x.lon, x.lat]))
      m.fitBounds(b, { padding: 40, duration: first ? 0 : 1300 })
      trails.current.clear()
    } else if (s) {
      m.easeTo({ center: [s.lon, s.lat], zoom: Math.max(m.getZoom(), 12.4), duration: 1100 })
    }
  }, [ready, active, selected, net])

  // ---- trains with fading trails
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    if (t < lastT.current - 5 || t > lastT.current + 1800) trails.current.clear()
    lastT.current = t
    const live = new Set<string>()
    const feats = trains.map((tr) => {
      const p = placers[tr.branch]?.(tr.idx) ?? ([0, 0] as [number, number])
      live.add(tr.tripId)
      const tl = trails.current.get(tr.tripId) ?? []
      const last = tl[tl.length - 1]
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.0004) {
        tl.push(p)
        if (tl.length > TRAIL) tl.shift()
        trails.current.set(tr.tripId, tl)
      }
      return { tr, p, tl }
    })
    for (const k of [...trails.current.keys()]) if (!live.has(k)) trails.current.delete(k)
    const deep = darken(net.color)
    ;(m.getSource('trains') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: feats.map(({ tr, p }) => ({
        type: 'Feature' as const,
        properties: { late: tr.delay != null && tr.delay > 300, color: net.color, deep },
        geometry: { type: 'Point' as const, coordinates: p },
      })),
    })
    ;(m.getSource('trails') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: feats.filter((f) => f.tl.length > 1).map(({ tr, tl, p }) => ({
        type: 'Feature' as const,
        properties: { late: tr.delay != null && tr.delay > 300, color: net.color },
        geometry: { type: 'LineString' as const, coordinates: [...tl.slice(0, -1), p] },
      })),
    })
  }, [ready, trains, placers, t, net])

  // ---- arrival pulses at the selected station
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const keep = new Set(arrivals.map((a) => a.key))
    for (const [k, mk] of markers.current) if (!keep.has(k)) { mk.remove(); markers.current.delete(k) }
    for (const a of arrivals) {
      if (markers.current.has(a.key)) continue
      const div = document.createElement('div')
      div.className = 'arrive-pulse'
      markers.current.set(a.key, new maplibregl.Marker({ element: div }).setLngLat([a.lon, a.lat]).addTo(m))
    }
  }, [ready, arrivals])

  return (
    <div className="map" ref={el} aria-label="Map of the subway with trains in replay time. Use the station picker for keyboard selection.">
      {fallback && <div className="map-fallback">Basemap unavailable — showing the lines only</div>}
    </div>
  )
}
