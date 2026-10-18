# Polling versus notification wakeups

Captured: 2026-10-18T20:32:23.665Z

Same migrated worker image, one worker/concurrency1, zero configured mock delay, 30 sparse jobs/trial.
3 repetitions/condition with rotated order; identical seeded arrival offsets.
Cells show median [minimum–maximum] of individual trial metrics; trial p99 values are not pooled.

| Condition | Valid trials | Queue p50 ms | Queue p99 ms | Total p99 ms | Execution p99 ms | Empty claim queries/s | All claims/s |
|---|:---:|---:|---:|---:|---:|---:|---:|
| poll-1000 | 3/3 | 404.50 [390.50–441.50] | 952.17 [911.42–965.62] | 967.49 [933.39–982.20] | 23.42 [22.71–28.42] | 0.98 [0.98–0.98] | 1.46 [1.46–1.46] |
| poll-100 | 3/3 | 53.50 [52.50–63.00] | 103.00 [102.84–106.13] | 119.71 [117.42–125.68] | 24.26 [22.00–24.71] | 9.47 [9.46–9.49] | 9.95 [9.94–9.97] |
| notify-1000 | 3/3 | 6.00 [6.00–7.00] | 11.55 [7.71–20.65] | 28.71 [26.42–32.26] | 19.42 [19.42–21.13] | 1.22 [1.22–1.22] | 1.70 [1.70–1.70] |

## Individual trials

| Order | Repeat | Condition | Completed | Queue p99 ms | Total p99 ms | Empty queries | Empty queries/s | Valid |
|---:|---:|---|---:|---:|---:|---:|---:|:---:|
| 1 | 1 | poll-1000 | 30/30 | 965.62 | 982.20 | 61 | 0.98 | yes |
| 2 | 1 | poll-100 | 30/30 | 103.00 | 125.68 | 593 | 9.49 | yes |
| 3 | 1 | notify-1000 | 30/30 | 7.71 | 26.42 | 76 | 1.22 | yes |
| 4 | 2 | poll-100 | 30/30 | 106.13 | 119.71 | 591 | 9.46 | yes |
| 5 | 2 | notify-1000 | 30/30 | 20.65 | 32.26 | 76 | 1.22 | yes |
| 6 | 2 | poll-1000 | 30/30 | 952.17 | 967.49 | 61 | 0.98 | yes |
| 7 | 3 | notify-1000 | 30/30 | 11.55 | 28.71 | 76 | 1.22 | yes |
| 8 | 3 | poll-1000 | 30/30 | 911.42 | 933.39 | 61 | 0.98 | yes |
| 9 | 3 | poll-100 | 30/30 | 102.84 | 117.42 | 592 | 9.47 | yes |

poll-1000/poll-100 use polling only. notify-1000 adds notifications with fixed 1000ms backup checks.
The notification trigger is installed for all conditions; polling controls are freshly measured on the same image.
The notify listener must register once before warmup and show no disconnect/re-registration through the trial.
Claim counter snapshots exclude warmup and count only observed claim operations; producer, probe and other SQL are excluded.
Query rates are not total database CPU/cost: trigger execution and notification connection/network overhead are not included.
Notification mode still performs backup checks and needs one extra listener connection per worker process.
This isolates existing idle-worker pickup; KEDA is paused, so it does not measure scale-from-zero or maximum capacity.
Zero configured mock delay still includes tool/validation/persistence work; total latency excludes HTTP submission.
Completion timestamps precede the final job/eval writes and transaction commit tail, as in earlier reports.
Three local trials of 30 jobs provide a small observed range, not a confidence interval or stable population p99.
Failed/incomplete trials retain their evidence; non-comparable groups have no aggregate latency/query values.
