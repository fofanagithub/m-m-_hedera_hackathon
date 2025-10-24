from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from uuid import uuid4

import numpy as np
from gymnasium import Env, spaces


@dataclass(frozen=True)
class ActionSpec:
    index: int
    phase: str
    duration: int


class SumoTrafficSignalEnv(Env):
    """Single-junction traffic signal control environment powered by SUMO."""

    metadata = {"render_modes": ["human"], "render_fps": 1}

    def __init__(
        self,
        sumo_config: str,
        *,
        max_steps: int = 1800,
        warmup_steps: int = 60,
        green_durations: Tuple[int, ...] = (10, 20, 40),
        gui: bool = False,
        sumo_binary: Optional[str] = None,
    ) -> None:
        super().__init__()

        self._traci_label = f"traffic-env-{uuid4().hex}"

        self._ensure_traci_available()

        cfg_path = Path(sumo_config).resolve()
        if not cfg_path.exists():
            raise FileNotFoundError(f"SUMO configuration not found: {cfg_path}")
        self.sumo_config = str(cfg_path)

        self.max_steps = max_steps
        self.warmup_steps = warmup_steps
        self.green_durations = tuple(sorted(green_durations))
        self.gui = gui
        self.sumo_binary = sumo_binary or os.environ.get("SUMO_BIN") or ("sumo-gui" if gui else "sumo")

        # Traffic light configuration (kept in sync with cross.net.xml)
        self.junction_id = "J0"
        self.ns_lanes: Tuple[str, ...] = ("N2J0_0", "S2J0_0")
        self.ew_lanes: Tuple[str, ...] = ("E2J0_0", "W2J0_0")
        self.phase_index: Dict[str, int] = {"NS": 0, "EW": 2}
        self.amber_index: Dict[Tuple[str, str], int] = {("NS", "EW"): 3, ("EW", "NS"): 1}
        self.amber_duration = 4

        self.action_table: List[ActionSpec] = self._build_action_table()

        # Observation: [queue_ns, queue_ew, wait_ns, wait_ew, is_ns_green, progress]
        self.observation_space = spaces.Box(
            low=np.array([0.0, 0.0, 0.0, 0.0, 0.0, 0.0], dtype=np.float32),
            high=np.array([500.0, 500.0, 1e5, 1e5, 1.0, 1.0], dtype=np.float32),
            dtype=np.float32,
        )

        self.action_space = spaces.Discrete(len(self.action_table))

        self._traci = None
        self._steps = 0
        self._current_phase_label = "NS"

    # ------------------------------------------------------------------
    # Gymnasium API
    # ------------------------------------------------------------------
    def reset(self, *, seed: Optional[int] = None, options: Optional[Dict] = None):  # type: ignore[override]
        super().reset(seed=seed)
        self._close_traci()
        self._start_traci()
        self._steps = 0
        self._current_phase_label = "NS"

        traci = self._require_traci()
        traci.trafficlight.setPhase(self.junction_id, self.phase_index[self._current_phase_label])
        traci.trafficlight.setPhaseDuration(self.junction_id, self.green_durations[0])

        for _ in range(self.warmup_steps):
            traci.simulationStep()
            self._steps += 1

        observation = self._observe()
        return observation, {}

    def step(self, action: int):  # type: ignore[override]
        if not self.action_space.contains(action):
            raise ValueError(f"Invalid action index: {action}")

        self._apply_action(action)
        observation = self._observe()

        queue_ns, queue_ew, wait_ns, wait_ew, _, _ = observation
        reward = -1.0 * (queue_ns + queue_ew + 0.01 * (wait_ns + wait_ew))

        terminated = self._steps >= self.max_steps
        truncated = False

        info = {
            "steps": self._steps,
            "phase": self._current_phase_label,
            "action_spec": asdict(self.action_table[action]),
        }
        return observation, reward, terminated, truncated, info

    def close(self) -> None:
        self._close_traci()
        super().close()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _apply_action(self, action: int) -> None:
        spec = self.action_table[action]
        traci = self._require_traci()

        if spec.phase != self._current_phase_label:
            amber_phase = self.amber_index[(self._current_phase_label, spec.phase)]
            traci.trafficlight.setPhase(self.junction_id, amber_phase)
            traci.trafficlight.setPhaseDuration(self.junction_id, self.amber_duration)
            for _ in range(self.amber_duration):
                traci.simulationStep()
                self._steps += 1
                if self._steps >= self.max_steps:
                    return

        traci.trafficlight.setPhase(self.junction_id, self.phase_index[spec.phase])
        traci.trafficlight.setPhaseDuration(self.junction_id, spec.duration)

        for _ in range(spec.duration):
            traci.simulationStep()
            self._steps += 1
            if self._steps >= self.max_steps:
                break

        self._current_phase_label = spec.phase

    def _observe(self) -> np.ndarray:
        traci = self._require_traci()

        def lane_stats(lanes: Tuple[str, ...]) -> Tuple[float, float]:
            queue = 0.0
            waiting = 0.0
            for lane in lanes:
                queue += float(traci.lane.getLastStepHaltingNumber(lane))
                waiting += float(traci.lane.getWaitingTime(lane))
            return queue, waiting

        queue_ns, wait_ns = lane_stats(self.ns_lanes)
        queue_ew, wait_ew = lane_stats(self.ew_lanes)
        progress = min(1.0, self._steps / max(1, self.max_steps))
        is_ns_green = 1.0 if self._current_phase_label == "NS" else 0.0

        obs = np.array([queue_ns, queue_ew, wait_ns, wait_ew, is_ns_green, progress], dtype=np.float32)
        return obs

    def _start_traci(self) -> None:
        import traci  # local import to ensure SUMO is available at runtime

        args = [self.sumo_binary, "-c", self.sumo_config, "--no-step-log", "true", "--waiting-time-memory", "1000"]
        if not self.gui:
            args += ["--start"]
        traci.start(args, label=self._traci_label)
        self._traci = traci.getConnection(self._traci_label)

    def _close_traci(self) -> None:
        if self._traci is not None:
            try:
                self._traci.close()
            except Exception:
                pass
            finally:
                self._traci = None

    def _require_traci(self):
        if self._traci is None:
            raise RuntimeError("SUMO (traci) session is not running. Call reset() first.")
        return self._traci

    def _build_action_table(self) -> List[ActionSpec]:
        table: List[ActionSpec] = []
        idx = 0
        for duration in self.green_durations:
            table.append(ActionSpec(index=idx, phase="NS", duration=int(duration)))
            idx += 1
        for duration in self.green_durations:
            table.append(ActionSpec(index=idx, phase="EW", duration=int(duration)))
            idx += 1
        return table

    @staticmethod
    def _ensure_traci_available() -> None:
        try:
            import traci  # noqa: F401
        except ImportError as exc:  # pragma: no cover - intentional runtime guard
            raise RuntimeError(
                "The 'traci' module is not available. Install SUMO and set SUMO_HOME (see README)."
            ) from exc

    # Convenience accessors --------------------------------------------------
    def action_mapping(self) -> List[Dict[str, int | str]]:
        """Return a serialisable copy of the action table."""
        return [{"index": spec.index, "phase": spec.phase, "duration": spec.duration} for spec in self.action_table]
