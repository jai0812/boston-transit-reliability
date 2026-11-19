import { useEffect, useState } from 'react'
import { loadRelease, loadStations, type Release, type StationsFile } from './data'
import { Home } from './pages/Home'
import { Method } from './pages/Method'
import { Replay } from './pages/Replay'
import { Results } from './pages/Results'

function useHash() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const on = () => {
      const next = window.location.hash
      setHash((prev) => {
        if (prev.split('?')[0] !== next.split('?')[0]) window.scrollTo(0, 0)
        return next
      })
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const [path, qs] = (hash.replace(/^#/, '') || '/').split('?')
  return { path, query: new URLSearchParams(qs ?? '') }
}

export default function App() {
  const { path, query } = useHash()
  const [release, setRelease] = useState<Release | null>(null)
  const [nets, setNets] = useState<StationsFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [line, setLine] = useState(query.get('line') ?? 'Blue')

  useEffect(() => {
    loadRelease()
      .then(async (r) => {
        setRelease(r)
        setNets(await Promise.all(r.lines.map((l) => loadStations(l.id))))
      })
      .catch((e) => setError(String(e.message ?? e)))
  }, [])

  const meta = release?.lines.find((l) => l.id === line) ?? release?.lines[0]
  // The active line's color drives the whole theme (animated via @property --line).
  useEffect(() => {
    if (meta) document.documentElement.style.setProperty('--line', meta.color)
  }, [meta])

  const page = path.startsWith('/results') ? 'results' : path.startsWith('/method') ? 'method' : path.startsWith('/replay') ? 'replay' : 'home'
  const switchLine = (id: string) => {
    setLine(id)
    if (page === 'replay') history.replaceState(null, '', `#/replay?line=${id}`)
  }

  return (
    <>
      <a className="sr-only" href="#main-content">Skip to content</a>
      <header className="topbar">
        <div className="wrap">
          <a className="brand" href="#/">
            <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
              <rect width="32" height="32" rx="7" />
              <rect x="4" y="14.5" width="24" height="3" rx="1.5" fill="#fff" />
              <circle cx="7" cy="16" r="3.2" fill="#fff" />
              <circle cx="16" cy="16" r="3.2" fill="var(--line)" stroke="#fff" strokeWidth="2" />
              <circle cx="25" cy="16" r="3.2" fill="#fff" />
            </svg>
            <b>Subway Replay</b>
            <small>unofficial</small>
          </a>
          {release && (page === 'replay' || page === 'results') && (
            <div className="lines" role="group" aria-label="Line">
              {release.lines.map((l) => (
                <button key={l.id} className="line-pill" style={{ ['--c' as string]: l.color }} aria-pressed={l.id === meta?.id} onClick={() => switchLine(l.id)}>
                  <span className="line-dot" aria-hidden>{l.id[0]}</span>
                  <span className="ln">{l.id}</span>
                </button>
              ))}
            </div>
          )}
          <nav className="nav" aria-label="Main">
            <a href="#/" aria-current={page === 'home' ? 'page' : undefined}>Home</a>
            <a href="#/replay" aria-current={page === 'replay' ? 'page' : undefined}>Replay</a>
            <a href="#/results" aria-current={page === 'results' ? 'page' : undefined}>Results</a>
            <a href="#/method" aria-current={page === 'method' ? 'page' : undefined}>Method</a>
          </nav>
        </div>
      </header>
      <div id="main-content">
        {error ? (
          <main className="wrap"><div className="state"><b>The replay data didn't load</b>{error}. Reload the page to try again.</div></main>
        ) : !release || !nets || !meta ? (
          <div className="loading-line" role="status" aria-label="Loading" />
        ) : page === 'results' ? (
          <Results release={release} line={meta} nets={nets} onLine={switchLine} />
        ) : page === 'method' ? (
          <Method release={release} />
        ) : page === 'home' ? (
          <Home release={release} nets={nets} onLine={switchLine} />
        ) : (
          <Replay release={release} line={meta} nets={nets} query={query} />
        )}
      </div>
      <footer>
        <div className="wrap">
          <span>Unofficial. Not affiliated with or endorsed by the MBTA.</span>
          <span>Data: <a href="https://performancedata.mbta.com/">MBTA performance data</a> and GTFS archive.</span>
          <span>Map © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://openfreemap.org">OpenFreeMap</a></span>
          {release && <span>Release {release.release_id}</span>}
        </div>
      </footer>
    </>
  )
}
