import { api } from "../../../scripts/api.js";
import { openLibraryBrowser } from "../refs/library_browser.js";
import { CARD_DENSITIES, normalizeCardDensity } from "../refs/refs_state.js";

export function el(tag, cls, text) {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text != null) element.textContent = text;
    return element;
}

export function icon(name) {
    const mark = el("i", `pi pi-${name}`);
    mark.setAttribute("aria-hidden", "true");
    return mark;
}

export function button(label, name, action, compact = false) {
    const control = el("button", compact ? "ahr-icon-btn" : "ahr-btn");
    control.type = "button";
    control.title = label;
    control.setAttribute("aria-label", label);
    if (name) control.append(icon(name));
    if (!compact) control.append(el("span", "", label));
    control.addEventListener("click", action);
    return control;
}

export async function fetchJson(path, options = {}) {
    const response = await api.fetchApi(path, { cache: "no-store", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
}

export function post(path, body, signal) {
    return fetchJson(path, { method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) });
}

export function mediaUrl(path) {
    return typeof api.apiURL === "function" ? api.apiURL(path) : path;
}

export function outputUrl({ filename, subfolder, type = "output" }) {
    return mediaUrl(`/view?${new URLSearchParams({ filename, subfolder, type })}`);
}

export function createShell(node, title, symbol, signal) {
    const root = el("div", "ahr ahv3");
    const head = el("header", "ahr-header"), name = el("div", "ahr-title");
    const actions = el("div", "ahr-actions"), body = el("div", "ahr-body");
    const hint = el("div", "ahr-toast"), densities = el("div", "ahr-density");
    hint.setAttribute("role", "status");
    hint.setAttribute("aria-live", "polite");
    function refreshDensity() {
        const saved = node.properties?.h3VideoDensity;
        root.dataset.density = normalizeCardDensity(saved === "extra" ? "xlarge" : saved);
        for (const control of densities.children) {
            control.setAttribute("aria-pressed", String(control.dataset.size === root.dataset.density));
        }
    }
    for (const [size, symbol, label] of CARD_DENSITIES) {
        const control = button(label, symbol, () => {
            node.properties ??= {};
            node.properties.h3VideoDensity = size;
            refreshDensity();
            node.setDirtyCanvas?.(true, true);
        }, true);
        control.classList.add("is-seg");
        control.dataset.size = size;
        densities.append(control);
    }
    name.append(icon(symbol), el("span", "", title));
    actions.append(densities);
    head.append(name, actions);
    root.append(head, body, hint);
    let timer;
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    function toast(message, error = false) {
        if (signal.aborted) return;
        clearTimeout(timer);
        hint.textContent = message;
        hint.classList.toggle("is-error", error);
        hint.classList.add("is-visible");
        timer = setTimeout(() => hint.classList.remove("is-visible"), 3700);
    }
    refreshDensity();
    return { root, body, toast, refreshDensity };
}

export function section(body, title, symbol) {
    const box = el("section", "ahr-section ahv3-section"), head = el("div", "ahr-section-head");
    const heading = el("h3", "ahr-section-title"), actions = el("div", "ahv3-actions");
    heading.append(icon(symbol), el("span", "", title));
    const content = el("div", "ahv3-content");
    head.append(heading, actions);
    box.append(head, content);
    body.append(box);
    return { box, content, actions };
}

let optionMeasure;
function trackSelectedText(select, display, signal) {
    function update() {
        const text = select.selectedOptions[0]?.textContent || "";
        select.title = text;
        display.textContent = text;
        const css = getComputedStyle(select);
        optionMeasure ??= document.createElement("canvas").getContext("2d");
        optionMeasure.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
        const space = select.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) - 20;
        display.hidden = !text || select.clientWidth === 0 || optionMeasure.measureText(text).width <= space;
    }
    const observer = new ResizeObserver(update);
    observer.observe(select);
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
    return update;
}

export function createFields(node, signal) {
    const controls = [];
    const widget = name => node.widgets?.find(candidate => candidate.name === name);
    const read = name => widget(name)?.value;
    function write(name, value) {
        const target = widget(name);
        if (!target || target.value === value) return;
        target.value = value;
        target.callback?.(value);
        node.setDirtyCanvas?.(true, true);
    }
    function field(parent, name, title, spec = {}) {
        const label = el("label", "ahv3-field");
        const caption = el("span", "", title);
        const input = el(spec.options ? "select" : spec.wrap ? "textarea" : "input",
            spec.options ? "ahr-select" : spec.wrap ? "ahr-note ahv3-wrap-input" : "ahr-number");
        const fullValue = spec.fullValue ? el("span", "ahv3-full-value") : null;
        const updateFullValue = fullValue && trackSelectedText(input, fullValue, signal);
        if (spec.options) {
            for (const option of spec.options) {
                const [value, text] = Array.isArray(option) ? option : [option, option];
                const item = el("option", "", text);
                item.value = value;
                input.append(item);
            }
        } else if (spec.wrap) {
            input.rows = 1;
            input.addEventListener("keydown", event => {
                if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); input.blur(); }
            });
            input.addEventListener("input", () => {
                if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, "");
            });
        } else {
            input.type = spec.toggle ? "checkbox" : spec.numeric ? "number" : "text";
            if (spec.numeric) Object.assign(input, spec.numeric);
        }
        if (spec.placeholder) input.placeholder = spec.placeholder;
        if (spec.toggle) {
            label.classList.add("ahr-toggle");
            input.setAttribute("role", "switch");
            label.append(input, el("span", "ahr-switch"), caption);
        } else {
            label.append(caption, input);
        }
        input.addEventListener("change", () => {
            if (spec.numeric && !input.reportValidity()) {
                input.value = read(name) ?? "";
                return;
            }
            const value = spec.numeric ? input.valueAsNumber : spec.toggle ? input.checked : input.value;
            if (spec.numeric && !Number.isFinite(value)) return;
            write(name, value);
            spec.change?.(value);
            refresh();
        });
        controls.push(() => {
            const value = read(name);
            if (spec.toggle) input.checked = Boolean(value);
            else if (document.activeElement !== input) input.value = value ?? "";
            updateFullValue?.();
            label.hidden = spec.show ? !spec.show() : false;
            input.disabled = spec.enabled ? !spec.enabled() : false;
            const socket = node.inputs?.find(port => port.name === name);
            input.disabled ||= socket?.link != null || !widget(name);
        });
        if (fullValue) {
            const block = el("div", "ahv3-field-stack");
            block.append(label, fullValue);
            parent.append(block);
        } else parent.append(label);
        return input;
    }
    function refresh() { controls.forEach(update => update()); }
    return { read, write, field, refresh, widget };
}

export function createProjectBar({ parent, fields, cut, signal, toast, onSelect, kind }) {
    const scope = cut ? "segments" : "clips";
    const base = cut ? "/amiaomiao_h3/lvm" : "/amiaomiao_h3/clip_bin";
    const current = () => fields.read("project_name") || (cut ? "H3_LVM" : "Default_Project");
    const bar = el("div", "ahr-project-bar is-video ahv3-project");
    const label = el("span", "ahr-project-label");
    label.append(icon("folder"), el("span", "", cut ? "裁切片段库" : "生成片段库"));
    const select = el("select", "ahr-select ahr-project-select");
    const fullName = cut ? el("div", "ahv3-full-value ahv3-project-full") : null;
    const updateFullName = fullName && trackSelectedText(select, fullName, signal);
    select.setAttribute("aria-label", label.textContent);
    const form = el("form", "ahr-create-form");
    const name = el("input", "ahr-number ahr-create-input");
    name.placeholder = "项目名称";
    name.setAttribute("aria-label", "新项目名称");
    name.required = true;
    const error = el("div", "ahr-create-error");
    error.setAttribute("role", "alert");
    let browser, projects = [], request = 0;
    function render() {
        const selected = current();
        select.replaceChildren();
        const rows = projects.some(row => row.name === selected) ? projects : [{ name: selected }, ...projects];
        for (const row of rows) {
            const count = row.count ?? row.segments ?? row.clips ?? row.segment_count ?? row.clip_count;
            const option = el("option", "", Number.isFinite(count) ? `${row.name} (${count})` : row.name);
            option.value = row.name;
            select.append(option);
        }
        select.value = selected;
        updateFullName?.();
    }
    async function refresh() {
        const ticket = ++request;
        const query = cut ? "scope=segments" : `asset_kind=${encodeURIComponent(kind())}`;
        render();
        try {
            const data = await fetchJson(`${base}/projects?${query}`, { signal });
            if (ticket !== request || signal.aborted) return;
            projects = (data.projects || []).map(row => typeof row === "string" ? { name: row } : row);
            render();
        } catch (err) {
            toast(err.message, true);
        }
    }
    function use(project, reset = true) {
        if (!project || signal.aborted) return;
        const changed = current() !== project;
        fields.write("project_name", project);
        onSelect(changed && reset);
        void refresh();
    }
    const browse = button("浏览", "folder-open", () => {
        browser = openLibraryBrowser({
            scope, current: current(), clipAssetKind: cut ? undefined : kind(),
            fetchJson: (url, options) => fetchJson(url, { ...options, signal }), url: mediaUrl,
            onUse: use, onRenamed: (oldName, newName) => oldName === current() ? use(newName, false) : refresh(),
            onDeleted: (oldName, next) => oldName === current() ? use(next || (cut ? "H3_LVM" : "Default_Project")) : refresh(),
        });
    });
    const add = button("新建项目", "plus", () => show(true), true);
    const submit = el("button", "ahr-btn is-confirm", "建立");
    submit.type = "submit";
    const cancel = button("取消", null, () => show(false));
    function show(open) {
        bar.classList.toggle("is-creating", open);
        form.hidden = !open;
        select.hidden = browse.hidden = add.hidden = open;
        updateFullName?.();
        error.textContent = "";
        if (open) { name.value = ""; name.focus(); }
        else add.focus();
    }
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const value = name.value.trim();
        if (!value || submit.disabled) return;
        submit.disabled = cancel.disabled = true;
        try {
            const data = await post(`${base}/project`, cut ? { project: value, scope } : { project: value }, signal);
            if (signal.aborted) return;
            show(false);
            use(data.name || data.project || value);
        } catch (err) {
            if (!signal.aborted) error.textContent = err.message;
        } finally {
            submit.disabled = cancel.disabled = false;
        }
    });
    form.addEventListener("keydown", event => { if (event.key === "Escape" && !submit.disabled) show(false); });
    form.append(name, submit, cancel, error);
    form.hidden = true;
    select.addEventListener("change", () => use(select.value));
    bar.append(label, select, browse, add, form);
    if (fullName) bar.append(fullName);
    parent.append(bar);
    signal.addEventListener("abort", () => browser?.close(), { once: true });
    return { current, refresh };
}

export function createPreview(signal) {
    let modal;
    function close() { modal?.close(); }
    signal.addEventListener("abort", close, { once: true });
    function open(title, source, proxy, { autoplay = false } = {}) {
        if (signal.aborted) return;
        close();
        const dialog = el("dialog", "ahr ahv3-modal"), head = el("header", "ahr-header");
        dialog.setAttribute("aria-label", title);
        const request = new AbortController();
        const actions = el("div", "ahv3-preview-actions");
        const status = el("div", "ahv3-preview-status", "正在载入视频…");
        status.setAttribute("role", "status");
        const video = el("video", "ahv3-player");
        video.controls = video.playsInline = true;
        video.autoplay = autoplay;
        video.preload = "metadata";
        let attempted = false;
        const retry = button("重试", "refresh", () => {
            if (attempted || !source) void loadCompatible();
            else loadSource(source);
        });
        retry.hidden = true;
        function loading(text) {
            status.textContent = text;
            status.hidden = false;
            status.classList.remove("is-error");
            retry.hidden = true;
        }
        function error(text) {
            status.textContent = text;
            status.hidden = false;
            status.classList.add("is-error");
            retry.hidden = false;
        }
        function loadSource(url) {
            loading("正在载入视频…");
            video.src = mediaUrl(url);
            video.load();
        }
        async function loadCompatible() {
            if (!proxy || compatible.disabled) return;
            attempted = true;
            compatible.disabled = true;
            loading("正在生成兼容预览…");
            try {
                const result = await post(proxy, {}, request.signal);
                if (dialog.open) loadSource(result.url);
            } catch (failure) {
                if (dialog.open) error(failure.message);
            } finally {
                compatible.disabled = false;
            }
        }
        const compatible = proxy && button("兼容预览", "refresh", loadCompatible);
        if (compatible) actions.append(compatible);
        const dismiss = button("关闭", "times", () => dialog.close());
        dismiss.autofocus = true;
        actions.append(dismiss);
        const heading = el("strong", "ahr-title", title);
        heading.title = title;
        head.append(heading, actions);
        dialog.append(head, video, status, retry);
        video.addEventListener("loadedmetadata", () => {
            if (!dialog.open) return;
            if (video.videoWidth && video.videoHeight) {
                dialog.style.setProperty("--ahv3-preview-ratio", video.videoWidth / video.videoHeight);
            }
            status.hidden = true;
            retry.hidden = true;
        });
        video.addEventListener("error", () => {
            if (!dialog.open) return;
            if (compatible && !attempted) void loadCompatible();
            else error("无法播放这段视频。请重试，或检查原文件是否仍在。");
        });
        dialog.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Escape") {
                event.preventDefault();
                dialog.close();
            }
        });
        dialog.addEventListener("close", () => {
            request.abort();
            video.pause();
            video.removeAttribute("src");
            video.load();
            dialog.remove();
            if (modal === dialog) modal = null;
        }, { once: true });
        document.body.append(dialog);
        modal = dialog;
        dialog.showModal();
        if (source) loadSource(source);
        else if (compatible) void loadCompatible();
        return dialog;
    }
    return { open, close };
}
