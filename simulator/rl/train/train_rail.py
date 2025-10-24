from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Optional

import typer
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback, EvalCallback
from stable_baselines3.common.vec_env import DummyVecEnv

from simulator.rl.envs import RailCrossingEnv

app = typer.Typer(help="Train reinforcement learning policies for rail barrier control.")


def _make_env(env_kwargs: dict) -> RailCrossingEnv:
    return RailCrossingEnv(**env_kwargs)


@app.command()
def rail(
    artifact_dir: Path = typer.Option(
        Path(__file__).resolve().parents[1] / "artifacts" / "rail",
        help="Directory to store training artifacts.",
    ),
    total_timesteps: int = typer.Option(400_000, help="Number of training timesteps."),
    eval_every: int = typer.Option(20_000, help="Evaluation frequency in timesteps."),
    seed: int = typer.Option(17, help="Random seed."),
    max_eta_ms: int = typer.Option(60_000, help="Maximum simulated ETA for trains (ms)."),
    time_step_ms: int = typer.Option(2_000, help="Time delta per environment step (ms)."),
    close_lead_ms: int = typer.Option(20_000, help="Barrier should be closed within this lead time (ms)."),
    fail_penalty: float = typer.Option(-50.0, help="Penalty when barrier is open during arrival."),
    close_penalty: float = typer.Option(-0.01, help="Penalty applied each step the barrier stays closed."),
    success_reward: float = typer.Option(5.0, help="Reward when the barrier is closed as train passes."),
) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    checkpoints_dir = artifact_dir / "checkpoints"
    best_dir = artifact_dir / "best"
    eval_dir = artifact_dir / "eval"
    tensorboard_dir = artifact_dir / "runs"
    for folder in (checkpoints_dir, best_dir, eval_dir, tensorboard_dir):
        folder.mkdir(parents=True, exist_ok=True)

    env_kwargs = dict(
        max_eta_ms=int(max_eta_ms),
        time_step_ms=int(time_step_ms),
        close_lead_ms=int(close_lead_ms),
        fail_penalty=float(fail_penalty),
        close_penalty=float(close_penalty),
        success_reward=float(success_reward),
        seed=int(seed),
    )

    def env_fn() -> RailCrossingEnv:
        return _make_env(env_kwargs)

    vec_env = DummyVecEnv([env_fn])
    eval_env = DummyVecEnv([env_fn])

    model = PPO(
        "MlpPolicy",
        vec_env,
        verbose=1,
        n_steps=1024,
        batch_size=256,
        learning_rate=3e-4,
        gamma=0.99,
        gae_lambda=0.95,
        clip_range=0.2,
        tensorboard_log=str(tensorboard_dir),
        seed=seed,
    )

    checkpoint_cb = CheckpointCallback(
        save_freq=max(1, eval_every // 2),
        save_path=str(checkpoints_dir),
        name_prefix="rail_policy",
    )
    eval_cb = EvalCallback(
        eval_env,
        best_model_save_path=str(best_dir),
        log_path=str(eval_dir),
        eval_freq=eval_every,
        deterministic=True,
        n_eval_episodes=5,
    )

    typer.echo(f"Starting rail training for {total_timesteps:,} timesteps...")
    model.learn(total_timesteps=total_timesteps, callback=[checkpoint_cb, eval_cb])

    model_path = artifact_dir / "rail_policy.zip"
    model.save(model_path)

    env_for_metadata = env_fn()
    metadata = {
        "created_at": datetime.utcnow().isoformat() + "Z",
        "env": {
            "max_eta_ms": env_for_metadata.max_eta_ms,
            "time_step_ms": env_for_metadata.time_step_ms,
            "close_lead_ms": env_for_metadata.close_lead_ms,
            "fail_penalty": env_for_metadata.fail_penalty,
            "close_penalty": env_for_metadata.close_penalty,
            "success_reward": env_for_metadata.success_reward,
        },
        "total_timesteps": total_timesteps,
        "action_mapping": list(env_for_metadata.action_mapping()),
    }
    env_for_metadata.close()

    metadata_path = artifact_dir / "rail_policy.meta.json"
    metadata_path.write_text(json.dumps(metadata, indent=2))

    typer.echo(f"Saved policy to {model_path.relative_to(artifact_dir.parent)}")
    typer.echo(f"Metadata written to {metadata_path.relative_to(artifact_dir.parent)}")

    vec_env.close()
    eval_env.close()


if __name__ == "__main__":
    app()
