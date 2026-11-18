# Lighthouse Tester

Runs Lighthouse in bulk (URLs × environment profiles × N runs), records the machine's conditions
before, during and after, and writes a report plus a CSV that can be uploaded later as a baseline.
There is no database: the CSV is the only persistent record.

## Use

```sh
npm install
npm start            # web UI at http://localhost:4173
```

Needs Node 22.19+ and Google Chrome (or Chromium) installed.

CLI (same engine, same config):

```sh
node src/cli.js env
node src/cli.js run --url https://example.com --profile desktop-cable --runs 5
node src/cli.js run --url https://example.com --baseline output/<batch>/results.csv
node src/cli.js compare --baseline old.csv --current new.csv
npm test             # unit tests
npm run smoke        # real Lighthouse run against a local page (needs Chrome)
```

CI (`.github/workflows/ci.yml`) runs both on Ubuntu, macOS and Windows with Node 22 and 24.

## Output

Each batch is a folder under `output/` (configurable):

| File | What |
|---|---|
| `report.html` | Summary. A banner at the top states whether conditions were ideal, with before/after values for every check |
| `results.csv` | One row per run plus one median row per URL × profile. Includes the conditions at the start of each run, versions, OS and CPU. Upload it later as a baseline |
| `batch.json` | Full structured record, including environment snapshots |
| `runs/*.report.html` / `*.json` | The native Lighthouse report and LHR for each run |

## Config

`lighthouse-tester.config.json` (created on first start) holds profiles, environment thresholds,
regression thresholds, run defaults and probe settings. Edit it by hand or in the UI.

## How conditions are judged

Checks: power source, power saver, CPU load, free memory, thermal state, latency, jitter, connection
failures, download throughput, Wi-Fi signal. Each is Ideal, Warning, Poor or Not assessed.
A check the OS cannot provide is Not assessed, never a failure. The overall verdict is
Ideal, Acceptable (any warning) or Poor (any poor). Runs are never blocked; the verdict is recorded.

A light snapshot (no throughput or Wi-Fi) is taken before every run; the full one before and after the batch.

## Notes

- The Download throughput check fetches 10 MB from a public speed-test endpoint. Set `probes.throughputUrl` to `null` to disable it.
- Latency and jitter are TCP connect times to the first target's host.
- Runs are serial by design; parallel runs distort each other.
- The server listens on 127.0.0.1 only and rejects other Host and Origin headers.
- Chrome is the one installed on the machine; its version is recorded per row and compared against the baseline.
