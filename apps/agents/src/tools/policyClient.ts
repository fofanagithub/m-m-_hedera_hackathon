import axios from 'axios';
import { z } from 'zod';
import { TrafficPlanSchema } from './trafficController.js';
import { BarrierSchema } from './railController.js';

export const TrafficObservationSchema = z.object({
  queue_ns: z.number().nonnegative(),
  queue_ew: z.number().nonnegative(),
  wait_ns: z.number().nonnegative().optional(),
  wait_ew: z.number().nonnegative().optional(),
  is_ns_green: z.number().min(0).max(1).optional(),
  progress: z.number().min(0).max(1).optional(),
});

const TrafficInferenceResponseSchema = z.object({
  plan: TrafficPlanSchema,
  action_index: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  policy_metadata: z.any().optional(),
});

export const RailObservationSchema = z.object({
  eta_ms: z.number().nonnegative(),
  barrier_closed: z.number().min(0).max(1),
});

const RailInferenceResponseSchema = z.object({
  command: BarrierSchema,
  action_index: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  policy_metadata: z.any().optional(),
});

export type TrafficObservation = z.infer<typeof TrafficObservationSchema>;
export type TrafficInferenceResponse = z.infer<typeof TrafficInferenceResponseSchema>;
export type RailObservation = z.infer<typeof RailObservationSchema>;
export type RailInferenceResponse = z.infer<typeof RailInferenceResponseSchema>;

export async function requestTrafficPlan(baseUrl: string, observation: TrafficObservation): Promise<TrafficInferenceResponse> {
  const payload = { observation };
  const endpoint = new URL('/traffic/infer', baseUrl).toString();
  const res = await axios.post(endpoint, payload, { timeout: 4000 });
  return TrafficInferenceResponseSchema.parse(res.data);
}

export async function requestRailPlan(baseUrl: string, observation: RailObservation): Promise<RailInferenceResponse> {
  const payload = { observation };
  const endpoint = new URL('/rail/infer', baseUrl).toString();
  const res = await axios.post(endpoint, payload, { timeout: 4000 });
  return RailInferenceResponseSchema.parse(res.data);
}
