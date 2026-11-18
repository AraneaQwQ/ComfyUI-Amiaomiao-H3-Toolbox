import { FIELDS } from "./state.js";

export const FIELD_NAMES = ["参考定义", "摘要", "保留分析", "详细描述", "环境声", "背景配乐"];
export function referenceCategory(path, placeholder = "", before = "", after = "") {
    if (placeholder.includes("@主体")) return "subject";
    if (placeholder.includes("@音频")) return "audio";
    if (placeholder.includes("@图片")) return "image";
    if (placeholder.includes("@视频")) return "video";
    if (["overall_soundscape", "non_diegetic_music"].includes(path)) return "audio";
    if (path === "subject_definitions" && (placeholder.includes("@素材")
        || /^<Subject\s+\d+>[^。\n]*$/.test(before.trim()))) return "visual";
    if (path === "retention_analysis") {
        const line = before + placeholder + after;
        if (/选择音频关系|选上方音频关系/.test(line)) return "audio";
        if (/选择可视关系|选上方可视关系/.test(line)) return "visible";
    }
    return "all";
}
export const BUTTON_LABELS = {
    "Subject +": "新增主体", "多源分工": "组合多个参考",
    "剪辑源": "要修改的视频", "续写源": "要接着生成的视频", "视频结构": "参考运镜与节奏",
    "音频复用": "直接使用原音频", "可视分析": "画面保留与修改", "音频分析": "声音复制与参考",
    "声音绑定": "参考角色音色",
    "镜头 +": "添加一个镜头", "音轨歌词": "歌词与画面对齐", "物理音效": "动作音效",
    "声音事件": "指定音效出现时机", "属性迁移": "把特征用到其他主体", "弱参考": "只参考大致感觉",
    "音频参考": "参考声音特征", "复制音频": "使用原环境声或音效", "参考音频": "参考环境声或音效",
    "复制配乐": "使用原配乐", "参考配乐": "参考音乐风格", "全片静音": "不设置环境声",
};
export const BUTTON_HELP = {
    "Subject +": "定义一个角色、物体或场景。可选多张图片或视频共同说明同一个主体。",
    "多源分工": "同一个主体的不同特征来自不同素材。例如外貌来自图片A，动作来自视频B。",
    "首帧": "让这张图片作为某个镜头开始时的画面。",
    "关键帧": "指定某个时刻的画面状态，开始和结束之间也可以设置。",
    "尾帧": "让某个镜头结束时到达这张图片的姿态与构图。",
    "构图或分镜": "参考人物站位、景别或镜头顺序，不要求整张图片原样出现。",
    "剪辑源": "在已有视频上修改人物、背景或其他内容，说明哪段视频是修改对象。",
    "续写源": "从已有视频的结尾接着生成，说明它最后的人物位置和动作状态。",
    "视频结构": "参考视频怎样移动镜头、何时切镜及节奏快慢。",
    "音频复用": "直接使用原录音的完整音轨、片段或某一层声音。",
    "音频参考": "参考音色、曲风或节奏来生成新声音，不直接复制原录音。",
    "声音绑定": "为已定义主体绑定音频的音色。选择主体后沿用已有S编号或分配下一个；节点不按最终对白顺序自动重排。完成后按首次实际发声顺序核对，S编号与Subject编号无必然对应。",
    "角色使用原声": "将原录音指定为角色的对白或歌声，点击句中的用途选择说话或唱歌。摘要选择audio reuse；只复制人声层或片段选partially_copy，完整录音作为全部最终音轨才选fully_copy。详细描述准确填写原台词或歌词；节点不会听写、提取人声或保证精准口型。换音色重新演绎属于audio reference。S编号沿用已有绑定或分配下一个，请按首次实际发声顺序复核。",
    "目标概述": "用一句话说明视频整体要呈现什么。句式根据已选任务变化。",
    "添加参考用途": "追加一条素材用途说明，例如用图片A参考外貌、视频B参考运镜，可重复添加。",
    "可视分析": "说明某个主体或画面参考在哪些镜头出现，以及哪些特征保留或改变。",
    "音频分析": "说明声音是直接复制，还是只参考音色、节奏等特征。",
    "镜头 +": "在现有最大镜头编号之后新增一个镜头句式。",
    "补齐规划镜头": "按本栏镜头数量补上缺少的镜头，保留已写正文；每个镜头独立分段。",
    "整体画风": "在详细描述最前面添加全片画风、光照、色彩和材质，只需添加一次。",
    "对白": "使用<Subject N> (Sx)标识实际发声角色，完整台词写在<d>[Chinese] ...</d>中。自动填号只是编辑辅助；按首次实际发声顺序复核，同一角色画外发声沿用同一S编号。",
    "画外音或旁白": "声音来自画面外或旁白，画面内人物不做对应口型。",
    "音轨歌词": "用某句实际歌词定位画面事件，例如唱到该句时转身或切镜。",
    "首帧引用": "在镜头正文中说明从哪张图片开始，以及之后如何运动。",
    "关键帧引用": "在镜头正文中指定某个时刻对应的参考图片。",
    "尾帧引用": "在镜头正文中说明如何运动到指定结束画面。",
    "视频引用": "说明具体沿用参考视频的哪段动作、运镜或切镜方式。",
    "音频引用": "说明某段声音何时使用，以及是复制原音还是参考其特征。",
    "声音事件": "把一个音效与具体时刻或动作对应，例如落脚时响起脚步声。",
    "画面文字": "填写招牌、屏幕等载体上需要实际显示的文字。",
    "环境声": "描述场景持续存在的底声，例如雨声、虫鸣或远处车流。",
    "物理音效": "描述动作产生的声音，例如衣料摩擦、碰撞或脚步。",
    "复制音频": "直接使用参考录音中的环境声或音效，并说明使用范围。",
    "参考音频": "参考原音频的声音特点，生成适合当前场景的新声音。",
    "全片静音": "在环境声分区填入N/A；配乐是否使用仍由背景配乐分区决定。",
    "背景配乐": "描述观众听到的背景音乐，包括乐器、节奏和强弱变化。",
    "复制配乐": "直接使用参考音频里的完整配乐或指定片段。",
    "参考配乐": "参考原配乐的风格、乐器或节奏来生成新配乐。",
    "无配乐": "在背景配乐分区填入N/A，不影响环境声或对白。",
    "按关键帧生成": "以指定的首帧、关键帧或尾帧作为画面目标生成视频。",
    "参考素材生成": "利用参考素材定义的人物、场景或其他特征生成视频。",
    "修改已有视频": "修改提供的视频，例如换人物或背景，同时说明哪些内容保留。",
    "接着视频往后生成": "承接原视频结尾继续发生的新事件。",
    "直接使用原音频": "使用录音本身，可与画面生成、视频修改等任务组合。",
    "参考音频特征": "只参考声音特征来生成新声音，可与画面任务组合。",
    "fully_preserved": "完整保留该标签定义的职责及特征。例如定义角色外貌与服装后，保留这些特征并新增转身动作仍可选此项；不是像素级不变或数值权重。",
    "partially_preserved": "原定义仍被使用，但部分已定义特征改变或仅保留一部分；明确保留项和改变项。仅新增动作不自动属于部分保留。",
    "attribute_transfer": "将参考的特定特征转移给另一个可识别目标。必须说明来源、转移的属性和目标标签；普通引用素材不应一律选此项。",
    "weak_reference": "只借鉴大致风格、构图、气氛或相似感觉。",
    "fully_copy": "完整源音频作为目标视频全部最终音轨。如果只复制片段或某个音层，或另加、删改声音，请使用partially_copy。",
    "partially_copy": "只复制部分片段或声音层，或另加、删改其他声音。",
    "reference": "不直接复制录音，只参考音色、节奏、曲风等声音特征。",
    "说话人": "插入单个说话人标记，例如(S1)。普通人物对白优先使用对白句式自动填写。",
    "多人发声": "多人同时发声时列出对应编号，例如(S1,S2)。",
    "台词或歌词": "插入实际说出或唱出的文字标记。",
    "跨切连续": "插入<scenetrans>标记入口。跨镜对白需按官方基础指南结合前后镜头和连续性描述使用；点击不会自动生成完整嵌入语法。",
    "结尾截断": "插入<cutoff>标记入口。用于视频结束时被截断的内容，需按官方基础指南补齐上下文；不代表提前结束所有动作或声音。",
    "听不清": "标记无法辨认的语音内容。",
    "格式标记": "插入台词、说话人和跨切等格式标记。",
};
export const TASK_TYPES = [
    ["按关键帧生成", "keyframe completion"], ["参考素材生成", "reference generation"],
    ["修改已有视频", "video editing"], ["接着视频往后生成", "video continuation"],
    ["直接使用原音频", "audio reuse"], ["参考音频特征", "audio reference"],
];
export const VISUAL_RELATIONS = [
    ["完全保留", "fully_preserved"], ["部分保留", "partially_preserved"],
    ["属性迁移", "attribute_transfer"], ["弱参考", "weak_reference"],
];
export const AUDIO_RELATIONS = [
    ["完整复制", "fully_copy"], ["部分复制", "partially_copy"],
    ["参考", "reference"], ["弱参考", "weak_reference"],
];
export function summaryParts(text) {
    const match = text.match(/^\s*\[([^\]]*)\][ \t]*/);
    const tasks = match?.[1].split(/\s*\+\s*/).map(value => value.trim()) || [];
    const known = TASK_TYPES.map(item => item[1]);
    if (!match || !tasks.every(value => known.includes(value) || value === "【任务类型】" || value === ""))
        return { tasks: [], body: text };
    return { tasks: [...new Set(tasks.filter(value => known.includes(value)))], body: text.slice(match[0].length) };
}
export function toggleSummaryTask(text, value) {
    const { tasks, body } = summaryParts(text);
    const next = tasks.includes(value) ? tasks.filter(task => task !== value) : [...tasks, value];
    return (next.length ? `[${next.join(" + ")}] ` : "") + body;
}
export function summaryPreset(text) {
    const { tasks } = summaryParts(text);
    if (tasks.includes("video editing") && !tasks.includes("video continuation")) return PRESETS.summary[1][1];
    if (tasks.includes("video continuation") && !tasks.includes("video editing")) return PRESETS.summary[2][1];
    return PRESETS.summary[0][1];
}
export const PRESETS = {
    subject_definitions: [
        ["Subject +", "<Subject {subject}>是由【@素材，可多个】定义的【对象类型，如角色、物体或场景】，【特征，如外貌服装、形状材质或空间布局】。"],
        ["多源分工", "<Subject {subject}>的【属性，如外貌或服装】来自【@素材】，【另一属性，如动作或画风】来自【@素材】，【需保持一致的特征】。"],
        ["首帧", "【@图片】是[Shot 【镜头编号，如1】]的首帧，画面为【主体位置、姿态与背景】。"],
        ["关键帧", "【@图片】是[Shot 【镜头编号，如1】]在【时刻，如00:03.000】的关键帧，画面为【此刻的姿态、构图或动作状态】。"],
        ["尾帧", "【@图片】是[Shot 【镜头编号，如1】]的尾帧，画面为【结束时的姿态、位置与构图】。"],
        ["构图或分镜", "【@图片】为【镜头范围，如Shot 1或全片】提供【参考内容，如人物站位、景别或分镜顺序】参考，【具体沿用的画面安排】。"],
        ["剪辑源", "【@视频】是目标视频的剪辑源，【源内容与待修改部分，如人物、背景或物体】。"],
        ["续写源", "【@视频】是续写起点，末尾状态为【人物位置、动作方向与场景状态】。"],
        ["视频结构", "【@视频】提供【运镜、切点或节奏】参考，【沿用范围，如全片切镜或某段镜头运动】。"],
        ["音频复用", "【@音频】用于直接复用【完整最终音轨、片段或音层】，【使用范围，如全片、某镜头或指定时间段】。"],
        ["音频参考", "【@音频】提供【音色、曲风、节奏或声音质感】参考，【需参考的特征，如低沉沙哑、轻快节奏】。"],
        ["声音绑定", "【@音频】是【@主体】(S【自动】)的音色参考，【声音特征，如清亮、低沉或略带沙哑】。"],
        ["角色使用原声", "【@音频】中的【选择说话或唱歌】原声用于【@主体】(S【自动】)，直接复用【音频范围，如完整录音、指定片段或人声层】，保留原录音的台词或歌词与声音表现。"],
    ],
    summary: [
        ["摘要句式", "[【任务类型】] 目标视频呈现【主要人物、场景与事件】。"],
        ["剪辑摘要", "[video editing] 目标视频是【@视频】的剪辑版本，将【修改内容，如替换人物或背景】，并保留【保留内容，如动作、构图与切镜】。"],
        ["续写摘要", "[video continuation] 从【@视频】的末尾继续，【后续事件，如人物转身走向门口】，最终【结束状态，如停在门前回望】。"],
    ],
    retention_analysis: [
        ["可视分析", "【@参考标签】（【选择镜头，可多选】）: 【选择可视关系】 - 【保留或改变的特征，如保留服装、改变动作】。"],
        ["音频分析", "【@音频】: 【选择音频关系】 - 【复制范围或参考方式，如仅参考音色、不复用原台词】。"],
    ],
    detailed_description: [
        ["镜头 +", "{shot} 【景别与构图，如中景、人物居左；环境与光照】。【动作过程，如抬头、转身再迈步】。【运镜，如固定、推近或跟随】。【声音，如脚步、风声或对白】。"],
        ["整体画风", "整体采用【画风，如写实电影、动漫CG或手绘】，光照为【光线方向与软硬，如侧面柔光】，色彩与材质为【色调与质感，如冷色、哑光金属】。"],
        ["对白", "【@主体】(S【自动】)【动作及语气，如停步后轻声询问】，<d>[Chinese] 【实际说出的台词】</d>"],
        ["角色使用原声", "【@主体】(S【自动】)按照【@音频】中的原声【选择说话或唱歌】，直接复用【原录音的指定片段或人声层】，口型、呼吸与表演对应录音的发声节奏，<d>[Chinese] 【该段原录音的准确台词或歌词】</d>。【动作与表情】。"],
        ["画外音或旁白", "【发声源，如低沉男声旁白】(S【编号】)以画外音说，<d>[Chinese] 【实际说出的台词】</d>【画面人物的嘴唇保持闭合】。"],
        ["音轨歌词", "【@音频】播放到<d>[Chinese] 【对应的实际歌词】</d>时，【同步画面事件，如转身或切镜】。"],
        ["首帧引用", "镜头从【@图片】开始，【后续动作与画面变化】。"],
        ["关键帧引用", "在【时刻，如00:03.000】，画面对应【@图片】，【到达此状态前后的动作变化】。"],
        ["尾帧引用", "镜头结束于【@图片】，【如何运动至尾帧的姿态与构图】。"],
        ["视频引用", "依据【@视频】的【片段或结构，如前3秒动作或全片切镜】，【采用方式，如沿用运镜、替换人物】。"],
        ["音频引用", "在【时刻或事件，如开门时】，【复制或参考】【@音频】的【声音内容，如门响、对白或节奏】。"],
        ["声音事件", "【声音来源，如脚步、车门或远处雷声】在【时刻或动作，如人物落脚时】发出【声音特征，如短促、沉闷或带回响】。"],
        ["画面文字", "【文字载体，如招牌、屏幕或纸条】上写着\"【需要显示的原始文字】\"。"],
    ],
    overall_soundscape: [
        ["环境声", "全片环境声为【环境底声，如雨声、虫鸣或街道车流】，空间感与强弱变化为【远近、混响及变化，如远处持续、近处渐强】。"],
        ["物理音效", "主要物理音效包括【动作对应音效，如脚步、衣料摩擦或金属碰撞】。"],
        ["复制音频", "直接复用【@音频】的【环境声或音效层，如雨声或脚步】，用于【范围，如全片或Shot 2】。"],
        ["参考音频", "参考【@音频】的【声音特征，如空旷混响或密集雨点】，生成【目标环境声或音效】。"],
        ["全片静音", "N/A"],
    ],
    non_diegetic_music: [
        ["背景配乐", "观众可听到的背景配乐采用【配器，如钢琴、弦乐或合成器】，速度为【节奏，如缓慢舒展或快速紧张】，动态发展为【变化，如轻柔开始、高潮渐强、结尾淡出】。"],
        ["复制配乐", "直接复用【@音频】的【完整配乐或片段，如前5秒】，用于【范围，如全片或某段镜头】。"],
        ["参考配乐", "参考【@音频】的【曲风、配器、节奏或动态】，具体为【希望沿用的音乐特征，如钢琴主旋律与渐强弦乐】。"],
        ["无配乐", "N/A"],
    ],
};
export const SUMMARY_REFERENCE_PRESET = "使用【@参考标签】作为【参考用途，如角色外貌、场景或运镜】。";
export const REFERENCE_PRESET_GROUPS = [
    { title: "主体定义", hint: "从图片或视频定义角色、物体、场景等可复用内容。", labels: ["Subject +", "多源分工"] },
    { title: "图片参考", hint: "指定首尾帧、关键帧，或参考构图与分镜。", labels: ["首帧", "关键帧", "尾帧", "构图或分镜"] },
    { title: "视频参考", hint: "指定修改源、续写起点，或参考运镜与切镜节奏。", labels: ["剪辑源", "续写源", "视频结构"] },
    { title: "音频参考", hint: "复用录音、让角色使用原声，或仅参考声音特征与音色。", labels: ["音频复用", "角色使用原声", "音频参考", "声音绑定"] },
];
export const DETAILED_PRESET_GROUPS = [
    { title: "镜头与画面", hint: "安排镜头段落，描述构图、动作、运镜和整体画风。", labels: ["补齐规划镜头", "镜头 +", "整体画风"] },
    { title: "对白与声音", hint: "描述人物说什么、怎样说，以及动作发生时的音效。", labels: ["对白", "角色使用原声", "画外音或旁白", "声音事件"] },
    { title: "图片与视频参考", hint: "指定镜头中的参考画面，或沿用视频的动作与运镜。", labels: ["首帧引用", "关键帧引用", "尾帧引用", "视频引用"] },
    { title: "音频参考", hint: "指定参考声音何时出现，或让画面与歌词同步。", labels: ["音频引用", "音轨歌词"] },
    { title: "文字与格式", hint: "填写画面内的文字，或插入对白、说话人和跨切等标记。", labels: ["画面文字"], markers: true },
];
export function plannedShotCount(doc) {
    const configured = Number(doc.ui.shot_count);
    const shots = [...(doc.text_fields?.detailed_description || "").matchAll(/\[Shot\s+(\d+)\]/g)]
        .map(match => Number(match[1]));
    return Math.min(100, Math.max(1, Math.floor(configured || Math.max(1, ...shots))));
}
export function shotScope(numbers) {
    return [...new Set(numbers)].filter(number => Number.isInteger(number) && number > 0)
        .sort((a, b) => a - b).map(number => `[Shot ${number}]`).join(", ");
}
export function completeShotOutline(text, count) {
    const block = number => [
        number === 1 ? "[Shot 1]" : `[Shot ${number}] At 【MM:SS.mmm】,`,
        "【景别与构图，如中景、人物居左；环境与光照】。",
        "【动作过程，如抬头、转身再迈步】。",
        "【运镜，如固定、推近或跟随】。",
        "【声音，如脚步、风声或对白】。",
    ].join("\n");
    let result = text;
    for (let number = 1; number <= count; number++) {
        const headings = [...result.matchAll(/^\[Shot\s+(\d+)\]/gm)];
        if (headings.some(match => Number(match[1]) === number)) continue;
        const next = headings.find(match => Number(match[1]) > number);
        if (next) result = result.slice(0, next.index) + block(number) + "\n\n" + result.slice(next.index);
        else result += (result && !result.endsWith("\n\n") ? (result.endsWith("\n") ? "\n" : "\n\n") : "") + block(number);
    }
    return result;
}
export const MARKERS = [
    ["说话人", "(S【编号】)"], ["多人发声", "(S【编号】,S【编号】)"],
    ["台词或歌词", "<d>[Chinese] 【内容】</d>"],
    ["跨切连续", "<scenetrans>"], ["结尾截断", "<cutoff>"],
    ["听不清", "[unclear]"], ["画面文字", "\"【文字】\""],
];

export function nextNumber(text, kind) {
    const numbers = [...text.matchAll(new RegExp(`<${kind}\\s+(\\d+)>`, "g"))].map(match => Number(match[1]));
    return Math.max(0, ...numbers) + 1;
}
export function speakerNumber(fields, subject) {
    const text = Object.values(fields).join("\n");
    const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bound = text.match(new RegExp(escaped + "\\s*\\(S(\\d+)\\)"));
    if (bound) return Number(bound[1]);
    return Math.max(0, ...[...text.matchAll(/\bS(\d+)\b/g)].map(match => Number(match[1]))) + 1;
}
export function expandPreset(template, fields) {
    const subject = nextNumber(fields.subject_definitions, "Subject");
    const shots = [...fields.detailed_description.matchAll(/\[Shot\s+(\d+)\]/g)].map(match => Number(match[1]));
    const shot = Math.max(0, ...shots) + 1;
    return template.replaceAll("{subject}", subject).replaceAll("{shot}",
        shot === 1 ? "[Shot 1]" : `[Shot ${shot}] At 【MM:SS.mmm】,`);
}
export function joinFields(fields) {
    return FIELDS.map(key => `${key}:\n${fields[key] ?? ""}`).join("\n\n");
}
export function splitNative(text) {
    const aliases = Object.fromEntries(FIELDS.flatMap((key, index) => [[key, key], [FIELD_NAMES[index], key]]));
    aliases["主体定义"] = "subject_definitions";
    aliases["整体音效"] = "overall_soundscape";
    aliases["背景音乐"] = "non_diegetic_music";
    text = text.replace(/^\s*```(?:text|markdown|md|plaintext)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/, "$1");
    const pattern = new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]+)?(?:\\d+[.)、][ \\t]*)?(?:\\*\\*)?(${Object.keys(aliases).join("|")})(?:\\*\\*)?[ \\t]*(?:[：:][ \\t]*(?:\\*\\*)?[ \\t]*|\\r?$)`, "gmi");
    const matches = [...text.matchAll(pattern)];
    if (!matches.length) return null;
    const fields = Object.fromEntries(FIELDS.map(key => [key, ""]));
    const prefix = text.slice(0, matches[0].index);
    if (prefix.trim()) fields.detailed_description = prefix;
    matches.forEach((match, index) => {
        const start = match.index + match[0].length;
        let body = text.slice(start, matches[index + 1]?.index ?? text.length);
        body = body.replace(/^\r?\n/, "");
        if (index < matches.length - 1) body = body.replace(/\r?\n\r?\n$/, "");
        const key = aliases[match[1].toLowerCase()];
        fields[key] += (fields[key] && body ? "\n\n" : "") + body;
    });
    return fields;
}
