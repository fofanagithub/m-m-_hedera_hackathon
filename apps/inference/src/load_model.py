from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.base_class import BaseAlgorithm


@dataclass
class PolicyBundle:
    model: BaseAlgorithm
    action_mapping: List[Dict[str, Any]]

    def predict(self, observation: np.ndarray) -> Tuple[int, np.ndarray]:
        observation = np.asarray(observation, dtype=np.float32)
        if observation.ndim == 1:
            observation = observation.reshape(1, -1)

        action, _ = self.model.predict(observation, deterministic=True)
        action_array = np.asarray(action).reshape(-1)
        action_index = int(action_array[0])

        with torch.no_grad():
            obs_tensor = torch.as_tensor(observation, device=self.model.device, dtype=torch.float32)
            values_tensor = self.model.policy.predict_values(obs_tensor)
            values = values_tensor.detach().cpu().numpy()

        return action_index, values


def _load_metadata(path: Optional[Path], default_mapping: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    if path is None or not path.exists():
        if default_mapping is not None:
            return list(default_mapping)
        raise FileNotFoundError("Metadata path not provided and no default mapping supplied")

    data = json.loads(path.read_text())
    mapping = data.get("action_mapping", [])
    if not mapping:
        raise ValueError(f"Metadata file {path} does not contain 'action_mapping'.")
    return mapping


def load_policy(model_path: Path, metadata_path: Optional[Path] = None, *, default_action_mapping: Optional[List[Dict[str, Any]]] = None) -> PolicyBundle:
    if not model_path.exists():
        raise FileNotFoundError(f"Policy weights not found at {model_path}")

    model = PPO.load(str(model_path))
    action_mapping = _load_metadata(metadata_path, default_action_mapping)
    return PolicyBundle(model=model, action_mapping=action_mapping)
