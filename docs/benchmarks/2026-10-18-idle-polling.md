# Idle polling comparison

Captured: 2026-10-18T19:57:35.111Z

One worker/concurrency1, zero mock delay, 30 seeded sparse arrivals per trial.
3 paired repetitions, alternating interval order; same arrival offsets each time.
Cells show median [minimum–maximum] of trial metrics; p99 values are not pooled.

| Poll ms | Valid trials | Queue p50 ms | Queue p99 ms | Total p99 ms | Execution p99 ms | Empty claim queries/s | All claims/s |
|---:|:---:|---:|---:|---:|---:|---:|---:|
| 1000 | 3/3 | 428.00 [409.50–466.50] | 972.33 [967.98–991.42] | 989.46 [986.21–1010.71] | 21.71 [20.71–22.71] | 0.98 [0.98–0.98] | 1.46 [1.46–1.46] |
| 100 | 3/3 | 66.50 [63.00–67.50] | 107.71 [99.71–109.42] | 123.71 [116.13–129.84] | 20.71 [19.71–21.71] | 9.47 [9.46–9.49] | 9.95 [9.94–9.97] |

## Individual trials

| Order | Repeat | Poll ms | Completed | Queue p99 ms | Total p99 ms | Empty queries | Empty queries/s | Valid |
|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| 1 | 1 | 1000 | 30/30 | 967.98 | 986.21 | 61 | 0.98 | yes |
| 2 | 1 | 100 | 30/30 | 109.42 | 129.84 | 591 | 9.46 | yes |
| 3 | 2 | 100 | 30/30 | 99.71 | 116.13 | 593 | 9.49 | yes |
| 4 | 2 | 1000 | 30/30 | 991.42 | 1010.71 | 61 | 0.98 | yes |
| 5 | 3 | 1000 | 30/30 | 972.33 | 989.46 | 61 | 0.98 | yes |
| 6 | 3 | 100 | 30/30 | 107.71 | 123.71 | 592 | 9.47 | yes |

Claim counters are sampled after warmup and at the end of the observation window.
Empty claims each correspond to one successful queue claim query returning no job; health, producer and other SQL are excluded.
The query rate is an observed count, not a direct CPU/cost measurement. Query errors, resets or worker replacement invalidate a trial.
This is a sparse-arrival wakeup experiment on a shared local host, not a throughput-capacity measurement.
Zero mock delay still includes tool calls, validation, tracing and persistence work. Queue maxima are sampled.
Three paired trials provide a small observed range, not a confidence interval or stable population p99.
