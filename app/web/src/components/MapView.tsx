import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { StationsFile } from '../data'
import { makeLinePlacer, type TrainPos } from '../trains'

type Props = {
  data: StationsFile
  selected: string
  trains: TrainPos[]
  onSelect: (id: string) => void
}

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
const DARK_URL = 'https://tiles.openfreemap.org/styles/dark'

// Used when the basemap cannot load: the line, stations and trains still render.
const BLANK: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9edf0' } }],
}

export function MapView({ data, selected, trains, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const ready = useRef(false)
  const [fallback, setFallback] = useState(false)
  const place = useMemo(
    () => makeLinePlacer(data.line.geometry.coordinates as [number, number][], data.stations),
    [data],
  )
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const trainsRef = useRef(trains)
  trainsRef.current = trains

  const pushTrains = (m: maplibregl.Map, list: TrainPos[]) => {
    const src = m.getSource('trains') as GeoJSONSource | undefined
    src?.setData({
      type: 'FeatureCollection',
      features: list.map((t) => ({
        type: 'Feature',
        properties: { trip: t.tripId, late: t.delay != null && t.delay > 300 },
        geometry: { type: 'Point', coordinates: place(t.pos) },
      })),
    })
  }

  useEffect(() => {
    if (!el.current) return
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const bounds = new maplibregl.LngLatBounds()
    data.stations.forEach((s) => bounds.extend([s.lon, s.lat]))
    const m = new maplibregl.Map({
      container: el.current,
      style: dark ? DARK_URL : STYLE_URL,
      bounds,
      fitBoundsOptions: { padding: 40 },
      attributionControl: { compact: true },
      cooperativeGestures: true,
    })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

    let loaded = false
    const timer = window.setTimeout(() => {
      if (!loaded) { setFallback(true); m.setStyle(BLANK) }
    }, 8000)
    m.on('error', (e: maplibregl.ErrorEvent) => {
      if (!loaded && /style|tiles/i.test(String(e.error?.message ?? ''))) {
        loaded = true
        setFallback(true)
        m.setStyle(BLANK)
      }
    })

    const addLayers = () => {
      loaded = true
      if (m.getSource('line')) return
      m.addSource('line', { type: 'geojson', data: data.line })
      m.addSource('stations', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: data.stations.map((s) => ({
            type: 'Feature',
            properties: { id: s.id, name: s.name },
            geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          })),
        },
      })
      m.addSource('trains', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      m.addLayer({ id: 'line-casing', type: 'line', source: 'line', paint: { 'line-color': '#ffffff', 'line-width': 10 }, layout: { 'line-cap': 'round', 'line-join': 'round' } })
      m.addLayer({ id: 'line', type: 'line', source: 'line', paint: { 'line-color': '#003DA5', 'line-width': 6 }, layout: { 'line-cap': 'round', 'line-join': 'round' } })
      m.addLayer({
        id: 'stations', type: 'circle', source: 'stations',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'id'], selected], 9, 5.5],
          'circle-color': '#ffffff',
          'circle-stroke-color': ['case', ['==', ['get', 'id'], selected], '#17181b', '#003DA5'],
          'circle-stroke-width': ['case', ['==', ['get', 'id'], selected], 4, 2.5],
        },
      })
      m.addLayer({
        id: 'station-labels', type: 'symbol', source: 'stations',
        layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': '#17181b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
      })
      m.addLayer({
        id: 'trains-halo', type: 'circle', source: 'trains',
        paint: { 'circle-radius': 11, 'circle-color': ['case', ['get', 'late'], '#ED8B00', '#003DA5'], 'circle-opacity': 0.22 },
      })
      m.addLayer({
        id: 'trains', type: 'circle', source: 'trains',
        paint: {
          'circle-radius': 6,
          'circle-color': ['case', ['get', 'late'], '#ED8B00', '#002A73'],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
        },
      })
      m.on('click', 'stations', (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id
        if (id) onSelectRef.current(String(id))
      })
      m.on('mouseenter', 'stations', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'stations', () => { m.getCanvas().style.cursor = '' })
      ready.current = true
      m.resize()
      m.fitBounds(bounds, { padding: 36, duration: 0 })
      pushTrains(m, trainsRef.current)
    }
    m.on('style.load', addLayers)
    if (m.isStyleLoaded()) addLayers()
    // Refit whenever the panel changes size (grid reflow, fonts, rotation).
    const ro = new ResizeObserver(() => {
      m.resize()
      m.fitBounds(bounds, { padding: { top: 40, bottom: 40, left: 30, right: 90 }, duration: 0 })
    })
    ro.observe(el.current)
    return () => { ro.disconnect(); window.clearTimeout(timer); ready.current = false; m.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getLayer('stations')) return
    m.setPaintProperty('stations', 'circle-radius', ['case', ['==', ['get', 'id'], selected], 9, 5.5])
    m.setPaintProperty('stations', 'circle-stroke-color', ['case', ['==', ['get', 'id'], selected], '#17181b', '#003DA5'])
    m.setPaintProperty('stations', 'circle-stroke-width', ['case', ['==', ['get', 'id'], selected], 4, 2.5])
  }, [selected])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    pushTrains(m, trains)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trains, place])

  return (
    <div className="map" ref={el} aria-label="Map of the Blue Line with trains in replay time. Use the station picker for keyboard selection.">
      {fallback && <div className="map-fallback">Basemap unavailable — showing the line only</div>}
    </div>
  )
}
