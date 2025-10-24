import type { Request, Response } from 'express';
import { Router } from 'express';

const r = Router();

r.get('/', (_req: Request, res: Response) => res.json({ ok: true }));

export default r;
