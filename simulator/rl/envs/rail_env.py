from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Tuple

import gymnasium as gym
import numpy as np
from gymnasium import spaces


@dataclass(frozen=True)
class RailActionSpec:
    index: int
    label: str


class RailCrossingEnv(gym.Env[np.ndarray, int]):
    """Simple rail crossing controller environment.

    The agent decides whether to keep the barrier open or close it as a train approaches.
    Observation is normalised eta plus the current barrier state.
    """

    metadata = {"render_modes": ["human"], "render_fps": 1}

    def __init__(
        self,
        *,
        max_eta_ms: int = 60_000,
        time_step_ms: int = 2_000,
        close_lead_ms: int = 20_000,
        fail_penalty: float = -50.0,
        close_penalty: float = -0.005,
        success_reward: float = 5.0,
        seed: Optional[int] = None,
    ) -> None:
        super().__init__()
        if time_step_ms <= 0:
            raise ValueError("time_step_ms must be > 0")
        if not (0 < close_lead_ms <= max_eta_ms):
            raise ValueError("close_lead_ms must be in (0, max_eta_ms]")

        self.max_eta_ms = int(max_eta_ms)
        self.time_step_ms = int(time_step_ms)
        self.close_lead_ms = int(close_lead_ms)
        self.fail_penalty = float(fail_penalty)
        self.close_penalty = float(close_penalty)
        self.success_reward = float(success_reward)

        self.observation_space = spaces.Box(low=0.0, high=1.0, shape=(2,), dtype=np.float32)
        self.action_space = spaces.Discrete(2)

        self._rng = np.random.default_rng(seed)
        self._eta_ms = self.max_eta_ms
        self._barrier_closed = False
        self._time_closed_ms = 0
        self._elapsed_ms = 0
        self._episode_done = False

        self.action_table: Tuple[RailActionSpec, ...] = (
            RailActionSpec(index=0, label="OPEN"),
            RailActionSpec(index=1, label="CLOSE"),
        )

    def reset(self, *, seed: Optional[int] = None, options: Optional[Dict] = None):  # type: ignore[override]
        if seed is not None:
            self._rng = np.random.default_rng(seed)
        self._eta_ms = self._rng.integers(int(0.6 * self.max_eta_ms), self.max_eta_ms + 1)
        self._barrier_closed = False
        self._time_closed_ms = 0
        self._elapsed_ms = 0
        self._episode_done = False
        return self._observe(), {}

    def step(self, action: int):  # type: ignore[override]
        if self._episode_done:
            raise RuntimeError("Call reset() before stepping after episode ended")
        if not self.action_space.contains(action):
            raise ValueError(f"Invalid action {action}")

        reward = 0.0
        info: Dict[str, float] = {}

        if action == 1:
            self._barrier_closed = True
        else:
            self._barrier_closed = False

        self._eta_ms = max(0, self._eta_ms - self.time_step_ms)
        self._elapsed_ms += self.time_step_ms
        if self._barrier_closed:
            self._time_closed_ms += self.time_step_ms
            reward += self.close_penalty
        else:
            self._time_closed_ms = max(0, self._time_closed_ms - self.time_step_ms)

        approaching = self._eta_ms <= self.close_lead_ms
        if approaching and not self._barrier_closed:
            reward += self.fail_penalty
            self._episode_done = True
        elif self._eta_ms == 0:
            if self._barrier_closed:
                reward += self.success_reward
                self._episode_done = True
            else:
                reward += self.fail_penalty
                self._episode_done = True
        elif self._barrier_closed and self._eta_ms > self.close_lead_ms:
            reward += self.close_penalty * 2

        obs = self._observe()
        terminated = self._episode_done
        truncated = False
        info.update(
            eta_ms=float(self._eta_ms),
            barrier_closed=float(self._barrier_closed),
            elapsed_ms=float(self._elapsed_ms),
        )
        return obs, reward, terminated, truncated, info

    def close(self):
        super().close()

    def _observe(self) -> np.ndarray:
        eta_norm = self._eta_ms / self.max_eta_ms if self.max_eta_ms > 0 else 0.0
        barrier = 1.0 if self._barrier_closed else 0.0
        return np.array([eta_norm, barrier], dtype=np.float32)

    def action_mapping(self) -> Tuple[Dict[str, str], ...]:
        return tuple({"index": spec.index, "barrier_state": spec.label} for spec in self.action_table)
