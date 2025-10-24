import axios from 'axios';
import { set_barrier, BarrierSchema } from '../tools/railController.js';
import { requestRailPlan, RailObservationSchema } from '../tools/policyClient.js';

export type RailConfig = {
  backendBaseUrl: string;
  controllerUrl: string;
  closeLeadMs: number;
  inferenceUrl?: string;
};

type RailCommand = { state: 'OPEN' | 'CLOSING' | 'CLOSED' | 'OPENING' };
type RailCommandDecision = { command: RailCommand; strategy: 'eta_threshold' | 'policy' };

type BackendRailDecision = {
  ok: boolean;
  command: RailCommand;
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

let lastBarrierState: 'OPEN' | 'CLOSED' = 'OPEN';

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isDefaultRailController(controllerUrl: string, backendBaseUrl: string): boolean {
  try {
    const base = backendBaseUrl.endsWith('/') ? backendBaseUrl : `${backendBaseUrl}/`;
    const expected = stripTrailingSlash(new URL('control/rail', base).toString());
    return stripTrailingSlash(controllerUrl) === expected;
  } catch {
    return false;
  }
}

function fallbackCommand(eta: number, cfg: RailConfig): RailCommandDecision {
  if (eta <= cfg.closeLeadMs) {
    return { command: { state: 'CLOSED' as const }, strategy: 'eta_threshold' as const };
  }
  return { command: { state: 'OPEN' as const }, strategy: 'eta_threshold' as const };
}

async function requestBackendRailCommand(
  controllerUrl: string,
  observation: { eta_ms: number; barrier_closed: number },
  location?: unknown,
): Promise<BackendRailDecision> {
  const payload: Record<string, unknown> = { observation };
  if (typeof location === 'string' && location.trim()) {
    payload.location = location.trim();
  }
  payload.source = 'agent';

  const base = controllerUrl.endsWith('/') ? controllerUrl : controllerUrl + '/';
  const endpoint = new URL('./infer', base).toString();
  const { data } = await axios.post<BackendRailDecision>(endpoint, payload, { timeout: 5000 });
  return data;
}

export async function tickRail(cfg: RailConfig) {
  const { data } = await axios.get(cfg.backendBaseUrl + '/ingest/next', {
    params: { kind: 'rail' },
    timeout: 5000,
  });
  const item = data?.item;
  if (!item) return { skipped: true };

  const eta = Number(item.value?.etaMs ?? item.value?.eta_ms ?? 30000);
  const observationResult = RailObservationSchema.safeParse({
    eta_ms: eta,
    barrier_closed: lastBarrierState === 'CLOSED' ? 1 : 0,
  });
  let observation = null as typeof observationResult.data | null;
  const failureReasons: string[] = [];
  if (observationResult.success) {
    observation = observationResult.data;
  } else {
    console.warn('[agents] invalid rail observation, using fallback', observationResult.error);
    failureReasons.push('observation_invalid');
  }

  let decisionSource: 'policy' | 'fallback' = 'fallback';
  let policyDecision: Awaited<ReturnType<typeof requestRailPlan>> | null = null;
  let backendDecision: BackendRailDecision | null = null;
  let commandResult: RailCommandDecision = fallbackCommand(eta, cfg);

  if (observation) {
    try {
      backendDecision = await requestBackendRailCommand(cfg.controllerUrl, observation, item.location);
      const commandFromBackend = BarrierSchema.parse(backendDecision.command);
      commandResult = { command: commandFromBackend, strategy: 'policy' as const };
      decisionSource = 'policy';
    } catch (err) {
      console.warn('[agents] backend rail inference failed, attempting direct inference', err);
      failureReasons.push('backend_inference_error');
    }
  }

  if (!backendDecision && cfg.inferenceUrl && observation) {
    try {
      policyDecision = await requestRailPlan(cfg.inferenceUrl, observation);
      const commandFromPolicy = BarrierSchema.parse(policyDecision.command);
      commandResult = { command: commandFromPolicy, strategy: 'policy' as const };
      decisionSource = 'policy';
    } catch (err) {
      console.warn('[agents] rail inference request failed, falling back', err);
      failureReasons.push('direct_inference_error');
    }
  }

  const parsedCommand = BarrierSchema.parse(commandResult.command);
  const usesMockController = isDefaultRailController(cfg.controllerUrl, cfg.backendBaseUrl);
  if (!usesMockController) {
    try {
      await set_barrier(cfg.controllerUrl, parsedCommand);
    } catch (err) {
      console.warn('[agents] rail controller call failed', err);
    }
  }

  const barrierClosedBefore = lastBarrierState === 'CLOSED' ? 1 : 0;
  const observationForLog: Record<string, unknown> = observation
    ? { ...observation }
    : {
        eta_ms: eta,
        barrier_closed: barrierClosedBefore,
      };

  const metadataForLog = policyDecision?.policy_metadata ?? {
    strategy: commandResult.strategy,
    closeLeadMs: cfg.closeLeadMs,
  };

  if (!backendDecision) {
    const reasoningForLog: Record<string, unknown> = {
      method: policyDecision ? 'policy_inference' : 'fallback_heuristic',
      strategy: commandResult.strategy,
      decisionSource,
    };
    if (policyDecision) {
      reasoningForLog.confidence = policyDecision.confidence;
      reasoningForLog.actionIndex = policyDecision.action_index;
      if (policyDecision.policy_metadata) {
        reasoningForLog.policyMetadata = policyDecision.policy_metadata;
      }
    } else {
      reasoningForLog.eta_ms = eta;
      reasoningForLog.closeLeadMs = cfg.closeLeadMs;
    }
    if (failureReasons.length) {
      reasoningForLog.failures = failureReasons;
    }
    try {
      await axios.post(
        cfg.backendBaseUrl + '/control/decisions/log',
        {
          agent: 'rail',
          location: String(item.location ?? ''),
          decision: parsedCommand,
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
      console.warn('[agents] failed to log rail decision', err);
    }
  }

  lastBarrierState = parsedCommand.state === 'CLOSED' ? 'CLOSED' : 'OPEN';

  return {
    applied: true,
    command: parsedCommand,
    source: decisionSource,
    location: String(item.location ?? ''),
    etaMs: eta,
  };
}
