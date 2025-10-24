import axios from 'axios';
import fs from 'node:fs';

const DOCKER_INFERENCE_DEFAULT = 'http://inference:8100';
const LOCAL_INFERENCE_DEFAULT = 'http://localhost:8100';

const runningInsideContainer = (() => {
  if (
    process.env.DOCKER === 'true' ||
    process.env.CONTAINER === 'docker' ||
    process.env.DOCKER_CONTAINER === 'true'
  ) {
    return true;
  }
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
})();

function resolveBaseUrl(): string {
  const explicit =
    process.env.INFERENCE_BASE_URL?.trim() ||
    process.env.TRAFFIC_INFER_URL?.trim() ||
    process.env.RAIL_INFER_URL?.trim();
  if (explicit) {
    return explicit;
  }
  return runningInsideContainer ? DOCKER_INFERENCE_DEFAULT : LOCAL_INFERENCE_DEFAULT;
}

const DEFAULT_BASE_URL = resolveBaseUrl();
const REQUEST_TIMEOUT_MS = Number(process.env.INFERENCE_TIMEOUT_MS ?? 5000);

export interface TrafficObservationPayload {
  queue_ns: number;
  queue_ew: number;
  wait_ns?: number;
  wait_ew?: number;
  is_ns_green?: number;
  progress?: number;
}

export interface TrafficInferenceResult {
  plan: Record<string, unknown>;
  action_index: number;
  confidence: number;
  policy_metadata: Record<string, unknown>;
}

export interface RailObservationPayload {
  eta_ms: number;
  barrier_closed: number;
}

export interface RailInferenceResult {
  command: Record<string, unknown>;
  action_index: number;
  confidence: number;
  policy_metadata: Record<string, unknown>;
}

function getClient() {
  return axios.create({
    baseURL: DEFAULT_BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

const client = getClient();

export async function inferTraffic(observation: TrafficObservationPayload) {
  const { data } = await client.post<TrafficInferenceResult>('/traffic/infer', { observation });
  return data;
}

export async function inferRail(observation: RailObservationPayload) {
  const { data } = await client.post<RailInferenceResult>('/rail/infer', { observation });
  return data;
}
