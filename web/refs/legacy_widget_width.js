import { app } from "../../../scripts/app.js";
import { createWidgetWidthFix, graphNodes } from "./legacy_widget_width_core.js";

const SETTING_ID = "AmiaomiaoH3.Toolbox.LegacyWidgetWidthFix";
const PATCHED = "__amiaomiao_widget_width_lifecycle";
const isToolboxNode = node => String(node?.comfyClass ?? node?.constructor?.comfyClass ?? node?.type ?? "").startsWith("AmiaomiaoH3_");
const fix = createWidgetWidthFix({ getGraph: () => app.graph });

function patchToolboxNode(nodeType) {
    const prototype = nodeType?.prototype;
    if (!prototype || prototype[PATCHED]) return;
    Object.defineProperty(prototype, PATCHED, { value: true });
    const added = prototype.onAdded;
    prototype.onAdded = function (...args) {
        const result = added?.apply(this, args);
        fix.addHost(this);
        return result;
    };
    const removed = prototype.onRemoved;
    prototype.onRemoved = function (...args) {
        try {
            return removed?.apply(this, args);
        } finally {
            fix.removeHost(this);
        }
    };
}

function settingEnabled() {
    return app.ui?.settings?.getSettingValue?.(SETTING_ID) !== false;
}

app.registerExtension({
    name: "Amiaomiao.H3.LegacyWidgetWidthFix",
    init() {
        fix.installHooks(globalThis.LGraphNode?.prototype);
        app.ui?.settings?.addSetting?.({
            id: SETTING_ID,
            category: ["Amiaomiao H3 Toolbox", "兼容", "控件宽度"],
            name: "修复旧版画布控件宽度",
            tooltip: "画布里有 Toolbox 节点时，修复 ComfyUI 旧版画布拉宽节点后控件不跟着变宽的问题。前端修好后可以关闭。",
            type: "boolean",
            defaultValue: true,
            onChange: value => fix.setEnabled(value),
        });
        fix.setEnabled(settingEnabled());
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name?.startsWith("AmiaomiaoH3_")) patchToolboxNode(nodeType);
    },
    nodeCreated(node) {
        fix.installHooks(globalThis.LGraphNode?.prototype);
        if (isToolboxNode(node)) fix.addHost(node);
        fix.repairNode(node);
    },
    afterConfigureGraph() {
        fix.syncHosts(graphNodes(app.graph), isToolboxNode);
        fix.scheduleRepair();
    },
    setup() {
        fix.installHooks(globalThis.LGraphNode?.prototype);
        fix.setEnabled(settingEnabled());
        fix.syncHosts(graphNodes(app.graph), isToolboxNode);
        fix.scheduleRepair();
    },
});
