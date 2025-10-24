"""
Synthetic traffic publisher for multiple junctions.
Usage:
python traffic_sim.py --rate 2 --junctions junction-central junction-north junction-west
"""
import argparse
import itertools
import math
import random
import time
from typing import Iterable, List

import requests

# Default junctions displayed on the SmartCity map
DEFAULT_JUNCTIONS = ["junction-central", "junction-north", "junction-west"]

# Deterministic base profiles so each junction has a recognisable pattern
JUNCTION_PROFILES = {
    "junction-central": {"ns": 28, "ew": 18, "phase": 0.0, "ns_amp": 8, "ew_amp": 6},
    "junction-north": {"ns": 18, "ew": 12, "phase": 1.4, "ns_amp": 5, "ew_amp": 4},
    "junction-west": {"ns": 22, "ew": 26, "phase": 2.3, "ns_amp": 7, "ew_amp": 5},
}

parser = argparse.ArgumentParser()
parser.add_argument("--target", default="http://localhost:8000/ingest")
parser.add_argument("--rate", type=float, default=2.0, help="Events per second across all junctions")
parser.add_argument("--junction", help="Single junction id (legacy flag)")
parser.add_argument("--junctions", nargs="+", help="List of junction ids to simulate")
parser.add_argument("--seed", type=int, help="Optional random seed for reproducibility")
args = parser.parse_args()

if args.seed is not None:
    random.seed(args.seed)

selected: List[str]
if args.junctions:
    selected = args.junctions
elif args.junction:
    selected = [args.junction]
else:
    selected = DEFAULT_JUNCTIONS

selected = [item.strip() for item in selected if item.strip()]
if not selected:
    raise SystemExit("No junctions provided")

cycle: Iterable[str] = itertools.cycle(selected)
interval = max(0.15, 1.0 / max(0.5, args.rate * len(selected)))

print(f"[traffic_sim] publishing for {selected} to {args.target}")


def lookup_profile(junction: str) -> dict:
    base = JUNCTION_PROFILES.get(junction)
    if base:
        return base
    phase = random.random() * math.pi
    return {"ns": 20, "ew": 16, "phase": phase, "ns_amp": 6, "ew_amp": 5}


def sample_measurement(junction: str, tick: int) -> dict:
    profile = lookup_profile(junction)
    drift = math.sin(tick / 6.0 + profile.get("phase", 0.0))

    base_ns = profile.get("ns", 20)
    base_ew = profile.get("ew", 16)
    ns_amp = profile.get("ns_amp", 6)
    ew_amp = profile.get("ew_amp", 5)

    queue_ns = max(0, int(base_ns + drift * ns_amp + random.gauss(0, 2.2)))
    queue_ew = max(0, int(base_ew + math.cos(tick / 5.0 + profile.get("phase", 0.0)) * ew_amp + random.gauss(0, 1.8)))

    wait_ns = round(queue_ns * random.uniform(1.4, 3.2), 1)
    wait_ew = round(queue_ew * random.uniform(1.2, 2.8), 1)
    progress = max(0.0, min(0.99, 0.5 + 0.35 * math.sin(tick / 8.0)))
    congestion = float(min(100.0, max(queue_ns, queue_ew) * 1.6))

    return {
        "kind": "traffic",
        "location": junction,
        "value": {
            "avg_queue_len_NS": queue_ns,
            "avg_queue_len_EW": queue_ew,
            "wait_time_NS": wait_ns,
            "wait_time_EW": wait_ew,
            "progress": round(progress, 3),
            "congestion": round(congestion, 1),
        },
        "ts": int(time.time() * 1000),
    }


def main() -> None:
    session = requests.Session()
    tick = 0
    for junction in cycle:
        payload = sample_measurement(junction, tick)
        tick += 1
        try:
            resp = session.post(args.target, json=payload, timeout=3)
            status = resp.status_code
            congestion = payload["value"]["congestion"]
            print(f"[traffic_sim] {junction} congestion={congestion:.1f} status={status}")
        except Exception as exc:  # pragma: no cover - CLI utility
            print(f"[traffic_sim] error posting {junction}: {exc}")
        time.sleep(interval)


if __name__ == "__main__":
    main()
