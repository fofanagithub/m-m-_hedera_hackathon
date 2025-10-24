import { z } from 'zod';
import { Client, TopicMessageSubmitTransaction } from '@hashgraph/sdk';

export type LogArgs = { topicId: string; payload: any };

function buildClient() {
    const accountId = process.env.HEDERA_ACCOUNT_ID;
    const privateKey = process.env.HEDERA_PRIVATE_KEY;
    const network = (process.env.HEDERA_NETWORK || 'testnet') as 'testnet'|'mainnet'|'previewnet';
    if (!accountId || !privateKey) return null; // autoriser mock
    const client = Client.forName(network);
    client.setOperator(accountId, privateKey);
    return client;
}

export const LogSchema = z.object({ topicId: z.string(), payload: z.record(z.any()) });

export async function hedera_log_decision({ topicId, payload }: LogArgs) {
    const topic = (topicId || '').trim();
    if (!topic || !/^\d+\.\d+\.\d+$/.test(topic)) {
        console.warn('[hedera] skipping publish, invalid topic id', topicId);
        return { ok: false, skipped: true };
    }

    const client = buildClient();
    const message = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() }));
    if (!client) {
        console.log('[hedera:mock] submit', { topicId: topic, payload });
        return { ok: true, mock: true };
    }
    const tx = await new TopicMessageSubmitTransaction({ topicId: topic, message }).execute(client);
    const rec = await tx.getReceipt(client);
    return { ok: true, status: rec.status.toString() };
}
