from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .load_model import PolicyBundle, load_policy

TRAFFIC_MODEL_PATH = Path(os.environ.get("MODEL_PATH", "/models/traffic_policy.zip"))
TRAFFIC_META_PATH = Path(os.environ.get("MODEL_METADATA_PATH", TRAFFIC_MODEL_PATH.with_suffix(".meta.json")))
RAIL_MODEL_PATH = Path(os.environ.get("RAIL_MODEL_PATH", "/models/rail_policy.zip"))
RAIL_META_PATH = Path(os.environ.get("RAIL_MODEL_METADATA_PATH", RAIL_MODEL_PATH.with_suffix(".meta.json")))

app = FastAPI(title="SmartCity Policy Inference")


class TrafficObservation(BaseModel):
    queue_ns: float = Field(..., ge=0)
    queue_ew: float = Field(..., ge=0)
    wait_ns: Optional[float] = Field(None, ge=0)
    wait_ew: Optional[float] = Field(None, ge=0)
    is_ns_green: Optional[float] = Field(None, ge=0, le=1)
    progress: Optional[float] = Field(None, ge=0, le=1)


class TrafficInferenceRequest(BaseModel):
    observation: TrafficObservation
    context: Dict[str, Any] = Field(default_factory=dict)


class TrafficInferenceResponse(BaseModel):
    plan: Dict[str, Any]
    action_index: int
    confidence: float
    policy_metadata: Dict[str, Any]


class RailObservation(BaseModel):
    eta_ms: float = Field(..., ge=0)
    barrier_closed: float = Field(..., ge=0, le=1)


class RailInferenceRequest(BaseModel):
    observation: RailObservation
    context: Dict[str, Any] = Field(default_factory=dict)


class RailInferenceResponse(BaseModel):
    command: Dict[str, Any]
    action_index: int
    confidence: float
    policy_metadata: Dict[str, Any]


DEFAULT_TRAFFIC_MAPPING: List[Dict[str, Any]] = []
for idx, (phase, duration) in enumerate(
    [("NS", 10), ("NS", 20), ("NS", 40), ("EW", 10), ("EW", 20), ("EW", 40)]
):
    DEFAULT_TRAFFIC_MAPPING.append({"index": idx, "phase": phase, "duration": duration})

DEFAULT_RAIL_MAPPING: List[Dict[str, Any]] = [
    {"index": 0, "barrier_state": "OPEN"},
    {"index": 1, "barrier_state": "CLOSE"},
]


@lru_cache
def get_traffic_policy_bundle() -> PolicyBundle:
    metadata_path = TRAFFIC_META_PATH if TRAFFIC_META_PATH.exists() else None
    return load_policy(
        TRAFFIC_MODEL_PATH,
        metadata_path,
        default_action_mapping=DEFAULT_TRAFFIC_MAPPING,
    )


@lru_cache
def get_rail_policy_bundle() -> PolicyBundle:
    metadata_path = RAIL_META_PATH if RAIL_META_PATH.exists() else None
    return load_policy(
        RAIL_MODEL_PATH,
        metadata_path,
        default_action_mapping=DEFAULT_RAIL_MAPPING,
    )


def _traffic_observation_to_vector(obs: TrafficObservation) -> np.ndarray:
    wait_ns = obs.wait_ns if obs.wait_ns is not None else obs.queue_ns * 2.0
    wait_ew = obs.wait_ew if obs.wait_ew is not None else obs.queue_ew * 2.0
    is_ns_green = obs.is_ns_green if obs.is_ns_green is not None else 1.0
    progress = obs.progress if obs.progress is not None else 0.0
    return np.array(
        [
            float(obs.queue_ns),
            float(obs.queue_ew),
            float(wait_ns),
            float(wait_ew),
            float(is_ns_green),
            float(progress),
        ],
        dtype=np.float32,
    )


def _traffic_action_to_plan(bundle: PolicyBundle, action_index: int) -> Dict[str, Any]:
    for spec in bundle.action_mapping:
        if int(spec.get("index")) == action_index:
            duration = int(spec.get("duration", 10))
            phase = str(spec.get("phase", "NS"))
            if phase.upper() == "NS":
                return {"ns": "green", "eo": "red", "durationSec": duration}
            if phase.upper() == "EW":
                return {"ns": "red", "eo": "green", "durationSec": duration}
    raise HTTPException(status_code=500, detail=f"No traffic mapping for index={action_index}")


def _rail_observation_to_vector(obs: RailObservation, env_metadata: Dict[str, Any]) -> np.ndarray:
    max_eta = float(env_metadata.get("max_eta_ms", 60_000) or 60_000)
    eta_norm = float(obs.eta_ms) / max_eta if max_eta > 0 else 0.0
    barrier = float(obs.barrier_closed)
    return np.array([eta_norm, barrier], dtype=np.float32)


def _rail_action_to_command(bundle: PolicyBundle, action_index: int) -> Dict[str, Any]:
    for spec in bundle.action_mapping:
        if int(spec.get("index")) == action_index:
            raw_state = str(spec.get("barrier_state", "CLOSE")).upper()
            if raw_state == "OPEN":
                return {"state": "OPEN"}
            return {"state": "CLOSED"}
    raise HTTPException(status_code=500, detail=f"No rail mapping for index={action_index}")


def _value_to_confidence(value: np.ndarray) -> float:
    if value is None or np.size(value) == 0:
        return 0.5
    raw = float(np.ravel(value)[0])
    return float(1.0 / (1.0 + math.exp(-raw)))


@app.on_event("startup")
async def warmup_models() -> None:
    for loader in (get_traffic_policy_bundle, get_rail_policy_bundle):
        try:
            loader()
        except Exception:  # pragma: no cover - best effort
            pass


@app.get("/health")
async def healthcheck() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/traffic/infer", response_model=TrafficInferenceResponse)
async def infer_traffic(request: TrafficInferenceRequest) -> TrafficInferenceResponse:
    bundle = get_traffic_policy_bundle()
    vector = _traffic_observation_to_vector(request.observation)
    action, critic_value = bundle.predict(vector)
    plan = _traffic_action_to_plan(bundle, action)
    confidence = _value_to_confidence(critic_value)

    return TrafficInferenceResponse(
        plan=plan,
        action_index=action,
        confidence=confidence,
        policy_metadata={
            "action_mapping": bundle.action_mapping,
            "model_path": str(TRAFFIC_MODEL_PATH),
            "metadata_path": str(TRAFFIC_META_PATH) if TRAFFIC_META_PATH.exists() else None,
        },
    )


@app.post("/rail/infer", response_model=RailInferenceResponse)
async def infer_rail(request: RailInferenceRequest) -> RailInferenceResponse:
    bundle = get_rail_policy_bundle()
    metadata: Dict[str, Any] = {}
    meta_path = RAIL_META_PATH if RAIL_META_PATH.exists() else None
    if meta_path is not None:
        try:
            metadata = json.loads(meta_path.read_text())
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=500, detail=f"Invalid metadata file {meta_path}") from exc
    env_meta = metadata.get("env", {}) if isinstance(metadata, dict) else {}
    vector = _rail_observation_to_vector(request.observation, env_meta)
    action, critic_value = bundle.predict(vector)
    command = _rail_action_to_command(bundle, action)
    confidence = _value_to_confidence(critic_value)

    return RailInferenceResponse(
        command=command,
        action_index=action,
        confidence=confidence,
        policy_metadata={
            "action_mapping": bundle.action_mapping,
            "model_path": str(RAIL_MODEL_PATH),
            "metadata_path": str(RAIL_META_PATH) if RAIL_META_PATH.exists() else None,
        },
    )
