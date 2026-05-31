from ..common import _log_tool_event, _request_json
import json

# Router del agente de suelo/ubicacion
# Expone una tool para resolver contexto de suelo desde coordenadas o nombre
def register_tools(mcp):
    @mcp.tool()
    def resolve_soil_context(draft: dict) -> dict:
        """Resolve soil/location context from draft coordinates or location hint."""
        print("[resolve_soil_context] draft=")
        print(json.dumps(draft, ensure_ascii=False, indent=2))

        latitut = draft.get("latitut")
        longitut = draft.get("longitut")
        location_name = draft.get("nom_ubicacio")

        _log_tool_event(
            tool_name="resolve_soil_context",
            detail=(
                f"draft_keys={sorted(draft.keys())}; "
                f"latitut={latitut}; longitut={longitut}; location_name={location_name}"
            ),
            target_route="GET /catalogue/geocode | GET /catalogue/geocode-by-name",
        )

        # Usar coordenadas ya presentes en el draft
        if latitut is not None and longitut is not None:
            query = {"lat": latitut, "lon": longitut}

            print("[resolve_soil_context] GET /catalogue/geocode query=")
            print(json.dumps(query, ensure_ascii=False, indent=2))

            resolved = _request_json(
                "GET",
                "/catalogue/geocode",
                query=query,
            )

            print("[resolve_soil_context] response from GET /catalogue/geocode=")
            print(json.dumps(resolved, ensure_ascii=False, indent=2))

            return {
                "status": "ok",
                "tool": "resolve_soil_context",
                "input_mode": "coordinates",
                "resolved": resolved,
                "message": "Context de sòl resolt correctament"
            }

        # Si no hay coordenadas, buscar por nombre de ubicación
        # En el caso de no tener ni coordenadas ni nombre, devolver error indicando que no se han proporcionado datos de ubicación
        location_name = str(location_name).strip() if location_name is not None else ""
        if not location_name:
            return {
                "status": "error",
                "tool": "resolve_soil_context",
                "message": "No location data provided.",
            }


        query = {"name": location_name}

        print("[resolve_soil_context] GET /catalogue/geocode-by-name query=")
        print(json.dumps(query, ensure_ascii=False, indent=2))

        resolved = _request_json(
            "GET",
            "/catalogue/geocode-by-name",
            query=query,
        )

        print("[resolve_soil_context] response from GET /catalogue/geocode-by-name=")
        print(json.dumps(resolved, ensure_ascii=False, indent=2))

        return {
            "status": "ok",
            "tool": "resolve_soil_context",
            "input_mode": "name",
            "location_name": location_name,
            "resolved": resolved,
            "message": "Context de sòl resolt correctament"
        }
