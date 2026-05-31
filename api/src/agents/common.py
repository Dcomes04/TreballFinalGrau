import json
import os
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

NODE_API_BASE_URL = os.getenv("NODE_API_BASE_URL", "http://127.0.0.1:3001")
MCP_TIMEOUT_MS = int(os.getenv("MCP_TIMEOUT_MS", "120000"))

# Función para mostrar logs de eventos relacionados con las tools, indicando el nombre de la tool, el detalle del evento y la ruta objetivo a la que se hizo la llamada
def _log_tool_event(tool_name: str, detail: str, target_route: str) -> None:
    timestamp = datetime.now().isoformat(timespec="seconds")
    print(f"[{timestamp}] [soil] tool={tool_name} detail={detail}")
    print(f"[{timestamp}] [soil] route_target={target_route}")

# Función para hacer una petición HTTP a la API de Node y devolver la respuesta como JSON, manejando errores de red y HTTP
def _request_json(method: str, path: str, query: dict | None = None, body: dict | None = None) -> dict:
    url = f"{NODE_API_BASE_URL.rstrip('/')}{path}"
    if query:
        url = f"{url}?{urlencode(query)}"
    
    data = None
    headers = {"Accept": "application/json"}

    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url=url, data=data, headers=headers, method=method)
    timeout_seconds = max(1.0, MCP_TIMEOUT_MS / 1000)

    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
            if not raw:
                return {}
            return json.loads(raw)
    except HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} calling {path}: {payload}") from exc
    except URLError as exc:
        raise RuntimeError(f"Network error calling {path}: {exc.reason}") from exc