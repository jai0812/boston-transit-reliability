-- Observations and the left join from the scheduled roster.
-- Input: lamp_raw (all daily files, Blue only), planned_events.

CREATE OR REPLACE TABLE observations AS
SELECT
    strptime(service_date::VARCHAR, '%Y%m%d')::DATE AS service_date,
    trip_id,
    stop_id,
    stop_sequence::INT AS stop_sequence,
    direction_id::INT AS direction_id,
    parent_station,
    -- guard against a future switch to milliseconds
    CASE WHEN stop_timestamp > 100000000000 THEN stop_timestamp // 1000
         ELSE stop_timestamp END AS observed_epoch,
    scheduled_arrival_time AS lamp_scheduled_offset_s,
    trip_id LIKE 'ADDED-%' AS is_added_trip,
    vehicle_label,
    route_id AS lamp_route_id,
    branch_route_id
FROM lamp_raw
WHERE route_id IN (SELECT route_id FROM line_routes);

-- Duplicate (date, trip, stop) observation rows would create a many-to-many join.
CREATE OR REPLACE TABLE observation_dupes AS
SELECT service_date, trip_id, stop_id, count(*) AS n
FROM observations GROUP BY ALL HAVING count(*) > 1;

CREATE OR REPLACE TABLE obs_unique AS
SELECT * FROM observations
QUALIFY row_number() OVER (
    PARTITION BY service_date, trip_id, stop_id
    ORDER BY observed_epoch NULLS LAST) = 1;

CREATE OR REPLACE TABLE joined_events AS
SELECT
    p.*,
    o.observed_epoch,
    o.lamp_scheduled_offset_s,
    o.stop_sequence AS lamp_stop_sequence,
    o.vehicle_label,
    CASE
        WHEN p.service_date IN (SELECT service_date FROM lamp_empty_days) THEN 'source_gap'
        WHEN o.trip_id IS NULL THEN 'unobserved'
        WHEN o.direction_id <> p.direction_id THEN 'conflict_direction'
        WHEN o.lamp_scheduled_offset_s IS NOT NULL
             AND abs(o.lamp_scheduled_offset_s - p.scheduled_offset_s) > 60 THEN 'conflict_schedule'
        WHEN o.observed_epoch IS NULL THEN 'missing_timestamp'
        WHEN o.observed_epoch - p.scheduled_epoch > 4 * 3600
          OR o.observed_epoch - p.scheduled_epoch < -1800 THEN 'suspicious'
        ELSE 'observed'
    END AS observation_status,
    CASE WHEN o.observed_epoch IS NOT NULL THEN o.observed_epoch - p.scheduled_epoch END
        AS delay_s
FROM planned_events p
LEFT JOIN obs_unique o
  ON o.service_date = p.service_date AND o.trip_id = p.trip_id AND o.stop_id = p.stop_id;

CREATE OR REPLACE TABLE data_quality AS
WITH planned AS (
    SELECT service_date, line_id, direction_id,
           count(*) AS planned_events,
           count(*) FILTER (WHERE observation_status = 'source_gap') AS source_gap,
           count(*) FILTER (WHERE observation_status = 'observed') AS observed,
           count(*) FILTER (WHERE observation_status = 'unobserved') AS unobserved,
           count(*) FILTER (WHERE observation_status = 'missing_timestamp') AS missing_timestamp,
           count(*) FILTER (WHERE observation_status LIKE 'conflict%') AS conflicts,
           count(*) FILTER (WHERE observation_status = 'suspicious') AS suspicious
    FROM joined_events GROUP BY ALL
),
extra AS (
    SELECT o.service_date, lr.line_id, o.direction_id,
           count(*) AS lamp_rows,
           count(*) FILTER (WHERE o.is_added_trip) AS added_trip_rows,
           count(*) FILTER (WHERE p.trip_id IS NULL) AS rows_without_planned_event
    FROM obs_unique o
    JOIN line_routes lr ON lr.route_id = o.lamp_route_id
    LEFT JOIN planned_events p
      ON o.service_date = p.service_date AND o.trip_id = p.trip_id AND o.stop_id = p.stop_id
    GROUP BY ALL
)
SELECT planned.*, extra.lamp_rows, extra.added_trip_rows, extra.rows_without_planned_event,
       round(observed / nullif(planned_events - source_gap, 0), 4) AS match_rate
FROM planned
LEFT JOIN extra USING (service_date, line_id, direction_id)
ORDER BY service_date, line_id, direction_id;
