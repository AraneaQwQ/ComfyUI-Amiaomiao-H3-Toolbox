// H3 生成设置: duration, picture size (ratio + orientation + megapixels) and the 2nd-pass factor.
// The panel edits the node's own hidden widgets, so saved workflows and the backend read the
// same values; it only adds a clearer layout and live results.
import { RATIOS, planSize, scaledSize, secondsToLength } from "./refs_state.js";

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

// One glyph per ratio, drawn to scale inside a fixed box so the tiles never resize.
function ratioGlyph(long, short, portrait) {
    const box = el("span", "ahs-glyph");
    const shape = el("i");
    const max = 30;
    let w = max, h = max * short / long;
    if (portrait) [w, h] = [h, w];
    if (portrait && h > 22) { w = w * 22 / h; h = 22; }
    if (!portrait && h > 22) { w = w * 22 / h; h = 22; }
    shape.style.width = `${w.toFixed(1)}px`;
    shape.style.height = `${h.toFixed(1)}px`;
    box.append(shape);
    return box;
}

const RATIO_HINTS = { "1:1": "方形", "4:3": "传统", "3:2": "相机", "16:9": "常用", "1.85:1": "电影",
    "21:9": "超宽", "2.39:1": "宽银幕" };

export class SettingsPanel {
    // fields: { get(name), set(name, value) } bound to the node widgets.
    constructor(fields) {
        this.fields = fields;
        this.reference = null;  // { frames, name } from the last run, for 跟随 Video 1
        this.liveReference = { status: "missing", text: "连接「H3 参考素材」并启用一个视频后才能跟随 Video 1" };
        this.root = el("div", "ahr ahs");
        this.render();
    }

    value(name) { return this.fields.get(name); }

    set(name, value, rerender = true) {
        this.fields.set(name, value);
        if (rerender) this.render(); else this.updateResult();
    }

    showResult(message) {
        const info = message?.h3_settings?.[0];
        if (info?.reference_frames) this.reference = { frames: info.reference_frames, name: info.reference_name || "Video 1" };
        this.render();
    }

    setReference(reference) {
        this.liveReference = reference;
        if (reference.status === "missing" && this.value("follow_reference")) this.fields.set("follow_reference", false);
        this.render();
    }

    numberField(name, { min, max, step, digits = 2, width = 88, label }) {
        const input = el("input", "ahr-number ahs-number");
        input.type = "number";
        Object.assign(input, { min, max, step });
        input.style.width = `${width}px`;
        input.value = String(this.value(name));
        input.setAttribute("aria-label", label);
        const commit = () => {
            let value = Number(input.value);
            if (!Number.isFinite(value)) value = Number(this.value(name));
            value = Math.min(max, Math.max(min, value));
            value = digits === 0 ? Math.round(value / step) * step : Number(value.toFixed(digits));
            input.value = String(value);
            this.set(name, value, false);
        };
        input.addEventListener("change", commit);
        input.addEventListener("input", () => {
            const value = Number(input.value);
            if (Number.isFinite(value) && value >= min && value <= max) { this.fields.set(name, value); this.updateResult(); }
        });
        return input;
    }

    section(title, extra) {
        const box = el("section", "ahs-section");
        const head = el("div", "ahs-head");
        head.append(el("h4", "", title));
        if (extra) head.append(extra);
        box.append(head);
        return box;
    }

    segmented(name, options, label, disabled = false) {
        const group = el("div", "ahs-seg");
        group.setAttribute("role", "radiogroup");
        group.setAttribute("aria-label", label);
        for (const option of options) {
            const button = el("button", "", option);
            button.type = "button";
            button.setAttribute("role", "radio");
            button.setAttribute("aria-checked", String(this.value(name) === option));
            button.disabled = disabled;
            button.addEventListener("click", () => { if (this.value(name) !== option) this.set(name, option); });
            group.append(button);
        }
        return group;
    }

    render() {
        this.root.replaceChildren();
        const follow = !!this.value("follow_reference");
        const custom = this.value("ratio") === "自定义";
        const portrait = this.value("orientation") === "竖";

        // duration
        const duration = this.section("时长");
        const line = el("div", "ahs-line");
        const seconds = this.numberField("seconds", { min: 0.2, max: 150, step: 0.1, width: 104, label: "视频时长（秒）" });
        seconds.classList.add("ahs-seconds");
        seconds.disabled = follow;
        this.lengthNote = el("span", "ahs-derived");
        line.append(seconds, el("span", "ahs-unit", "秒"), this.lengthNote);
        duration.append(line);

        const reference = this.section("参考视频");
        const followToggle = el("label", "ahr-toggle ahs-follow");
        const box = el("input");
        box.type = "checkbox";
        box.checked = follow;
        box.disabled = this.liveReference.status === "missing" && !follow;
        box.addEventListener("change", () => {
            if (box.checked && this.liveReference.status === "missing") {
                box.checked = false;
                this.render();
                return;
            }
            this.set("follow_reference", box.checked);
        });
        followToggle.append(box, el("span", "ahr-switch"), el("span", "", "成片长度跟随 Video 1"));
        followToggle.classList.toggle("is-disabled", box.disabled);
        followToggle.title = box.disabled ? this.liveReference.text : "成片长度跟随 Video 1。生成时多补出的尾帧，会在解码后裁掉。";
        const referenceNote = el("div", `ahs-reference-note is-${this.liveReference.status}`, this.liveReference.text);
        const pad = el("label", "ahr-toggle ahs-pad");
        const padBox = el("input");
        padBox.type = "checkbox";
        padBox.checked = !!this.value("pad_reference");
        padBox.disabled = this.liveReference.status === "missing";
        padBox.addEventListener("change", () => this.set("pad_reference", padBox.checked));
        pad.append(padBox, el("span", "ahr-switch"), el("span", "", "保留参考视频结尾"));
        pad.classList.toggle("is-disabled", padBox.disabled);
        pad.title = padBox.disabled ? "没有启用的参考视频，这个设置暂时不起作用"
            : "H3 只能按固定帧数读取参考视频。长度不合适时，原生节点会裁掉一点结尾。开启后会重复最后一帧补足长度，原来的动作都会保留。";
        const padNote = el("span", "ahs-pad-note", padBox.disabled ? "没有参考视频，暂不适用"
            : padBox.checked ? "开启：不丢掉参考视频最后的动作" : "关闭：可能少掉参考视频最后几帧");
        const padLine = el("div", "ahs-line");
        padLine.append(pad, padNote);
        reference.append(followToggle, referenceNote, padLine);

        // picture
        const picture = this.section("画幅", this.segmented("orientation", ["横", "竖"], "方向", this.value("ratio") === "1:1" || custom));
        const tiles = el("div", "ahs-ratios");
        tiles.setAttribute("role", "radiogroup");
        tiles.setAttribute("aria-label", "比例");
        for (const [name, long, short] of [...RATIOS, ["自定义", 4, 3]]) {
            const tile = el("button", "ahs-ratio");
            tile.type = "button";
            tile.setAttribute("role", "radio");
            tile.setAttribute("aria-checked", String(this.value("ratio") === name));
            const glyph = ratioGlyph(long, short, portrait && name !== "1:1");
            if (name === "自定义") glyph.classList.add("is-custom");
            const shown = portrait && name.includes(":") && name !== "1:1" ? name.split(":").reverse().join(":") : name;
            tile.append(glyph, el("span", "ahs-ratio-name", shown), el("small", "", RATIO_HINTS[name] || (name === "自定义" ? "宽 × 高" : "")));
            tile.setAttribute("aria-label", name === "自定义" ? "自定义" : `比例 ${shown}`);
            tile.dataset.ratio = name;
            tile.addEventListener("click", () => { if (this.value("ratio") !== name) this.set("ratio", name); });
            tiles.append(tile);
        }
        picture.append(tiles);
        const sizeSlot = el("div", "ahs-size-slot");
        const customLine = el("div", "ahs-line ahs-size-custom");
        customLine.inert = !custom;
        customLine.append(el("span", "ahs-label", "宽 × 高"),
            this.numberField("custom_width", { min: 64, max: 8192, step: 32, digits: 0, label: "自定义宽" }),
            el("span", "ahs-unit", "×"),
            this.numberField("custom_height", { min: 64, max: 8192, step: 32, digits: 0, label: "自定义高" }),
            el("span", "ahs-unit", "按 32 对齐"));
        const presetLine = el("div", "ahs-line");
        presetLine.inert = custom;
        presetLine.append(el("span", "ahs-label", "像素量"),
            this.numberField("megapixels", { min: 0.1, max: 8, step: 0.01, label: "像素量（MP）" }),
            el("span", "ahs-unit", "MP"));
        for (const preset of [0.5, 0.75, 0.98]) {
            const chip = el("button", "ahs-chip", preset === 0.98 ? "0.98 · H3 原生" : String(preset));
            chip.type = "button";
            chip.setAttribute("aria-pressed", String(Math.abs(Number(this.value("megapixels")) - preset) < 1e-6));
            chip.addEventListener("click", () => this.set("megapixels", preset));
            presetLine.append(chip);
        }
        sizeSlot.append(customLine, presetLine);
        picture.append(sizeSlot);

        // second pass
        const second = this.section("二采");
        const secondLine = el("div", "ahs-line");
        secondLine.append(el("span", "ahs-label", "放大"),
            this.numberField("upscale", { min: 1, max: 4, step: 0.05, label: "二采放大倍率" }),
            el("span", "ahs-unit", "倍"));
        second.append(secondLine);

        // result
        this.result = el("div", "ahs-result");

        this.root.append(duration, reference, picture, second, this.result);
        this.updateResult();
    }

    updateResult() {
        const [w, h] = planSize(this.value("ratio"), this.value("orientation"), this.value("megapixels"),
            this.value("custom_width"), this.value("custom_height"));
        const [w2, h2] = scaledSize(w, h, this.value("upscale"));
        const follow = !!this.value("follow_reference");
        let lengthText;
        const live = this.liveReference;
        if (follow && live.status === "ready") {
            const frames = secondsToLength(live.frames / 24);
            lengthText = `${frames} 帧 · ${(frames / 24).toFixed(2)} 秒（${live.name} ${live.frames} 帧）`;
            this.lengthNote.textContent = `${live.name} · ${live.frames} 帧 → ${frames} 帧`;
        } else if (follow && live.status === "estimate") {
            const frames = secondsToLength(live.frames / 24);
            lengthText = `约 ${frames} 帧 · ${(frames / 24).toFixed(2)} 秒（${live.name} 约 ${live.frames} 帧）`;
            this.lengthNote.textContent = `${live.name} 约 ${live.frames} 帧 → ${frames} 帧`;
        } else if (follow && this.reference) {
            const frames = secondsToLength(this.reference.frames / 24);
            lengthText = `${frames} 帧 · ${(frames / 24).toFixed(2)} 秒（${this.reference.name} ${this.reference.frames} 帧）`;
            this.lengthNote.textContent = `${this.reference.name} · ${this.reference.frames} 帧 → ${frames} 帧`;
        } else if (follow) {
            lengthText = "运行后按 Video 1 计算";
            this.lengthNote.textContent = "运行时读取 Video 1 的长度";
        } else {
            const frames = secondsToLength(this.value("seconds"));
            lengthText = `${frames} 帧 · ${(frames / 24).toFixed(2)} 秒`;
            this.lengthNote.textContent = `= ${frames} 帧`;
        }
        this.result.replaceChildren();
        for (const [label, value] of [["一采", `${w} × ${h}`], ["二采", `${w2} × ${h2}`], ["长度", lengthText]]) {
            this.result.append(el("span", "", label), el("b", "", value));
        }
    }
}
