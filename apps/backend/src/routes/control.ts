import type { Request, Response } from 'express';
import { Router } from 'express';

import { mem, type DecisionLog } from '../db.js';
import {
  inferRail,
  inferTraffic,
  type RailObservationPayload,
  type TrafficObservationPayload,
} from '../services/inference.js';
import { submitDecisionToConsensus, type ConsensusLogResult } from '../services/hedera.js';

const r = Router();

const DECISION_HISTORY_LIMIT = 1000;

function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function coerceLocation(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.location === 'string') {
      return coerceLocation(obj.location);
    }
    if (typeof obj.id === 'string') {
      return coerceLocation(obj.id);
    }
    if (typeof obj.junction === 'string') {
      return coerceLocation(obj.junction);
    }
  }
  return undefined;
}

function normalizeReasoning(value: unknown): Record<string, unknown> | string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function recordDecision(entry: DecisionLog) {
  mem.decisions.push(entry);
  if (mem.decisions.length > DECISION_HISTORY_LIMIT) {
    mem.decisions.splice(0, mem.decisions.length - DECISION_HISTORY_LIMIT);
  }
}

function parseTrafficObservation(body: any): TrafficObservationPayload {
  if (!body || typeof body.queue_ns !== 'number' || typeof body.queue_ew !== 'number') {
    throw new Error('queue_ns and queue_ew numeric fields are required');
  }
  const observation: TrafficObservationPayload = {
    queue_ns: Number(body.queue_ns),
    queue_ew: Number(body.queue_ew),
  };
  if (typeof body.wait_ns === 'number') observation.wait_ns = Number(body.wait_ns);
  if (typeof body.wait_ew === 'number') observation.wait_ew = Number(body.wait_ew);
  if (typeof body.is_ns_green === 'number') observation.is_ns_green = Number(body.is_ns_green);
  if (typeof body.progress === 'number') observation.progress = Number(body.progress);
  return observation;
}

function parseRailObservation(body: any): RailObservationPayload {
  if (!body || typeof body.eta_ms !== 'number' || typeof body.barrier_closed !== 'number') {
    throw new Error('eta_ms and barrier_closed numeric fields are required');
  }
  const barrier = Math.max(0, Math.min(1, Number(body.barrier_closed)));
  return {
    eta_ms: Number(body.eta_ms),
    barrier_closed: barrier,
  };
}

r.post('/traffic/infer', async (req: Request, res: Response) => {
  try {
    const rawPayload = req.body ?? {};
    const observationInput = rawPayload.observation ?? rawPayload;
    const location =
      coerceLocation(rawPayload.location) ??
      coerceLocation(rawPayload.junction) ??
      coerceLocation(observationInput.location);
    const source = coerceString(rawPayload.source ?? observationInput.source);

    const observation = parseTrafficObservation(observationInput);
    const inference = await inferTraffic(observation);
    const ts = Date.now();
    const reasoning: Record<string, unknown> = {
      method: 'policy_inference',
      stage: 'backend_inference',
      selectedAction: inference.action_index,
      confidence: inference.confidence,
    };
    if (inference.policy_metadata) {
      reasoning.policyMetadata = inference.policy_metadata;
    }
    const decision: DecisionLog = {
      agent: 'traffic',
      location,
      source,
      observation,
      decision: inference.plan,
      status: 'APPLIED',
      ts,
      confidence: inference.confidence,
      actionIndex: inference.action_index,
      policyMetadata: inference.policy_metadata,
      reasoning,
    };

    const consensus = await submitDecisionToConsensus('traffic', decision);
    if (consensus) {
      decision.consensusTimestamp = consensus.consensusTimestamp;
      decision.topicId = consensus.topicId;
      decision.sequenceNumber = consensus.sequenceNumber;
    }

    recordDecision(decision);
    return res.json({
      ok: true,
      plan: inference.plan,
      actionIndex: inference.action_index,
      confidence: inference.confidence,
      location: location ?? null,
      source: source ?? null,
      reasoning,
      consensus: consensus ?? null,
    });
  } catch (err) {
    console.error('[controller:traffic] inference failed', err);
    const status = err instanceof Error && err.message.toLowerCase().includes('required') ? 400 : 502;
    const message = err instanceof Error ? err.message : 'unknown error';
    return res.status(status).json({ error: message });
  }
});

r.post('/rail/infer', async (req: Request, res: Response) => {
  try {
    const rawPayload = req.body ?? {};
    const observationInput = rawPayload.observation ?? rawPayload;
    const location =
      coerceLocation(rawPayload.location) ??
      coerceLocation(observationInput.location);
    const source = coerceString(rawPayload.source ?? observationInput.source);

    const observation = parseRailObservation(observationInput);
    const inference = await inferRail(observation);
    const ts = Date.now();
    const reasoning: Record<string, unknown> = {
      method: 'policy_inference',
      stage: 'backend_inference',
      selectedAction: inference.action_index,
      confidence: inference.confidence,
    };
    if (inference.policy_metadata) {
      reasoning.policyMetadata = inference.policy_metadata;
    }
    const decision: DecisionLog = {
      agent: 'rail',
      location,
      source,
      observation,
      decision: inference.command,
      status: 'APPLIED',
      ts,
      confidence: inference.confidence,
      actionIndex: inference.action_index,
      policyMetadata: inference.policy_metadata,
      reasoning,
    };

    const consensus = await submitDecisionToConsensus('rail', decision);
    if (consensus) {
      decision.consensusTimestamp = consensus.consensusTimestamp;
      decision.topicId = consensus.topicId;
      decision.sequenceNumber = consensus.sequenceNumber;
    }

    recordDecision(decision);
    return res.json({
      ok: true,
      command: inference.command,
      actionIndex: inference.action_index,
      confidence: inference.confidence,
      location: location ?? null,
      source: source ?? null,
      reasoning,
      consensus: consensus ?? null,
    });
  } catch (err) {
    console.error('[controller:rail] inference failed', err);
    const status = err instanceof Error && err.message.toLowerCase().includes('required') ? 400 : 502;
    const message = err instanceof Error ? err.message : 'unknown error';
    return res.status(status).json({ error: message });
  }
});

r.get('/decisions/latest', (req: Request, res: Response) => {
  const agentParam = typeof req.query.agent === 'string' ? req.query.agent.toLowerCase() : undefined;
  const agentFilter = agentParam === 'traffic' || agentParam === 'rail' ? agentParam : undefined;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : undefined;

  const latestByKey = new Map<string, DecisionLog>();

  for (const entry of mem.decisions) {
    if (agentFilter && entry.agent !== agentFilter) continue;
    const locationKey = entry.location ?? '__unknown__';
    const key = `${entry.agent}::${locationKey}`.toLowerCase();
    const current = latestByKey.get(key);
    if (!current || entry.ts > current.ts) {
      latestByKey.set(key, entry);
    }
  }

  let items = Array.from(latestByKey.values()).sort((a, b) => b.ts - a.ts);
  if (limit) {
    items = items.slice(0, limit);
  }

  const payload = items.map((entry) => ({
    agent: entry.agent,
    location: entry.location ?? null,
    source: entry.source ?? null,
    status: entry.status,
    ts: entry.ts,
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
    actionIndex: typeof entry.actionIndex === 'number' ? entry.actionIndex : null,
    decision: entry.decision,
    observation: entry.observation,
    policyMetadata: entry.policyMetadata ?? null,
    reasoning: entry.reasoning ?? null,
    consensus: entry.topicId
      ? {
          topicId: entry.topicId,
          sequenceNumber: entry.sequenceNumber ?? null,
          consensusTimestamp: entry.consensusTimestamp ?? null,
        }
      : null,
  }));

  return res.json({ updated: Date.now(), items: payload });
});



r.post('/decisions/log', async (req: Request, res: Response) => {
  const payload = req.body ?? {};
  const agentRaw = typeof payload.agent === 'string' ? payload.agent.toLowerCase() : '';
  if (agentRaw !== 'traffic' && agentRaw !== 'rail') {
    return res.status(400).json({ error: "agent must be 'traffic' or 'rail'" });
  }

  const location = coerceLocation(payload.location);
  const source = coerceString(payload.source);
  const timestamp = Number.isFinite(Number(payload.ts)) ? Number(payload.ts) : Date.now();
  const status = typeof payload.status === 'string' ? payload.status : 'APPLIED';
  const confidence = typeof payload.confidence === 'number' ? Number(payload.confidence) : undefined;
  const actionIndex = typeof payload.actionIndex === 'number' ? Number(payload.actionIndex) : undefined;
  const policyMetadata =
    payload.policyMetadata && typeof payload.policyMetadata === 'object'
      ? (payload.policyMetadata as Record<string, unknown>)
      : undefined;
  const reasoning = normalizeReasoning(payload.reasoning);

  const entry: DecisionLog = {
    agent: agentRaw,
    location,
    source,
    observation: 'observation' in payload ? payload.observation : null,
    decision: payload.decision,
    status,
    ts: timestamp,
    confidence,
    actionIndex,
    policyMetadata,
    reasoning,
  };

  const consensusPromise = submitDecisionToConsensus(entry.agent, entry);
  const consensusWaitMsRaw = Number(process.env.CONSENSUS_LOG_WAIT_MS);
  const consensusWaitMs =
    Number.isFinite(consensusWaitMsRaw) && consensusWaitMsRaw >= 0
      ? Math.floor(consensusWaitMsRaw)
      : 1500;

  let consensus: ConsensusLogResult | null = null;
  let consensusPending = false;

  const consensusWithUpdate = consensusPromise
    ? consensusPromise
        .then((result) => {
          if (result) {
            entry.topicId = result.topicId;
            entry.sequenceNumber = result.sequenceNumber;
            entry.consensusTimestamp = result.consensusTimestamp;
          }
          return result;
        })
        .catch((err) => {
          console.error('[controller] consensus submission failed', err);
          return null;
        })
    : null;

  if (consensusWithUpdate) {
    if (consensusWaitMs === 0) {
      consensusPending = true;
    } else {
      const timeout = new Promise<null>((_, reject) => {
        setTimeout(() => reject(new Error('consensus_timeout')), consensusWaitMs);
      });
      try {
        // Wait briefly so most responses include consensus data without blocking forever.
        consensus = await Promise.race([consensusWithUpdate, timeout]);
      } catch (err) {
        if (err instanceof Error && err.message === 'consensus_timeout') {
          consensusPending = true;
        } else {
          console.error('[controller] consensus submission failed', err);
        }
      }
    }
  }

  recordDecision(entry);
  return res.json({
    ok: true,
    stored: {
      agent: entry.agent,
      location: entry.location ?? null,
      status: entry.status,
      ts: entry.ts,
    },
    consensus: consensus ?? null,
    consensusPending,
    reasoning: entry.reasoning ?? null,
  });
});

r.post('/traffic/set_plan', (_req: Request, res: Response) => {
  return res.status(410).json({ error: 'deprecated: use POST /control/traffic/infer' });
});

r.post('/rail/set_barrier', (_req: Request, res: Response) => {
  return res.status(410).json({ error: 'deprecated: use POST /control/rail/infer' });
});

export default r;
