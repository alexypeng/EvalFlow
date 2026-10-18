# Fixed-worker benchmark

Captured: 2026-10-18T10:22:51.581Z

Queue/worker benchmark: direct Postgres producer, mock provider, one job/second, 2000ms mock latency.
One exploratory trial per worker count; workers are warmed before measurement. This excludes HTTP latency.

| Workers | Completed | Completion/s during arrivals | Completion/s incl. drain | Total p50 ms | Total p99 ms | Queue p99 ms | Execution p99 ms | Drain s | Valid |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 1 | 60/60 | 0.48 | 0.49 | 33190.00 | 62777.48 | 60758.25 | 2028.51 | 62.39 | yes |
| 2 | 60/60 | 0.95 | 0.96 | 2992.50 | 3407.43 | 1393.79 | 2025.82 | 2.42 | yes |
| 4 | 60/60 | 0.97 | 0.98 | 2211.00 | 2879.48 | 860.07 | 2027.41 | 1.16 | yes |

The workload offers only one job/second. A four-worker result near one completion/second does not measure its maximum capacity.
p99 is interpolated over successful jobs; sample counts and failed/missing/pending jobs remain visible in the JSON report.
Queue maxima are sampled, not exact. Queue/execution breakdowns require one attempt; invalid trials must not be compared.
The local Docker host is shared with other services; these are exploratory results, not isolated or repeated capacity measurements.
