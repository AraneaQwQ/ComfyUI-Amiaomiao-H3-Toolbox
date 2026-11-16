# Amiaomiao's H3 Toolbox

面向 MiniMax H3 工作流的 ComfyUI 自定义节点集合，整合 ClipStream、H3 Long Video Manager 和 H3 提示词编排器。

> **测试版 0.2.10**：已完成自动化回归和独立界面测试，尚未完成所有真实 ComfyUI 画布、工作流及模型生成场景的验收。请先备份工作流和素材库，再用于重要项目。

## 功能

- Clip Bin 素材库：保存和选择镜头，支持普通卡与 Dual 双采样卡、接续和视频预览。
- 锁卡保护：单张或进入批量模式锁定、解锁；项目中有锁卡时不能删除整个项目。
- 长视频分段、场景切分、参考素材管理、引导时间线和视频对比。
- H3 提示词编排器：素材、主体定义、分段提示词和检查报告。此节点仍在测试中。
- 工具箱使用独立节点 ID、API 和素材目录，可与原插件共存。首次启动会在后台尝试复制旧素材库，已有同名目标项目不会覆盖。

## 安装

需要支持 ComfyUI V3 API 的 ComfyUI 版本，以及该环境中的 Python。进入 ComfyUI 的 `custom_nodes` 目录执行：

```bash
git clone https://github.com/AraneaQwQ/ComfyUI-Amiaomiao-H3-Toolbox.git
```

使用运行 ComfyUI 的 Python 安装本插件目录下的依赖：

```bash
python -m pip install -r ComfyUI-Amiaomiao-H3-Toolbox/requirements.txt
```

便携版用户请使用便携版自带的 Python。安装后重启 ComfyUI，并在浏览器按 Ctrl+F5 刷新。节点位于 `Amiaomiao H3` 菜单或相应工具箱分类中。工具箱不会自动将旧工作流节点替换为新版节点。

## 锁卡

每张 shot 可以单独锁定或解锁；锁定后仍可选作接续源。点击“批量锁定”显示勾选框，可勾选多张或全选后批量操作；退出模式会清空勾选。普通和 Dual Picker 分别显示各自类型，项目删除前需要解锁两类中的所有锁卡。锁定状态保存在项目目录内的 `.card_locks.json`。

## 许可证和来源

本项目按 GPL-3.0 发布，完整许可证见 [LICENSE](LICENSE)。ClipStream 所含上游项目及作者见 [ATTRIBUTION.md](ATTRIBUTION.md)；Long Video Manager 基于 [AraneaQwQ/H3-Long-Video-Manager](https://github.com/AraneaQwQ/H3-Long-Video-Manager)，包含 RAFOLIE 的贡献，其 MIT 许可证见 [LVM-MIT-LICENSE](LVM-MIT-LICENSE)。
