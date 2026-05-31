import { Router, Request, Response } from 'express';
import { AgentRequestSchema, OrchestratorService } from '../services/agent';

export const agentRouter = Router();
const orchestrator = new OrchestratorService();

// POST /api/agent/orchestrate
// Endpoint para manejar solicitudes de orquestación de agentes. Valida la entrada, llama al servicio de orquestación y devuelve la respuesta
agentRouter.post('/orchestrate', async (req: Request, res: Response): Promise<void> => {
  const parsed = AgentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  try {
    const response = await orchestrator.handle(parsed.data);
    res.json(response);
  } catch (error) {
    res.status(400).json({
      error: (error as Error).message,
    });
  }
});
