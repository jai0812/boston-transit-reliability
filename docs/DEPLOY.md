# Deploying to mbta.sharmajai.com

The public site is fully static: the React build plus the release JSON under `/api/v1/`.
No server, GPU or live MBTA feed is needed at request time.

## Build

```bash
make export   # writes app/web/public/api/v1 from the frozen model run
make web      # app/web/dist = site + release files
```

## Host (any static host)

| Setting | Value |
| --- | --- |
| Root / base directory | `app/web` |
| Build command | `npm ci && npm run build` |
| Output directory | `dist` |
| Node | 22+ |

The release JSON is committed under `app/web/public/api/v1`, so the host only builds the
frontend. Routing uses `#/…` URLs, so no rewrite rules are needed.

Cache headers: `api/v1/replay/*.json` never changes within a release and is safe to cache
for a long time. A new release gets a new `release_id`. Rolling back means redeploying the
earlier commit, and its data comes back with it.

## Custom domain

1. In the host's dashboard add the domain `mbta.sharmajai.com`.
2. At your DNS provider for sharmajai.com add a record:
   `CNAME  mbta  →  <the target the host shows>` (for example `cname.vercel-dns.com`,
   `<site>.netlify.app` or `<project>.pages.dev`).
3. Wait for the host to issue the HTTPS certificate.

## Optional API

`app/api/main.py` serves the same contract as JSON endpoints
(`/v1/release`, `/v1/stations`, `/v1/replay?station_id=&direction_id=&service_date=`,
`/v1/metrics`, `/healthz`) and the built site on one origin:

```bash
make serve    # http://localhost:8000
```
