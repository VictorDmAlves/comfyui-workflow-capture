"""ComfyUI Workflow Capture - frontend-only workflow document exporter.

No executable graph nodes are registered. This extension neither executes a workflow
nor alters prompts, seeds, models, or saved graph data.
"""

import inspect
from pathlib import Path

from aiohttp import web
from server import PromptServer

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _package_for_node_class(cls):
    """Best effort: resolve the installed custom-node *folder*, not its category."""
    try:
        path = Path(inspect.getfile(cls)).resolve()
        parts = path.parts
        for i, part in enumerate(parts):
            if part.casefold() == "custom_nodes" and i + 1 < len(parts):
                name = parts[i + 1]
                return Path(name).stem if name.lower().endswith('.py') else name
    except (OSError, TypeError, ValueError):
        pass

    module = getattr(cls, "__module__", "") or ""
    parts = module.split(".")
    if "custom_nodes" in parts:
        at = parts.index("custom_nodes")
        if at + 1 < len(parts):
            return parts[at + 1]
    if module.startswith("comfy_extras") or module == "nodes" or module.startswith("comfy."):
        return "ComfyUI (built-in)"
    return "Unknown / third-party" if module else "Unknown"


@PromptServer.instance.routes.get("/vic_workflow_capture/node_map")
async def workflow_capture_node_map(request):
    """Expose package names only (never local file paths)."""
    import nodes

    result = {}
    display_names = getattr(nodes, "NODE_DISPLAY_NAME_MAPPINGS", {})
    for node_type, cls in dict(getattr(nodes, "NODE_CLASS_MAPPINGS", {})).items():
        try:
            result[str(node_type)] = {
                "package": _package_for_node_class(cls),
                "display_name": str(display_names.get(node_type) or node_type),
            }
        except Exception:
            continue
    return web.json_response({"nodes": result})
