"""
Simulate a rail crossing by streaming ETA measurements.
Usage:
python rail_sim.py --pattern approach-30s
"""
import argparse
import time
import requests

parser = argparse.ArgumentParser()
parser.add_argument('--target', default='http://localhost:8000/ingest')
parser.add_argument('--pattern', default='approach-30s')
parser.add_argument('--location', default='rail-crossing', help='Location identifier for the crossing')
args = parser.parse_args()

PATTERNS = {
    'approach-30s': {'step': 2000, 'reset': 40000},
    'approach-20s': {'step': 1500, 'reset': 25000},
}

config = PATTERNS.get(args.pattern, PATTERNS['approach-30s'])
step = config['step']
reset = config['reset']

eta = reset
print(f"[rail_sim] publishing ETA updates for {args.location} to {args.target}")

while True:
    eta = max(0, eta - step)
    payload = {
        'kind': 'rail',
        'location': args.location,
        'value': {
            'etaMs': eta,
            'pattern': args.pattern,
        },
        'ts': int(time.time() * 1000),
    }
    try:
        response = requests.post(args.target, json=payload, timeout=3)
        print(f"[rail_sim] etaMs={eta} status={response.status_code}")
    except Exception as exc:  # pragma: no cover - CLI script
        print('[rail_sim] error', exc)
    if eta == 0:
        eta = reset
    time.sleep(step / 1000)
