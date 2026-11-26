import { app } from "../../scripts/app.js";

const setting = "AmiaomiaoH3.UpgradeLegacyWorkflow";
const legacy = new Set([
    "H3 Audio Reference Loader",
    "H3 Guide Keyframe Release",
    "H3 Guide Timeline",
    "H3 Guide Timeline v2",
    "H3 Guide Timeline v2 B",
    "H3 Image Reference Loader",
    "H3 Long Video Manager",
    "H3 Long Video Manager v2",
    "H3 Segment Picker",
    "H3 Smart Split",
    "H3 Smart Split v2",
    "H3 Video Compare Slider",
    "H3 Video Loader",
    "MiniMaxClipBinDualPicker",
    "MiniMaxClipBinDualSaver",
    "MiniMaxClipBinLongBuilder",
    "MiniMaxClipBinPicker",
    "MiniMaxClipBinSaver",
    "MiniMaxH3JoinMatchClipStream",
    "MiniMaxH3MotionContextChainClipStream",
    "MiniMaxH3MotionContextClipStream",
    "MiniMaxH3MotionContextLoadLatentClipStream",
    "MiniMaxH3MotionContextSaveLatentClipStream",
    "MiniMaxH3MotionContextSeamProbeClipStream",
    "MiniMaxH3MotionContextTrimClipStream",
    "MiniMaxH3OverlapRestoreClipStream",
    "MiniMaxH3RefineBlendClipStream",
    "MiniMaxH3SigmasTailClipStream",
]);

export function upgradeLegacyWorkflow(workflow, registered) {
    let count = 0;
    const pending = [workflow];
    while (pending.length) {
        const graph = pending.pop();
        if (Array.isArray(graph?.definitions?.subgraphs)) {
            for (const subgraph of graph.definitions.subgraphs) pending.push(subgraph);
        }
        if (!Array.isArray(graph?.nodes)) continue;
        for (const node of graph.nodes) {
            if (!legacy.has(node?.type)) continue;
            const type = `AmiaomiaoH3_${node.type}`;
            if (!Object.hasOwn(registered, type)) continue;
            node.type = type;
            if (node.properties && typeof node.properties === "object") {
                node.properties["Node name for S&R"] = type;
                delete node.properties.cnr_id;
                delete node.properties.aux_id;
                delete node.properties.ver;
            }
            count++;
        }
    }
    return count;
}

app.registerExtension({
    name: "AmiaomiaoH3.WorkflowUpgrade",
    settings: [{
        id: setting,
        name: "打开工作流时将旧 ClipStream / Long Video 节点升级为 Toolbox",
        type: "boolean",
        defaultValue: true,
    }],
    beforeConfigureGraph(workflow) {
        if (app.ui.settings.getSettingValue(setting) === false) return;
        const registered = globalThis.LiteGraph?.registered_node_types;
        if (!registered) return;
        const count = upgradeLegacyWorkflow(workflow, registered);
        if (count) app.extensionManager?.toast?.add({
            severity: "info",
            summary: "H3 Toolbox",
            detail: `已替换 ${count} 个旧节点。可另存为 Toolbox 工作流，保留原文件。`,
            life: 4500,
        });
    },
});
