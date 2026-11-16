import asyncio
from urllib.parse import urlsplit
from .core import compile_document
from .assets import read_assets


def register_prompt_routes():
    from aiohttp import web
    from server import PromptServer
    server = PromptServer.instance
    if getattr(server, "_amiaomiao_h3_prompt_routes", False):
        return
    server._amiaomiao_h3_prompt_routes = True

    async def payload(request):
        origin = request.headers.get("Origin") or request.headers.get("Referer")
        if request.headers.get("Sec-Fetch-Site") == "cross-site" or (
                origin and urlsplit(origin).netloc != request.host):
            raise web.HTTPForbidden(text="不接受跨站请求。")
        if request.content_type != "application/json":
            raise web.HTTPUnsupportedMediaType(text="需要 JSON。")
        if request.content_length and request.content_length > 1_000_000:
            raise web.HTTPRequestEntityTooLarge(max_size=1_000_000, actual_size=request.content_length)
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("请求必须是对象。")
        return body

    @server.routes.post("/amiaomiao_h3/prompt/compile")
    async def compile_prompt(request):
        try:
            body = await payload(request)
            result = compile_document(body.get("document", {}))
            return web.json_response(result, headers={"Cache-Control": "no-store"})
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
            return web.json_response({"error": "编排失败：" + str(exc)}, status=400)

    @server.routes.post("/amiaomiao_h3/prompt/assets")
    async def prompt_assets(request):
        try:
            import folder_paths
            body = await payload(request)
            roots = {"input": folder_paths.get_input_directory(),
                     "output": folder_paths.get_output_directory(), "temp": folder_paths.get_temp_directory()}
            result = await asyncio.to_thread(read_assets, body.get("selectors", []), roots)
            return web.json_response(result, headers={"Cache-Control": "no-store"})
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            return web.json_response({"error": "读取素材失败：" + str(exc)}, status=400)
