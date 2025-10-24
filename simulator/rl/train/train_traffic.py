from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import typer
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback, EvalCallback
from stable_baselines3.common.vec_env import DummyVecEnv

from simulator.rl.envs import SumoTrafficSignalEnv

app = typer.Typer(help="Train SUMO-based reinforcement learning policies for traffic lights.")


def _make_env(env_kwargs: dict) -> SumoTrafficSignalEnv:
    return SumoTrafficSignalEnv(**env_kwargs)


@app.command()
def traffic(
    sumo_config: Path = typer.Option(
        Path(__file__).resolve().parents[1] / "sumo" / "configs" / "cross.sumocfg",
        exists=True,
        readable=True,
        help="SUMO configuration file to use for training.",
    ),
    artifact_dir: Path = typer.Option(
        Path(__file__).resolve().parents[1] / "artifacts",
        help="Where to persist trained models and metadata.",
    ),
    total_timesteps: int = typer.Option(200_000, help="Number of training timesteps."),
    max_steps: int = typer.Option(1_800, help="Max simulation steps per episode."),
    warmup_steps: int = typer.Option(60, help="Warm-up steps before the first decision."),
    duration: List[int] = typer.Option([10, 20, 40], help="Allowed green durations (seconds). Repeat to customise."),
    eval_every: int = typer.Option(20_000, help="Evaluation frequency (timesteps)."),
    seed: int = typer.Option(42, help="Random seed."),
    gui: bool = typer.Option(False, flag_value=True, help="Use sumo-gui for visual debugging."),
    sumo_binary: Optional[str] = typer.Option(None, help="Override SUMO binary (defaults to env or sumo/sumo-gui)."),
) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    checkpoints_dir = artifact_dir / "checkpoints"
    best_dir = artifact_dir / "best"
    eval_dir = artifact_dir / "eval"
    tensorboard_dir = artifact_dir / "runs"
    for folder in (checkpoints_dir, best_dir, eval_dir, tensorboard_dir):
        folder.mkdir(parents=True, exist_ok=True)

    deduped_durations = sorted({int(x) for x in duration if x > 0})
    env_kwargs = dict(
        sumo_config=str(sumo_config.resolve()),
        max_steps=int(max_steps),
        warmup_steps=int(warmup_steps),
        green_durations=tuple(deduped_durations),
        gui=gui,
        sumo_binary=sumo_binary,
    )

    def env_fn():
        return _make_env(env_kwargs)

    vec_env = DummyVecEnv([env_fn])
    eval_env = DummyVecEnv([env_fn])
    vec_env.seed(seed)
    eval_env.seed(seed + 1)

    model = PPO(
        "MlpPolicy",
        vec_env,
        verbose=1,
        n_steps=1024,
        batch_size=256,
        learning_rate=3e-4,
        gamma=0.99,
        gae_lambda=0.95,
        clip_range=0.1,
        tensorboard_log=str(tensorboard_dir),
        seed=seed,
    )

    checkpoint_cb = CheckpointCallback(
        save_freq=max(1, eval_every // 2),
        save_path=str(checkpoints_dir),
        name_prefix="traffic_policy",
    )
    eval_cb = EvalCallback(
        eval_env,
        best_model_save_path=str(best_dir),
        log_path=str(eval_dir),
        eval_freq=eval_every,
        deterministic=True,
        n_eval_episodes=5,
    )

    typer.echo(f"Starting training for {total_timesteps:,} timesteps...")
    model.learn(total_timesteps=total_timesteps, callback=[checkpoint_cb, eval_cb])

    model_path = artifact_dir / "traffic_policy.zip"
    model.save(model_path)

    # Persist metadata for inference service
    env_for_metadata = env_fn()
    metadata = {
        "created_at": datetime.utcnow().isoformat() + "Z",
        "sumo_config": str(sumo_config.resolve()),
        "total_timesteps": total_timesteps,
        "max_steps": max_steps,
        "warmup_steps": warmup_steps,
        "green_durations": deduped_durations,
        "action_mapping": env_for_metadata.action_mapping(),
    }
    env_for_metadata.close()

    metadata_path = artifact_dir / "traffic_policy.meta.json"
    metadata_path.write_text(json.dumps(metadata, indent=2))

    typer.echo(f"Saved policy to {model_path.relative_to(artifact_dir.parent)}")
    typer.echo(f"Metadata written to {metadata_path.relative_to(artifact_dir.parent)}")

    vec_env.close()
    eval_env.close()


if __name__ == "__main__":
    app()
