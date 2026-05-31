import { Router, Request, Response } from 'express';
import { CreateExecutionSchema } from '../services/executions/executions.service.create';
import { createExecutionAndRunFull } from '../services/executions/executions.service.runtime';
import { 
  listExecutions, 
  getExecutionReuseInput, 
  getExecutionResultView, 
  getExecutionDatasetCsv, 
  getExecution,
  deleteExecution,
} from '../services/executions/executions.service.read';
import {
  createExecutionPlantacioPlanJob,
  getExecutionPlantacioPlanView,
} from '../services/executions/executions.service.plantacio-plan';
import {
  GetSuperficieOptionsInputSchema,
  previewSuperficieOptionsFromInput,
  getStoredSuperficieScenarioOptions,
  ChooseSuperficieFromInputSchema,
  chooseSuperficieFromInput,
} from '../services/scenario.service';

export const executionsRouter = Router();

function normalizeExecutionId(rawId: string): string {
  return String(rawId ?? '').trim();
}

// POST /executions/superficie/options - llamada por la tool preview_scenario para obtener las opciones de superficie de un escenario dado el draft actual
executionsRouter.post('/superficie/options', async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();

  const parsed = GetSuperficieOptionsInputSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn(`[SUP-OPTIONS] schema_invalid`);
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  console.info(`[SUP-OPTIONS] input=${JSON.stringify(parsed.data)}`);

  try {
    const result = await previewSuperficieOptionsFromInput(parsed.data);
    console.info(
      `[SUP-OPTIONS] ok escenari_id=${result.escenari_id} n_options=${result.n_opcions} elapsed_ms=${Date.now() - startedAt}`,
    );
    res.on('finish', () => {
      console.info(
        `[SUP-OPTIONS] response_sent status=${res.statusCode} elapsed_ms=${Date.now() - startedAt}`,
      );
    });
    res.json(result);
  } catch (err) {
    console.error(`[SUP-OPTIONS] error=${(err as Error).message}`);
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /executions/superficie/options/:escenariId - recibir las opciones de superficie ya calculadas para un escenari_id dado
executionsRouter.get('/superficie/options/:escenariId', async (req: Request, res: Response): Promise<void> => {
  const escenariId = String(req.params.escenariId ?? '').trim();

  if (!escenariId) {
    res.status(400).json({ error: 'escenari_id is required' });
    return;
  }

  try {
    const result = getStoredSuperficieScenarioOptions(escenariId);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// POST /executions/superficie/choose - elegir una de las opciones de superficie según las pedidas por la tool preview_scenario
executionsRouter.post('/superficie/choose', async (req: Request, res: Response): Promise<void> => {
  const parsed = ChooseSuperficieFromInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  try {
    const result = await chooseSuperficieFromInput(parsed.data);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /executions
executionsRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const requestId = `exec-${Date.now()}`;
  const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body as Record<string, unknown>) : [];
  console.info(`[EXEC-POST] request_id=${requestId} keys=${bodyKeys.join(',')}`);
  const parsed = CreateExecutionSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn(`[EXEC-POST] request_id=${requestId} schema_invalid`);
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  console.info(`[EXEC-POST] request_id=${requestId} input=${JSON.stringify(parsed.data)}`);
  try {
    console.info(`[EXEC-POST] request_id=${requestId} creating execution and running full simulation...`);
    const result = await createExecutionAndRunFull(parsed.data);
    console.info(`[EXEC-POST] request_id=${requestId} ok execucio_id=${result.execucio_id} estat=${result.estat}`);
    res.status(202).json(result);
  } catch (err) {
    console.error(`[EXEC-POST] request_id=${requestId} error=${(err as Error).message}`);
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /executions
executionsRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const list = await listExecutions();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /executions/:id/reuse-input
executionsRouter.get('/:id/reuse-input', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await getExecutionReuseInput(normalizeExecutionId(req.params.id));
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /executions/:id/result
executionsRouter.get('/:id/result', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await getExecutionResultView(normalizeExecutionId(req.params.id));
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /executions/:id/plantacions/:plantacioId/plan
executionsRouter.post('/:id/plantacions/:plantacioId/plan', async (req: Request, res: Response): Promise<void> => {
  const execucioId = normalizeExecutionId(req.params.id);
  const plantacioId = String(req.params.plantacioId ?? '').trim();
  
  if (!execucioId || !plantacioId) {
    res.status(400).json({ error: 'execucio_id and plantacio_id are required' });
    return;
  }

  try {
    const result = await createExecutionPlantacioPlanJob(execucioId, plantacioId);
    res.status(202).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /executions/:id/plantacions/:plantacioId/plan
executionsRouter.get('/:id/plantacions/:plantacioId/plan', async (req: Request, res: Response): Promise<void> => {
  const execucioId = normalizeExecutionId(req.params.id);
  const plantacioId = String(req.params.plantacioId ?? '').trim();
  if (!execucioId || !plantacioId) {
    res.status(400).json({ error: 'execucio_id and plantacio_id are required' });
    return;
  }

  try {
    const result = await getExecutionPlantacioPlanView(execucioId, plantacioId);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// GET /executions/:id/dataset
executionsRouter.get('/:id/dataset', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await getExecutionDatasetCsv(normalizeExecutionId(req.params.id));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${data.filename}"`);
    res.status(200).send(data.csv);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /executions/:id
executionsRouter.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const execution = await getExecution(normalizeExecutionId(req.params.id));
    if (!execution) {
      res.status(404).json({ error: 'Execution not found' });
      return;
    }
    res.json(execution);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /executions/:id
executionsRouter.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await deleteExecution(normalizeExecutionId(req.params.id));
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});