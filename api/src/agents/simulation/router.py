from ..common import _log_tool_event, _request_json
import json

# Construye el payload final de ejecucion a partir del draft, sin depender del layout de escenario.
def _build_execution_payload(draft: dict) -> dict:
    # Traduce el draft al contrato exacto de POST /executions.
    ec_value = float(draft.get("ec_ms_cm") or 0)

    return {
        "cultiu_id": draft.get("cultiu_id"),
        "latitut": draft.get("latitut"),
        "longitut": draft.get("longitut"),
        "nom_ubicacio": draft.get("nom_ubicacio"),
        "soil_preview": draft.get("soil_preview"),
        "temps_simulat_inici": draft.get("temps_simulat_inici"),
        "ph": draft.get("ph"),
        "ec_ms_cm": draft.get("ec_ms_cm"),
        "tds_ppm": draft.get("tds_ppm") if draft.get("tds_ppm") is not None else max(0, ec_value * 640),
        "humitat_sol_pct": draft.get("humitat_sol_pct"),
        "temperatura_sol_c": draft.get("temperatura_sol_c"),
        "n_sol_ppm": draft.get("n_sol_ppm"),
        "p_sol_ppm": draft.get("p_sol_ppm"),
        "k_sol_ppm": draft.get("k_sol_ppm"),
    }


# Campos minimos para permitir ejecutar una simulacion completa.
REQUIRED_FIELDS = [
    "cultiu_id",
    "latitut",
    "longitut",
    "nom_ubicacio",
    "soil_preview",
    "temps_simulat_inici",
    "ph",
    "ec_ms_cm",
    "humitat_sol_pct",
    "temperatura_sol_c",
    "n_sol_ppm",
    "p_sol_ppm",
    "k_sol_ppm",
]


# Router del agente de simulacion.
# Incluye una tool de validacion de borrador y otra de ejecucion.
def register_tools(mcp):
    @mcp.tool()
    def run_simulation(draft: dict) -> dict:
        """Execute full simulation using the draft payload."""
        _log_tool_event(
            tool_name="run_simulation",
            detail=(
                f"draft_keys={sorted(draft.keys())}; "
                f"cultiu_id={draft.get('cultiu_id')}; "
                f"temps_simulat_inici={draft.get('temps_simulat_inici')}"
            ),
            target_route="POST /executions",
        )
        
        # Validacion defensiva: no ejecutar si faltan datos obligatorios.
        missing = [field for field in REQUIRED_FIELDS if draft.get(field) in (None, "")]
        _log_tool_event(
            tool_name="run_simulation",
            detail=f"required_fields={REQUIRED_FIELDS}; missing={missing}",
            target_route="validation before POST /executions",
        )
        if missing:
            return {
                "status": "error",
                "tool": "run_simulation",
                "missing": missing,
                "message": "Draft is not ready for simulation.",
            }

        payload = _build_execution_payload(draft)
        _log_tool_event(
            tool_name="run_simulation",
            detail=(
                f"execution_payload_keys={sorted(payload.keys())};\n"
                f"payload=\n{json.dumps(payload, ensure_ascii=False, indent=2)}"
            ),
            target_route="POST /executions",
        )

        execution = _request_json("POST", "/executions", body=payload)
        execution_id = execution.get("execucio_id") if isinstance(execution, dict) else None
        execution_status = execution.get("estat") if isinstance(execution, dict) else None
        async_started = bool(execution.get("async_started")) if isinstance(execution, dict) else False
        _log_tool_event(
            tool_name="run_simulation",
            detail=(
                f"execution_response_keys={sorted(execution.keys()) if isinstance(execution, dict) else []};\n"
                f"execution_response=\n{json.dumps(execution, ensure_ascii=False, indent=2) if isinstance(execution, dict) else execution}"
            ),
            target_route="POST /executions response",
        )

        return {
            "status": "ok",
            "tool": "run_simulation",
            "execucio_id": execution_id,
            "estat": execution_status,
            "async_started": async_started,
            "temps_simulat_inici": draft.get("temps_simulat_inici"),
            "message": (
                f"Simulacio iniciada correctament. execucio_id={execution_id}, estat={execution_status}, temps_simulat_inici={draft.get('temps_simulat_inici')}"
                if execution_id
                else "Simulation start request processed."
            ),
        }

    @mcp.tool()
    def build_execution_plantacio_plan(draft: dict) -> dict:
        """Generate irrigation and fertilizer plan for an execution + plantacio."""
        execucio_id = draft.get("execucio_id")
        plantacio_id = draft.get("plantacio_id")
        
        _log_tool_event(
            tool_name="build_execution_plantacio_plan",
            detail=(
                f"draft_keys={sorted(draft.keys())}; "
                f"execucio_id={execucio_id}; "
                f"plantacio_id={plantacio_id}"
            ),
            target_route="POST /executions/:id/plantacions/:plantacioId/plan",
        )
        
        missing = [field for field in ("execucio_id", "plantacio_id") if not draft.get(field)]

        if missing:
            return {
                "status": "error",
                "tool": "build_execution_plantacio_plan",
                "missing": missing,
                "message": "Missing execution or plantacio identifier.",
            }

        _log_tool_event(
            tool_name="build_execution_plantacio_plan",
            detail="plan_payload={}",
            target_route="POST /executions/:id/plantacions/:plantacioId/plan",
        )

        plan_job = _request_json(
            "POST",
            f"/executions/{execucio_id}/plantacions/{plantacio_id}/plan",
            body={},
        )

        _log_tool_event(
            tool_name="build_execution_plantacio_plan",
            detail=(
                f"plan_response=\n{json.dumps(plan_job, ensure_ascii=False, indent=2)}"
                if isinstance(plan_job, dict)
                else f"plan_response={plan_job}"
            ),
            target_route="POST /executions/:id/plantacions/:plantacioId/plan response",
        )

        plan_id = plan_job.get("execucio_plantacio_id") if isinstance(plan_job, dict) else None
        plan_status = plan_job.get("estat") if isinstance(plan_job, dict) else None
        async_started = bool(plan_job.get("async_started")) if isinstance(plan_job, dict) else False

        return {
            "status": "ok",
            "tool": "build_execution_plantacio_plan",
            "async_started": async_started,
            "execucio_plantacio_id": plan_id,
            "execucio_id": execucio_id,
            "plantacio_id": plantacio_id,
            "estat": plan_status,
            "message": (
                f"Generacio del pla iniciada. execucio_plantacio_id={plan_id}, estat={plan_status}"
                if plan_id
                else "Plan generation request processed."
            ),
        }