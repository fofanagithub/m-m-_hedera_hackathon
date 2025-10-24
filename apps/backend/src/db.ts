import { Pool } from 'pg';

const url = process.env.DATABASE_URL ?? process.env.DB_URL;
let pool: Pool | null = null;

export type AgentKind = 'traffic' | 'rail';

type KindKey = AgentKind | string;

export interface Measurement<Value = unknown> {
  kind: KindKey;
  location: string;
  value: Value;
  metric?: number;
  ts: number;
}

export interface DecisionLog {
  agent: AgentKind;
  location?: string;
  source?: string;
  observation: unknown;
  decision: unknown;
  status: string;
  ts: number;
  confidence?: number;
  actionIndex?: number;
  policyMetadata?: Record<string, unknown>;
  reasoning?: Record<string, unknown> | string;
  consensusTimestamp?: string;
  topicId?: string;
  sequenceNumber?: string;
}

export interface MemoryStore {
  measurements: Measurement[];
  decisions: DecisionLog[];
  recent: Map<KindKey, Measurement[]>;
  latestByLocation: Map<KindKey, Map<string, Measurement>>;
}

export function getPool() {
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url });
  return pool;
}

export const mem: MemoryStore = {
  measurements: [],
  decisions: [],
  recent: new Map(),
  latestByLocation: new Map(),
};

