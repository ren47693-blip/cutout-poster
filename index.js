/* 文字抽取成图 (Cutout Poster) v0.2 - SillyTavern 扩展
 * 全手动操作：点图挖洞 / 点词留字 / 点格子选中，实时预览。
 * 新增模板：CutoutPoster.register({ id, name, controls, defaults, hint, render, ... })
 */
(() => {
    'use strict';

    const EXT = 'cutout_poster';
    const SAMPLE = 'A kaleidoscope of painted wings dances across the vast and tranquil cerulean sky.';

    /* ---------- 基础工具 ---------- */
    const getCtx = () => (window.SillyTavern && SillyTavern.getContext ? SillyTavern.getContext() : null);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function toast(msg) { if (window.toastr) window.toastr.info(msg); else alert(msg); }
    let downloadSeq = 0;
    async function download(blob, name) {
        // 每次生成独立 URL，并把链接短暂挂载到 DOM；避免移动端第二次点击失效
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '.png';
        a.download = base + '_' + (++downloadSeq) + ext;
        a.rel = 'noopener';
        a.style.position = 'fixed'; a.style.left = '-9999px';
        document.body.appendChild(a);
        try {
            a.click();
            // iOS/Safari 对异步释放 Blob URL 较敏感，延长保留时间
            await new Promise(resolve => setTimeout(resolve, 1200));
        } finally {
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
    }

    /* ---------- 设置 ---------- */
    let fallbackSettings = null;
    function getSettings() {
        const c = getCtx();
        let s;
        if (c && c.extensionSettings) { c.extensionSettings[EXT] ??= {}; s = c.extensionSettings[EXT]; }
        else { fallbackSettings ??= JSON.parse(localStorage.getItem(EXT) || '{}'); s = fallbackSettings; }
        s.template ??= 'cutout';
        s.params ??= {};
        s.customFont ??= '';
        return s;
    }
    function saveSettings() {
        const c = getCtx();
        if (c && c.saveSettingsDebounced) c.saveSettingsDebounced();
        else localStorage.setItem(EXT, JSON.stringify(fallbackSettings));
    }

    /* ---------- IndexedDB（保存导入的字体和模板脚本） ---------- */
    function idb() {
        return new Promise((res, rej) => {
            const r = indexedDB.open('cutout_poster', 1);
            r.onupgradeneeded = () => {
                const d = r.result;
                d.createObjectStore('fonts', { keyPath: 'name' });
                d.createObjectStore('tpls', { keyPath: 'name' });
            };
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    async function dbAll(store) {
        const d = await idb();
        return new Promise((res, rej) => {
            const q = d.transaction(store).objectStore(store).getAll();
            q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
    }
    async function dbPut(store, val) {
        const d = await idb();
        return new Promise((res, rej) => {
            const t = d.transaction(store, 'readwrite');
            t.objectStore(store).put(val);
            t.oncomplete = () => res(); t.onerror = () => rej(t.error);
        });
    }

    /* ---------- 文字处理 ---------- */
    const CJK = '\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
    const TOKEN_RE = new RegExp(`[${CJK}]|[^\\s${CJK}{}]+`, 'g');
    let segmenter = null;
    function tokenizeLine(line, gran) {
        const out = [];
        if (gran === 'word' && window.Intl && Intl.Segmenter) {
            segmenter ??= new Intl.Segmenter(['zh', 'en'], { granularity: 'word' });
            for (const part of [line.replace(/\{\s*\}/g, '')]) {
                if (!part) continue;
                for (const sg of segmenter.segment(part)) {
                    const t = sg.segment;
                    if (/^\s+$/.test(t)) { if (out.length) out[out.length - 1].sp = true; continue; }
                    out.push({ t, slot: false, sp: false });
                }
            }
            return out;
        }
        let m;
        TOKEN_RE.lastIndex = 0;
        while ((m = TOKEN_RE.exec(line))) {
            const t = m[0], nxt = line[m.index + t.length];
            out.push({ t, slot: /^\{\s*\}$/.test(t), sp: !!nxt && /\s/.test(nxt) });
        }
        return out;
    }
    function tokenize(text, gran) {
        const lines = String(text).replace(/\r/g, '').split('\n');
        const out = [];
        lines.forEach((ln, li) => {
            if (li) out.push({ nl: true, t: '\n', slot: false, sp: false });
            out.push(...tokenizeLine(ln, gran));
        });
        return out;
    }
    function wrap(items, maxW) {
        const lines = [];
        let cur = [], w = 0;
        for (const it of items) {
            if (it.nl) { cur.push(it); lines.push({ items: cur, w }); cur = []; w = 0; continue; }
            if (cur.length && w + it.w > maxW + 1) { lines.push({ items: cur, w }); cur = []; w = 0; }
            cur.push(it); w += it.w;
        }
        if (cur.length) lines.push({ items: cur, w });
        return lines;
    }
    const mctx = document.createElement('canvas').getContext('2d');

    /* ---------- 字体 ---------- */
    const importedFonts = [];
    function FONT_OPTS() {
        return [
            ['theme', '酒馆主题字体'], ['sans', '无衬线'], ['serif', '衬线'], ['mono', '等宽'],
            ['kai', '楷体/手写'], ['custom', '自己输入字体名'],
            ...importedFonts.map(n => ['imp:' + n, '📁 ' + n]),
        ];
    }
    function fontFamily(k) {
        if (k === 'theme') return getComputedStyle(document.body).fontFamily || 'sans-serif';
        if (k === 'custom') { const n = getSettings().customFont; return n ? `"${n}", sans-serif` : 'sans-serif'; }
        if (k && k.startsWith('imp:')) return `"${k.slice(4)}", sans-serif`;
        return ({
            sans: 'Inter, "PingFang SC", "Microsoft YaHei", Arial, sans-serif',
            serif: '"Playfair Display", "Songti SC", SimSun, Georgia, serif',
            mono: '"Courier New", Menlo, monospace',
            kai: 'KaiTi, "Kaiti SC", STKaiti, cursive, serif',
        })[k] || 'sans-serif';
    }
    async function loadSavedFonts() {
        try {
            for (const rec of await dbAll('fonts')) {
                try {
                    const ff = new FontFace(rec.name, rec.buf);
                    await ff.load(); document.fonts.add(ff);
                    if (!importedFonts.includes(rec.name)) importedFonts.push(rec.name);
                } catch (e) { console.warn('[CutoutPoster] font load failed', rec.name, e); }
            }
        } catch (e) { /* IndexedDB 不可用时忽略 */ }
    }

    /* ---------- 图形路径 ---------- */
    function pathShape(c, shape, cx, cy, w, h) {
        const x = cx - w / 2, y = cy - h / 2;
        c.beginPath();
        switch (shape) {
            case 'circle': case 'ellipse':
                c.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); break;
            case 'diamond':
                c.moveTo(cx, y); c.lineTo(x + w, cy); c.lineTo(cx, y + h); c.lineTo(x, cy); c.closePath(); break;
            case 'triangle':
                c.moveTo(cx, y); c.lineTo(x + w, y + h); c.lineTo(x, y + h); c.closePath(); break;
            case 'star': {
                const R = w / 2, r = R * 0.45;
                for (let i = 0; i < 10; i++) {
                    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R;
                    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * (h / w);
                    i ? c.lineTo(px, py) : c.moveTo(px, py);
                }
                c.closePath(); break;
            }
            case 'heart':
                c.moveTo(cx, y + h * 0.95);
                c.bezierCurveTo(x - w * 0.1, y + h * 0.55, x + w * 0.05, y - h * 0.05, cx, y + h * 0.28);
                c.bezierCurveTo(x + w * 0.95, y - h * 0.05, x + w * 1.1, y + h * 0.55, cx, y + h * 0.95);
                c.closePath(); break;
            default: c.rect(x, y, w, h);
        }
    }

    /* ---------- 运行时状态 ---------- */
    const S = {
        text: '', img: null, imgId: 0, hits: [], geo: null,
        cut: { holes: [] }, slots: new Set(), keep: null, cells: null,
        drag: null, undo: [], ctls: {},
    };
    const TEMPLATES = {};
    const imgW = im => im.naturalWidth || im.width;
    const imgH = im => im.naturalHeight || im.height;

    function makePlaceholder() {
        const cv = document.createElement('canvas');
        cv.width = 1200; cv.height = 800;
        const c = cv.getContext('2d');
        const g = c.createLinearGradient(0, 0, 1200, 800);
        g.addColorStop(0, '#6ea8e8'); g.addColorStop(1, '#2d6a4f');
        c.fillStyle = g; c.fillRect(0, 0, 1200, 800);
        const rng = mulberry32(42);
        for (let i = 0; i < 90; i++) {
            c.fillStyle = `hsl(${Math.floor(rng() * 360)},75%,60%)`;
            c.beginPath();
            c.ellipse(rng() * 1200, rng() * 800, 10 + rng() * 26, 6 + rng() * 14, rng() * 3, 0, Math.PI * 2);
            c.fill();
        }
        return cv;
    }

    /* =====================================================
     * 模板 1：挖洞置换（全手动）
     * ===================================================== */
    // 洞只存中心点；大小/形状是全局参数，拖滑杆时所有洞实时变化
    function holeGeom(P, h, IW, IH) {
        const w = (h.size || P.size) / 100;
        const aspect = h.aspect || P.aspect;
        const hp = ((P.shape === 'rect' || P.shape === 'ellipse') ? (IW * w) / Math.max(0.2, aspect) : IW * w) / IH;
        return {
            cx: clamp(h.cx, w / 2, 1 - w / 2),
            cy: clamp(h.cy, Math.min(hp / 2, 0.5), Math.max(1 - hp / 2, 0.5)),
            w, h: hp,
        };
    }
    function drawFrag(c, P, g, dcx, dcy, dw, dh) {
        const img = S.img;
        c.save();
        pathShape(c, P.shape, dcx, dcy, dw, dh);
        c.clip();
        c.drawImage(img, (g.cx - g.w / 2) * imgW(img), (g.cy - g.h / 2) * imgH(img), g.w * imgW(img), g.h * imgH(img),
            dcx - dw / 2, dcy - dh / 2, dw, dh);
        c.restore();
        if (P.border) {
            pathShape(c, P.shape, dcx, dcy, dw, dh);
            c.lineWidth = 2; c.strokeStyle = P.fg; c.stroke();
        }
    }
    const cutout = {
        id: 'cutout',
        name: '挖洞置换',
        hint(P) {
            return P.layout === 'slots'
                ? '点图片：挖洞（再点取消）。点文字：在那里放一个槽位（再点取消）。槽位按文字顺序，依次装入先挖的洞。'
                : '点图片挖洞；下方碎片可拖动。先点选一块碎片，再用“当前碎片单独大小”调整它的尺寸。';
        },
        defaults: {
            layout: 'below', gran: 'char', shape: 'square', size: 12, aspect: 1.5, lowerPct: 100,
            bg: '#f1efe6', fg: '#222222', border: false, fontSize: 3.4, font: 'theme', individualSize: 12,
        },
        controls: [
            { group: '版面', key: 'layout', label: '碎片落点', type: 'select', options: [['below', '下方散落'], ['slots', '文字槽位']] },
            { group: '版面', key: 'gran', label: '文字点选单位', type: 'select', options: [['char', '逐字'], ['word', '按词']], show: P => P.layout === 'slots', onChange() { S.slots = new Set(); } },
            { group: '版面', key: 'lowerPct', label: '下方区域高度 %', type: 'range', min: 40, max: 160, step: 5, show: P => P.layout === 'below' },
            { group: '形状', key: 'shape', label: '洞的形状', type: 'select', options: [['square', '方形'], ['circle', '圆形'], ['rect', '长方形'], ['ellipse', '椭圆'], ['diamond', '菱形'], ['triangle', '三角'], ['star', '星形'], ['heart', '爱心']] },
            { group: '形状', key: 'size', label: '新碎片默认大小 %', type: 'range', min: 3, max: 40, step: 1 },
            { group: '形状', key: 'individualSize', label: '当前碎片单独大小 %', type: 'range', min: 3, max: 60, step: 1, onChange(v) { const h = S.cut.holes[S.selectedHole]; if (h) h.size = v; } },
            { group: '形状', key: 'aspect', label: '长宽比(长方形/椭圆)', type: 'range', min: 0.4, max: 3, step: 0.1 },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.5, max: 6, step: 0.1, show: P => P.layout === 'slots' },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS, show: P => P.layout === 'slots' },
            { group: '颜色', key: 'bg', label: '底色/洞色', type: 'color' },
            { group: '颜色', key: 'fg', label: '文字/描边色', type: 'color' },
            { group: '颜色', key: 'border', label: '碎片描边', type: 'checkbox' },
        ],
        snap() { return JSON.stringify({ h: S.cut.holes, s: [...S.slots] }); },
        restore(str) { const d = JSON.parse(str); S.cut.holes = d.h; S.slots = new Set(d.s); },
        clear() { S.cut.holes = []; S.slots = new Set(); },
        render(cv, c, P) {
            const img = S.img, holes = S.cut.holes;
            const W = 1200, IW = W, IH = Math.round(W * imgH(img) / imgW(img));
            const G = holes.map(h => holeGeom(P, h, IW, IH));
            if (P.layout === 'slots') return renderSlots(cv, c, P, W, IW, IH, holes, G);
            const lowerH = Math.round(IH * P.lowerPct / 100);
            cv.width = W; cv.height = IH + lowerH;
            c.fillStyle = P.bg; c.fillRect(0, 0, cv.width, cv.height);
            c.drawImage(img, 0, 0, IW, IH);
            S.geo = { x: 0, y: 0, w: IW, h: IH };
            G.forEach(g => { pathShape(c, P.shape, g.cx * IW, g.cy * IH, g.w * IW, g.h * IH); c.fillStyle = P.bg; c.fill(); });
            G.forEach((g, i) => {
                const dw = g.w * IW, dh = g.h * IH;
                const dx = g.cx * IW + (holes[i].ox || 0), dy = IH + g.cy * lowerH + (holes[i].oy || 0);
                drawFrag(c, P, g, dx, dy, dw, dh);
                S.hits.push({ kind: 'frag', i, x: dx - dw / 2, y: dy - dh / 2, w: dw, h: dh });
            });
        },
        onDown(x, y, P) {
            const inside = h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
            for (let k = S.hits.length - 1; k >= 0; k--) {
                const h = S.hits[k];
                if (h.kind === 'frag' && inside(h)) {
                    const ho = S.cut.holes[h.i];
                    S.selectedHole = h.i; P.individualSize = ho.size || P.size; if (S.ctls.individualSize) S.ctls.individualSize.value = P.individualSize;
                    S.drag = { i: h.i, sx: x, sy: y, ox: ho.ox || 0, oy: ho.oy || 0 };
                    return true;
                }
            }
            if (P.layout === 'slots') {
                const t = S.hits.find(h => (h.kind === 'sslot' || h.kind === 'stok') && inside(h));
                if (t) { S.slots.has(t.i) ? S.slots.delete(t.i) : S.slots.add(t.i); return true; }
            }
            const g = S.geo;
            if (!g || x < g.x || x > g.x + g.w || y < g.y || y > g.y + g.h) return false;
            const fx = (x - g.x) / g.w, fy = (y - g.y) / g.h;
            const holes = S.cut.holes;
            const hit = holes.findIndex(h => {
                const q = holeGeom(P, h, g.w, g.h);
                return Math.abs(fx - q.cx) <= q.w / 2 && Math.abs(fy - q.cy) <= q.h / 2;
            });
            if (hit >= 0) { S.selectedHole = hit; P.individualSize = holes[hit].size || P.size; if (S.ctls.individualSize) S.ctls.individualSize.value = P.individualSize; holes.splice(hit, 1); }
            else { const n = holes.length; holes.push({ cx: fx, cy: fy, ox: 0, oy: 0, size: P.size, aspect: P.aspect }); S.selectedHole = n; P.individualSize = P.size; if (S.ctls.individualSize) S.ctls.individualSize.value = P.size; }
            return true;
        },
        onMove(x, y) {
            if (!S.drag || S.drag.i === undefined) return false;
            const ho = S.cut.holes[S.drag.i];
            if (!ho) return false;
            ho.ox = S.drag.ox + (x - S.drag.sx);
            ho.oy = S.drag.oy + (y - S.drag.sy);
            return true;
        },
        onUp() { S.drag = null; },
    };

    function renderSlots(cv, c, P, W, IW, IH, holes, G) {
        const fs = Math.round(W * P.fontSize / 100);
        const fam = fontFamily(P.font);
        mctx.font = `${fs}px ${fam}`;
        const base = tokenize((S.text || '').trim() || SAMPLE, P.gran);
        const toks = [];
        base.forEach((t, i) => {
            toks.push(Object.assign({}, t, { ti: i }));
            if (!t.slot && !t.nl && S.slots.has(i)) toks.push({ t: '{ }', slot: true, sp: true, ti: -1, after: i });
        });
        const spaceW = mctx.measureText(' ').width;
        let slotI = 0;
        const items = toks.map(tk => {
            if (tk.nl) return { nl: true, w: 0 };
            if (tk.slot) {
                const i = slotI++, g = G[i];
                let fh = fs * 2.4, fw = g ? fh * (g.w * IW) / (g.h * IH) : fh * 1.4;
                const cap = W * 0.28;
                if (fw > cap) { fw = cap; fh = g ? fw * (g.h * IH) / (g.w * IW) : fw / 1.4; }
                return { slot: true, i, fw, fh, after: tk.after, w: fw + fs * 0.5 + spaceW };
            }
            return { t: tk.t, ti: tk.ti, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) };
        });
        const lines = wrap(items, W * 0.84);
        lines.forEach(l => {
            const mf = Math.max(0, ...l.items.filter(i => i.slot).map(i => i.fh));
            l.lh = Math.max(fs * 1.9, mf ? mf + fs * 0.6 : 0);
        });
        const pad = fs * 2.5;
        const textH = Math.round(pad * 2 + lines.reduce((s, l) => s + l.lh, 0));
        cv.width = W; cv.height = textH + IH;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, cv.height);
        c.drawImage(S.img, 0, textH, IW, IH);
        S.geo = { x: 0, y: textH, w: IW, h: IH };
        G.forEach(g => { pathShape(c, P.shape, g.cx * IW, textH + g.cy * IH, g.w * IW, g.h * IH); c.fillStyle = P.bg; c.fill(); });
        c.font = `${fs}px ${fam}`; c.textBaseline = 'middle'; c.textAlign = 'left';
        let y = pad;
        lines.forEach(l => {
            let x = (W - l.w) / 2;
            const cy = y + l.lh / 2;
            l.items.forEach(it => {
                if (it.nl) return;
                if (it.slot) {
                    const fx = x, g = G[it.i];
                    if (g) drawFrag(c, P, g, fx + it.fw / 2, cy, it.fw, it.fh);
                    else {
                        c.save(); c.setLineDash([6, 5]); c.strokeStyle = P.fg;
                        c.strokeRect(fx, cy - it.fh / 2, it.fw, it.fh); c.restore();
                    }
                    if (it.after !== undefined) S.hits.push({ kind: 'sslot', i: it.after, x, y, w: it.w, h: l.lh });
                } else {
                    c.fillStyle = P.fg; c.fillText(it.t, x, cy);
                    S.hits.push({ kind: 'stok', i: it.ti, x, y, w: it.w, h: l.lh });
                }
                x += it.w;
            });
            y += l.lh;
        });
    }

    /* ---------- 通用：点选 / 拖动连选 ---------- */
    function paintDown(kind, set, x, y) {
        const h = S.hits.find(h => h.kind === kind && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
        if (!h) return false;
        const val = !set.has(h.i);
        val ? set.add(h.i) : set.delete(h.i);
        S.drag = { paint: true, val, kind, set };
        return true;
    }
    function paintMove(x, y) {
        const d = S.drag;
        if (!d || !d.paint) return false;
        const h = S.hits.find(h => h.kind === d.kind && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
        if (!h || d.set.has(h.i) === d.val) return false;
        d.val ? d.set.add(h.i) : d.set.delete(h.i);
        return true;
    }

    /* =====================================================
     * 模板 2：涂黑诗
     * ===================================================== */
    const blackout = {
        id: 'blackout',
        name: '涂黑诗',
        hint: '整段先全部涂黑。点词语：留下/再涂黑；手指划过可连选。',
        defaults: { gran: 'char', fontSize: 3.6, font: 'theme', paper: '#f4efdc', ink: '#111111' },
        controls: [
            { group: '点选', key: 'gran', label: '点选单位', type: 'select', options: [['char', '逐字'], ['word', '按词(中文自动分词)']], onChange() { S.keep = null; } },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.8, max: 7, step: 0.1 },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '颜色', key: 'paper', label: '纸色', type: 'color' },
            { group: '颜色', key: 'ink', label: '墨色', type: 'color' },
        ],
        snap() { return JSON.stringify([...(S.keep ? S.keep.set : [])]); },
        restore(str) { S.keep = { set: new Set(JSON.parse(str)) }; },
        clear() { S.keep = { set: new Set() }; },
        render(cv, c, P) {
            S.keep ??= { set: new Set() };
            const W = 1000, M = 80;
            const fs = Math.round(W * P.fontSize / 100), fam = fontFamily(P.font);
            mctx.font = `${fs}px ${fam}`;
            const toks = tokenize((S.text || '').trim() || SAMPLE, P.gran);
            const spaceW = mctx.measureText(' ').width;
            const items = toks.map((tk, i) => tk.nl ? { nl: true, w: 0 } : { i, t: tk.t, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) });
            const lines = wrap(items, W - M * 2);
            const lh = fs * 1.7;
            const blockW = Math.max(1, ...lines.map(l => l.w));
            cv.width = W; cv.height = Math.round(M * 2 + lines.length * lh);
            c.fillStyle = P.paper; c.fillRect(0, 0, W, cv.height);
            c.font = `${fs}px ${fam}`; c.textBaseline = 'middle';
            let y = M;
            for (const l of lines) {
                const real = l.items.filter(it => !it.nl);
                if (real.length) {
                    c.fillStyle = P.ink; c.fillRect(M, y, blockW, lh);        // 整行连续的黑块
                    let x = M;
                    const pos = real.map(it => { const p = { it, x }; x += it.w; return p; });
                    let a = 0;
                    while (a < pos.length) {
                        const kept = S.keep.set.has(pos[a].it.i);
                        let b = a;
                        while (b + 1 < pos.length && S.keep.set.has(pos[b + 1].it.i) === kept) b++;
                        if (kept) {                                             // 连续保留的字连成一块白底，中间没有线
                            const x0 = pos[a].x, x1 = pos[b].x + pos[b].it.w;
                            c.fillStyle = P.paper; c.fillRect(x0, y + lh * 0.1, x1 - x0, lh * 0.8);
                            c.fillStyle = P.ink;
                            for (let k = a; k <= b; k++) c.fillText(pos[k].it.t, pos[k].x, y + lh / 2);
                        }
                        a = b + 1;
                    }
                    pos.forEach(p => S.hits.push({ kind: 'tok', i: p.it.i, x: p.x, y, w: p.it.w, h: lh }));
                }
                y += lh;
            }
        },
        onDown(x, y) { S.keep ??= { set: new Set() }; return paintDown('tok', S.keep.set, x, y); },
        onMove: paintMove,
        onUp() { S.drag = null; },
    };

    /* =====================================================
     * 模板 3：验证码九宫格
     * ===================================================== */
    const captcha = {
        id: 'captcha',
        name: '验证码九宫格',
        hint: '点格子：选中/取消；手指划过可连选。标题留空则取选中的文字。',
        defaults: { cols: 4, rows: 4, gap: 8, title: '', sub: 'If there are none, click skip', blue: '#2f77e8' },
        controls: [
            { group: '文字', key: 'title', label: '大标题(留空=选中文字)', type: 'text' },
            { group: '文字', key: 'sub', label: '副标题', type: 'text' },
            { group: '网格', key: 'cols', label: '列数', type: 'range', min: 2, max: 8, step: 1, onChange() { S.cells = null; } },
            { group: '网格', key: 'rows', label: '行数', type: 'range', min: 2, max: 8, step: 1, onChange() { S.cells = null; } },
            { group: '网格', key: 'gap', label: '格间距', type: 'range', min: 0, max: 20, step: 1 },
            { group: '颜色', key: 'blue', label: '主色', type: 'color' },
        ],
        snap() { return JSON.stringify([...(S.cells ? S.cells.set : [])]); },
        restore(str) { S.cells = { set: new Set(JSON.parse(str)) }; },
        clear() { S.cells = { set: new Set() }; },
        render(cv, c, P) {
            S.cells ??= { set: new Set() };
            const img = S.img, W = 1000, pad = 40, gap = P.gap, cols = P.cols, rows = P.rows;
            const gw = W - pad * 2, cw = (gw - gap * (cols - 1)) / cols, gh = rows * cw + gap * (rows - 1);
            const headH = 280, footH = 170, y0 = pad + headH + gap, footY = y0 + gh + gap;
            cv.width = W; cv.height = Math.round(footY + footH);
            c.fillStyle = '#f2f2f2'; c.fillRect(0, 0, W, cv.height);
            c.fillStyle = P.blue; c.fillRect(pad, pad, gw, headH);
            c.fillStyle = '#fff'; c.textBaseline = 'alphabetic'; c.textAlign = 'left';
            c.font = '34px Roboto, Arial, sans-serif';
            c.fillText('Select all squares with', pad + 30, pad + 70);
            const title = ((P.title || S.text || 'a human').trim().replace(/\s+/g, ' ')).slice(0, 40);
            let tfs = 100;
            do { c.font = `bold ${tfs}px Roboto, Arial, sans-serif`; tfs -= 4; } while (c.measureText(title).width > gw - 60 && tfs > 24);
            c.fillText(title, pad + 30, pad + 170);
            c.font = '32px Roboto, Arial, sans-serif';
            c.fillText(P.sub, pad + 30, pad + 232);
            const s = Math.max(gw / imgW(img), gh / imgH(img));
            const sx0 = (imgW(img) - gw / s) / 2, sy0 = (imgH(img) - gh / s) / 2;
            for (let r = 0; r < rows; r++) {
                for (let k = 0; k < cols; k++) {
                    const dx = pad + k * (cw + gap), dy = y0 + r * (cw + gap), idx = r * cols + k;
                    const sel = S.cells.set.has(idx);
                    const sc = sel ? 0.84 : 1, dw = cw * sc, off = (cw - dw) / 2;
                    c.drawImage(img, sx0 + (dx - pad) / s, sy0 + (dy - y0) / s, cw / s, cw / s, dx + off, dy + off, dw, dw);
                    if (sel) {
                        const bx = dx + 6, by = dy + 6;
                        c.fillStyle = P.blue; c.beginPath(); c.arc(bx + 20, by + 20, 22, 0, Math.PI * 2); c.fill();
                        c.strokeStyle = '#fff'; c.lineWidth = 5; c.lineCap = 'round'; c.lineJoin = 'round';
                        c.beginPath(); c.moveTo(bx + 10, by + 21); c.lineTo(bx + 18, by + 29); c.lineTo(bx + 31, by + 12); c.stroke();
                    }
                    S.hits.push({ kind: 'cell', i: idx, x: dx, y: dy, w: cw, h: cw });
                }
            }
            const cy = footY + footH / 2 + 4;
            c.strokeStyle = '#666'; c.lineWidth = 7; c.lineCap = 'round';
            c.beginPath(); c.arc(pad + 55, cy, 26, 0.5, Math.PI * 1.75); c.stroke();
            c.beginPath(); c.moveTo(pad + 80, cy - 36); c.lineTo(pad + 80, cy - 14); c.lineTo(pad + 62, cy - 14); c.closePath(); c.fillStyle = '#666'; c.fill();
            const hx = pad + 160;
            c.beginPath(); c.arc(hx, cy + 4, 28, Math.PI, 0); c.stroke();
            c.fillRect(hx - 36, cy + 2, 14, 30); c.fillRect(hx + 22, cy + 2, 14, 30);
            const ix = pad + 270;
            c.beginPath(); c.arc(ix, cy, 32, 0, Math.PI * 2); c.stroke();
            c.fillStyle = '#666'; c.font = 'bold 40px Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
            c.fillText('i', ix, cy + 2);
            const bw = 280, bh = 100, bx = W - pad - bw, by = footY + (footH - bh) / 2;
            c.fillStyle = P.blue; c.fillRect(bx, by, bw, bh);
            c.fillStyle = '#fff'; c.font = 'bold 40px Roboto, Arial, sans-serif';
            c.fillText(S.cells.set.size ? 'VERIFY' : 'SKIP', bx + bw / 2, by + bh / 2 + 2);
            c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        },
        onDown(x, y) { S.cells ??= { set: new Set() }; return paintDown('cell', S.cells.set, x, y); },
        onMove: paintMove,
        onUp() { S.drag = null; },
    };


    /* =====================================================
     * 额外模板：根据参考图扩展的六种版式
     * ===================================================== */
    const extraTemplates = [
        {
            id: 'river', name: '河流文字排版',
            hint: '文字沿着蜿蜒的河道重复延伸；可调整重复密度、颜色与留白。',
            defaults: { bg:'#17251f', fg:'#f1dfbd', fontSize:22, repeat:7, margin:55 },
            controls: [
                {group:'排版',key:'repeat',label:'文字重复密度',type:'range',min:2,max:14,step:1},
                {group:'排版',key:'fontSize',label:'文字大小',type:'range',min:12,max:34,step:1},
                {group:'排版',key:'margin',label:'边距',type:'range',min:20,max:120,step:5},
                {group:'颜色',key:'bg',label:'底色',type:'color'},
                {group:'颜色',key:'fg',label:'文字色',type:'color'}
            ],
            render(cv,c,P) {
                const W=1100,H=1250; cv.width=W;cv.height=H;
                c.fillStyle=P.bg;c.fillRect(0,0,W,H);
                c.globalAlpha=.26;c.drawImage(S.img,0,0,W,H);c.globalAlpha=1;
                c.fillStyle=P.fg;c.font=`bold ${P.fontSize}px Arial`;c.textBaseline='middle';
                const phrase=(S.text||SAMPLE).replace(/\s+/g,' ').trim()+' ';
                const lines=Math.ceil(H/(P.fontSize*1.42));
                for(let r=0;r<lines;r++){
                    const y=80+r*P.fontSize*1.42;
                    const wave=Math.sin(r*.22)*190+Math.sin(r*.075)*90;
                    const start=Math.max(P.margin, W*.52+wave);
                    const count=Math.ceil((W-start-P.margin)/(P.fontSize*0.55));
                    const text=(phrase.repeat(P.repeat)).slice(0,Math.max(0,count*3));
                    c.fillText(text,start,y);
                }
                c.save();c.globalCompositeOperation='destination-out';
                c.beginPath();c.moveTo(0,0);c.bezierCurveTo(270,180,850,170,620,370);
                c.bezierCurveTo(400,540,970,650,720,820);c.bezierCurveTo(550,1010,250,1020,0,1250);
                c.lineWidth=105;c.strokeStyle='#000';c.lineCap='round';c.stroke();c.restore();
                c.save();c.globalAlpha=.95;c.strokeStyle=P.fg;c.lineWidth=5;c.beginPath();
                c.moveTo(0,0);c.bezierCurveTo(270,180,850,170,620,370);
                c.bezierCurveTo(400,540,970,650,720,820);c.bezierCurveTo(550,1010,250,1020,0,1250);c.stroke();c.restore();
            }
        },
        {
            id:'pixeltiles',name:'像素碎片拼贴',
            hint:'上方保留完整照片，下方以不同大小的像素方块重新拼贴；点击画面可切换方块位置。',
            defaults:{bg:'#f3f0e7',cols:9,tiles:22,block:68},
            controls:[
                {group:'碎片',key:'tiles',label:'碎片数量',type:'range',min:6,max:45,step:1},
                {group:'碎片',key:'block',label:'基础方块大小',type:'range',min:28,max:130,step:2},
                {group:'碎片',key:'cols',label:'像素密度',type:'range',min:5,max:16,step:1},
                {group:'颜色',key:'bg',label:'留白颜色',type:'color'}
            ],
            render(cv,c,P){
                const W=1100,H=1450,top=690;cv.width=W;cv.height=H;c.fillStyle=P.bg;c.fillRect(0,0,W,H);
                c.drawImage(S.img,0,0,W,top);
                const rng=mulberry32(913+P.tiles+P.cols), cell=W/P.cols;
                for(let i=0;i<P.tiles;i++){
                    const sx=rng()*Math.max(1,imgW(S.img)-cell),sy=rng()*Math.max(1,imgH(S.img)-cell);
                    const size=P.block*(.42+rng()*1.05),dx=rng()*(W-size),dy=top+60+rng()*(H-top-size-70);
                    c.drawImage(S.img,sx,sy,cell,cell,dx,dy,size,size);
                }
            }
        },
        {
            id:'circles',name:'圆形记忆档案',
            hint:'上半部聚合圆形照片碎片，下半部铺开完整照片并留下圆形空位。',
            defaults:{bg:'#f5e9d9',count:34,diameter:58,lower:15},
            controls:[
                {group:'圆形碎片',key:'count',label:'圆形数量',type:'range',min:12,max:55,step:1},
                {group:'圆形碎片',key:'diameter',label:'圆形基础直径',type:'range',min:28,max:100,step:2},
                {group:'版面',key:'lower',label:'下方留白比例',type:'range',min:0,max:35,step:1},
                {group:'颜色',key:'bg',label:'纸张颜色',type:'color'}
            ],
            render(cv,c,P){
                const W=1100,H=1500,band=650;cv.width=W;cv.height=H;c.fillStyle=P.bg;c.fillRect(0,0,W,band);
                const rng=mulberry32(128+P.count);
                for(let i=0;i<P.count;i++){
                    const d=P.diameter*(.55+rng()*.8),x=60+rng()*(W-120),y=55+rng()*(band-110);
                    c.save();c.beginPath();c.arc(x,y,d/2,0,Math.PI*2);c.clip();
                    const sx=rng()*imgW(S.img),sy=rng()*imgH(S.img);
                    c.drawImage(S.img,sx,sy,Math.min(d,imgW(S.img)-sx),Math.min(d,imgH(S.img)-sy),x-d/2,y-d/2,d,d);c.restore();
                    c.strokeStyle='#554b3e';c.lineWidth=2;c.beginPath();c.arc(x,y,d/2,0,Math.PI*2);c.stroke();
                }
                const lowerY=band+P.lower*5;c.drawImage(S.img,0,lowerY,W,H-lowerY);
                c.fillStyle=P.bg;
                for(let i=0;i<12;i++){const x=80+rng()*(W-160),y=lowerY+40+rng()*(H-lowerY-80),d=36+rng()*36;c.beginPath();c.arc(x,y,d/2,0,Math.PI*2);c.fill();}
                c.fillStyle='#211b17';c.font='italic 42px Georgia';c.textAlign='center';
                const words=(S.text||'existem coisas para lamentar').split(/\s+/).slice(0,8).join(' ');
                c.fillText(words,W/2,band-28);
            }
        },
        {
            id:'editorial',name:'编辑部时间轴',
            hint:'左侧为照片，右侧为阶梯式时间轴；文字内容自动拆分为条目。',
            defaults:{bg:'#c9c9c5',fg:'#111111',title:'THE FUTURE IS OURS',fontSize:24},
            controls:[
                {group:'文字',key:'title',label:'主标题',type:'text'},
                {group:'文字',key:'fontSize',label:'条目字号',type:'range',min:14,max:34,step:1},
                {group:'颜色',key:'bg',label:'右侧底色',type:'color'},
                {group:'颜色',key:'fg',label:'文字色',type:'color'}
            ],
            render(cv,c,P){
                const W=1200,H=900,left=570;cv.width=W;cv.height=H;c.fillStyle=P.bg;c.fillRect(0,0,W,H);
                c.drawImage(S.img,0,0,left,H);
                c.fillStyle=P.fg;c.textAlign='left';c.font='900 42px Arial';c.fillText(P.title,610,75);
                const entries=(S.text||'CONCEPT PHOTO #1\\nCONCEPT PHOTO #2\\nSTORY FILM #1\\nALBUM PREVIEW\\nM/V TEASER\\nRELEASE').split(/\n|[;；]/).filter(Boolean);
                const n=Math.min(entries.length,12);
                for(let i=0;i<n;i++){
                    const y=150+i*58,x=600+(i%3)*26;
                    c.fillStyle='#e7e7e3';c.fillRect(x,y-27,Math.min(570,W-x-24),42);
                    c.fillStyle=P.fg;c.font=`bold ${P.fontSize}px Arial`;
                    c.fillText(`${String(i+1).padStart(2,'0')}   ${entries[i].trim().slice(0,42)}`,x+18,y+2);
                }
                c.textAlign='right';c.font='bold 82px Arial';c.fillText('LOST',W-35,H-35);
            }
        },
        {
            id:'archive',name:'档案研究展板',
            hint:'白纸档案式构图：中央展示主图，四周分布编号、说明和局部细节。',
            defaults:{bg:'#f7f6f1',fg:'#211f1b',fontSize:18,notes:8},
            controls:[
                {group:'版面',key:'notes',label:'档案标注数量',type:'range',min:3,max:14,step:1},
                {group:'文字',key:'fontSize',label:'说明字号',type:'range',min:12,max:26,step:1},
                {group:'颜色',key:'bg',label:'纸色',type:'color'},
                {group:'颜色',key:'fg',label:'文字色',type:'color'}
            ],
            render(cv,c,P){
                const W=1200,H=900;cv.width=W;cv.height=H;c.fillStyle=P.bg;c.fillRect(0,0,W,H);
                c.fillStyle=P.fg;c.font='italic 18px Georgia';c.fillText('DESIGN AND RESEARCH',42,42);
                c.drawImage(S.img,340,90,560,610);
                c.strokeStyle=P.fg;c.lineWidth=1;c.strokeRect(340,90,560,610);
                const notes=(S.text||SAMPLE).split(/\s+/);
                c.font=`${P.fontSize}px Georgia`;c.textAlign='left';
                for(let i=0;i<P.notes;i++){
                    const x=i%2?930:45,y=125+Math.floor(i/2)*145;
                    c.fillText(`${String(i+1).padStart(2,'0')}.`,x,y);
                    const line=notes.slice(i*4,i*4+4).join(' ').slice(0,48)||'Reference detail';
                    c.fillText(line,x,y+30);
                    c.beginPath();c.moveTo(x,y+42);c.lineTo(x+210,y+42);c.stroke();
                }
                c.font='italic 15px Georgia';c.fillText('FIELD NOTES  /  VISUAL INDEX',45,H-35);
            }
        },
        {
            id:'network',name:'人物关系网络',
            hint:'将照片中的人物位置抽象为节点与连线，下方形成故事关系网络。',
            defaults:{bg:'#145bdc',fg:'#ffffff',nodes:42,labels:7},
            controls:[
                {group:'网络',key:'nodes',label:'节点数量',type:'range',min:12,max:75,step:1},
                {group:'网络',key:'labels',label:'文字标签数量',type:'range',min:2,max:12,step:1},
                {group:'颜色',key:'bg',label:'网络底色',type:'color'},
                {group:'颜色',key:'fg',label:'文字色',type:'color'}
            ],
            render(cv,c,P){
                const W=1100,H=1300,top=620;cv.width=W;cv.height=H;
                c.drawImage(S.img,0,0,W,top);c.fillStyle=P.bg;c.fillRect(0,top,W,H-top);
                const rng=mulberry32(440+P.nodes),pts=[];
                for(let i=0;i<P.nodes;i++)pts.push({x:35+rng()*(W-70),y:top+45+rng()*(H-top-90)});
                c.strokeStyle='rgba(255,255,255,.6)';c.lineWidth=1.5;
                pts.forEach((p,i)=>{for(let j=i+1;j<Math.min(i+4,pts.length);j++){if(rng()>.35){c.beginPath();c.moveTo(p.x,p.y);c.lineTo(pts[j].x,pts[j].y);c.stroke();}}});
                pts.forEach((p,i)=>{
                    const d=16+rng()*22,sx=rng()*imgW(S.img),sy=rng()*imgH(S.img);
                    c.drawImage(S.img,sx,sy,Math.min(50,imgW(S.img)-sx),Math.min(50,imgH(S.img)-sy),p.x-d/2,p.y-d/2,d,d);
                    c.strokeStyle=P.fg;c.strokeRect(p.x-d/2,p.y-d/2,d,d);
                });
                c.fillStyle=P.fg;c.font='22px Arial';
                const words=(S.text||'just crossing paths in each other stories').split(/\s+/);
                for(let i=0;i<P.labels;i++)c.fillText(`(${i+1}) ${words[i]||'stories'}`,50+(i%4)*260,top+70+Math.floor(i/4)*125);
            }
        },
        {
            id:'skytiles',name:'天空图像嵌字',
            hint:'把小图像切片嵌入句子中，再以散落的图像碎片填充下方画面。',
            defaults:{bg:'#e9e9e9',fg:'#171717',fontSize:29,tiles:7},
            controls:[
                {group:'文字',key:'fontSize',label:'句子字号',type:'range',min:18,max:42,step:1},
                {group:'碎片',key:'tiles',label:'图像切片数量',type:'range',min:3,max:12,step:1},
                {group:'颜色',key:'bg',label:'底色',type:'color'},
                {group:'颜色',key:'fg',label:'文字色',type:'color'}
            ],
            render(cv,c,P){
                const W=1100,H=1300,top=560;cv.width=W;cv.height=H;c.fillStyle=P.bg;c.fillRect(0,0,W,H);
                const words=(S.text||SAMPLE).split(/\s+/),line1=words.slice(0,6),line2=words.slice(6,12);
                c.fillStyle=P.fg;c.font=`${P.fontSize}px Arial`;c.textBaseline='middle';
                const drawLine=(arr,y)=>{
                    let x=70;
                    arr.forEach((w,i)=>{
                        c.fillText(w,x,y);x+=c.measureText(w+' ').width;
                        if(i<P.tiles && x<W-150){
                            const d=42+(i%3)*9,sx=(i*131)%Math.max(1,imgW(S.img)-d),sy=(i*79)%Math.max(1,imgH(S.img)-d);
                            c.drawImage(S.img,sx,sy,d,d,x,y-d/2,d,d);x+=d+10;
                        }
                    });
                };
                drawLine(line1,150);drawLine(line2,250);
                c.drawImage(S.img,0,top,W,H-top);
                const rng=mulberry32(77+P.tiles);
                for(let i=0;i<P.tiles;i++){
                    const d=45+rng()*100,sx=rng()*Math.max(1,imgW(S.img)-d),sy=rng()*Math.max(1,imgH(S.img)-d);
                    const dx=rng()*(W-d),dy=top+rng()*(H-top-d);
                    c.fillStyle=P.bg;c.fillRect(dx-5,dy-5,d+10,d+10);
                    c.drawImage(S.img,sx,sy,d,d,dx,dy,d,d);
                }
            }
        }
    ];

    /* ---------- 模板注册 ---------- */
    function register(t) {
        TEMPLATES[t.id] = t;
        if (overlay) refreshTplSelect();
    }
    [cutout, blackout, captcha, ...extraTemplates].forEach(t => TEMPLATES[t.id] = t);
    window.CutoutPoster = {
        register, templates: TEMPLATES,
        util: { S, pathShape, tokenize, wrap, fontFamily, mulberry32, clamp, paintDown, paintMove },
    };

    async function runSavedTemplates() {
        try {
            for (const rec of await dbAll('tpls')) {
                try { new Function('CutoutPoster', rec.code)(window.CutoutPoster); }
                catch (e) { console.warn('[CutoutPoster] template failed', rec.name, e); }
            }
        } catch (e) { /* ignore */ }
    }

    /* =====================================================
     * 图片加载
     * ===================================================== */
    async function loadImage(src) {
        let url = src;
        try {
            if (!/^(blob:|data:)/.test(src)) {
                const r = await fetch(src);
                if (r.ok) url = URL.createObjectURL(await r.blob());
            }
        } catch (e) { /* 回退直接加载 */ }
        return new Promise((res, rej) => {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = () => res(im);
            im.onerror = () => rej(new Error('图片加载失败'));
            im.src = url;
        });
    }
    function setImage(im) { S.img = im; S.imgId++; }

    /* =====================================================
     * 面板
     * ===================================================== */
    let overlay = null, cv = null, c2d = null, rafPending = false;
    const fontLoading = new Set();
    const $ = sel => overlay.querySelector(sel);

    function curTpl() { return TEMPLATES[getSettings().template] || TEMPLATES.cutout; }
    function params() {
        const st = getSettings(), tpl = curTpl();
        st.params[tpl.id] = Object.assign({}, tpl.defaults, st.params[tpl.id]);
        return st.params[tpl.id];
    }
    function scheduleRender() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; render(); });
    }
    function render() {
        if (!overlay) return;
        const tpl = curTpl(), P = params();
        if (!S.img) setImage(makePlaceholder());
        if (P.font) {
            const fam = fontFamily(P.font);
            if (!fontLoading.has(fam)) {
                fontLoading.add(fam);
                document.fonts.load(`20px ${fam}`).then(() => scheduleRender()).catch(() => {});
            }
        }
        S.hits = [];
        try { tpl.render(cv, c2d, P); }
        catch (e) { console.error('[CutoutPoster] render error', e); toast('渲染出错，详见控制台'); }
        const hint = typeof tpl.hint === 'function' ? tpl.hint(P) : tpl.hint;
        $('#cp_hint').textContent = hint || '';
        updateVisibility();
    }
    const ui = {
        setParam(key, val) {
            params()[key] = val; saveSettings();
            const el = S.ctls[key];
            if (el) { if (el.type === 'checkbox') el.checked = val; else el.value = val; }
        },
    };
    function updateVisibility() {
        const tpl = curTpl(), P = params();
        tpl.controls.forEach(ct => {
            const el = S.ctls[ct.key];
            if (el && el.parentElement) el.parentElement.style.display = (ct.show && !ct.show(P)) ? 'none' : '';
        });
        (S.cards || []).forEach(card => {
            const any = [...card.querySelectorAll('.cp_ctl')].some(e => e.style.display !== 'none');
            card.style.display = any ? '' : 'none';
        });
    }
    function buildControls() {
        const tpl = curTpl(), P = params(), box = $('#cp_dyn');
        box.innerHTML = ''; S.ctls = {}; S.cards = [];
        let card = null, lastGroup = null;
        tpl.controls.forEach(ct => {
            const g = ct.group || '参数';
            if (g !== lastGroup) {
                card = document.createElement('div'); card.className = 'cp_card';
                const t = document.createElement('div'); t.className = 'cp_ct'; t.textContent = g;
                card.append(t); box.append(card); S.cards.push(card); lastGroup = g;
            }
            const wrap = document.createElement('label');
            wrap.className = 'cp_ctl' + (ct.type === 'checkbox' ? ' cp_inline' : '');
            const span = document.createElement('span');
            span.textContent = ct.label;
            let input;
            if (ct.type === 'select') {
                input = document.createElement('select');
                const opts = typeof ct.options === 'function' ? ct.options() : ct.options;
                opts.forEach(([v, l]) => input.add(new Option(l, v)));
                input.value = P[ct.key];
            } else if (ct.type === 'range') {
                input = document.createElement('input');
                input.type = 'range'; input.min = ct.min; input.max = ct.max; input.step = ct.step; input.value = P[ct.key];
                const out = document.createElement('b'); out.textContent = ' ' + P[ct.key];
                span.append(out);
                input.addEventListener('input', () => { out.textContent = ' ' + input.value; });
            } else if (ct.type === 'checkbox') {
                input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!P[ct.key];
            } else {
                input = document.createElement('input'); input.type = ct.type === 'color' ? 'color' : 'text'; input.value = P[ct.key];
            }
            input.addEventListener('input', () => {
                const v = ct.type === 'range' ? Number(input.value) : ct.type === 'checkbox' ? input.checked : input.value;
                params()[ct.key] = v; saveSettings();
                if (ct.onChange) ct.onChange(v);
                scheduleRender();
            });
            S.ctls[ct.key] = input;
            wrap.append(span, input);
            card.append(wrap);
        });
        updateVisibility();
    }
    function refreshTplSelect() {
        const sel = $('#cp_tpl');
        sel.innerHTML = '';
        Object.values(TEMPLATES).forEach(t => sel.add(new Option(t.name, t.id)));
        sel.value = getSettings().template;
    }

    // 画布用 object-fit: contain，需把屏幕坐标换算回画布坐标
    function canvasXY(e) {
        const r = cv.getBoundingClientRect();
        const k = Math.min(r.width / cv.width, r.height / cv.height);
        const w = cv.width * k, h = cv.height * k;
        const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
        return [(e.clientX - ox) / k, (e.clientY - oy) / k];
    }

    function pickFile(accept, cb) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = accept;
        inp.addEventListener('change', () => { if (inp.files[0]) cb(inp.files[0]); });
        inp.click();
    }

    function buildPanel() {
        overlay = document.createElement('div');
        overlay.id = 'cp_overlay';
        const ic = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
        overlay.innerHTML = `
        <div id="cp_panel">
          <div class="cp_head">
            <b>文字抽取成图</b>
            <div class="cp_tools">
              <button id="cp_undo" class="cp_ic" title="撤销">${ic('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>')}</button>
              <button id="cp_clear" class="cp_ic" title="清除全部">${ic('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>')}</button>
              <button id="cp_export" class="cp_ic" title="导出 PNG">${ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>')}</button>
              <button id="cp_copy" class="cp_ic" title="复制图片">${ic('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>')}</button>
              <button id="cp_toggle" class="cp_ic" title="显示/隐藏设置">${ic('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>')}</button>
              <button id="cp_close" class="cp_ic" title="关闭">${ic('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}</button>
            </div>
          </div>
          <div class="cp_body">
            <div class="cp_preview"><div class="cp_stage"><canvas id="cp_canvas"></canvas></div></div>
            <div class="cp_side">
              <div id="cp_hint"></div>
              <div class="cp_tabs">
                <button data-tab="a" class="on">内容</button>
                <button data-tab="b">样式</button>
                <button data-tab="c">更多</button>
              </div>
              <div class="cp_pane" data-pane="a">
                <div class="cp_card">
                  <div class="cp_ct">模板</div>
                  <select id="cp_tpl"></select>
                </div>
                <div class="cp_card">
                  <div class="cp_ct">文字</div>
                  <textarea id="cp_text" rows="4" placeholder="${SAMPLE}"></textarea>
                </div>
                <div class="cp_card">
                  <div class="cp_ct">图片</div>
                  <div class="cp_row">
                    <button id="cp_upload" class="cp_btn">上传</button>
                    <button id="cp_avatar" class="cp_btn">角色头像</button>
                    <button id="cp_bg" class="cp_btn">聊天背景</button>
                  </div>
                  <div class="cp_row"><input type="text" id="cp_url" placeholder="图片 URL"><button id="cp_urlgo" class="cp_btn">载入</button></div>
                </div>
              </div>
              <div class="cp_pane" data-pane="b" style="display:none"><div id="cp_dyn"></div></div>
              <div class="cp_pane" data-pane="c" style="display:none">
                <div class="cp_card">
                  <div class="cp_ct">字体</div>
                  <div class="cp_row"><button id="cp_fontimp" class="cp_btn">导入字体文件</button></div>
                  <label class="cp_ctl"><span>自己输入字体名（字体选“自己输入”时生效）</span><input type="text" id="cp_customfont" placeholder="例如：LXGW WenKai"></label>
                </div>
                <div class="cp_card">
                  <div class="cp_ct">预设与模板</div>
                  <div class="cp_row">
                    <button id="cp_presetout" class="cp_btn">导出预设</button>
                    <button id="cp_presetin" class="cp_btn">导入预设</button>
                  </div>
                  <div class="cp_row"><button id="cp_tplimp" class="cp_btn">导入模板脚本(.js)</button></div>
                </div>
              </div>
            </div>
          </div>
        </div>`;
        document.body.append(overlay);
        cv = $('#cp_canvas'); c2d = cv.getContext('2d');

        refreshTplSelect();
        $('#cp_tpl').addEventListener('change', e => {
            getSettings().template = e.target.value; saveSettings();
            S.undo = []; S.drag = null;
            buildControls(); render();
        });
        $('#cp_customfont').value = getSettings().customFont;
        $('#cp_customfont').addEventListener('input', e => { getSettings().customFont = e.target.value.trim(); saveSettings(); scheduleRender(); });

        overlay.addEventListener('mousedown', e => { if (e.target === overlay) closePanel(); });
        // 顶栏拖动整个面板（pointer 兼容触屏、鼠标和触控笔）
        const panel = $('#cp_panel'), head = panel.querySelector('.cp_head');
        let panelDrag = null;
        head.style.cursor = 'grab'; head.style.touchAction = 'none';
        head.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            const r = panel.getBoundingClientRect();
            panelDrag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            panel.style.position = 'fixed'; panel.style.margin = '0';
            panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
            panel.style.width = r.width + 'px'; panel.style.height = r.height + 'px';
            head.setPointerCapture(e.pointerId); head.style.cursor = 'grabbing';
            e.preventDefault();
        });
        head.addEventListener('pointermove', e => {
            if (!panelDrag) return;
            panel.style.left = clamp(panelDrag.left + e.clientX - panelDrag.x, 0, innerWidth - panel.offsetWidth) + 'px';
            panel.style.top = clamp(panelDrag.top + e.clientY - panelDrag.y, 0, innerHeight - panel.offsetHeight) + 'px';
        });
        const stopPanelDrag = () => { panelDrag = null; head.style.cursor = 'grab'; };
        head.addEventListener('pointerup', stopPanelDrag);
        head.addEventListener('pointercancel', stopPanelDrag);
        $('#cp_close').addEventListener('click', closePanel);
        $('#cp_toggle').addEventListener('click', () => { overlay.classList.toggle('cp_focus'); setTimeout(render, 30); });
        $('#cp_text').addEventListener('input', e => { S.text = e.target.value; S.keep = null; S.slots = new Set(); scheduleRender(); });
        overlay.querySelectorAll('.cp_tabs button').forEach(b => b.addEventListener('click', () => {
            overlay.querySelectorAll('.cp_tabs button').forEach(x => x.classList.toggle('on', x === b));
            overlay.querySelectorAll('.cp_pane').forEach(p => { p.style.display = p.dataset.pane === b.dataset.tab ? '' : 'none'; });
        }));

        // 图片来源
        $('#cp_upload').addEventListener('click', () => pickFile('image/*', async f => {
            try { setImage(await loadImage(URL.createObjectURL(f))); render(); } catch (err) { toast(err.message); }
        }));
        $('#cp_avatar').addEventListener('click', async () => {
            const x = getCtx();
            const ch = x && x.characters && x.characters[x.characterId];
            if (!ch || !ch.avatar) return toast('当前没有选中角色');
            try { setImage(await loadImage('/characters/' + encodeURIComponent(ch.avatar))); render(); } catch (err) { toast(err.message); }
        });
        $('#cp_bg').addEventListener('click', async () => {
            const el = document.getElementById('bg1') || document.body;
            const m = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
            if (!m) return toast('当前没有聊天背景图');
            try { setImage(await loadImage(m[1])); render(); } catch (err) { toast(err.message); }
        });
        $('#cp_urlgo').addEventListener('click', async () => {
            const u = $('#cp_url').value.trim(); if (!u) return;
            try { setImage(await loadImage(u)); render(); } catch (err) { toast('加载失败（可能是跨域），请改用上传'); }
        });

        // 顶部工具
        $('#cp_undo').addEventListener('click', () => {
            const tpl = curTpl();
            if (!S.undo.length || !tpl.restore) return;
            tpl.restore(S.undo.pop()); render();
        });
        $('#cp_clear').addEventListener('click', () => {
            const tpl = curTpl();
            if (!tpl.clear) return;
            if (tpl.snap) S.undo.push(tpl.snap());
            tpl.clear(); render();
        });
        $('#cp_export').addEventListener('click', () => {
            try {
                cv.toBlob(b => {
                    if (!b) return toast('导出失败：图片跨域，请改用上传');
                    download(b, `cutout_${Date.now()}.png`);
                }, 'image/png');
            } catch (e) { toast('导出失败：图片跨域，请改用上传'); }
        });
        $('#cp_copy').addEventListener('click', () => {
            try {
                cv.toBlob(async b => {
                    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); toast('已复制到剪贴板'); }
                    catch (e) { toast('复制失败，请用导出'); }
                }, 'image/png');
            } catch (e) { toast('复制失败：图片跨域'); }
        });

        // 字体 / 预设 / 模板导入
        $('#cp_fontimp').addEventListener('click', () => pickFile('.ttf,.otf,.woff,.woff2', async f => {
            try {
                const name = f.name.replace(/\.[^.]+$/, '');
                const buf = await f.arrayBuffer();
                const ff = new FontFace(name, buf.slice(0));
                await ff.load(); document.fonts.add(ff);
                if (!importedFonts.includes(name)) importedFonts.push(name);
                try { await dbPut('fonts', { name, buf }); } catch (e) { toast('字体已加载，但无法永久保存'); }
                buildControls();
                if ('font' in params()) ui.setParam('font', 'imp:' + name);
                render(); toast('已导入字体：' + name);
            } catch (e) { toast('字体导入失败'); }
        }));
        $('#cp_presetout').addEventListener('click', () => {
            const st = getSettings();
            download(new Blob([JSON.stringify({ cutoutPoster: 1, template: st.template, params: st.params, customFont: st.customFont }, null, 2)], { type: 'application/json' }), 'cutout_preset.json');
        });
        $('#cp_presetin').addEventListener('click', () => pickFile('.json', async f => {
            try {
                const d = JSON.parse(await f.text());
                if (!d.cutoutPoster) throw new Error('bad');
                const st = getSettings();
                if (TEMPLATES[d.template]) st.template = d.template;
                Object.assign(st.params, d.params || {});
                if (d.customFont) { st.customFont = d.customFont; $('#cp_customfont').value = d.customFont; }
                saveSettings(); refreshTplSelect(); buildControls(); render(); toast('预设已导入');
            } catch (e) { toast('预设文件无效'); }
        }));
        $('#cp_tplimp').addEventListener('click', () => pickFile('.js', async f => {
            try {
                const code = await f.text();
                if (!confirm('模板脚本会在本页面执行，只导入你信任的文件。继续吗？')) return;
                new Function('CutoutPoster', code)(window.CutoutPoster);
                try { await dbPut('tpls', { name: f.name, code }); } catch (e) { /* ignore */ }
                refreshTplSelect(); toast('模板已导入');
            } catch (e) { console.error(e); toast('模板脚本出错，详见控制台'); }
        }));

        // 画布交互
        cv.addEventListener('wheel', e => {
            if (curTpl().id !== 'cutout' || !S.cut.holes.length) return;
            const [x,y] = canvasXY(e);
            const hit = [...S.hits].reverse().find(h => h.kind === 'frag' && x>=h.x && x<=h.x+h.w && y>=h.y && y<=h.y+h.h);
            if (!hit) return;
            const hole = S.cut.holes[hit.i];
            hole.size = clamp((hole.size || params().size) + (e.deltaY < 0 ? 1 : -1), 3, 60);
            S.selectedHole = hit.i; e.preventDefault(); scheduleRender();
        }, {passive:false});
        cv.addEventListener('pointerdown', e => {
            const tpl = curTpl();
            if (!tpl.onDown) return;
            const [x, y] = canvasXY(e);
            const before = tpl.snap ? tpl.snap() : null;
            if (tpl.onDown(x, y, params())) {
                if (before !== null) { S.undo.push(before); if (S.undo.length > 60) S.undo.shift(); }
                try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                e.preventDefault();
                render();
            }
        });
        cv.addEventListener('pointermove', e => {
            const tpl = curTpl();
            if (!tpl.onMove || !S.drag) return;
            const [x, y] = canvasXY(e);
            if (tpl.onMove(x, y, params())) scheduleRender();
        });
        const up = () => { const tpl = curTpl(); if (tpl.onUp) tpl.onUp(); else S.drag = null; };
        cv.addEventListener('pointerup', up);
        cv.addEventListener('pointercancel', up);

        buildControls();
    }

    function closePanel() { overlay.classList.remove('open'); document.body.style.overflow = ''; }

    function openPanel(text) {
        if (!overlay) buildPanel();
        if (typeof text === 'string' && text.trim()) {
            S.text = text.trim();
            $('#cp_text').value = S.text;
            S.keep = null; S.slots = new Set();
        }
        overlay.classList.add('open');
        document.body.style.overflow = 'hidden';
        render();
    }

    /* =====================================================
     * 划词按钮 & 入口
     * ===================================================== */
    function initSelection() {
        const btn = document.createElement('div');
        btn.id = 'cp_float_btn';
        btn.textContent = '抽取成图';
        document.body.append(btn);
        let lastText = '';
        const hide = () => { btn.style.display = 'none'; };
        const check = () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount) return hide();
            const t = sel.toString().trim();
            if (!t) return hide();
            const n = sel.anchorNode;
            const el = n && n.nodeType === 1 ? n : n && n.parentElement;
            if (!el || !el.closest('#chat .mes_text')) return hide();
            lastText = t;
            const r = sel.getRangeAt(0).getBoundingClientRect();
            btn.style.display = 'block';
            const bw = btn.offsetWidth || 100, bh = btn.offsetHeight || 32;
            // 放在选区下方（避开手机系统自带的上方菜单和选择把手）
            let top = r.bottom + 34;
            if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - 60);
            btn.style.top = top + 'px';
            btn.style.left = clamp(r.left + r.width / 2 - bw / 2, 8, window.innerWidth - bw - 8) + 'px';
        };
        let timer = null;
        document.addEventListener('mouseup', () => setTimeout(check, 10));
        document.addEventListener('touchend', () => setTimeout(check, 200));
        document.addEventListener('selectionchange', () => { clearTimeout(timer); timer = setTimeout(check, 300); });
        btn.addEventListener('pointerdown', e => e.preventDefault());
        btn.addEventListener('mousedown', e => e.preventDefault());
        btn.addEventListener('click', () => { hide(); openPanel(lastText); });
    }

    function addMenuEntry(tries = 0) {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) { if (tries < 20) setTimeout(() => addMenuEntry(tries + 1), 500); return; }
        if (document.getElementById('cp_menu_item')) return;
        const d = document.createElement('div');
        d.id = 'cp_menu_item';
        d.className = 'list-group-item flex-container flexGap5 interactable';
        d.tabIndex = 0;
        d.innerHTML = '<div class="fa-solid fa-scissors extensionsMenuExtensionButton"></div><span>文字抽取成图</span>';
        d.addEventListener('click', () => openPanel(''));
        menu.append(d);
    }

    async function init() {
        initSelection(); addMenuEntry();
        await loadSavedFonts();
        await runSavedTemplates();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
