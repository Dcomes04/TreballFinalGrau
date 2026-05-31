import { ENV } from '../../config/env';
import type { AgentRequest, AgentResponse, AgentToolResult } from './orchestrator.types';

// Respuesta esperada del orquestrador Python
type PythonOrchestratorResponse = {
  result?: AgentToolResult;
};

export class OrchestratorService {
  private prettyJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  // handle es la función principal para manejar una solicitud de orquestación de agente
  async handle(request: AgentRequest): Promise<AgentResponse> {
    const endpoint = this.buildEndpoint('/orchestrate');
    const payload = this.buildPythonPayload(request);
    const traceId = `orch-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const startedAt = Date.now();

    console.log(`[orchestrator][${traceId}] -> POST ${endpoint}`);
    console.log(`[orchestrator][${traceId}] payload=`);
    console.log(this.prettyJson(payload));

    // Envío de la petición al orquestador Python y manejo de la respuesta
    const response = await this.postToPython(endpoint, payload, traceId);
    console.log(`[orchestrator][${traceId}] <- headers status=${response.status} elapsed_ms=${Date.now() - startedAt}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[orchestrator][${traceId}] <- error status=${response.status} body=`);
      try {
        console.error(this.prettyJson(JSON.parse(errorText)));
      } catch {
        console.error(errorText);
      }

      try {
        const parsed = JSON.parse(errorText) as PythonOrchestratorResponse;

        return this.mapResponse(parsed);
      } catch {
        return {
          result: {
            status: 'error',
            tool: null,
            message: errorText || response.statusText,
          },
        };
      }
    }

    const data = (await response.json()) as PythonOrchestratorResponse;
    console.log(`[orchestrator][${traceId}] <- response elapsed_ms=${Date.now() - startedAt} body=`);
    console.log(this.prettyJson(data));
    return this.mapResponse(data);
  }

  // postToPython es una función para enviar una solicitud POST al orquestador Python con el payload dado y el traceId para seguimiento
  private async postToPython(endpoint: string, payload: Record<string, unknown>, traceId: string): Promise<Response> {
    const buildRequestInit = (): RequestInit => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Orchestrator-Trace-Id': traceId,
      },
      body: JSON.stringify(payload),
    } as RequestInit);

    try {
      return await fetch(endpoint, buildRequestInit());
    } catch (error) {
      const message = (error as Error).message;
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      console.error(
        `[orchestrator][${traceId}] fetch_error message=${message} cause_code=${cause?.code ?? 'n/a'} cause_message=${cause?.message ?? 'n/a'}`,
      );
      throw error;
    }
  }

  // buildEndpoint es una función para construir la URL completa del endpoint del orquestador Python a partir de la base URL configurada y el path dado
  private buildEndpoint(path: string): string {
    const base = ENV.PY_ORCHESTRATOR_URL.replace(/\/$/, '');
    return `${base}${path}`;
  }

  // buildPythonPayload es una función para construir el payload que se enviará al orquestador Python a partir de la solicitud del agente
  private buildPythonPayload(request: AgentRequest): Record<string, unknown> {
    return {
      message: request.message,
      draft: request.draft,
      active_result_execution_id: request.active_result_execution_id,
    };
  }

  // mapResponse es una función para mapear la respuesta del orquestador Python a la estructura de respuesta esperada por el cliente
  private mapResponse(data: PythonOrchestratorResponse): AgentResponse {
    return {
      result: data.result ?? {
        status: 'error',
        tool: null,
        message: 'No response from Python orchestrator.',
      },
    };
  }
}
