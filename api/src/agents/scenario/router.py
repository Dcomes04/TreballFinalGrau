from ..common import _log_tool_event, _request_json
import json

def register_tools(mcp):
    # preview_scenario: calcula las opciones de superficie según los parámetros asignados en el draft
    @mcp.tool()
    def preview_scenario(draft: dict) -> dict:
        """Build scenario options from the current draft."""
        print("[preview_scenario] draft=")
        print(json.dumps(draft, ensure_ascii=False, indent=2))

        # Mirar que no falten campos necesarios para calcular superficie, si faltan devolver error indicando qué campos faltan
        required = ["cultiu_id", "llargada_max_m", "amplada_max_m", "n_plantes"]
        missing = [field for field in required if draft.get(field) in (None, "")]
        if missing:
            return {
                "status": "error",
                "tool": "preview_scenario",
                "missing": missing,
                "message": "Faltan campos para calcular opciones de superficie.",
            }

        # Generar el payload para calcular la superficie, llamar a la ruta POST /executions/superficie/options y devolver el resultado
        payload = {
            "cultiu_id": draft.get("cultiu_id"),
            "llargada_max_m": draft.get("llargada_max_m"),
            "amplada_max_m": draft.get("amplada_max_m"),
            "n_plantes": draft.get("n_plantes"),
        }

        print("[preview_scenario] payload=")
        print(json.dumps(payload, ensure_ascii=False, indent=2))

        superficie = _request_json("POST", "/executions/superficie/options", body=payload)
        
        _log_tool_event(
            tool_name="preview_scenario",
            detail=(
                f"superficie_keys={sorted(superficie.keys()) if isinstance(superficie, dict) else 'n/a'}; "
                f"escenari_id={superficie.get('escenari_id') if isinstance(superficie, dict) else 'n/a'}; "
                f"n_options={superficie.get('n_options') if isinstance(superficie, dict) else 'n/a'}"
            ),
            target_route="POST /executions/superficie/options",
        )

        return {
            "status": "ok",
            "tool": "preview_scenario",
            "superficie": superficie,
            "message": (
                f"Superficie calculada correctament. escenari_id={superficie.get('escenari_id')}"
                if isinstance(superficie, dict) and superficie.get("escenari_id")
                else "Superficie calculada correctament."
            ),
        }
