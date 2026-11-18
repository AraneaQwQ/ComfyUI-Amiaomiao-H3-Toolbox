import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { NODE_ID } from "./state.js";
import { ComposerPanel } from "./text_editor.js";

function hideLegacyFrameWidgets(node) {
    for (const widget of node.widgets || []) {
        if (["mc_overlap_frames", "mc_trim_frames"].includes(widget.name)) {
            widget.options = { ...widget.options, hidden: true };
        }
    }
}

if (!document.getElementById("amiaomiao-h3-prompt-style")) {
    const link = document.createElement("link");
    link.id = "amiaomiao-h3-prompt-style"; link.rel = "stylesheet";
    link.href = new URL("./prompt.css", import.meta.url).href; document.head.append(link);
}
app.registerExtension({
    name: "Amiaomiao.H3.PromptComposer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_ID) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            hideLegacyFrameWidgets(this);
            const documentWidget = this.widgets.find(widget => widget.name === "document");
            if (!documentWidget) return result;
            documentWidget.options = { ...documentWidget.options, hidden: true };
            const panel = new ComposerPanel({
                node: this, api, graph: app.graph, value: documentWidget.value,
                onChange: value => {
                    documentWidget.value = value;
                    app.graph?.setDirtyCanvas(true, true);
                },
            });
            this.h3PromptPanel = panel;
            const widget = this.addDOMWidget("h3_prompt_editor", "h3-prompt", panel.root, {
                serialize: false, hideOnZoom: false, getMinHeight: () => 340,
            });
            widget.serialize = false;
            this.size = [Math.max(this.size[0], 700), Math.max(this.size[1], 780)];
            return result;
        };
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = configure?.apply(this, arguments);
            hideLegacyFrameWidgets(this);
            const widget = this.widgets?.find(w => w.name === "document");
            if (widget) this.h3PromptPanel?.load(widget.value);
            return result;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = executed?.apply(this, arguments);
            const compiled = message?.h3_prompt?.[0];
            if (compiled && this.h3PromptPanel) {
                this.h3PromptPanel.lastCompiled = compiled;
                this.h3PromptPanel.renderResults();
            }
            return result;
        };
        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.h3PromptPanel?.dispose(); return removed?.apply(this, arguments);
        };
    },
});
