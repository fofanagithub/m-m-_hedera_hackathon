import axios from 'axios';
import { z } from 'zod';


export const TrafficPlanSchema = z.object({
    ns: z.enum(['red','amber','green']),
    eo: z.enum(['red','amber','green']),
    durationSec: z.number().int().positive()
});


export async function set_traffic_light(controllerBaseUrl: string, plan: z.infer<typeof TrafficPlanSchema>) {
    const url = `${controllerBaseUrl}/set_plan`;
    const res = await axios.post(url, plan, { timeout: 5000 });
    return res.data;
}