import express, { Request, Response, NextFunction } from 'express';
import { catalogueRouter } from './routes/catalogue.routes';
import { executionsRouter } from './routes/executions.routes';
import { agentRouter } from './routes/agent.routes';

export function createServer() {
  const app = express();

  // CORS — allow the Vite dev server
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use(express.json());
  app.use('/catalogue',  catalogueRouter);
  app.use('/executions', executionsRouter);
  app.use('/agent', agentRouter);

  return app;
}

