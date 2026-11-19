import { dateLabel, type Release } from '../data'

export function Method({ release }: { release: Release }) {
  const s = release.splits
  const span = (k: string) => `${dateLabel(s[k][0])} – ${dateLabel(s[k][1])}`
  return (
    <main className="wrap prose">
      <p className="lbl">How this works</p>
      <h1 className="page-title">Method</h1>
      <p className="lede">
        This is a replay of past Blue, Red and Green Line service. For each scheduled train at each platform, a model
        made a forecast at 8 PM the evening before. You can watch that forecast play out against the arrival MBTA
        actually recorded.
      </p>

      <h2>What is predicted</h2>
      <p>
        One example is one scheduled arrival: a trip reaching a platform on a service date. The target is <em>delay</em>:
        recorded arrival minus scheduled arrival, in seconds. Negative means early. The forecast is three numbers: a
        median and an 80% range (10th to 90th percentile). Nothing observed on the day itself is used, so there are no
        upstream delays, live headways or dwell times.
      </p>

      <h2>Data</h2>
      <ul>
        <li><b>Recorded arrivals</b>: MBTA LAMP daily subway files. <code>stop_timestamp</code> is the first time a train was seen stopped at the platform, with a fallback to the realtime arrival. Treat it as a feed-derived proxy for the arrival.</li>
        <li><b>Schedule</b>: the archived GTFS version in effect for each date, with its calendar exceptions. Times past midnight (e.g. 25:10) and daylight-saving days use the GTFS "noon minus 12 hours" rule.</li>
        <li><b>Join</b>: exact match on date, trip and platform, kept as a left join from the schedule. A scheduled train with no matching record stays visible as "no record". It is not silently dropped.</li>
        <li><b>Extra trains</b>: MBTA logs many trains under <code>ADDED-</code> trip IDs that match no scheduled trip, especially during disruptions and special-event service. They are counted on the Results page but are not part of the benchmark.</li>
        <li><b>Source gaps</b>: some daily files are empty. Those days are marked "no MBTA data" and excluded from denominators.</li>
      </ul>

      <h2>Lines and branches</h2>
      <ul>
        <li><b>Blue Line</b>: one trunk, Wonderland to Bowdoin.</li>
        <li><b>Red Line</b>: a shared trunk from Alewife to JFK/UMass, then the Ashmont and Braintree branches.</li>
        <li><b>Green Line</b>: four routes (B, C, D, E) that share the central subway and split at Kenmore and Copley, with surface stops on every branch. Trains on the shared tracks show on every branch strip they pass through.</li>
        <li>Branches are detected from the schedule's own trip patterns. Each line has its own model, calibration and score, so a noisy line cannot widen another line's ranges.</li>
      </ul>

      <h2>Time splits</h2>
      <ul>
        <li>Train: {span('train')}</li>
        <li>Validation: {span('validation')} (feature, hyperparameter and early-stopping choices)</li>
        <li>Calibration: {span('calibration')} (interval widening only, after the model was frozen)</li>
        <li>Test: {span('test')} (scored once; the only days you can replay)</li>
      </ul>
      <p>One-week gaps separate the blocks, and every service day stays whole inside one block.</p>

      <h2>Systems compared</h2>
      <ul>
        <li><b>Scheduled arrival</b>: predicts zero delay. This is the bar a model has to clear.</li>
        <li><b>Historical baseline</b>: delay percentiles from training data, by platform, time of day and weekday/weekend. It needs at least 50 rows per group and falls back to platform, then line-wide.</li>
        <li><b>LightGBM</b>: three quantile models (α = 0.10, 0.50, 0.90) per line, on schedule features: route/branch, platform, direction, stop sequence, weekday, time of day, the scheduled gap to the previous train, and the day's planned service level. Outputs are sorted so the range never crosses.</li>
        <li><b>Calibrated LightGBM</b>: split conformalized quantile regression (Romano, Patterson &amp; Candès, 2019). Both ends of the range are widened by the score quantile from the calibration weeks.</li>
      </ul>

      <h2>Honest caveats</h2>
      <ul>
        {release.retrospective_notes.map((n) => <li key={n}>{n}</li>)}
        <li>Conformal guarantees assume exchangeable data, and consecutive trains are not. Coverage is reported empirically on later weeks, by station and by week, so drift is visible.</li>
        <li>A wider range always covers more. Read coverage together with width and interval score.</li>
        <li>History features use rolling medians of daily per-platform medians (and of daily 90th percentiles) from D−29 to D−2. That keeps the build tractable at 13 million scheduled arrivals.</li>
        <li>
          Subway lines are run to headways, not exact timetables. When a train starts late or another train takes over a
          scheduled trip's ID, the delay against that trip can reach tens of minutes even though riders still saw frequent
          trains. On the Blue Line in the test weeks, 10% of matched arrivals were 24+ minutes behind their trip's
          schedule, and that spread was already there at the first stop. This is why the ranges are wide, and why a passenger wait-time target is
          the natural next experiment.
        </li>
      </ul>

      <h2>Reproduce it</h2>
      <p>
        Release <code>{release.release_id}</code> was built from commit <code>{release.code_commit}</code> using{' '}
        {release.inputs.lamp_files} LAMP files and {release.inputs.gtfs_feeds} archived schedules. Run{' '}
        <code>make fetch build-data train calibrate evaluate export</code> to rebuild it.
      </p>

      <h2>Sources</h2>
      <ul>
        {release.sources.map((x) => <li key={x.url}><a href={x.url}>{x.name}</a></li>)}
        <li>Motivation: probabilistic transit forecasting research, e.g. Transportation Research Part C (2026), on showing uncertainty alongside predictions.</li>
      </ul>
      <p><b>{release.disclaimer}</b></p>
    </main>
  )
}
