import { useEffect, useState } from 'react'
import { loadRelease, loadStations, type Release, type StationsFile } from './data'
import { Method } from './pages/Method'
import { Replay } from './pages/Replay'
import { Results } from './pages/Results'

function useHash() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const on = () => { setHash(window.location.hash); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const [path, qs] = (hash.replace(/^#/, '') || '/replay').split('?')
  return { path, query: new URLSearchParams(qs ?? '') }
}

export default function App() {
  const { path, query } = useHash()
  const [release, setRelease] = useState<Release | null>(null)
  const [stations, setStations] = useState<StationsFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([loadRelease(), loadStations()])
      .then(([r, s]) => { setRelease(r); setStations(s) })
      .catch((e) => setError(String(e.message ?? e)))
  }, [])

  const page = path.startsWith('/results') ? 'results' : path.startsWith('/method') ? 'method' : 'replay'

  return (
    <>
      <a className="sr-only" href="#main-content">Skip to content</a>
      <header className="topbar">
        <div className="wrap">
          <a className="brand" href="#/replay">
            <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
              <rect width="32" height="32" rx="7" fill="#003DA5" />
              <rect x="4" y="14.5" width="24" height="3" rx="1.5" fill="#fff" />
              <circle cx="7" cy="16" r="3.2" fill="#fff" />
              <circle cx="16" cy="16" r="3.2" fill="#003DA5" stroke="#fff" strokeWidth="2" />
              <circle cx="25" cy="16" r="3.2" fill="#fff" />
            </svg>
            <b>Blue Line Replay</b>
            <small>unofficial</small>
          </a>
          <nav className="nav" aria-label="Main">
            <a href="#/replay" aria-current={page === 'replay' ? 'page' : undefined}>Replay</a>
            <a href="#/results" aria-current={page === 'results' ? 'page' : undefined}>Results</a>
            <a href="#/method" aria-current={page === 'method' ? 'page' : undefined}>Method</a>
          </nav>
        </div>
      </header>
      <div id="main-content">
        {error ? (
          <main className="wrap"><div className="state"><b>The replay data didn't load</b>{error}. Reload the page to try again.</div></main>
        ) : !release || !stations ? (
          <div className="loading-line" role="status" aria-label="Loading" />
        ) : page === 'results' ? (
          <Results release={release} stations={stations} />
        ) : page === 'method' ? (
          <Method release={release} />
        ) : (
          <Replay release={release} stations={stations} query={query} />
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
