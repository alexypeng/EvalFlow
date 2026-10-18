# Four-worker arrival-rate sweep

Captured: 2026-10-18T12:10:36.112Z

4 fixed workers, concurrency 1, 2000ms mock latency; 60s of arrivals per trial.
3 trials per rate; rotated order, warmup batch and full drain between trials.
Direct Postgres queue producer; HTTP and real-provider latency excluded.

## Across repeated trials

Each cell is the median [minimum–maximum] of trial-level measurements. Trial p99 values are not pooled.

| Arrivals/s | Valid trials | Completed | Completion/s during arrivals | Completion/s incl. drain | Total p99 ms | Queue p99 ms | Execution p99 ms | Peak queued (sampled) | Drain s |
|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3/3 | 180/180 | 0.97 [0.97–0.97] | 0.98 [0.98–0.98] | 3009.69 [2999.28–3011.92] | 984.87 [984.46–987.87] | 2030.82 [2029.23–2036.23] | 1.00 [1.00–1.00] | 1.31 [1.25–1.41] |
| 2 | 3/3 | 360/360 | 1.90 [1.90–1.90] | 1.92 [1.92–1.92] | 3502.53 [3433.00–3515.20] | 1487.72 [1421.86–1499.44] | 2024.81 [2024.81–2033.05] | 3.00 [3.00–3.00] | 2.49 [2.46–2.54] |
| 3 | 3/3 | 540/540 | 1.92 [1.92–1.92] | 1.94 [1.94–1.94] | 32814.36 [32784.51–33050.10] | 30801.31 [30768.51–31035.26] | 2028.05 [2023.21–2030.00] | 60.00 [60.00–63.00] | 32.76 [32.66–32.89] |

Aggregate statistics are withheld unless every planned repetition for that rate is present and valid.

## Individual trials

| Order | Repetition | Arrivals/s | Jobs | Completion/s incl. drain | Total p99 ms | Queue p99 ms | Drain s | Valid |
|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 1 | 1 | 1 | 60/60 | 0.98 | 3009.69 | 984.87 | 1.31 | yes |
| 2 | 1 | 2 | 120/120 | 1.92 | 3433.00 | 1421.86 | 2.46 | yes |
| 3 | 1 | 3 | 180/180 | 1.94 | 33050.10 | 31035.26 | 32.89 | yes |
| 4 | 2 | 2 | 120/120 | 1.92 | 3515.20 | 1499.44 | 2.54 | yes |
| 5 | 2 | 3 | 180/180 | 1.94 | 32784.51 | 30768.51 | 32.76 | yes |
| 6 | 2 | 1 | 60/60 | 0.98 | 2999.28 | 984.46 | 1.41 | yes |
| 7 | 3 | 3 | 180/180 | 1.94 | 32814.36 | 30801.31 | 32.66 | yes |
| 8 | 3 | 1 | 60/60 | 0.98 | 3011.92 | 987.87 | 1.25 | yes |
| 9 | 3 | 2 | 120/120 | 1.92 | 3502.53 | 1487.72 | 2.49 | yes |

These are repeated local results on a shared Docker host, not a production capacity guarantee.
Finite arrival windows include startup-to-first-completion effects; the drain-inclusive rate includes the full backlog drain.
Queue maxima are sampled. Timestamp latency ends at the completion marker before the final transaction commit tail.
Three trials provide a small observed range, not a confidence interval or a stable population p99.
