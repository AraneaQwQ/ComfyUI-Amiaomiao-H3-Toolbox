"""Experimental integration candidate; pending full coexistence verification."""
from comfy_api.latest import ComfyExtension
from .storage_migration import migrate_on_startup
from .prompt.nodes import NODE_LIST as PROMPT_NODES
from .prompt.server import register_prompt_routes
from .refs.nodes import NODE_LIST as REFS_NODES
from .clipstream.clipbin import NODE_LIST as CLIP_NODES
from .clipstream.clipbin.v2_nodes import STAGE_NODES
from .clipstream.motion_context import NODE_LIST as MOTION_NODES
from .clipstream.clipbin.clip_bin_api import register_clip_bin_routes
from .clipstream.clipbin.clip_stage import register_clip_stage_router
from .clipstream.motion_context.nodes import register_chain_routes
from .long_video.comfyui.nodes import NODE_LIST as LONG_NODES
from .long_video.comfyui.server_api import register_h3lvm_routes
from .long_video.comfyui.video_compare import register_video_compare_routes

WEB_DIRECTORY = './web'


def toolbox_class(original):
    class ToolboxNode(original):
        @classmethod
        def define_schema(cls):
            schema = original.define_schema()
            schema.node_id = 'AmiaomiaoH3_' + schema.node_id
            return schema
    ToolboxNode.__name__ = 'Toolbox_' + original.__name__
    return ToolboxNode


class ToolboxExtension(ComfyExtension):
    async def get_node_list(self):
        return [toolbox_class(n) for n in [*MOTION_NODES, *CLIP_NODES, *STAGE_NODES, *LONG_NODES]] + PROMPT_NODES + REFS_NODES


async def comfy_entrypoint():
    migrate_on_startup()
    register_prompt_routes()
    register_clip_bin_routes()
    register_clip_stage_router()
    register_chain_routes()
    register_h3lvm_routes()
    register_video_compare_routes()
    return ToolboxExtension()
