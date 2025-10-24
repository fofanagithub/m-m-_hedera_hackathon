import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import health from './routes/health.js';
import ingest from './routes/ingest.js';
import control from './routes/control.js';


const app = express();
app.use(cors());
app.use(bodyParser.json());


app.use('/health', health);
app.use('/ingest', ingest);
app.use('/control', control);


const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
app.listen(PORT, () => {
console.log(`[backend] listening on http://localhost:${PORT}`);
});