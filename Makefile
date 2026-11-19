# Boston Transit Reliability Explorer — short commands for every stage.
START ?= 2025-06-23
END   ?= 2026-07-05
PY    := uv run python -m

.PHONY: bootstrap fetch build-data baseline train calibrate evaluate export verify serve web dev test lint

bootstrap:            ## install Python and Node dependencies
	uv sync
	cd app/web && npm ci

fetch:                ## download LAMP daily files + archived GTFS (idempotent, checksummed)
	$(PY) pipeline.transit.fetch --start $(START) --end $(END)

build-data:           ## planned roster, observations, join, data quality, features
	$(PY) pipeline.transit.build

baseline train:       ## historical baseline + LightGBM quantile search on validation
	$(PY) pipeline.transit.model train

calibrate:            ## conformal widening on the calibration weeks
	$(PY) pipeline.transit.model calibrate

evaluate:             ## score every system once on the test weeks
	$(PY) pipeline.transit.model evaluate

export:               ## write the static replay release into app/web/public/api/v1
	$(PY) pipeline.transit.export

verify: test lint     ## tests + lint + typecheck
	cd app/web && npx tsc -b

web:                  ## build the static site into app/web/dist
	cd app/web && npm run build

serve: web            ## API + built site on http://localhost:8000
	uv run uvicorn app.api.main:app --port 8000

dev:                  ## frontend dev server with hot reload
	cd app/web && npm run dev

test:
	uv run pytest -q

lint:
	uv run ruff check pipeline app/api tests
