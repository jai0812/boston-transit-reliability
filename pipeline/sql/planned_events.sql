-- Scheduled subway arrival roster, one row per (service_date, trip, stop).
-- Inputs (temp tables created by build.py):
--   date_feed(service_date DATE, feed_key VARCHAR, schedule_published_at TIMESTAMPTZ)
--   line_routes(route_id VARCHAR, line_id VARCHAR)
--   g_calendar, g_calendar_dates, g_trips, g_stop_times, g_stops  (all feeds, with feed_key)
-- Times: GTFS service-day offsets are measured from "noon minus 12h" local time,
-- so a 25:10:00 arrival lands at 01:10 the next calendar day, and DST days are correct.

CREATE OR REPLACE TABLE planned_events AS
WITH active_service AS (
    SELECT df.service_date, df.feed_key, c.service_id
    FROM date_feed df
    JOIN g_calendar c
      ON c.feed_key = df.feed_key
     AND strftime(df.service_date, '%Y%m%d') BETWEEN c.start_date AND c.end_date
     AND CASE dayofweek(df.service_date)
            WHEN 0 THEN c.sunday WHEN 1 THEN c.monday WHEN 2 THEN c.tuesday
            WHEN 3 THEN c.wednesday WHEN 4 THEN c.thursday WHEN 5 THEN c.friday
            ELSE c.saturday END = '1'
    UNION
    SELECT df.service_date, df.feed_key, cd.service_id
    FROM date_feed df
    JOIN g_calendar_dates cd
      ON cd.feed_key = df.feed_key AND cd.date = strftime(df.service_date, '%Y%m%d')
     AND cd.exception_type = '1'
    EXCEPT
    SELECT df.service_date, df.feed_key, cd.service_id
    FROM date_feed df
    JOIN g_calendar_dates cd
      ON cd.feed_key = df.feed_key AND cd.date = strftime(df.service_date, '%Y%m%d')
     AND cd.exception_type = '2'
),
trips AS (
    SELECT a.service_date, a.feed_key, t.trip_id, t.direction_id::INT AS direction_id,
           t.trip_headsign, t.route_id, lr.line_id
    FROM active_service a
    JOIN g_trips t ON t.feed_key = a.feed_key AND t.service_id = a.service_id
    JOIN line_routes lr ON lr.route_id = t.route_id
),
st AS (
    SELECT tr.service_date, tr.feed_key, tr.trip_id, tr.direction_id, tr.trip_headsign,
           tr.route_id, tr.line_id,
           s.stop_id, s.stop_sequence::INT AS stop_sequence, s.arrival_time,
           split_part(s.arrival_time, ':', 1)::INT * 3600
             + split_part(s.arrival_time, ':', 2)::INT * 60
             + split_part(s.arrival_time, ':', 3)::INT AS scheduled_offset_s,
           min(s.stop_sequence::INT) OVER (PARTITION BY tr.service_date, tr.trip_id)
             AS first_seq
    FROM trips tr
    JOIN g_stop_times s ON s.feed_key = tr.feed_key AND s.trip_id = tr.trip_id
    WHERE s.arrival_time IS NOT NULL AND s.arrival_time <> ''
)
SELECT
    st.service_date,
    st.route_id,
    st.line_id,
    st.trip_id,
    st.stop_id,
    st.stop_sequence,
    st.direction_id,
    st.trip_headsign,
    coalesce(nullif(stp.parent_station, ''), st.stop_id) AS parent_station,
    st.arrival_time AS scheduled_gtfs_time,
    st.scheduled_offset_s,
    -- noon local, minus 12 elapsed hours, plus the offset
    (epoch(timezone('America/New_York', st.service_date::TIMESTAMP + INTERVAL 12 HOUR))::BIGINT
        - 43200 + st.scheduled_offset_s) AS scheduled_epoch,
    st.feed_key
FROM st
LEFT JOIN g_stops stp ON stp.feed_key = st.feed_key AND stp.stop_id = st.stop_id
-- The origin terminal has no passenger arrival; keep timed arrivals only.
WHERE st.stop_sequence > st.first_seq;
