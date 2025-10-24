import axios from 'axios';
import { z } from 'zod';


export const BarrierSchema = z.object({ state: z.enum(['OPEN','CLOSING','CLOSED','OPENING']) });


export async function set_barrier(controllerBaseUrl: string, state: z.infer<typeof BarrierSchema>) {
    const url = `${controllerBaseUrl}/set_barrier`;
    const res = await axios.post(url, state, { timeout: 5000 });
    return res.data;
}