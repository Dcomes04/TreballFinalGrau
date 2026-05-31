import { randomUUID } from 'node:crypto';
import { ENV } from '../config/env';
import { upsertRow } from '../datasources/write';

export interface AlarmMetadata {
  fase_id?: string;
  fase_nom?: string;
  dia_total_simulacio?: number;
  dia_fase?: number;
}

export type FailExecutionWithAlarm = (
  message: string,
  context?: Record<string, unknown>,
  alarmMeta?: AlarmMetadata,
) => Promise<never>;

export class ExecutionAlarmError extends Error {
  execucioId: string;
  failIso: string;

  constructor(message: string, execucioId: string, failIso: string) {
    super(message);
    this.name = 'ExecutionAlarmError';
    this.execucioId = execucioId;
    this.failIso = failIso;
  }
}

// Servicio para gestionar alarmas de ejecución: registra la alarma en la base de datos y marca la ejecución como fallida
export function buildExecutionAlarmService(params: {
  execucioId: string;
  d0: Date;
}): FailExecutionWithAlarm {
  const { execucioId, d0 } = params;

  return async function failExecutionWithAlarm(
    message: string,
    context?: Record<string, unknown>,
    alarmMeta?: AlarmMetadata,
  ): Promise<never> {
    const dayOffset = alarmMeta?.dia_total_simulacio ?? 0;
    const failDate = new Date(d0);
    failDate.setUTCDate(failDate.getUTCDate() + Math.max(0, dayOffset));
    const failIso = failDate.toISOString();

    await upsertRow(ENV.PATH, 'alarma_esdeveniment', {
      pkColumns: 'alarma_id',
      data: {
        alarma_id: randomUUID(),
        execucio_id: execucioId,
        tipus_alarma: 'OUT_OF_RANGE_INPUT',
        estat: 'OPEN',
        motiu: message,
        fase_id: alarmMeta?.fase_id ?? null,
        fase_nom: alarmMeta?.fase_nom ?? null,
        dia_total_simulacio: alarmMeta?.dia_total_simulacio ?? null,
        dia_fase: alarmMeta?.dia_fase ?? null,
      },
    });

    await upsertRow(ENV.PATH, 'execucio_simulada', {
      pkColumns: 'execucio_id',
      data: {
        execucio_id: execucioId,
        estat: 'FAILED',
        temps_simulat_fi: failIso,
        dia_actual_simulacio: failIso,
        resultats: {
          error_code: 'OUT_OF_RANGE_INPUT',
          error_message: message,
          context: context ?? null,
        },
      },
    });

    throw new ExecutionAlarmError(message, execucioId, failIso);
  };
}