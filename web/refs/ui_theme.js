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

// ---------- ComfyUI Global Settings: Typography, Anti-Stripe & High-DPI Adaptation ----------
const DISPLAY_SETTINGS = {
    fontFamily: "AmiaomiaoH3.Toolbox.FontFamily",
    customFont: "AmiaomiaoH3.Toolbox.CustomFont",
    clarity: "AmiaomiaoH3.Toolbox.TextClarity",
    dpiPreset: "AmiaomiaoH3.Toolbox.DpiPreset",
    fontScale: "AmiaomiaoH3.Toolbox.FontScale",
};

const FONT_PRESETS = {
    "清晰黑体（自动推荐）": {
        sans: '"HarmonyOS Sans SC", "MiSans", "Alibaba PuHuiTi 3.0", "PingFang SC", "Microsoft YaHei", "SimHei", system-ui, sans-serif',
        mono: '"Cascadia Mono", Consolas, ui-monospace, monospace',
    },
    "微软雅黑（标准）": {
        sans: '"Microsoft YaHei", "Microsoft YaHei UI", system-ui, sans-serif',
        mono: '"Cascadia Mono", Consolas, ui-monospace, monospace',
    },
    "思源黑体 / Noto Sans": {
        sans: '"Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", system-ui, sans-serif',
        mono: '"Cascadia Mono", Consolas, ui-monospace, monospace',
    },
    "黑体 SimHei（防条纹最强）": {
        sans: '"SimHei", "Microsoft YaHei", system-ui, sans-serif',
        mono: '"Cascadia Mono", Consolas, ui-monospace, monospace',
    },
    "更纱等宽（数字极清）": {
        sans: '"Sarasa Gothic SC", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace',
        mono: '"Sarasa Gothic SC", "Cascadia Mono", Consolas, ui-monospace, monospace',
    },
};

const CLARITY_PRESETS = {
    "清晰加厚 · 防条纹（推荐）": {
        key: "crisp",
        body: 500,
        ui: 600,
        strong: 700,
        render: "geometricPrecision",
        smooth: "antialiased",
    },
    "特粗高对比（远视距）": {
        key: "bold",
        body: 600,
        ui: 700,
        strong: 800,
        render: "geometricPrecision",
        smooth: "antialiased",
    },
    "原生细字重": {
        key: "standard",
        body: 400,
        ui: 600,
        strong: 700,
        render: "auto",
        smooth: "auto",
    },
};

function detectDpiMultiplier() {
    const dpr = Number(globalThis.devicePixelRatio) || 1;
    const screenW = Number(globalThis.screen?.width) || 1920;
    const screenH = Number(globalThis.screen?.height) || 1080;
    const physW = Math.round(screenW * dpr);
    const physH = Math.round(screenH * dpr);
    if (physW >= 3400 || physH >= 2000) return dpr <= 1.55 ? 1.14 : 1.06; // 4K
    if (physW >= 2300 || physH >= 1300) return dpr <= 1.25 ? 1.08 : 1.04; // 2K
    return 1.03; // 1080p & standard displays
}

function resolveDpiMultiplier(preset) {
    if (preset === "1080p 优化（防条纹）") return 1.04;
    if (preset === "2K 屏优化（1440p）") return 1.10;
    if (preset === "4K 屏优化（2160p）") return 1.16;
    if (preset === "关闭自动补偿（100%）") return 1.00;
    return detectDpiMultiplier();
}

function readDisplaySetting(id, fallback) {
    const value = app.ui?.settings?.getSettingValue?.(id);
    return value === undefined || value === null ? fallback : value;
}

function applyDisplaySettings() {
    const root = document.documentElement;
    if (!root) return;

    const fontChoice = String(readDisplaySetting(DISPLAY_SETTINGS.fontFamily, "清晰黑体（自动推荐）"));
    const customFont = String(readDisplaySetting(DISPLAY_SETTINGS.customFont, "")).trim();
    const clarityChoice = String(readDisplaySetting(DISPLAY_SETTINGS.clarity, "清晰加厚 · 防条纹（推荐）"));
    const dpiChoice = String(readDisplaySetting(DISPLAY_SETTINGS.dpiPreset, "自动适配（1080p / 2K / 4K）"));
    const scaleRaw = Number(readDisplaySetting(DISPLAY_SETTINGS.fontScale, 100));
    const scalePct = Number.isFinite(scaleRaw) ? Math.min(135, Math.max(85, scaleRaw)) : 100;

    const fontSpec = FONT_PRESETS[fontChoice] || FONT_PRESETS["清晰黑体（自动推荐）"];
    const sans = (fontChoice === "自定义字体（填下方名称）" && customFont)
        ? `${customFont}, "Microsoft YaHei", system-ui, sans-serif`
        : fontSpec.sans;
    const clarity = CLARITY_PRESETS[clarityChoice] || CLARITY_PRESETS["清晰加厚 · 防条纹（推荐）"];
    const dpiMul = resolveDpiMultiplier(dpiChoice);
    const finalScale = Math.min(1.5, Math.max(0.85, Math.round(dpiMul * (scalePct / 100) * 1000) / 1000));

    root.dataset.amiaomiaoH3Clarity = clarity.key;
    root.style.setProperty("--h3-font-family", sans);
    root.style.setProperty("--h3-font-mono", fontSpec.mono);
    root.style.setProperty("--h3-font-scale", String(finalScale));
    root.style.setProperty("--h3-weight-body", String(clarity.body));
    root.style.setProperty("--h3-weight-ui", String(clarity.ui));
    root.style.setProperty("--h3-weight-strong", String(clarity.strong));
    root.style.setProperty("--h3-text-render", clarity.render);
    root.style.setProperty("--h3-font-smooth", clarity.smooth);
}

let displaySettingsRegistered = false;
function registerDisplaySettings() {
    if (displaySettingsRegistered) return;
    const add = app.ui?.settings?.addSetting;
    if (typeof add !== "function") return;
    displaySettingsRegistered = true;

    const onChange = () => applyDisplaySettings();
    // ComfyUI addSetting displays items in reverse registration order (LIFO), so register bottom-to-top.
    const defs = [
        {
            id: DISPLAY_SETTINGS.fontScale,
            category: ["Amiaomiao H3 Toolbox", "显示与字体", "全局字体大小微调"],
            name: "全局字体大小微调 (%)",
            tooltip: "在高 DPI 适配基础上按百分比微调全部 6 个 H3 核心节点与项目库弹窗的字号（85% ~ 135%），实时生效无需重启。",
            type: "slider",
            defaultValue: 100,
            attrs: { min: 85, max: 135, step: 5 },
            onChange,
        },
        {
            id: DISPLAY_SETTINGS.dpiPreset,
            category: ["Amiaomiao H3 Toolbox", "显示与字体", "高 DPI 适配"],
            name: "高 DPI / 屏幕清晰度适配",
            tooltip: "根据 1080p / 2K / 4K 屏幕分辨率与系统缩放自动补偿字号清晰度，也可手动锁定档位。",
            type: "combo",
            defaultValue: "自动适配（1080p / 2K / 4K）",
            options: [
                "自动适配（1080p / 2K / 4K）",
                "1080p 优化（防条纹）",
                "2K 屏优化（1440p）",
                "4K 屏优化（2160p）",
                "关闭自动补偿（100%）",
            ],
            onChange,
        },
        {
            id: DISPLAY_SETTINGS.clarity,
            category: ["Amiaomiao H3 Toolbox", "显示与字体", "文字粗细与防条纹"],
            name: "文字粗细与防条纹模式",
            tooltip: "针对 ComfyUI 缩放画布优化字体平滑、字重与次级文字对比度，消除字体发细与条纹感。",
            type: "combo",
            defaultValue: "清晰加厚 · 防条纹（推荐）",
            options: Object.keys(CLARITY_PRESETS),
            onChange,
        },
        {
            id: DISPLAY_SETTINGS.customFont,
            category: ["Amiaomiao H3 Toolbox", "显示与字体", "自定义字体名称"],
            name: "自定义本机字体名称（选填）",
            tooltip: "当上方「界面字体」选为「自定义字体」时生效，填写任意 Windows/系统已安装字体名（如 HarmonyOS Sans SC、MiSans、LXGW WenKai）。",
            type: "text",
            defaultValue: "",
            onChange,
        },
        {
            id: DISPLAY_SETTINGS.fontFamily,
            category: ["Amiaomiao H3 Toolbox", "显示与字体", "界面字体"],
            name: "界面字体",
            tooltip: "切换 H3 核心节点与项目库弹窗的界面字体。默认优先无衬线清晰黑体，避免缩放画布出现横笔断层。",
            type: "combo",
            defaultValue: "清晰黑体（自动推荐）",
            options: [...Object.keys(FONT_PRESETS), "自定义字体（填下方名称）"],
            onChange,
        },
    ];
    for (const def of defs) add.call(app.ui.settings, def);
}

let dpiResizeTimer = 0;
if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("resize", () => {
        clearTimeout(dpiResizeTimer);
        dpiResizeTimer = setTimeout(() => applyDisplaySettings(), 160);
    });
}

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
    init() {
        registerDisplaySettings();
        applyDisplaySettings();
    },
    setup() {
        registerDisplaySettings();
        applyDisplaySettings();
    },
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
        if (!document.getElementById("amiaomiao-h3-ui-theme-style")) {
            const stylesheet = document.createElement("link");
            stylesheet.id = "amiaomiao-h3-ui-theme-style";
            stylesheet.rel = "stylesheet";
            stylesheet.href = new URL("./ui_theme.css?v=20261127u", import.meta.url).href;
            document.head.append(stylesheet);
        }
        applyDisplaySettings();

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
