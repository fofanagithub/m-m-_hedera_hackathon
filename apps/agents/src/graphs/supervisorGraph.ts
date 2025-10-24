import { hedera_log_decision } from '../tools/hederaLog.js';

export type SupervisorConfig = {
  hcsTopicId: string;
};

export type TrafficStatus = {
  applied?: boolean;
  plan?: { ns: 'green' | 'amber' | 'red'; eo: 'green' | 'amber' | 'red'; durationSec: number };
  source?: 'policy' | 'fallback';
  location?: string;
  queueNS?: number;
  queueEW?: number;
  progress?: number;
  congestion?: number;
};

export type RailStatus = {
  applied?: boolean;
  command?: { state: 'OPEN' | 'CLOSED' | 'CLOSING' | 'OPENING' };
  source?: 'policy' | 'fallback';
  location?: string;
  etaMs?: number;
};

export type SupervisorContext = {
  traffic?: TrafficStatus;
  rail?: RailStatus;
};

export async function tickSupervisor(cfg: SupervisorConfig, ctx: SupervisorContext) {
  const anomalies: string[] = [];

  if (ctx.traffic?.plan && ctx.rail?.command) {
    const barrierClosed = ctx.rail.command.state === 'CLOSED';
    const trafficNsGreen = ctx.traffic.plan.ns === 'green';
    if (barrierClosed && trafficNsGreen) {
      anomalies.push('Barrier closed while north-south lights are green.');
    }
    const barrierOpen = ctx.rail.command.state === 'OPEN';
    if (barrierOpen && ctx.traffic.plan.eo === 'green' && ctx.traffic.plan.ns === 'red') {
      anomalies.push('Barrier open while east-west traffic flows; verify interlocks.');
    }
  }

  if (ctx.traffic?.source === 'fallback') {
    anomalies.push('Traffic controller in fallback mode.');
  }
  if (ctx.rail?.source === 'fallback') {
    anomalies.push('Rail controller in fallback mode.');
  }

  const topicId = (cfg.hcsTopicId || '').trim();
  if (topicId) {
    await hedera_log_decision({
      topicId,
      payload: {
        type: 'SUPERVISOR_STATUS',
        traffic: ctx.traffic,
        rail: ctx.rail,
        anomalies,
        ok: anomalies.length === 0,
      },
    });
  }

  return { ok: anomalies.length === 0, anomalies };
}
