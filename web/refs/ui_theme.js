import { app } from "../../../scripts/app.js";

const NODE_TYPE = "AmiaomiaoH3_UiTheme";
const TITLE = "H3 界面配色";
const SURFACE_KEYS = ["bg", "panel", "raised", "input", "line", "edge", "text", "muted", "faint"];
const BACKGROUNDS = {
    charcoal: { label: "深炭灰", colors: ["#17181B", "#1F2125", "#26292E", "#121316", "#33363C", "#4A4E56", "#E8E9EB", "#9A9EA6", "#838892"] },
    slate: { label: "冷蓝灰", colors: ["#151C25", "#1E2835", "#2A3647", "#101721", "#354458", "#51647D", "#E8EFF8", "#A9B8CC", "#8FA2BA"] },
    graphite: { label: "暖石墨", colors: ["#1E1B17", "#29241D", "#362E24", "#171410", "#463C30", "#655542", "#F0E9DE", "#C6B7A5", "#AD9A83"] },
    mist: { label: "雾白", light: true, colors: ["#EEF1F5", "#F8FAFD", "#E3E9F0", "#FFFFFF", "#CCD5E0", "#8191A4", "#202A38", "#48586B", "#536579"] },
    cream: { label: "奶油纸", light: true, colors: ["#F4EADB", "#FFF7EA", "#ECE0CE", "#FFFCF6", "#D8C8B2", "#A28C72", "#322820", "#62513F", "#6D5945"] },
    sky: { label: "晴空蓝", light: true, colors: ["#DFEBFA", "#F2F7FF", "#D4E2F5", "#FFFFFF", "#B7C9E1", "#738EAF", "#1D2C45", "#425875", "#4C6180"] },
};
const ACCENTS = {
    teal: { label: "青绿", dark: "#3FC8B4", light: "#086D61" },
    lemon: { label: "柠檬黄", dark: "#DCE85C", light: "#596200" },
    pearl: { label: "珍珠白", dark: "#D6DEE8", light: "#475B73" },
};
const BUTTON_SIZES = { small: { label: "小按钮" }, large: { label: "大按钮" } };
const DEFAULT = { background: "charcoal", accent: "teal", buttonSize: "small" };
const MARGIN = 6;
const PANEL_HEIGHT = 166 + MARGIN * 2;

function choice(node, key, choices) {
    const value = node?.properties?.[key];
    return typeof value === "string" && Object.hasOwn(choices, value) ? value : DEFAULT[key];
}

function rootGraph() {
    return app.rootGraphOrUndefined ?? app.graph;
}

let applied = "";
let scheduled = false;

function refreshTheme() {
    const nodes = (rootGraph()?._nodes ?? []).filter(node => node.type === NODE_TYPE);
    const owner = nodes[0];
    const background = choice(owner, "background", BACKGROUNDS);
    const accent = choice(owner, "accent", ACCENTS);
    const buttonSize = choice(owner, "buttonSize", BUTTON_SIZES);
    const palette = BACKGROUNDS[background];
    const key = `${background}:${accent}`;
    const root = document.documentElement;
    root.toggleAttribute("data-amiaomiao-h3-large-buttons", buttonSize === "large");
    if (key !== applied) {
        applied = key;
        const themed = background !== DEFAULT.background || accent !== DEFAULT.accent;
        if (themed) {
            root.dataset.amiaomiaoH3Theme = palette.light ? "light" : "dark";
            for (const [index, name] of SURFACE_KEYS.entries()) root.style.setProperty(`--h3-ui-${name}`, palette.colors[index]);
            root.style.setProperty("--h3-ui-accent", ACCENTS[accent][palette.light ? "light" : "dark"]);
        } else {
            delete root.dataset.amiaomiaoH3Theme;
            for (const name of [...SURFACE_KEYS, "accent"]) root.style.removeProperty(`--h3-ui-${name}`);
        }
    }
    for (const node of nodes) node.refreshThemePanel?.(node === owner, Boolean(palette.light));
}

function scheduleRefresh() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
        scheduled = false;
        refreshTheme();
    });
}

function element(tag, className, text) {
    const result = document.createElement(tag);
    result.className = className;
    if (text) result.textContent = text;
    return result;
}

function paletteGroup(panel, node, key, label, choices) {
    const size = key === "buttonSize";
    const group = element("div", size ? "aht-size-row" : "aht-group");
    const buttons = element("div", "aht-choices");
    buttons.setAttribute("role", "group");
    buttons.setAttribute("aria-label", label);
    group.append(element("span", "aht-label", label), buttons);
    panel.append(group);
    return Object.entries(choices).map(([value, preset]) => {
        const button = element("button", "aht-choice");
        const swatch = size ? null : element("span", "aht-swatch");
        button.type = "button";
        if (swatch) button.append(swatch);
        button.append(element("span", "aht-name", preset.label));
        button.addEventListener("click", () => {
            if (node.graph !== rootGraph() || choice(node, key, choices) === value) return;
            node.graph.beforeChange?.(node);
            node.setProperty(key, value);
            node.graph.afterChange?.(node);
        });
        buttons.append(button);
        return (enabled, light) => {
            const color = preset.colors?.[0] ?? preset[light ? "light" : "dark"];
            if (swatch) swatch.style.backgroundColor = color;
            button.title = swatch ? `${preset.label} · ${color}` : preset.label;
            button.disabled = !enabled;
            button.setAttribute("aria-pressed", String(choice(node, key, choices) === value));
        };
    });
}

app.registerExtension({
    name: "Amiaomiao.H3.UiTheme",
    beforeRegisterVueAppNodeDefs(definitions) {
        const definition = definitions.find(node => node.name === NODE_TYPE);
        if (definition) {
            definition.display_name = TITLE;
            definition.description = "切换当前工作流的 Toolbox 面板底色、强调色和按钮大小，无需接线或排队。";
        }
    },
    registerCustomNodes() {
        const { LiteGraph, LGraphNode } = globalThis;
        if (!LiteGraph || !LGraphNode) return;
        const stylesheet = document.createElement("link");
        stylesheet.rel = "stylesheet";
        stylesheet.href = new URL("./ui_theme.css", import.meta.url).href;
        document.head.append(stylesheet);

        class UiThemeNode extends LGraphNode {
            static title = TITLE;

            constructor(title) {
                super(title);
                this.isVirtualNode = true;
                Object.assign(this.properties, DEFAULT);
                const panel = element("div", "ahr aht");
                const updates = [
                    ...paletteGroup(panel, this, "background", "面板底色", BACKGROUNDS),
                    ...paletteGroup(panel, this, "accent", "强调色", ACCENTS),
                ];
                const footer = element("div", "aht-footer");
                updates.push(...paletteGroup(footer, this, "buttonSize", "按钮尺寸", BUTTON_SIZES));
                const sizeRow = footer.firstElementChild;
                sizeRow.title = "按钮尺寸随当前工作流保存";
                const status = element("span", "aht-status");
                footer.append(status);
                panel.append(footer);
                this.refreshThemePanel = (active, light) => {
                    for (const update of updates) update(active, light);
                    sizeRow.hidden = !active;
                    status.hidden = active;
                    status.textContent = this.graph === rootGraph() ? "当前画布的第一个配色节点生效" : "配色节点需放在主画布";
                };
                this.refreshThemePanel(false, false);
                const widget = this.addDOMWidget("h3_ui_theme", "h3-ui-theme", panel, {
                    serialize: false, hideOnZoom: false, margin: MARGIN,
                    getMinHeight: () => PANEL_HEIGHT, getMaxHeight: () => PANEL_HEIGHT,
                });
                widget.serialize = false;
                this.size = [320, this.computeSize()[1]];
            }

            onAdded() {
                this.refreshThemePanel(false, false);
                scheduleRefresh();
            }

            onRemoved() { scheduleRefresh(); }
            onConfigure() { scheduleRefresh(); }
            onPropertyChanged() { scheduleRefresh(); }

            onResize(size) {
                size[0] = Math.max(285, size[0]);
                size[1] = this.computeSize()[1];
            }
        }

        LiteGraph.registerNodeType(NODE_TYPE, UiThemeNode);
        UiThemeNode.category = "Amiaomiao H3/工具";
    },
    afterConfigureGraph: scheduleRefresh,
});
