import { Client, TopicCreateTransaction, TopicId, TopicMessageSubmitTransaction } from '@hashgraph/sdk';

import type { AgentKind, DecisionLog } from '../db.js';

export interface ConsensusLogResult {
  topicId: string;
  consensusTimestamp?: string;
  sequenceNumber?: string;
}

const topicEnvVar: Record<AgentKind, string> = {
  traffic: 'HEDERA_TOPIC_TRAFFIC',
  rail: 'HEDERA_TOPIC_RAIL',
};

const topicCache = new Map<AgentKind, TopicId>();
let cachedClient: Client | null = null;

function getNetworkClient(): Client | null {
  const operatorId = process.env.HEDERA_ACCOUNT_ID;
  const operatorKey = process.env.HEDERA_PRIVATE_KEY;
  if (!operatorId || !operatorKey) {
    console.warn('[hedera] operator credentials missing; consensus logging disabled');
    return null;
  }

  if (cachedClient) {
    return cachedClient;
  }

  const network = (process.env.HEDERA_NETWORK ?? 'testnet').toLowerCase();
  const client = network === 'mainnet'
    ? Client.forMainnet()
    : network === 'previewnet'
      ? Client.forPreviewnet()
      : Client.forTestnet();
  client.setOperator(operatorId, operatorKey);
  cachedClient = client;
  return client;
}

function envTopic(agent: AgentKind): TopicId | null {
  const raw = process.env[topicEnvVar[agent]];
  if (!raw) return null;
  try {
    return TopicId.fromString(raw);
  } catch (err) {
    console.error('[hedera] invalid topic id in env ' + topicEnvVar[agent] + '=' + raw);
    return null;
  }
}

async function ensureTopic(agent: AgentKind, client: Client): Promise<TopicId> {
  if (topicCache.has(agent)) {
    return topicCache.get(agent)!;
  }

  const fromEnv = envTopic(agent);
  if (fromEnv) {
    topicCache.set(agent, fromEnv);
    return fromEnv;
  }

  const memo = 'smartcity-' + agent + '-' + Date.now().toString();
  const tx = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .execute(client);
  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId;
  if (!topicId) {
    throw new Error('[hedera] failed to create topic');
  }
  topicCache.set(agent, topicId);
  console.warn('[hedera] created new topic ' + topicId.toString() + ' for agent=' + agent + '. Update ' + topicEnvVar[agent] + ' to reuse.');
  return topicId;
}

export async function submitDecisionToConsensus(agent: AgentKind, decision: DecisionLog): Promise<ConsensusLogResult | null> {
  const client = getNetworkClient();
  if (!client) {
    return null;
  }

  const topicId = await ensureTopic(agent, client);
  const payload = {
    agent,
    decision: decision.decision,
    observation: decision.observation,
    status: decision.status,
    ts: decision.ts,
    confidence: decision.confidence,
    actionIndex: typeof decision.actionIndex === 'number' ? decision.actionIndex : undefined,
    policyMetadata: decision.policyMetadata ?? undefined,
    reasoning: decision.reasoning ?? undefined,
  };
  const message = Buffer.from(JSON.stringify(payload));
  const submit = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .execute(client);
  const receipt = await submit.getReceipt(client);
  const record = await submit.getRecord(client);
  const consensusTimestamp = record.consensusTimestamp ? record.consensusTimestamp.toDate().toISOString() : undefined;
  const sequenceNumber = receipt.topicSequenceNumber ? receipt.topicSequenceNumber.toString() : undefined;
  return {
    topicId: topicId.toString(),
    consensusTimestamp,
    sequenceNumber,
  };
}
