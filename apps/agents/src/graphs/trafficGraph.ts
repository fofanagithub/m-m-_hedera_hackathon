import axios from 'axios';
import { requestTrafficPlan, TrafficObservationSchema, TrafficObservation } from '../tools/policyClient.js';
import { set_traffic_light, TrafficPlanSchema } from '../tools/trafficController.js';

export type TrafficConfig = {
  backendBaseUrl: string;
  controllerUrl: string;
  inferenceUrl?: string;
  threshold: number;
  d0: number;
  d1: number;
};

type TrafficPlan = {
  ns: 'red' | 'amber' | 'green';
  eo: 'red' | 'amber' | 'green';
  durationSec: number;
};

type TrafficPlanDecision = {
  plan: TrafficPlan;
  strategy: 'fallback_ns' | 'fallback_ew' | 'policy';
};

type BackendTrafficDecision = {
  ok: boolean;
  plan: TrafficPlan;
  actionIndex: number;
  confidence: number;
  location: string | null;
  source: string | null;
  consensus: {
    topicId: string;
    sequenceNumber: string | null;
    consensusTimestamp: string | null;
  } | null;
};

let lastPhase: 'NS' | 'EW' = 'NS';

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isDefaultTrafficController(controllerUrl: string, backendBaseUrl: string): boolean {
  try {
    const base = backendBaseUrl.endsWith('/') ? backendBaseUrl : `${backendBaseUrl}/`;
    const expected = stripTrailingSlash(new URL('control/traffic', base).toString());
    return stripTrailingSlash(controllerUrl) === expected;
  } catch {
    return false;
  }
}

function buildObservation(
  queueNS: number,
  queueEW: number,
  waitNS: number | undefined,
  waitEW: number | undefined,
  progress: number | undefined,
): TrafficObservation {
  const base: Partial<TrafficObservation> = {
    queue_ns: queueNS,
    queue_ew: queueEW,
    is_ns_green: lastPhase === 'NS' ? 1 : 0,
  };
  if (Number.isFinite(waitNS)) base.wait_ns = waitNS;
  if (Number.isFinite(waitEW)) base.wait_ew = waitEW;
  if (Number.isFinite(progress)) base.progress = progress;
  return TrafficObservationSchema.parse(base);
}

function fallbackPlan(queueNS: number, queueEW: number, cfg: TrafficConfig): TrafficPlanDecision {
  const dominant = queueNS >= queueEW ? 'NS' : 'EW';
  const peakQueue = Math.max(queueNS, queueEW);
  const duration = peakQueue > cfg.threshold ? cfg.d1 : cfg.d0;
  if (dominant === 'NS') {
    return {
      plan: { ns: 'green', eo: 'red', durationSec: duration },
      strategy: 'fallback_ns' as const,
    };
  }
  return {
    plan: { ns: 'red', eo: 'green', durationSec: duration },
    strategy: 'fallback_ew' as const,
  };
}

async function requestBackendTrafficPlan(
  controllerUrl: string,
  observation: TrafficObservation,
  location?: unknown,
): Promise<BackendTrafficDecision> {
  const payload: Record<string, unknown> = { observation };
  if (typeof location === 'string' && location.trim()) {
    payload.location = location.trim();
  }
  payload.source = 'agent';

  const base = controllerUrl.endsWith('/') ? controllerUrl : controllerUrl + '/';
  const endpoint = new URL('./infer', base).toString();
  const { data } = await axios.post<BackendTrafficDecision>(endpoint, payload, { timeout: 5000 });
  return data;
}

export async function tickTraffic(cfg: TrafficConfig) {
  const { data } = await axios.get(cfg.backendBaseUrl + '/ingest/next', {
    params: { kind: 'traffic' },
    timeout: 5000,
  });
  const item = data?.item;
  if (!item) return { skipped: true };

  const value = item.value || {};
  const queueNS = Number(value.avg_queue_len_NS ?? value.queue_ns ?? value.queueNS ?? value.queue ?? 0);
  const queueEW = Number(value.avg_queue_len_EW ?? value.queue_ew ?? value.queueEW ?? queueNS);
  const waitNS = Number(value.wait_time_NS ?? value.wait_ns);
  const waitEW = Number(value.wait_time_EW ?? value.wait_ew);
  const progress = Number(value.progress);
  const congestionCandidates = [
    Number(value.congestion),
    Number(value.congestion_index),
    Number(value.congestionIndex),
    queueNS,
    queueEW,
  ].filter((entry) => Number.isFinite(entry)) as number[];
  const congestionMetric = congestionCandidates.length > 0 ? Math.max(...congestionCandidates) : undefined;

  let observation: TrafficObservation | null = null;
  try {
    observation = buildObservation(queueNS, queueEW, waitNS, waitEW, progress);
  } catch (err) {
    console.warn('[agents] observation normalisation failed, continuing with fallback', err);
  }

  let planResult: TrafficPlanDecision = fallbackPlan(queueNS, queueEW, cfg);
  let policyDecision: Awaited<ReturnType<typeof requestTrafficPlan>> | null = null;
  let backendDecision: BackendTrafficDecision | null = null;
  let decisionSource: 'policy' | 'fallback' = 'fallback';
  const failureReasons: string[] = [];

  if (observation) {
    try {
      backendDecision = await requestBackendTrafficPlan(cfg.controllerUrl, observation, item.location);
      const planFromBackend = TrafficPlanSchema.parse(backendDecision.plan);
      planResult = { plan: planFromBackend, strategy: 'policy' };
      decisionSource = 'policy';
    } catch (err) {
      console.warn('[agents] backend traffic inference failed, attempting direct inference', err);
      failureReasons.push('backend_inference_error');
    }
  }

  if (!backendDecision && cfg.inferenceUrl && observation) {
    try {
      policyDecision = await requestTrafficPlan(cfg.inferenceUrl, observation);
      planResult = { plan: policyDecision.plan, strategy: 'policy' };
      decisionSource = 'policy';
    } catch (err) {
      console.warn('[agents] inference request failed, using fallback heuristic', err);
      failureReasons.push('direct_inference_error');
    }
  }

  const plan = TrafficPlanSchema.parse(planResult.plan);
  lastPhase = plan.ns === 'green' ? 'NS' : 'EW';

  const usesMockController = isDefaultTrafficController(cfg.controllerUrl, cfg.backendBaseUrl);
  if (!usesMockController) {
    try {
      await set_traffic_light(cfg.controllerUrl, plan);
    } catch (err) {
      console.warn('[agents] traffic controller call failed', err);
    }
  }

  const observationForLog: Record<string, unknown> = observation
    ? { ...observation }
    : {
        queue_ns: queueNS,
        queue_ew: queueEW,
      };
  if (Number.isFinite(waitNS)) observationForLog.wait_ns = waitNS;
  if (Number.isFinite(waitEW)) observationForLog.wait_ew = waitEW;
  if (Number.isFinite(progress)) observationForLog.progress = progress;

  const metadataForLog = policyDecision?.policy_metadata ?? {
    strategy: planResult.strategy,
    threshold: cfg.threshold,
  };

  if (!backendDecision) {
    const reasoningForLog: Record<string, unknown> = {
      method: policyDecision ? 'policy_inference' : 'fallback_heuristic',
      strategy: planResult.strategy,
      decisionSource,
    };
    if (policyDecision) {
      reasoningForLog.confidence = policyDecision.confidence;
      reasoningForLog.actionIndex = policyDecision.action_index;
      if (policyDecision.policy_metadata) {
        reasoningForLog.policyMetadata = policyDecision.policy_metadata;
      }
    } else {
      reasoningForLog.queue_ns = queueNS;
      reasoningForLog.queue_ew = queueEW;
      reasoningForLog.threshold = cfg.threshold;
    }
    if (failureReasons.length) {
      reasoningForLog.failures = failureReasons;
    }
    try {
      await axios.post(
        cfg.backendBaseUrl + '/control/decisions/log',
        {
          agent: 'traffic',
          location: String(item.location ?? ''),
          decision: plan,
          observation: observationForLog,
          status: 'APPLIED',
          ts: Date.now(),
          confidence: policyDecision?.confidence,
          actionIndex: policyDecision?.action_index,
          source: decisionSource,
          policyMetadata: metadataForLog,
          reasoning: reasoningForLog,
        },
        { timeout: 2000 },
      );
    } catch (err) {
      console.warn('[agents] failed to log traffic decision', err);
    }
  }

  return {
    applied: true,
    plan,
    source: decisionSource,
    location: String(item.location ?? ''),
    queueNS,
    queueEW,
    progress: Number.isFinite(progress) ? progress : undefined,
    congestion: typeof congestionMetric === 'number' && Number.isFinite(congestionMetric)
      ? congestionMetric
      : undefined,
  };
}
