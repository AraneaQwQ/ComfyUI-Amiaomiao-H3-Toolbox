# Amiaomiao's H3 Toolbox

面向 MiniMax H3 工作流的 ComfyUI 自定义节点集合，整合 ClipStream、H3 Long Video Manager 和 H3 提示词编排器。

> **测试版 0.4.0**：请先备份重要工作流和素材库。此版本已做专项回归，未覆盖所有模型和工作流组合。

## 功能

- Clip Bin 素材库：保存和选择镜头，支持普通卡与 Dual 双采样卡、接续和视频预览。
- 锁卡保护：单张或进入批量模式锁定、解锁；项目中有锁卡时不能删除整个项目。
- 「H3 参考素材」统一管理图片、视频和音频；「H3 参考生成视频（素材包）」可将素材包传给原生 H3 参考生成。
- 「H3 生成设置」与「H3 片段选择／保存 v2」支持单采、双采及接续工作流。
- 「H3 视频裁切 V3」直接归档裁切片段；「H3 长视频拼接 V3」直接保存并预览成片，不需要连接额外的保存节点。详见 [V3 视频工作流](docs/VIDEO_WORKFLOW_V3.md)。
- 支持引导时间线、视频对比和工作流级界面配色。
- H3 提示词编写器：支持六区中文编排与原生输入、素材与主体引用、镜头模板，并新增「视频时长（秒）」输出。时长输出是秒数，不是帧数；原有输出顺序不变。
- 工具箱使用独立节点 ID、API 和素材目录，可与原插件共存。首次启动会在后台尝试复制旧素材库，已有同名目标项目不会覆盖。
- 界面与操作优化：升级了生成设置、参考素材、提示词、片段选择 v2、视频裁切 V3、长视频拼接 V3、两采 Sigma 及项目库弹窗界面；参考素材支持按标签筛选、一键开关备注栏、音频波形左右滑块微调裁切；四节点统一在左下角支持 50%–200% 卡片大小滑块；提示词支持拖动分隔条调宽素材栏；在 ComfyUI 设置的「显示与字体」中可调整字体与高分屏清晰度。
- 新增「【阿喵喵&熙云】H3双采接续工作流」，并修复了删改镜头后长视频拼接不自动更新及单独运行拼接/裁切节点时被误拦截的问题。

## 安装

需要支持 ComfyUI V3 API 的 ComfyUI 版本，以及该环境中的 Python。进入 ComfyUI 的 `custom_nodes` 目录执行：

```bash
git clone https://github.com/AraneaQwQ/ComfyUI-Amiaomiao-H3-Toolbox.git
```

使用运行 ComfyUI 的 Python 安装本插件目录下的依赖：

```bash
python -m pip install -r ComfyUI-Amiaomiao-H3-Toolbox/requirements.txt
```

便携版用户请使用便携版自带的 Python。安装后重启 ComfyUI，并在浏览器按 Ctrl+F5 刷新。节点位于 `Amiaomiao H3` 菜单或相应工具箱分类中。

使用 MP4 预览或长视频拼接时，请在运行 ComfyUI 的机器上安装 FFmpeg，并保证 `ffmpeg` 和 `ffprobe` 能从 `PATH` 找到。详见上面的 V3 视频工作流文档。

打开普通工作流 JSON 时，Toolbox 会替换可识别的旧 ClipStream 和 Long Video Manager 节点，不扫描工作流目录，也不主动写回原文件。建议另存为新工作流；需要使用旧节点时，先在 ComfyUI 设置里关闭对应的升级开关。本功能不处理 API 格式的 JSON。

示例工作流见 [`workflows/`](workflows/)。

「h3 视频自动处理裁切+合并 v2」演示视频均分、按场景切分和从 Clip Bin 项目合并片段。需要 VideoHelperSuite 和 Depth Anything V2 节点包。导入后请在 `VHS_LoadVideo` 选择自己的视频；合并节点独立读取已有 Clip Bin 项目，请选择已归档片段的项目。

## 锁卡

每张 shot 可以单独锁定或解锁；锁定后仍可选作接续源。点击“批量锁定”显示勾选框，可勾选多张或全选后批量操作；退出模式会清空勾选。普通和 Dual Picker 分别显示各自类型，项目删除前需要解锁两类中的所有锁卡。锁定状态保存在项目目录内的 `.card_locks.json`。

## 许可证和来源

本项目按 GPL-3.0 发布，完整许可证见 [LICENSE](LICENSE)。ClipStream 所含上游项目及作者见 [ATTRIBUTION.md](ATTRIBUTION.md)；Long Video Manager 基于 [AraneaQwQ/H3-Long-Video-Manager](https://github.com/AraneaQwQ/H3-Long-Video-Manager)，包含 RAFOLIE 的贡献，其 MIT 许可证见 [LVM-MIT-LICENSE](LVM-MIT-LICENSE)。

## 开发者名单

- **[阿喵喵Az](https://space.bilibili.com/36380937)**（[B站主页](https://space.bilibili.com/36380937)）
- **[熙云君](https://space.bilibili.com/215190289)**（[B站主页](https://space.bilibili.com/215190289)）
