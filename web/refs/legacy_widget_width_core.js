export const WIDTH_KEY = "__lwwf_width";
export const GUARD_KEY = "__lwwf_guarded";

const OWNER_KEY = "__amiaomiao_widget_width_owner";
const HOOK_KEY = "__amiaomiao_widget_width_hook";
const HOOK_METHODS = ["addWidget", "addDOMWidget", "addCustomWidget"];

export function graphNodes(graph, output = [], seen = new Set()) {
    if (!graph || seen.has(graph)) return output;
    seen.add(graph);
    for (const node of graph._nodes ?? []) {
        output.push(node);
        if (node?.subgraph) graphNodes(node.subgraph, output, seen);
    }
    return output;
}

export function createWidgetWidthFix({ getGraph, getLiteGraph = () => globalThis.LiteGraph,
    requestFrame = callback => globalThis.requestAnimationFrame?.(callback) } = {}) {
    const owner = {};
    const hosts = new Set();
    let enabled = true;
    let active = false;
    let queued = false;

    const vueMode = () => !!getLiteGraph?.()?.vueNodesMode;
    const ownsWidget = widget => Object.getOwnPropertyDescriptor(widget ?? {}, "width")?.set?.[OWNER_KEY] === owner;

    function guard(widget) {
        if (!active || !widget) return false;
        if (ownsWidget(widget)) return true;
        try {
            const current = Object.prototype.hasOwnProperty.call(widget, WIDTH_KEY) ? widget[WIDTH_KEY] : widget.width;
            widget[WIDTH_KEY] = current;
            const set = function setWidgetWidth(value) {
                if (!active || vueMode()) this[WIDTH_KEY] = value;
            };
            Object.defineProperty(set, OWNER_KEY, { value: owner });
            Object.defineProperty(widget, "width", {
                configurable: true, enumerable: true,
                get() { return this[WIDTH_KEY]; },
                set,
            });
            if (!widget[GUARD_KEY]) Object.defineProperty(widget, GUARD_KEY, { value: true, configurable: true });
            return true;
        } catch {
            return false;
        }
    }

    function repairWidget(widget) {
        if (!active || vueMode() || !guard(widget)) return false;
        widget[WIDTH_KEY] = undefined;
        return true;
    }

    function unguard(widget) {
        if (!ownsWidget(widget)) return;
        const width = widget[WIDTH_KEY];
        try {
            delete widget.width;
            delete widget[WIDTH_KEY];
            delete widget[GUARD_KEY];
            widget.width = width;
        } catch {}
    }

    function forEachWidget(callback) {
        for (const node of graphNodes(getGraph?.())) for (const widget of node?.widgets ?? []) callback(widget);
    }

    function repairAll() {
        if (!active) return;
        forEachWidget(repairWidget);
        getGraph?.()?.setDirtyCanvas?.(true, true);
    }

    function scheduleRepair() {
        if (!active || queued) return;
        queued = true;
        const run = () => { queued = false; repairAll(); };
        if (typeof requestFrame === "function") requestFrame(run); else setTimeout(run, 0);
    }

    function refresh() {
        const next = enabled && hosts.size > 0;
        if (next === active) return;
        active = next;
        if (active) {
            repairAll();
            scheduleRepair();
        } else {
            forEachWidget(unguard);
            getGraph?.()?.setDirtyCanvas?.(true, true);
        }
    }

    function installHooks(prototype) {
        if (!prototype) return;
        for (const name of HOOK_METHODS) {
            const original = prototype[name];
            if (typeof original !== "function" || original[HOOK_KEY] === owner) continue;
            const patched = function patchedWidgetMethod(...args) {
                const widget = original.apply(this, args);
                if (active && widget) repairWidget(widget);
                return widget;
            };
            Object.defineProperty(patched, HOOK_KEY, { value: owner });
            prototype[name] = patched;
        }
    }

    function repairNode(node) {
        if (!active) return;
        for (const widget of node?.widgets ?? []) repairWidget(widget);
        const later = () => { if (active && node?.graph) for (const widget of node.widgets ?? []) repairWidget(widget); };
        if (typeof requestFrame === "function") requestFrame(later); else setTimeout(later, 0);
    }

    return {
        addHost(node) { if (node && !hosts.has(node)) { hosts.add(node); refresh(); } },
        removeHost(node) { if (hosts.delete(node)) refresh(); },
        syncHosts(nodes, isHost) { hosts.clear(); for (const node of nodes) if (isHost(node)) hosts.add(node); refresh(); },
        setEnabled(value) { enabled = value !== false; refresh(); },
        installHooks,
        repairNode,
        scheduleRepair,
        get active() { return active; },
    };
}
