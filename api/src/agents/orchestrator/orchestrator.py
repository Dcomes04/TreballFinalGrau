import asyncio
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from dotenv import load_dotenv
from langchain_mcp_adapters.client import MultiServerMCPClient
from openai import OpenAI

# Carga variables de entorno desde .env en el arranque del proceso
load_dotenv()

# Registro de servidores MCP por dominio funcional
MCP_SERVERS = {
    "scenario": {
        "transport": "streamable_http",
        "url": os.getenv("MCP_SCENARIO_URL", "http://127.0.0.1:8102/mcp"),
    },
    "simulation": {
        "transport": "streamable_http",
        "url": os.getenv("MCP_PLANTATION_URL", "http://127.0.0.1:8103/mcp"),
    },
    "soil": {
        "transport": "streamable_http",
        "url": os.getenv("MCP_SOIL_URL", "http://127.0.0.1:8104/mcp"),
    },
}

# Modelo y endpoint base para el orquestador LLM
OPENAI_MODEL = os.getenv("ORCHESTRATOR_MODEL", "qwen2.5-3b-instruct")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434"))

# Mapa explicito para identificar a que agente pertenece cada tool
TOOL_AGENT_MAP = {
    "preview_scenario": "scenario",
    "run_simulation": "simulation",
    "build_execution_plantacio_plan": "simulation",
    "resolve_soil_context": "soil",
}

# Cache de bootstrap para no redescubrir tools en cada request HTTP
_BOOTSTRAP_CACHE: tuple[OpenAI, dict[str, Any], list[dict[str, Any]]] | None = None
_BOOTSTRAP_LOCK = asyncio.Lock()

# Variable de entorno para activar logs detallados del orquestador y evitar imprimir contenido de mensajes largos en modo normal
DEBUG_LOGS = os.getenv("ORCHESTRATOR_DEBUG", "0") == "1"

# Decide en que host y puerto se expone el endpoint HTTP del orquestador segun variable de entorno
def _resolve_http_bind() -> tuple[str, int]:
    parsed = urlparse(os.getenv("PY_ORCHESTRATOR_URL", "http://127.0.0.1:8100"))
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 8100
    return host, port

# Prompt de sistema con reglas estrictas de orquestacion y uso de tools
SYSTEM_PROMPT = (
    """You are an agent specialized in orchestrating MCP tools.
Your task is to analyze the user request step by step and choose the right tool.
If no tool applies, respond directly.

STRICT RULES:
- Never invent required parameters.
- If required data is missing, ask for it before calling a tool.
- Do not execute simulation when required fields are missing.
- Prefer tool calls over free-form assumptions.
"""
)

# Crea el cliente que hablará con el modelo
def _create_openai_client() -> OpenAI:
    # Normaliza la URL para usar el endpoint /v1 compatible con cliente OpenAI
    base_url = OPENAI_BASE_URL.rstrip("/")
    if not base_url.endswith("/v1"):
        base_url = f"{base_url}/v1"

    # Usa API key dummy en local (Ollama) y exige key real en proveedores remotos.
    # Ollama no requiere key real, pero OpenAI client espera un valor.
    is_local_provider = "127.0.0.1" in base_url or "localhost" in base_url
    api_key = os.getenv("OPENAI_API_KEY") or ("ollama" if is_local_provider else "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required when using a non-local OPENAI_BASE_URL provider")

    return OpenAI(base_url=base_url, api_key=api_key)


# Convierte tools descubiertas por MCP al formato function-calling de OpenAI
# Importante para que el modelo pueda entender que herramientas tiene disponibles y sus parametros requeridos
def langchain_tools_to_openai_format(tools: list[Any]) -> list[dict[str, Any]]:
    openai_tools: list[dict[str, Any]] = []
    for tool in tools:
        if isinstance(tool.args_schema, dict):
            parameters = tool.args_schema
        else:
            parameters = tool.args_schema.model_json_schema()

        openai_tools.append(
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": parameters,
                },
            }
        )
    return openai_tools

# Imprimir por teminal un objeto JSON
def _preview_json(value: Any, limit: int = 4000) -> str:
    try:
        text = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
    except TypeError:
        text = str(value)

    return text if len(text) <= limit else f"{text[:limit]}...<truncated>"

# Función que ejecuta una tool MCP
async def execute_tool_call(tool_map: dict[str, Any], tool_name: str, tool_args: dict[str, Any]) -> str:
    # BUsca la tool en tool_map, si no existe devuelve error al modelo para que pueda recuperarse
    try:
        tool = tool_map[tool_name]
    except KeyError as exc:
        raise RuntimeError(f"Tool no disponible: {tool_name}") from exc

    # Invoca la tool de forma asíncrona y captura cualquier error para devolverlo al modelo en formato estructurado
    try:
        result = await tool.ainvoke(tool_args)
    except Exception as exc:
        return json.dumps(
            {
                "status": "error",
                "tool": tool_name,
                "message": str(exc),
            },
            ensure_ascii=True,
        )

    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=True)

# Normaliza la respuesta de una tool MCP
def _extract_tool_result_dict(tool_result_text: str) -> dict[str, Any] | None:
    # Convertir la respuesta de la tool que llega como str a objeto Python
    try:
        parsed = json.loads(tool_result_text)
    except json.JSONDecodeError:
        print("[orchestrator] La respuesta de la tool no es JSON válido.")
        return None

    # Algunos adapters MCP devuelven una lista de bloques [{"type":"text","text":"{...}"}].
    if isinstance(parsed, list):
        for index, item in enumerate(parsed):
            # Extraer el campo text del bloque MCP
            text_payload = item.get("text")

            # Intentar convertir el contenido de text a JSON interno
            try:
                nested = json.loads(text_payload)
                if isinstance(nested, dict):
                    return nested
            except json.JSONDecodeError:
                continue

    # Si no es diccionario, ni lista de bloques, ni se ha podido extraer un JSON interno,
    # no se puede normalizar la respuesta.
    print("[orchestrator] No se ha podido extraer un diccionario estructurado de la respuesta.")
    return None

# Función principal que procesa un mensaje de usuario, ejecuta el loop agentico y devuelve la respuesta final del asistente junto con el resultado de la última tool ejecutada
async def process_user_message(
    openai_client: OpenAI,
    tool_map: dict[str, Any],
    messages: list[dict[str, Any]],
    openai_tools: list[dict[str, Any]],
    draft_context: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any] | None]:
    if DEBUG_LOGS:
        print(
            f"[orchestrator] llm_step start "
            f"messages={len(messages)} tools={len(openai_tools)}"
        )
       
    # Llamada al modelo con el mensaje acumulado y las tools disponibles. El modelo puede responder con texto, o con llamadas a tools
    response = openai_client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=messages,
        tools=openai_tools,
        tool_choice="auto",
    )

    message = response.choices[0].message
    messages.append(message.model_dump())

    # Si el modelo no llama a ninguna tool, devuelve respuesta textual
    if not message.tool_calls:
        return message.content or "", None

    tool_call = message.tool_calls[0]
    tool_name = tool_call.function.name
    
    # Extrae los argumentos que el modelo ha incluido para la llamada a la tool
    try:
        parsed_args = json.loads(tool_call.function.arguments or "{}")
    except json.JSONDecodeError:
        parsed_args = {}

    tool_args = parsed_args if isinstance(parsed_args, dict) else {}
    
    # Si el modelo omite draft o lo envia vacio, inyectamos el draft de contexto
    if draft_context and tool_name in { "preview_scenario", "get_missing_fields", "run_simulation", "build_execution_plantacio_plan", "resolve_soil_context", }:
        draft_from_model = tool_args.get("draft")

        if isinstance(draft_from_model, dict):
            merged_draft = {
                **draft_from_model,
                **draft_context,
            }
        else:
            merged_draft = draft_context

        tool_args["draft"] = merged_draft

    print(f"[orchestrator] final_tool_args tool={tool_name}")
    print(_preview_json(tool_args))

    # Ejecuta la tool y captura su resultado
    tool_result = await execute_tool_call(tool_map, tool_name, tool_args)

    # Extrae el resultado de la tool
    parsed_tool_result = _extract_tool_result_dict(tool_result)
    if parsed_tool_result is None:
        parsed_tool_result = {
            "status": "ok",
            "message": tool_result,
        }


    # Construye la respuesta final del asistente a partir del resultado de la tool
    reply = str(
        parsed_tool_result.get("message")
        or parsed_tool_result.get("summary")
        or parsed_tool_result.get("error")
        or ""
    )

    return reply, parsed_tool_result

# Inicializa todo lo que necesita el orquestrador: cliente MCP, descubrimiento de tools y cliente OpenAI
async def _bootstrap() -> tuple[OpenAI, dict[str, Any], list[dict[str, Any]]]:
    # Inicializa cliente MCP, descubre tools y prepara cliente LLM.
    global _BOOTSTRAP_CACHE

    if _BOOTSTRAP_CACHE is not None:
        return _BOOTSTRAP_CACHE

    async with _BOOTSTRAP_LOCK:
        if _BOOTSTRAP_CACHE is not None:
            return _BOOTSTRAP_CACHE

        # Inicializa cliente MCP y descubre tools disponibles en los servidores registrados
        client = MultiServerMCPClient(MCP_SERVERS)
        tools = await client.get_tools()

        tool_map = {tool.name: tool for tool in tools}
        openai_tools = langchain_tools_to_openai_format(tools)
        openai_client = _create_openai_client()

        print("---------------------------------------------")
        print(f"[orchestrator] model={OPENAI_MODEL}")
        print(f"[orchestrator] openai_base_url={OPENAI_BASE_URL}")
        for tool_name in tool_map:
            print(f"[orchestrator] tool={tool_name}")
        print("---------------------------------------------")

        _BOOTSTRAP_CACHE = (openai_client, tool_map, openai_tools)
        return _BOOTSTRAP_CACHE

# Ejecuta una petición individual del orquestrador
async def orchestrate_once(
    user_message: str,
    draft: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # Preparar los elementos necesarios para orquestrar la petición
    openai_client, tool_map, openai_tools = await _bootstrap()
    
    # Mensaje que se le envía al modelo
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Añadir los datos del draft al mensaje que se le envía al modelo
    if draft:
        messages.append(
            {
                "role": "system",
                "content": f"Draft context (JSON): {json.dumps(draft, ensure_ascii=True)}",
            }
        )

    # Añadir el mensaje del usuario al mensaje que se le envía al modelo
    messages.append({"role": "user", "content": user_message})

    # Procesar el mensaje del usuario. Esta función devuelve la respuesta final del asistente y el resultado de la última tool ejecutada
    assistant_text, tool_result = await process_user_message(
        openai_client,
        tool_map,
        messages,
        openai_tools,
        draft_context=draft,
    )

    return {
        "tool_result": tool_result,
        "message": assistant_text,
    }

# Normaliza el resultado de las tools build_execution_plantacio_plan y run_simulation
def _normalize_tool_result(tool_result: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(tool_result)

    if not normalized.get("message") and normalized.get("error"):
        normalized["message"] = normalized.get("error")

    tool_name = normalized.get("tool")

    if tool_name == "build_execution_plantacio_plan":
        return {
            "status": normalized.get("status"),
            "tool": normalized.get("tool"),
            "message": normalized.get("message"),
            "missing": normalized.get("missing"),
            "execucio_plantacio_id": normalized.get("execucio_plantacio_id"),
            "execucio_id": normalized.get("execucio_id"),
            "plantacio_id": normalized.get("plantacio_id"),
            "estat": normalized.get("estat"),
            "async_started": normalized.get("async_started"),
        }

    if tool_name == "run_simulation":
        return {
            "status": normalized.get("status"),
            "tool": normalized.get("tool"),
            "message": normalized.get("message"),
            "missing": normalized.get("missing"),
            "execucio_id": normalized.get("execucio_id"),
            "estat": normalized.get("estat"),
            "async_started": normalized.get("async_started"),
            "temps_simulat_inici": normalized.get("temps_simulat_inici"),
        }

    normalized.pop("error", None)
    return normalized

# Construye un resultado de error estandarizado para devolver al cliente HTTP en caso de excepciones o errores controlados
def _error_result(message: str, tool: str | None = None) -> dict[str, Any]:
    return {
        "result": {
            "status": "error",
            "tool": tool,
            "message": message,
        }
    }

# Función que ejecuta una tool MCP concreta para ejecutar las herramientas que el modelo va eligiendo
async def orchestrate_payload(payload: dict[str, Any]) -> dict[str, Any]:
    user_message = str(payload.get("message") or "").strip()
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}

    if not user_message:
        return _error_result("No se ha enviado message valido.")

    orchestration_result = await orchestrate_once(
        user_message=user_message,
        draft=draft,
    )

    tool_result = orchestration_result.get("tool_result")

    if isinstance(tool_result, dict):
        print(f"[orchestrator] orchestrate_payload received_tool_result ")
        print(_preview_json(tool_result))

        return {
            "result": _normalize_tool_result(tool_result)
        }

    assistant_message = str(orchestration_result.get("message") or "")

    return {
        "result": {
            "status": "ok",
            "tool": None,
            "message": assistant_message,
        }
    }

# Función para enviar una respuesta HTTP en formato JSON
def _json_response(handler: BaseHTTPRequestHandler, status_code: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    try:
        handler.send_response(status_code)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.send_header("Access-Control-Allow-Methods", "POST,OPTIONS")
        handler.send_header("Access-Control-Allow-Headers", "Content-Type")
        handler.end_headers()
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError) as exc:
        print(f"[orchestrator-http] client disconnected while sending response: {exc}")


class OrchestratorHttpHandler(BaseHTTPRequestHandler):
    # Mostrar mensaje en debug
    def log_message(self, format: str, *args: Any) -> None:
        if DEBUG_LOGS:
            print(f"[orchestrator-http] {self.address_string()} - {format % args}")

    # Responde a peticiones OPTIONS
    def do_OPTIONS(self) -> None:  # noqa: N802
        _json_response(self, 200, {"status": "ok"})

    # Responde a peticiones POST en la ruta /orchestrate
    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/orchestrate":
            _json_response(self, 404, _error_result("Route not found"))
            return

        try:
            started_at = time.perf_counter()
            trace_id = self.headers.get("X-Orchestrator-Trace-Id", "n/a")
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(raw_body.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Invalid JSON payload")

            message = str(payload.get("message") or "").strip()
            draft_keys = sorted(payload.get("draft", {}).keys()) if isinstance(payload.get("draft"), dict) else []

            # Llama al orquestrador principal para procesar la petición, ejecutar las tools necesarias y construir la respuesta final
            result = asyncio.run(orchestrate_payload(payload))
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)

            response_result = result.get("result") if isinstance(result.get("result"), dict) else {}
            tool_name = response_result.get("tool")

            print(
                f"[orchestrator-http] trace_id={trace_id} done status=200 "
                f"elapsed_ms={elapsed_ms} tool={tool_name}"
            )
            _json_response(self, 200, result)
        except Exception as exc:
            print(f"[orchestrator-http] request error: {exc}")
            _json_response(self, 400, _error_result(str(exc)))

# Modo servidor para integrar con orchestrator.service.ts via HTTP
def run_http_server() -> None:
    host, port = _resolve_http_bind()
    server = ThreadingHTTPServer((host, port), OrchestratorHttpHandler)
    print(f"[orchestrator-http] listening on http://{host}:{port}/orchestrate")
    server.serve_forever()


if __name__ == "__main__":
    run_http_server()
