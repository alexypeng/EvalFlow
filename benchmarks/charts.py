# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""Render saved evidence; no cluster, database or new workload is required.

From the repository root: uv run benchmarks/charts.py [--check] [--preview-dir DIR]
"""
import argparse
import io
import json
from pathlib import Path
import subprocess

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true", help="fail if committed SVGs differ")
parser.add_argument("--preview-dir", type=Path, help="also render PNGs for visual inspection")
args = parser.parse_args()
data = json.loads(subprocess.check_output(["node", "benchmarks/chartData.mjs"], cwd=ROOT))
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "svg.fonttype": "none",
                     "svg.hashsalt": "evalflow-m6", "axes.spines.top": False, "axes.spines.right": False})

specs = [
    ("capacity", "Four workers: overload builds a backlog", "2-second mock calls · 60 seconds of arrivals per trial",
     [str(g["arrivalRate"]) for g in data["capacity"]], "Incoming jobs / second",
     [("completedPerSecondIncludingDrain", "Completions / second, including drain", 1),
      ("totalP99Ms", "Total latency p99 (seconds)", 0.001)]),
    ("wakeup", "One idle worker: faster pickup with notifications", "Zero configured mock delay · 30 sparse arrivals per trial",
     ["Poll 1000 ms", "Poll 100 ms", "Notify + 1 s backup"], "Wakeup mode",
     [("queueP99Ms", "Queue wait p99 (milliseconds)", 1),
      ("emptyQueriesPerSecond", "Empty claim queries / second", 1)]),
    ("concurrency", "One worker Pod: more concurrent slots reduce waiting", "2-second mock calls · 3 arrivals/second for 30 seconds per trial",
     [str(g["concurrency"]) for g in data["concurrency"]], "Concurrent job slots",
     [("completedPerSecondIncludingDrain", "Completions / second, including drain", 1),
      ("totalP99Ms", "Total latency p99 (seconds)", 0.001)]),
]
for key, title, subtitle, labels, xlabel, metrics in specs:
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.8))
    fig.suptitle(title, fontsize=16, fontweight="bold", y=0.98)
    fig.text(0.5, 0.895, subtitle, ha="center", color="#475569")
    for ax, (metric, ylabel, scale) in zip(axes, metrics):
        values = [g[metric] for g in data[key]]
        mid = [v["median"] * scale for v in values]
        low = [(v["median"] - v["min"]) * scale for v in values]
        high = [(v["max"] - v["median"]) * scale for v in values]
        ax.errorbar(range(len(mid)), mid, yerr=[low, high], fmt="o", color="#0369a1",
                    markersize=8, capsize=6, elinewidth=2)
        for i, value in enumerate(mid):
            ax.annotate(f"{value:.2f}", (i, values[i]["max"] * scale), xytext=(0, 10),
                        textcoords="offset points", ha="center", fontweight="bold")
        ax.set_xticks(range(len(labels)), labels)
        ax.set_xlim(-0.4, len(labels) - 0.6)
        ax.set_ylim(0, max(v["max"] * scale for v in values) * 1.25)
        ax.set_xlabel(xlabel, labelpad=10)
        ax.set_ylabel(ylabel)
        ax.yaxis.grid(True, alpha=0.2)
        ax.set_axisbelow(True)
    fig.text(0.5, 0.025, "Dots: median of 3 trial metrics. Whiskers: observed min–max, not confidence intervals.\n"
             "Trial p99 values are not pooled. Shared local kind/Docker host; HTTP submission excluded.",
             ha="center", fontsize=9, color="#475569")
    fig.subplots_adjust(left=0.08, right=0.98, top=0.81, bottom=0.23, wspace=0.30)
    buffer = io.BytesIO()
    fig.savefig(buffer, format="svg", metadata={"Date": None, "Creator": "EvalFlow benchmark charts"})
    target = ROOT / "docs" / "benchmarks" / "charts" / f"{key}.svg"
    if args.check:
        if not target.exists() or target.read_bytes() != buffer.getvalue():
            raise SystemExit(f"Chart differs: {target.relative_to(ROOT)}")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(buffer.getvalue())
    if args.preview_dir:
        args.preview_dir.mkdir(parents=True, exist_ok=True)
        fig.savefig(args.preview_dir / f"{key}.png", dpi=150)
    plt.close(fig)
    print(f"{'Checked' if args.check else 'Wrote'} {target.relative_to(ROOT)}")
