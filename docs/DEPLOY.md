# Deployment: mbta.sharmajai.com

The public site is fully static: the React build plus the release JSON under `/api/v1/`.
No server, GPU or live MBTA feed is needed at request time.

## How it is hosted

| Piece | Where |
| --- | --- |
| Code | https://github.com/jai0812/boston-transit-reliability (public) |
| Hosting | GitHub Pages, built by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) on every push to `main` |
| Domain | `mbta.sharmajai.com`, a Cloudflare DNS record: `CNAME mbta → jai0812.github.io`, **DNS only** (grey cloud) |
| HTTPS | Certificate issued by GitHub Pages; "Enforce HTTPS" on |
| Fallback URL | https://jai0812.github.io/boston-transit-reliability/ (redirects to the custom domain) |

The Vite build uses a relative base (`./`) and hash routing, so the same build works at the domain root
and at a project path, and no rewrite rules are needed.

## Publishing a new release

```bash
make build-data train calibrate evaluate export   # writes app/web/public/api/v1
git add app/web/public/api && git commit -m "Release <id>"
git push                                          # Pages workflow builds and deploys
```

Every release has its own `release_id`. Rolling back means reverting the commit; the data comes back
with the code.

## If something breaks

| Symptom | Check |
| --- | --- |
| Domain shows a GitHub 404 | Repo → Settings → Pages → Custom domain still says `mbta.sharmajai.com` |
| Certificate error | Cloudflare record must be **DNS only**. A proxied (orange) record blocks GitHub's certificate |
| Map is blank but the rest works | The basemap host (OpenFreeMap) may be down; the site falls back to lines only |
| Deploy failed | Repo → Actions → `deploy-pages` logs (`npx tsc -b` or `npm run build`) |

## Optional API

`app/api/main.py` serves the same data as JSON endpoints (`/v1/release`, `/v1/lines`,
`/v1/stations?line=`, `/v1/replay?line=&station_id=&direction_id=&service_date=`, `/v1/metrics?line=`,
`/healthz`) together with the built site on one origin:

```bash
make serve    # http://localhost:8000
```
