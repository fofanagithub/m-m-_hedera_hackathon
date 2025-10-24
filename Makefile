.PHONY: rl-train rl-smoke infer up down logs

rl-smoke:
\tpython -m simulator.rl.envs.smoke_test

rl-train:
\tpython simulator/rl/train/train_traffic.py

infer:
\tuvicorn apps.inference.src.infer_server:app --host 0.0.0.0 --port 8100

up:
\tdocker compose up --build

down:
\tdocker compose down

logs:
\tdocker compose logs -f agents backend
