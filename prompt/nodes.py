import json
from comfy_api.latest import io
from .core import compile_document, default_document

NODE_ID = "AmiaomiaoH3_PromptComposer"


class H3PromptComposer(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=NODE_ID, display_name="H3 提示词编排器",
            category="Amiaomiao H3/提示词",
            description="六段提示词、动态镜头与行内台词。原生模式原样输出；编排模式只负责格式，不调用翻译或生成模型。",
            inputs=[
                io.String.Input("document", default=json.dumps(default_document(), ensure_ascii=False),
                                multiline=True, tooltip="带版本的结构化草稿，随工作流保存；支持 API 直接填写。"),
                io.Boolean.Input("strict", default=True, display_name="阻止有错误的编排输出",
                                 tooltip="开启时，失效引用、未指定正式编号、非法镜头时间或裁切区台词会阻止执行。提醒不阻止执行。"),
                io.Int.Input("mc_overlap_frames", optional=True, default=-1, min=-1, max=4096,
                             force_input=True, display_name="实际重叠帧数",
                             tooltip="仅连接或填写已确认的实际值；-1 表示沿用草稿。与实际裁切帧数分别记录。"),
                io.Int.Input("mc_trim_frames", optional=True, default=-1, min=-1, max=4096,
                             force_input=True, display_name="实际裁切帧数",
                             tooltip="可连接 Motion Context 的 trim_frames 输出。执行时更新裁切检查，不假设与重叠帧数相同。"),
            ],
            outputs=[
                io.String.Output(display_name="提示词"),
                io.String.Output(display_name="结构化草稿"),
                io.String.Output(display_name="检查报告"),
            ],
        )

    @classmethod
    def execute(cls, document, strict=True, mc_overlap_frames=-1, mc_trim_frames=-1):
        result = compile_document(document, mc_overlap_frames=mc_overlap_frames,
                                  mc_trim_frames=mc_trim_frames)
        errors = [row for row in result["issues"] if row["level"] == "error"]
        if strict and errors:
            raise ValueError("H3 提示词检查未通过：\n" + "\n".join(
                row["path"] + "：" + row["message"] for row in errors))
        report = json.dumps({"issues": result["issues"], "speaker_map": result["speaker_map"],
                             "translation": result["translation"]}, ensure_ascii=False)
        return io.NodeOutput(result["prompt"], json.dumps(result["document"], ensure_ascii=False),
                             report, ui={"h3_prompt": [result]})


NODE_LIST = [H3PromptComposer]
