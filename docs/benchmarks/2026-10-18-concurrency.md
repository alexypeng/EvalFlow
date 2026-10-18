# One-worker concurrency comparison

Captured: 2026-10-18T21:13:49.431Z

One fixed worker Pod/process; 1/2/4 concurrent slots, 2000ms mock latency, 3 arrivals/s for 30s.
3 rotated repetitions per setting, 90 measured jobs/trial; per-slot warmup and full drain.
Same image/resources, polling-only mode at 1000ms, no mock permits or trace export; HTTP submission excluded.
Cells show median [minimum–maximum] of trial metrics; trial p99 values are not pooled.

| Slots | Valid trials | Completion/s during arrivals | Completion/s incl. drain | Total p50 ms | Total p99 ms | Queue p99 ms | Execution p99 ms | Peak queued (sampled) | Drain s |
|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3/3 | 0.47 [0.47–0.47] | 0.49 [0.49–0.49] | 78119.00 [77991.00–78137.50] | 151773.46 [151567.79–151775.46] | 149756.57 [149550.01–149762.91] | 2024.10 [2023.33–2037.84] | 75.00 [75.00–75.00] | 152.94 [152.74–152.95] |
| 2 | 3/3 | 0.93 [0.93–0.93] | 0.98 [0.98–0.98] | 32525.50 [32497.00–32551.50] | 62266.96 [62215.74–62270.52] | 60253.85 [60194.52–60254.41] | 2029.00 [2024.11–2031.11] | 60.00 [60.00–60.00] | 61.90 [61.85–61.90] |
| 4 | 3/3 | 1.83 [1.83–1.83] | 1.90 [1.89–1.90] | 9998.50 [9970.00–10070.50] | 17816.08 [17782.18–17894.74] | 15796.64 [15766.52–15879.52] | 2031.55 [2030.33–2037.40] | 30.00 [30.00–32.00] | 17.45 [17.42–17.53] |

## Individual trials

| Order | Repeat | Slots | Completed | Observed overlap | Completion/s incl. drain | Total p99 ms | Drain s | Valid |
|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 1 | 1 | 1 | 90/90 | 1 | 0.49 | 151775.46 | 152.95 | yes |
| 2 | 1 | 2 | 90/90 | 2 | 0.98 | 62266.96 | 61.90 | yes |
| 3 | 1 | 4 | 90/90 | 4 | 1.89 | 17894.74 | 17.53 | yes |
| 4 | 2 | 2 | 90/90 | 2 | 0.98 | 62215.74 | 61.85 | yes |
| 5 | 2 | 4 | 90/90 | 4 | 1.90 | 17816.08 | 17.45 | yes |
| 6 | 2 | 1 | 90/90 | 1 | 0.49 | 151773.46 | 152.94 | yes |
| 7 | 3 | 4 | 90/90 | 4 | 1.90 | 17782.18 | 17.42 | yes |
| 8 | 3 | 1 | 90/90 | 1 | 0.49 | 151567.79 | 152.74 | yes |
| 9 | 3 | 2 | 90/90 | 2 | 0.98 | 62270.52 | 61.90 | yes |

Ideal service rates before overhead are 0.5/1/2 jobs/s; 3 arrivals/s overload every setting.
Arrival-window rates include initial pickup and in-flight work; drain-inclusive rates include the full batch and final partial wave.
Observed overlap uses database start/completion markers and must reach the configured slot count.
The completion marker precedes final writes/commit; timestamp latencies exclude that transaction tail.
Three trials on a shared local Docker host give a small observed range, not a confidence interval or production capacity guarantee.
This tests in-process concurrency with fixed resources; pool sizing, CPU saturation and claim contention are not independently isolated.
KEDA is paused; process startup and per-slot warmup are excluded. Original concurrency/scaling settings are restored.
