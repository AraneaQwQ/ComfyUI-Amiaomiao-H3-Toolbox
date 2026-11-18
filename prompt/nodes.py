import json
import math
from comfy_api.latest import io
from .core import compile_document, default_document

NODE_ID = "AmiaomiaoH3_PromptComposer"


class H3PromptComposer(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=NODE_ID, display_name="H3 提示词编排器",
            category="Amiaomiao H3/提示词",
            description="编排模式按六个分区编辑中文提示词，支持句式、素材引用和格式标记。原生模式直接编辑完整文本。",
            inputs=[
                io.String.Input("document", default=json.dumps(default_document(), ensure_ascii=False),
                                multiline=True, tooltip="带版本的结构化草稿，随工作流保存；支持 API 直接填写。"),
                io.Boolean.Input("strict", default=True, display_name="阻止有错误的编排输出",
                                 tooltip="开启时，失效素材或缺少正式编号等错误会阻止执行。待填内容提醒不阻止执行。"),
                io.Int.Input("mc_overlap_frames", default=22, min=0, max=4096,
                             display_name="重叠帧数",
                             tooltip="与 Motion Context 重叠帧数一致即可。默认 22 帧（24fps 下约 0.92 秒）。"),
                io.Int.Input("mc_trim_frames", default=22, min=0, max=4096,
                             display_name="裁切帧数",
                             tooltip="与 Motion Context 裁切帧数一致即可。默认 22 帧；切入下一镜模式时才生效。"),
            ],
            outputs=[
                io.String.Output(display_name="提示词"),
                io.String.Output(display_name="结构化草稿"),
                io.String.Output(display_name="检查报告"),
                io.Float.Output(display_name="视频时长（秒）"),
            ],
        )

    @classmethod
    def execute(cls, document, strict=True, mc_overlap_frames=22, mc_trim_frames=22):
        result = compile_document(document, mc_overlap_frames=mc_overlap_frames,
                                  mc_trim_frames=mc_trim_frames)
        duration_ms = result["document"]["duration_ms"]
        if (isinstance(duration_ms, bool) or not isinstance(duration_ms, (int, float))
                or not math.isfinite(duration_ms) or duration_ms <= 0):
            raise ValueError("视频时长必须是大于零的有效秒数，请检查视频规划中的时长。")
        duration_seconds = duration_ms / 1000.0
        errors = [row for row in result["issues"] if row["level"] == "error"]
        if strict and errors:
            raise ValueError("H3 提示词检查未通过：\n" + "\n".join(
                row["path"] + "：" + row["message"] for row in errors))
        report = json.dumps({"issues": result["issues"], "speaker_map": result["speaker_map"],
                             "translation": result["translation"]}, ensure_ascii=False)
        return io.NodeOutput(result["prompt"], json.dumps(result["document"], ensure_ascii=False),
                             report, duration_seconds, ui={"h3_prompt": [result]})


NODE_LIST = [H3PromptComposer]
