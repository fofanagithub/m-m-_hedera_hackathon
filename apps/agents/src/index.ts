import 'dotenv/config';
import fs from 'node:fs';
import { tickTraffic } from './graphs/trafficGraph.js';
import { tickRail } from './graphs/railGraph.js';
import { tickSupervisor } from './graphs/supervisorGraph.js';

const DOCKER_BACKEND_DEFAULT = 'http://backend:8000';
const LOCAL_BACKEND_DEFAULT = 'http://localhost:8000';
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

const BACKEND_BASE_URL =
  (process.env.BACKEND_BASE_URL?.trim()) ||
  (runningInsideContainer ? DOCKER_BACKEND_DEFAULT : LOCAL_BACKEND_DEFAULT);

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function joinBase(url: string, suffix: string): string {
  return `${normalizeBaseUrl(url)}${suffix}`;
}

const TRAFFIC_URL =
  (process.env.CONTROLLER_TRAFFIC_URL?.trim()) ||
  joinBase(BACKEND_BASE_URL, '/control/traffic');

const RAIL_URL =
  (process.env.CONTROLLER_RAIL_URL?.trim()) ||
  joinBase(BACKEND_BASE_URL, '/control/rail');

const inferenceBase =
  (process.env.INFERENCE_BASE_URL?.trim()) ||
  (runningInsideContainer ? DOCKER_INFERENCE_DEFAULT : LOCAL_INFERENCE_DEFAULT);

const TRAFFIC_INFER_URL =
  (process.env.TRAFFIC_INFER_URL?.trim()) ||
  inferenceBase;

const RAIL_INFER_URL =
  (process.env.RAIL_INFER_URL?.trim()) ||
  inferenceBase;

const HCS_TOPIC_ID_SUPERVISOR = (process.env.HCS_TOPIC_ID_SUPERVISOR || '').trim();

function resolveBatchLimit(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey]);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return fallback;
}

const MAX_TRAFFIC_BATCH = resolveBatchLimit('TRAFFIC_BATCH_LIMIT', 12);
const MAX_RAIL_BATCH = resolveBatchLimit('RAIL_BATCH_LIMIT', 4);

async function loop() {
  const trafficBatch: Array<Awaited<ReturnType<typeof tickTraffic>>> = [];
  const railBatch: Array<Awaited<ReturnType<typeof tickRail>>> = [];

  try {
    for (let processed = 0; processed < MAX_TRAFFIC_BATCH; processed += 1) {
      const result = await tickTraffic({
        backendBaseUrl: BACKEND_BASE_URL,
        controllerUrl: TRAFFIC_URL,
        inferenceUrl: TRAFFIC_INFER_URL || undefined,
        threshold: 20,
        d0: 15,
        d1: 30,
      });
      if (!result || (result as { skipped?: boolean }).skipped) {
        break;
      }
      trafficBatch.push(result);
    }
  } catch (e) {
    console.error('[agents] traffic tick error', e);
  }

  try {
    for (let processed = 0; processed < MAX_RAIL_BATCH; processed += 1) {
      const result = await tickRail({
        backendBaseUrl: BACKEND_BASE_URL,
        controllerUrl: RAIL_URL,
        closeLeadMs: 20000,
        inferenceUrl: RAIL_INFER_URL || undefined,
      });
      if (!result || (result as { skipped?: boolean }).skipped) {
        break;
      }
      railBatch.push(result);
    }
  } catch (e) {
    console.error('[agents] rail tick error', e);
  }

  const trafficSummary = trafficBatch.length ? trafficBatch[trafficBatch.length - 1] : undefined;
  const railSummary = railBatch.length ? railBatch[railBatch.length - 1] : undefined;

  try {
    await tickSupervisor(
      { hcsTopicId: HCS_TOPIC_ID_SUPERVISOR },
      { traffic: trafficSummary ?? undefined, rail: railSummary ?? undefined },
    );
  } catch (e) {
    console.error('[agents] supervisor tick error', e);
  }
}

const INTERVAL_MS = Number(process.env.AGENT_POLL_INTERVAL_MS || 2000);
console.log('[agents] starting loop every', INTERVAL_MS, 'ms');
setInterval(loop, INTERVAL_MS);
