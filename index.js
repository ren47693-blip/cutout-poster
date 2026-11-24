/* 文字抽取成图 (Cutout Poster) v0.4 - SillyTavern 扩展 */
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

    // 多次连续下载修复：兼容 dataURL 与 Blob，延长 revokeObjectURL 时间
    function downloadCanvas(canvas, filename) {
        try {
            canvas.toBlob(blob => {
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.style.display = 'none';
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        a.remove();
                        URL.revokeObjectURL(url);
                    }, 30000);
                } else {
                    fallbackDataUrlDownload(canvas, filename);
                }
            }, 'image/png');
        } catch (e) {
            fallbackDataUrlDownload(canvas, filename);
        }
    }
    function fallbackDataUrlDownload(canvas, filename) {
        try {
            const dataUrl = canvas.toDataURL('image/png');
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = dataUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => a.remove(), 5000);
        } catch (err) {
            toast('导出失败：图片跨域受限，请改用本地上传');
        }
    }
    function downloadBlob(blob, name) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url; a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 30000);
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

    /* ---------- IndexedDB ---------- */
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

    /* ---------- 文字处理（不含 {} 槽位解析） ---------- */
    const CJK = '\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
    const TOKEN_RE = new RegExp(`[${CJK}]|[^\\s${CJK}]+`, 'g');
    let segmenter = null;
    function tokenizeLine(line, gran) {
        const out = [];
        if (gran === 'word' && window.Intl && Intl.Segmenter) {
            segmenter ??= new Intl.Segmenter(['zh', 'en'], { granularity: 'word' });
            for (const sg of segmenter.segment(line)) {
                const t = sg.segment;
                if (/^\s+$/.test(t)) { if (out.length) out[out.length - 1].sp = true; continue; }
                out.push({ t, sp: false });
            }
            return out;
        }
        let m;
        TOKEN_RE.lastIndex = 0;
        while ((m = TOKEN_RE.exec(line))) {
            const t = m[0], nxt = line[m.index + t.length];
            out.push({ t, sp: !!nxt && /\s/.test(nxt) });
        }
        return out;
    }
    function tokenize(text, gran) {
        const lines = String(text).replace(/\r/g, '').split('\n');
        const out = [];
        lines.forEach((ln, li) => {
            if (li) out.push({ nl: true, t: '\n', sp: false });
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
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    }

    /* ---------- 图形路径（支持拼图块） ---------- */
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
            case 'puzzle': {
                // 经典拼图块路径（上凸、右凹、下凸、左凹）
                const bw = w * 0.72, bh = h * 0.72;
                const bx = cx - bw / 2, by = cy - bh / 2;
                const kx = bw * 0.16, ky = bh * 0.16;
                c.moveTo(bx, by);
                // Top edge (outward tab)
                c.lineTo(bx + bw * 0.36, by);
                c.bezierCurveTo(bx + bw * 0.32, by - ky * 1.3, bx + bw * 0.68, by - ky * 1.3, bx + bw * 0.64, by);
                c.lineTo(bx + bw, by);
                // Right edge (inward slot)
                c.lineTo(bx + bw, by + bh * 0.36);
                c.bezierCurveTo(bx + bw - kx * 1.2, by + bh * 0.32, bx + bw - kx * 1.2, by + bh * 0.68, bx + bw, by + bh * 0.64);
                c.lineTo(bx + bw, by + bh);
                // Bottom edge (outward tab)
                c.lineTo(bx + bw * 0.64, by + bh);
                c.bezierCurveTo(bx + bw * 0.68, by + bh + ky * 1.3, bx + bw * 0.32, by + bh + ky * 1.3, bx + bw * 0.36, by + bh);
                c.lineTo(bx, by + bh);
                // Left edge (inward slot)
                c.lineTo(bx, by + bh * 0.64);
                c.bezierCurveTo(bx + kx * 1.2, by + bh * 0.68, bx + kx * 1.2, by + bh * 0.32, bx, by + bh * 0.36);
                c.closePath();
                break;
            }
            default: c.rect(x, y, w, h);
        }
    }

    /* ---------- 运行时状态 ---------- */
    const S = {
        rawImg: null, img: null, imgId: 0,
        crop: { x: 0, y: 0, w: 1, h: 1 },
        hits: [], geo: null,
        cut: { holes: [], sel: -1 },
        slots: new Set(),
        keep: null,
        cells: null,
        extract: { sel: new Set(), items: {} },
        collage: { holes: [], sel: -1 },
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

    // 应用裁剪生成当前工作图
    function rebuildCroppedImage() {
        if (!S.rawImg) return;
        const rw = imgW(S.rawImg), rh = imgH(S.rawImg);
        const sx = Math.round(S.crop.x * rw);
        const sy = Math.round(S.crop.y * rh);
        const sw = Math.max(10, Math.round(S.crop.w * rw));
        const sh = Math.max(10, Math.round(S.crop.h * rh));
        const out = document.createElement('canvas');
        out.width = sw; out.height = sh;
        out.getContext('2d').drawImage(S.rawImg, sx, sy, sw, sh, 0, 0, sw, sh);
        S.img = out;
        S.imgId++;
    }

    /* =====================================================
     * 模板 1：挖洞置换（支持独立碎片大小/角度/位置、拼图块、无 {} 符号）
     * ===================================================== */
    function holeGeom(P, h, IW, IH) {
        const sz = h.size !== undefined ? h.size : P.size;
        const w = sz / 100;
        const hp = ((P.shape === 'rect' || P.shape === 'ellipse') ? (IW * w) / Math.max(0.2, P.aspect) : IW * w) / IH;
        return {
            cx: clamp(h.cx, w / 2, 1 - w / 2),
            cy: clamp(h.cy, Math.min(hp / 2, 0.5), Math.max(1 - hp / 2, 0.5)),
            w, h: hp,
            rot: ((h.rot || 0) * Math.PI) / 180,
        };
    }

    function drawFrag(c, P, g, dcx, dcy, dw, dh, selected) {
        const img = S.img;
        c.save();
        c.translate(dcx, dcy);
        if (g.rot) c.rotate(g.rot);
        pathShape(c, P.shape, 0, 0, dw, dh);
        c.clip();
        c.drawImage(
            img,
            (g.cx - g.w / 2) * imgW(img), (g.cy - g.h / 2) * imgH(img),
            g.w * imgW(img), g.h * imgH(img),
            -dw / 2, -dh / 2, dw, dh
        );
        c.restore();

        if (P.border || selected) {
            c.save();
            c.translate(dcx, dcy);
            if (g.rot) c.rotate(g.rot);
            pathShape(c, P.shape, 0, 0, dw, dh);
            if (selected) {
                c.lineWidth = 3;
                c.strokeStyle = '#3b82f6';
                c.setLineDash([6, 4]);
                c.stroke();
            } else if (P.border) {
                c.lineWidth = 2;
                c.strokeStyle = P.fg;
                c.stroke();
            }
            c.restore();
        }
    }

    const SHAPE_OPTS = [
        ['square', '方形'], ['circle', '圆形'], ['puzzle', '拼图块'],
        ['rect', '长方形'], ['ellipse', '椭圆'], ['diamond', '菱形'],
        ['triangle', '三角'], ['star', '星形'], ['heart', '爱心'],
    ];

    const cutout = {
        id: 'cutout',
        name: '挖洞置换',
        hint(P) {
            return P.layout === 'slots'
                ? '点图片挖洞（再点取消）；点文字插槽（无{}符号）。点中碎片后可在样式中单独调大小与角度。'
                : '点图片挖洞（再点取消）。下方碎片可拖动位置，点中碎片后可在样式中单独调大小和角度。';
        },
        defaults: {
            layout: 'below', gran: 'char', shape: 'puzzle', size: 13, aspect: 1.5, lowerPct: 100,
            fragSize: 13, fragRot: 0,
            bg: '#f1efe6', fg: '#222222', border: false, fontSize: 3.4, font: 'theme',
        },
        controls: [
            { group: '版面', key: 'layout', label: '碎片落点', type: 'select', options: [['below', '下方散落'], ['slots', '文字槽位']] },
            { group: '版面', key: 'gran', label: '文字点选单位', type: 'select', options: [['char', '逐字'], ['word', '按词']], show: P => P.layout === 'slots', onChange() { S.slots = new Set(); } },
            { group: '版面', key: 'lowerPct', label: '下方区域高度 %', type: 'range', min: 40, max: 160, step: 5, show: P => P.layout === 'below' },
            { group: '形状', key: 'shape', label: '洞的形状', type: 'select', options: SHAPE_OPTS },
            {
                group: '形状', key: 'size', label: '默认洞大小 %', type: 'range', min: 3, max: 45, step: 1,
                onChange(v) {
                    // 未单独定制过的碎片跟随默认大小
                    S.cut.holes.forEach(h => { if (!h.customSize) h.size = v; });
                }
            },
            { group: '形状', key: 'aspect', label: '长宽比(长方形/椭圆)', type: 'range', min: 0.4, max: 3, step: 0.1 },
            {
                group: '当前选中碎片', key: 'fragSize', label: '单独大小 %', type: 'range', min: 3, max: 55, step: 1,
                show: () => S.cut.sel >= 0 && !!S.cut.holes[S.cut.sel],
                onChange(v) {
                    const h = S.cut.holes[S.cut.sel];
                    if (h) { h.size = v; h.customSize = true; }
                }
            },
            {
                group: '当前选中碎片', key: 'fragRot', label: '旋转角度 °', type: 'range', min: -180, max: 180, step: 1,
                show: () => S.cut.sel >= 0 && !!S.cut.holes[S.cut.sel],
                onChange(v) {
                    const h = S.cut.holes[S.cut.sel];
                    if (h) h.rot = v;
                }
            },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.5, max: 6, step: 0.1, show: P => P.layout === 'slots' },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS, show: P => P.layout === 'slots' },
            { group: '颜色', key: 'bg', label: '底色/洞色', type: 'color' },
            { group: '颜色', key: 'fg', label: '文字/描边色', type: 'color' },
            { group: '颜色', key: 'border', label: '碎片描边', type: 'checkbox' },
        ],
        snap() { return JSON.stringify({ h: S.cut.holes, s: [...S.slots], sel: S.cut.sel }); },
        restore(str) {
            const d = JSON.parse(str);
            S.cut.holes = d.h || [];
            S.slots = new Set(d.s || []);
            S.cut.sel = d.sel ?? -1;
            syncCutoutSelUI();
        },
        clear() { S.cut.holes = []; S.slots = new Set(); S.cut.sel = -1; syncCutoutSelUI(); },
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
            // 挖洞（支持各自大小与角度）
            G.forEach(g => {
                c.save();
                c.translate(g.cx * IW, g.cy * IH);
                if (g.rot) c.rotate(g.rot);
                pathShape(c, P.shape, 0, 0, g.w * IW, g.h * IH);
                c.fillStyle = P.bg;
                c.fill();
                c.restore();
            });
            // 下方碎片
            G.forEach((g, i) => {
                const dw = g.w * IW, dh = g.h * IH;
                const dx = g.cx * IW + (holes[i].ox || 0), dy = IH + g.cy * lowerH + (holes[i].oy || 0);
                drawFrag(c, P, g, dx, dy, dw, dh, S.cut.sel === i);
                S.hits.push({ kind: 'frag', i, x: dx - dw / 2, y: dy - dh / 2, w: dw, h: dh });
            });
        },
        onDown(x, y, P) {
            const inside = h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
            for (let k = S.hits.length - 1; k >= 0; k--) {
                const h = S.hits[k];
                if (h.kind === 'frag' && inside(h)) {
                    S.cut.sel = h.i;
                    syncCutoutSelUI();
                    const ho = S.cut.holes[h.i];
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
            if (hit >= 0) {
                holes.splice(hit, 1);
                if (S.cut.sel === hit) S.cut.sel = -1;
                else if (S.cut.sel > hit) S.cut.sel--;
            } else {
                holes.push({ cx: fx, cy: fy, ox: 0, oy: 0, size: P.size, rot: 0, customSize: false });
                S.cut.sel = holes.length - 1;
            }
            syncCutoutSelUI();
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

    function syncCutoutSelUI() {
        const P = params();
        const h = S.cut.holes[S.cut.sel];
        if (h) {
            P.fragSize = h.size !== undefined ? h.size : P.size;
            P.fragRot = h.rot || 0;
            if (S.ctls.fragSize) {
                S.ctls.fragSize.value = P.fragSize;
                const b = S.ctls.fragSize.parentElement.querySelector('b');
                if (b) b.textContent = ' ' + P.fragSize;
            }
            if (S.ctls.fragRot) {
                S.ctls.fragRot.value = P.fragRot;
                const b = S.ctls.fragRot.parentElement.querySelector('b');
                if (b) b.textContent = ' ' + P.fragRot;
            }
        }
        updateVisibility();
    }

    // 文字槽位版面：彻底移除 {} 符号，直接显示图案碎片或虚线框
    function renderSlots(cv, c, P, W, IW, IH, holes, G) {
        const fs = Math.round(W * P.fontSize / 100);
        const fam = fontFamily(P.font);
        mctx.font = `${fs}px ${fam}`;
        const base = tokenize((S.text || '').trim() || SAMPLE, P.gran);
        const toks = [];
        base.forEach((t, i) => {
            toks.push(Object.assign({}, t, { ti: i }));
            if (!t.nl && S.slots.has(i)) toks.push({ slot: true, sp: true, ti: -1, after: i });
        });
        const spaceW = mctx.measureText(' ').width;
        let slotI = 0;
        const items = toks.map(tk => {
            if (tk.nl) return { nl: true, w: 0 };
            if (tk.slot) {
                const i = slotI++, g = G[i];
                let fh = fs * 2.2, fw = g ? fh * (g.w * IW) / (g.h * IH) : fh * 1.3;
                const cap = W * 0.28;
                if (fw > cap) { fw = cap; fh = g ? fw * (g.h * IH) / (g.w * IW) : fw / 1.3; }
                return { slot: true, i, fw, fh, after: tk.after, w: fw + fs * 0.35 + spaceW };
            }
            return { t: tk.t, ti: tk.ti, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) };
        });
        const lines = wrap(items, W * 0.84);
        lines.forEach(l => {
            const mf = Math.max(0, ...l.items.filter(i => i.slot).map(i => i.fh));
            l.lh = Math.max(fs * 1.9, mf ? mf + fs * 0.5 : 0);
        });
        const pad = fs * 2.5;
        const textH = Math.round(pad * 2 + lines.reduce((s, l) => s + l.lh, 0));
        cv.width = W; cv.height = textH + IH;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, cv.height);
        c.drawImage(S.img, 0, textH, IW, IH);
        S.geo = { x: 0, y: textH, w: IW, h: IH };
        G.forEach(g => {
            c.save();
            c.translate(g.cx * IW, textH + g.cy * IH);
            if (g.rot) c.rotate(g.rot);
            pathShape(c, P.shape, 0, 0, g.w * IW, g.h * IH);
            c.fillStyle = P.bg;
            c.fill();
            c.restore();
        });
        c.font = `${fs}px ${fam}`; c.textBaseline = 'middle'; c.textAlign = 'left';
        let y = pad;
        lines.forEach(l => {
            let x = (W - l.w) / 2;
            const cy = y + l.lh / 2;
            l.items.forEach(it => {
                if (it.nl) return;
                if (it.slot) {
                    const fx = x + fs * 0.15, g = G[it.i];
                    if (g) {
                        drawFrag(c, P, g, fx + it.fw / 2, cy, it.fw, it.fh, S.cut.sel === it.i);
                        S.hits.push({ kind: 'frag', i: it.i, x: fx, y: cy - it.fh / 2, w: it.fw, h: it.fh });
                    } else {
                        c.save(); c.setLineDash([6, 5]); c.strokeStyle = P.fg;
                        c.strokeRect(fx, cy - it.fh / 2, it.fw, it.fh); c.restore();
                        if (it.after !== undefined) S.hits.push({ kind: 'sslot', i: it.after, x, y, w: it.w, h: l.lh });
                    }
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
     * 模板 2：涂黑诗（修复：无保留字的行或整段无字时不显示黑条）
     * ===================================================== */
    const blackout = {
        id: 'blackout',
        name: '涂黑诗',
        hint: '整段先涂黑。点词语留下/再涂黑，手指划过可连选；整行无保留字时自动隐藏该行黑条。',
        defaults: { gran: 'char', fontSize: 3.6, font: 'theme', paper: '#f4efdc', ink: '#111111', hideEmptyLine: true },
        controls: [
            { group: '点选', key: 'gran', label: '点选单位', type: 'select', options: [['char', '逐字'], ['word', '按词(中文自动分词)']], onChange() { S.keep = null; } },
            { group: '点选', key: 'hideEmptyLine', label: '无保留字时隐藏该行黑块', type: 'checkbox' },
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

            // 过滤掉无字行或未选字行（若开启隐藏空行）
            const visibleLines = lines.filter(l => {
                const real = l.items.filter(it => !it.nl);
                if (!real.length) return false;
                if (P.hideEmptyLine && S.keep.set.size > 0) {
                    return real.some(it => S.keep.set.has(it.i));
                }
                return true;
            });

            // 如果完全没有选任何字且开启了隐藏空行，或者没有有效文字，显示提示轻淡文字供点选，不画黑块
            const hasAnyKept = S.keep.set.size > 0;
            const drawLines = visibleLines.length ? visibleLines : lines.filter(l => l.items.some(it => !it.nl));

            cv.width = W; cv.height = Math.max(240, Math.round(M * 2 + drawLines.length * lh));
            c.fillStyle = P.paper; c.fillRect(0, 0, W, cv.height);
            c.font = `${fs}px ${fam}`; c.textBaseline = 'middle';
            let y = M;
            for (const l of drawLines) {
                const real = l.items.filter(it => !it.nl);
                if (real.length) {
                    const lineHasKept = real.some(it => S.keep.set.has(it.i));
                    if (!P.hideEmptyLine || hasAnyKept) {
                        if (!P.hideEmptyLine || lineHasKept) {
                            c.fillStyle = P.ink;
                            c.fillRect(M, y, blockW, lh);
                        }
                    } else {
                        // 尚未点选任何字时，显示半透明浅墨底以便看清文字进行点选
                        c.fillStyle = P.ink;
                        c.globalAlpha = 0.14;
                        c.fillRect(M, y, blockW, lh);
                        c.globalAlpha = 1;
                        c.fillStyle = P.ink;
                        let tx = M;
                        real.forEach(it => { c.fillText(it.t, tx, y + lh / 2); tx += it.w; });
                    }

                    let x = M;
                    const pos = real.map(it => { const p = { it, x }; x += it.w; return p; });
                    if (hasAnyKept || !P.hideEmptyLine) {
                        let a = 0;
                        while (a < pos.length) {
                            const kept = S.keep.set.has(pos[a].it.i);
                            let b = a;
                            while (b + 1 < pos.length && S.keep.set.has(pos[b + 1].it.i) === kept) b++;
                            if (kept) {
                                const x0 = pos[a].x, x1 = pos[b].x + pos[b].it.w;
                                c.fillStyle = P.paper; c.fillRect(x0, y + lh * 0.1, x1 - x0, lh * 0.8);
                                c.fillStyle = P.ink;
                                for (let k = a; k <= b; k++) c.fillText(pos[k].it.t, pos[k].x, y + lh / 2);
                            }
                            a = b + 1;
                        }
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
     * 模板 4（参考图）：挖字散落（上方挖去选中字块，下方自由散落排列）
     * ===================================================== */
    const wordExtract = {
        id: 'word_extract',
        name: '挖字散落',
        hint: '点上方文字将字块挖出（再点放回）；下方挖出的字块可自由拖动排列。',
        defaults: { gran: 'char', fontSize: 4.5, font: 'serif', topBg: '#7a1c1c', botBg: '#f4efe4', textColor: '#f7f3eb', holeColor: '#d9d0c1' },
        controls: [
            { group: '点选', key: 'gran', label: '挖字单位', type: 'select', options: [['char', '逐字'], ['word', '按词']], onChange() { S.extract = { sel: new Set(), items: {} }; } },
            { group: '文字', key: 'fontSize', label: '字体大小', type: 'range', min: 2.5, max: 7.5, step: 0.1 },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '颜色', key: 'topBg', label: '上半背景色', type: 'color' },
            { group: '颜色', key: 'botBg', label: '下半纸色', type: 'color' },
            { group: '颜色', key: 'textColor', label: '文字色', type: 'color' },
            { group: '颜色', key: 'holeColor', label: '挖空底纹色', type: 'color' },
        ],
        snap() { return JSON.stringify({ sel: [...S.extract.sel], items: S.extract.items }); },
        restore(str) {
            const d = JSON.parse(str);
            S.extract.sel = new Set(d.sel || []);
            S.extract.items = d.items || {};
        },
        clear() { S.extract = { sel: new Set(), items: {} }; },
        render(cv, c, P) {
            const W = 1000, M = 75;
            const fs = Math.round(W * P.fontSize / 100), fam = fontFamily(P.font);
            mctx.font = `bold ${fs}px ${fam}`;
            const toks = tokenize((S.text || '').trim() || '夫天地者，万物之逆旅也；光阴者，百代之过客也。', P.gran);
            const spaceW = mctx.measureText(' ').width;
            const items = toks.map((tk, i) => tk.nl ? { nl: true, w: 0 } : { i, t: tk.t, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) });
            const lines = wrap(items, W - M * 2);
            const lh = fs * 1.55;
            const topH = Math.max(360, Math.round(M * 2 + lines.length * lh));
            const botH = topH;
            cv.width = W; cv.height = topH + botH;

            // 上半部分
            c.fillStyle = P.topBg;
            c.fillRect(0, 0, W, topH);
            // 下半部分
            c.fillStyle = P.botBg;
            c.fillRect(0, topH, W, botH);

            c.font = `bold ${fs}px ${fam}`;
            c.textBaseline = 'middle';
            c.textAlign = 'center';

            let y = M;
            const extractedList = [];
            for (const l of lines) {
                let x = M;
                for (const it of l.items) {
                    if (it.nl) continue;
                    const bw = it.w * 0.94, bh = fs * 1.16;
                    const bx = x + it.w / 2, by = y + lh / 2;
                    if (S.extract.sel.has(it.i)) {
                        // 上方挖空方块
                        c.fillStyle = P.holeColor;
                        c.fillRect(bx - bw / 2, by - bh / 2, bw, bh);
                        extractedList.push({ i: it.i, t: it.t, bw, bh, origX: bx, origY: by });
                    } else {
                        c.fillStyle = P.textColor;
                        c.fillText(it.t, bx, by);
                    }
                    S.hits.push({ kind: 'ext_top', i: it.i, x, y, w: it.w, h: lh });
                    x += it.w;
                }
                y += lh;
            }

            // 下半部分渲染挖出的字块
            extractedList.forEach((ex, idx) => {
                if (!S.extract.items[ex.i]) {
                    const col = idx % 6, row = Math.floor(idx / 6);
                    S.extract.items[ex.i] = {
                        x: M + 80 + col * 140 + (row % 2) * 35,
                        y: topH + 90 + row * 110,
                    };
                }
                const pos = S.extract.items[ex.i];
                c.fillStyle = P.topBg;
                c.fillRect(pos.x - ex.bw / 2, pos.y - ex.bh / 2, ex.bw, ex.bh);
                c.fillStyle = P.textColor;
                c.fillText(ex.t, pos.x, pos.y);
                S.hits.push({ kind: 'ext_bot', i: ex.i, x: pos.x - ex.bw / 2, y: pos.y - ex.bh / 2, w: ex.bw, h: ex.bh });
            });
            c.textAlign = 'left';
        },
        onDown(x, y) {
            for (let k = S.hits.length - 1; k >= 0; k--) {
                const h = S.hits[k];
                if (h.kind === 'ext_bot' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
                    const pos = S.extract.items[h.i];
                    S.drag = { extId: h.i, sx: x, sy: y, ox: pos.x, oy: pos.y };
                    return true;
                }
            }
            const topHit = S.hits.find(h => h.kind === 'ext_top' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
            if (topHit) {
                if (S.extract.sel.has(topHit.i)) {
                    S.extract.sel.delete(topHit.i);
                } else {
                    S.extract.sel.add(topHit.i);
                }
                return true;
            }
            return false;
        },
        onMove(x, y) {
            if (!S.drag || S.drag.extId === undefined) return false;
            const pos = S.extract.items[S.drag.extId];
            if (!pos) return false;
            pos.x = S.drag.ox + (x - S.drag.sx);
            pos.y = S.drag.oy + (y - S.drag.sy);
            return true;
        },
        onUp() { S.drag = null; },
    };

    /* =====================================================
     * 模板 5（参考图）：文字剪影透图（纯色底板+大字镂空透出图片+点缀碎片）
     * ===================================================== */
    const textMask = {
        id: 'text_mask',
        name: '文字镂空海报',
        hint: '在图片或纯色底板上用文字直接镂空透出底层画面，适合做杂志/诗集封面感。',
        defaults: { fontSize: 11, font: 'serif', bg: '#2c1e38', align: 'center', lineH: 1.25, invert: false },
        controls: [
            { group: '排版', key: 'fontSize', label: '文字大小', type: 'range', min: 5, max: 22, step: 0.5 },
            { group: '排版', key: 'lineH', label: '行距', type: 'range', min: 0.9, max: 2.0, step: 0.05 },
            { group: '排版', key: 'align', label: '对齐', type: 'select', options: [['center', '居中'], ['left', '左对齐'], ['right', '右对齐']] },
            { group: '排版', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '颜色', key: 'bg', label: '遮罩底色', type: 'color' },
            { group: '颜色', key: 'invert', label: '反转（图片底+纯色字）', type: 'checkbox' },
        ],
        render(cv, c, P) {
            const img = S.img;
            const W = 1200, H = Math.round(W * imgH(img) / imgW(img));
            cv.width = W; cv.height = H;

            const fs = Math.round(W * P.fontSize / 100);
            const fam = fontFamily(P.font);
            const txt = (S.text || '').trim() || 'LOVE WILL TEAR US APART';

            // 离屏生成文字层
            const tcv = document.createElement('canvas');
            tcv.width = W; tcv.height = H;
            const tc = tcv.getContext('2d');
            tc.font = `bold ${fs}px ${fam}`;
            tc.textBaseline = 'middle';

            const rawLines = txt.split('\n');
            const wrapped = [];
            rawLines.forEach(rl => {
                const words = rl.split('');
                let cur = '';
                words.forEach(ch => {
                    if (tc.measureText(cur + ch).width > W * 0.84 && cur) {
                        wrapped.push(cur); cur = ch;
                    } else cur += ch;
                });
                if (cur) wrapped.push(cur);
            });

            const lh = fs * P.lineH;
            const totalH = wrapped.length * lh;
            let startY = (H - totalH) / 2 + lh / 2;

            tc.fillStyle = '#000';
            tc.textAlign = P.align;
            const tx = P.align === 'center' ? W / 2 : P.align === 'left' ? W * 0.08 : W * 0.92;
            wrapped.forEach((line, idx) => {
                tc.fillText(line, tx, startY + idx * lh);
            });

            if (P.invert) {
                // 图片底 + 纯色文字
                c.drawImage(img, 0, 0, W, H);
                tc.globalCompositeOperation = 'source-in';
                tc.fillStyle = P.bg;
                tc.fillRect(0, 0, W, H);
                c.drawImage(tcv, 0, 0);
            } else {
                // 纯色遮罩 + 文字区域镂空显示底层图片
                c.fillStyle = P.bg;
                c.fillRect(0, 0, W, H);
                const icv = document.createElement('canvas');
                icv.width = W; icv.height = H;
                const ic = icv.getContext('2d');
                ic.drawImage(tcv, 0, 0);
                ic.globalCompositeOperation = 'source-in';
                ic.drawImage(img, 0, 0, W, H);
                c.drawImage(icv, 0, 0);
            }
        }
    };

    /* =====================================================
     * 模板 6（参考图 IMG_6014 / IMG_6020）：双栏拼图对照
     * ===================================================== */
    const dualPuzzle = {
        id: 'dual_puzzle',
        name: '双栏拼图对照',
        hint: '点左侧图片挖出拼图块（再点取消）；右侧自动生成对应拼图聚拢阵列，也可手动拖动右侧碎片。',
        defaults: { shape: 'puzzle', size: 14, rightBg: '#5c5c5c', holeColor: '#666666', gather: true, sign: '' },
        controls: [
            { group: '拼图', key: 'shape', label: '碎片形状', type: 'select', options: SHAPE_OPTS },
            { group: '拼图', key: 'size', label: '碎片大小 %', type: 'range', min: 6, max: 30, step: 1 },
            { group: '拼图', key: 'gather', label: '右侧居中聚拢', type: 'checkbox' },
            { group: '文字', key: 'sign', label: '底部落款小字', type: 'text' },
            { group: '颜色', key: 'rightBg', label: '右侧底板色', type: 'color' },
            { group: '颜色', key: 'holeColor', label: '左侧挖洞填充色', type: 'color' },
        ],
        snap() { return JSON.stringify(S.collage.holes); },
        restore(str) { S.collage.holes = JSON.parse(str) || []; },
        clear() { S.collage.holes = []; },
        render(cv, c, P) {
            const img = S.img;
            const halfW = 600;
            const H = Math.max(600, Math.round(halfW * imgH(img) / imgW(img)));
            cv.width = halfW * 2;
            cv.height = H;

            // 左侧原图
            c.drawImage(img, 0, 0, halfW, H);
            S.geo = { x: 0, y: 0, w: halfW, h: H };

            // 右侧纯色底板
            c.fillStyle = P.rightBg;
            c.fillRect(halfW, 0, halfW, H);

            const holes = S.collage.holes;
            holes.forEach((h, i) => {
                const sz = (h.size || P.size) / 100;
                const w = halfW * sz;
                const hh = w;
                const lx = h.cx * halfW, ly = h.cy * H;

                // 左侧挖洞
                c.save();
                pathShape(c, P.shape, lx, ly, w, hh);
                c.fillStyle = P.holeColor;
                c.fill();
                c.restore();

                // 右侧碎片位置
                let rx, ry;
                if (P.gather) {
                    const cols = 3;
                    const col = i % cols, row = Math.floor(i / cols);
                    rx = halfW + halfW * 0.34 + col * (w * 0.72) + (h.ox || 0);
                    ry = H * 0.32 + row * (hh * 0.72) + (h.oy || 0);
                } else {
                    rx = halfW + lx + (h.ox || 0);
                    ry = ly + (h.oy || 0);
                }

                c.save();
                pathShape(c, P.shape, rx, ry, w, hh);
                c.clip();
                c.drawImage(
                    img,
                    (h.cx - sz / 2) * imgW(img), (h.cy - (hh / H) / 2) * imgH(img),
                    sz * imgW(img), (hh / H) * imgH(img),
                    rx - w / 2, ry - hh / 2, w, hh
                );
                c.restore();

                S.hits.push({ kind: 'dp_frag', i, x: rx - w / 2, y: ry - hh / 2, w, h: hh });
            });

            const signText = (P.sign || S.text || '').trim().slice(0, 24);
            if (signText) {
                c.fillStyle = 'rgba(255,255,255,0.55)';
                c.font = '22px sans-serif';
                c.textAlign = 'center';
                c.fillText(signText, halfW + halfW / 2, H - 32);
                c.textAlign = 'left';
            }
        },
        onDown(x, y, P) {
            for (let k = S.hits.length - 1; k >= 0; k--) {
                const h = S.hits[k];
                if (h.kind === 'dp_frag' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
                    const ho = S.collage.holes[h.i];
                    S.drag = { dpIdx: h.i, sx: x, sy: y, ox: ho.ox || 0, oy: ho.oy || 0 };
                    return true;
                }
            }
            const g = S.geo;
            if (!g || x < g.x || x > g.x + g.w || y < g.y || y > g.y + g.h) return false;
            const fx = x / g.w, fy = y / g.h;
            const sz = P.size / 100;
            const hit = S.collage.holes.findIndex(h => Math.abs(fx - h.cx) <= sz / 2 && Math.abs(fy - h.cy) <= sz / 2);
            if (hit >= 0) S.collage.holes.splice(hit, 1);
            else S.collage.holes.push({ cx: fx, cy: fy, ox: 0, oy: 0, size: P.size });
            return true;
        },
        onMove(x, y) {
            if (!S.drag || S.drag.dpIdx === undefined) return false;
            const ho = S.collage.holes[S.drag.dpIdx];
            if (!ho) return false;
            ho.ox = S.drag.ox + (x - S.drag.sx);
            ho.oy = S.drag.oy + (y - S.drag.sy);
            return true;
        },
        onUp() { S.drag = null; },
    };

    /* ---------- 模板注册 ---------- */
    function register(t) {
        TEMPLATES[t.id] = t;
        if (overlay) refreshTplSelect();
    }
    [cutout, blackout, captcha, wordExtract, textMask, dualPuzzle].forEach(t => TEMPLATES[t.id] = t);
    window.CutoutPoster = {
        register, templates: TEMPLATES,
        util: { S, pathShape, tokenize, wrap, fontFamily, mulberry32, clamp, paintDown, paintMove },
    };

    async function runSavedTemplates() {
        try {
            for (const rec of await dbAll('tpls')) {
                try { new Function('CutoutPoster', rec.code)(window.CutoutPoster); }
                catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    }

    /* =====================================================
     * 图片加载与裁剪编辑器
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
    function setRawImage(im) {
        S.rawImg = im;
        S.crop = { x: 0, y: 0, w: 1, h: 1 };
        rebuildCroppedImage();
        syncCropSliders();
    }

    // 独立框选裁剪弹窗
    let cropModal = null, cropCv = null, cropCtx = null, tempCrop = null, cropDrag = null;
    function openCropModal() {
        if (!S.rawImg) return toast('请先导入或选择一张图片');
        if (!cropModal) {
            cropModal = document.createElement('div');
            cropModal.id = 'cp_crop_modal';
            cropModal.innerHTML = `
                <div id="cp_crop_box">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <b>拖动框选裁剪区域（拖动四角/边可调整大小，拖动内部移动）</b>
                        <button id="cp_crop_reset" class="cp_btn">重置整图</button>
                    </div>
                    <canvas id="cp_crop_cv"></canvas>
                    <div style="display:flex;gap:8px;justify-content:flex-end;">
                        <button id="cp_crop_cancel" class="cp_btn">取消</button>
                        <button id="cp_crop_ok" class="cp_btn" style="background:rgba(59,130,246,.55);">确定裁剪</button>
                    </div>
                </div>`;
            document.body.appendChild(cropModal);
            cropCv = cropModal.querySelector('#cp_crop_cv');
            cropCtx = cropCv.getContext('2d');

            cropModal.querySelector('#cp_crop_reset').addEventListener('click', () => {
                tempCrop = { x: 0, y: 0, w: 1, h: 1 };
                drawCropPreview();
            });
            cropModal.querySelector('#cp_crop_cancel').addEventListener('click', () => {
                cropModal.classList.remove('open');
            });
            cropModal.querySelector('#cp_crop_ok').addEventListener('click', () => {
                S.crop = Object.assign({}, tempCrop);
                rebuildCroppedImage();
                syncCropSliders();
                cropModal.classList.remove('open');
                render();
            });

            const getCropXY = e => {
                const r = cropCv.getBoundingClientRect();
                const k = Math.min(r.width / cropCv.width, r.height / cropCv.height);
                const w = cropCv.width * k, h = cropCv.height * k;
                const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
                return [clamp((e.clientX - ox) / w, 0, 1), clamp((e.clientY - oy) / h, 0, 1)];
            };

            cropCv.addEventListener('pointerdown', e => {
                const [fx, fy] = getCropXY(e);
                const c = tempCrop;
                const tol = 0.045;
                const nearL = Math.abs(fx - c.x) < tol;
                const nearR = Math.abs(fx - (c.x + c.w)) < tol;
                const nearT = Math.abs(fy - c.y) < tol;
                const nearB = Math.abs(fy - (c.y + c.h)) < tol;

                let mode = 'new';
                if (nearL && nearT) mode = 'nw';
                else if (nearR && nearT) mode = 'ne';
                else if (nearL && nearB) mode = 'sw';
                else if (nearR && nearB) mode = 'se';
                else if (fx >= c.x && fx <= c.x + c.w && fy >= c.y && fy <= c.y + c.h) mode = 'move';

                cropDrag = { mode, sx: fx, sy: fy, orig: Object.assign({}, c) };
                if (mode === 'new') tempCrop = { x: fx, y: fy, w: 0.05, h: 0.05 };
                try { cropCv.setPointerCapture(e.pointerId); } catch (err) {}
            });
            cropCv.addEventListener('pointermove', e => {
                if (!cropDrag) return;
                const [fx, fy] = getCropXY(e);
                const o = cropDrag.orig, dx = fx - cropDrag.sx, dy = fy - cropDrag.sy;
                if (cropDrag.mode === 'move') {
                    tempCrop.x = clamp(o.x + dx, 0, 1 - o.w);
                    tempCrop.y = clamp(o.y + dy, 0, 1 - o.h);
                } else if (cropDrag.mode === 'new') {
                    tempCrop.x = Math.min(cropDrag.sx, fx);
                    tempCrop.y = Math.min(cropDrag.sy, fy);
                    tempCrop.w = Math.max(0.05, Math.abs(fx - cropDrag.sx));
                    tempCrop.h = Math.max(0.05, Math.abs(fy - cropDrag.sy));
                } else {
                    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
                    if (cropDrag.mode.includes('w')) x1 = clamp(fx, 0, x2 - 0.05);
                    if (cropDrag.mode.includes('e')) x2 = clamp(fx, x1 + 0.05, 1);
                    if (cropDrag.mode.includes('n')) y1 = clamp(fy, 0, y2 - 0.05);
                    if (cropDrag.mode.includes('s')) y2 = clamp(fy, y1 + 0.05, 1);
                    tempCrop = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
                }
                drawCropPreview();
            });
            cropCv.addEventListener('pointerup', () => { cropDrag = null; });
        }
        tempCrop = Object.assign({}, S.crop);
        cropModal.classList.add('open');
        drawCropPreview();
    }

    function drawCropPreview() {
        const im = S.rawImg;
        const W = imgW(im), H = imgH(im);
        cropCv.width = W; cropCv.height = H;
        cropCtx.drawImage(im, 0, 0, W, H);
        // 暗化遮罩
        cropCtx.fillStyle = 'rgba(0,0,0,0.55)';
        cropCtx.fillRect(0, 0, W, H);
        const rx = tempCrop.x * W, ry = tempCrop.y * H, rw = tempCrop.w * W, rh = tempCrop.h * H;
        cropCtx.drawImage(im, rx, ry, rw, rh, rx, ry, rw, rh);
        cropCtx.strokeStyle = '#fff';
        cropCtx.lineWidth = Math.max(2, W / 300);
        cropCtx.strokeRect(rx, ry, rw, rh);
        // 四角手柄
        const hs = Math.max(10, W / 70);
        cropCtx.fillStyle = '#3b82f6';
        [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]].forEach(([px, py]) => {
            cropCtx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
        });
    }

    function syncCropSliders() {
        if (!overlay) return;
        const z = $('#cp_img_zoom');
        if (z) {
            const zoomPct = Math.round((1 / Math.max(0.1, S.crop.w)) * 100);
            z.value = clamp(zoomPct, 100, 300);
        }
    }

    /* =====================================================
     * 面板与拖动逻辑
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
        if (!S.rawImg) setRawImage(makePlaceholder());
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
          <div class="cp_head" id="cp_drag_bar" title="按住此处拖动移动面板">
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
                  <div class="cp_ct">图片与裁剪</div>
                  <div class="cp_row">
                    <button id="cp_upload" class="cp_btn">上传</button>
                    <button id="cp_avatar" class="cp_btn">角色头像</button>
                    <button id="cp_bg" class="cp_btn">聊天背景</button>
                  </div>
                  <div class="cp_row">
                    <button id="cp_crop_open" class="cp_btn">✂️ 框选裁剪图片</button>
                  </div>
                  <label class="cp_ctl">
                    <span>快速缩放画面</span>
                    <input type="range" id="cp_img_zoom" min="100" max="300" step="5" value="100">
                  </label>
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

        // 顶部栏拖动整个面板移动
        const panel = $('#cp_panel');
        const dragBar = $('#cp_drag_bar');
        let panelOffset = { x: 0, y: 0 }, panelDrag = null;
        dragBar.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            panelDrag = { sx: e.clientX, sy: e.clientY, ox: panelOffset.x, oy: panelOffset.y };
            try { dragBar.setPointerCapture(e.pointerId); } catch (err) {}
        });
        dragBar.addEventListener('pointermove', e => {
            if (!panelDrag) return;
            panelOffset.x = panelDrag.ox + (e.clientX - panelDrag.sx);
            panelOffset.y = panelDrag.oy + (e.clientY - panelDrag.sy);
            panel.style.transform = `translate(${panelOffset.x}px, ${panelOffset.y}px)`;
        });
        const stopPanelDrag = () => { panelDrag = null; };
        dragBar.addEventListener('pointerup', stopPanelDrag);
        dragBar.addEventListener('pointercancel', stopPanelDrag);

        refreshTplSelect();
        $('#cp_tpl').addEventListener('change', e => {
            getSettings().template = e.target.value; saveSettings();
            S.undo = []; S.drag = null;
            buildControls(); render();
        });
        $('#cp_customfont').value = getSettings().customFont;
        $('#cp_customfont').addEventListener('input', e => { getSettings().customFont = e.target.value.trim(); saveSettings(); scheduleRender(); });

        overlay.addEventListener('mousedown', e => { if (e.target === overlay) closePanel(); });
        $('#cp_close').addEventListener('click', closePanel);
        $('#cp_toggle').addEventListener('click', () => { overlay.classList.toggle('cp_focus'); setTimeout(render, 30); });
        $('#cp_text').addEventListener('input', e => { S.text = e.target.value; S.keep = null; S.slots = new Set(); scheduleRender(); });
        overlay.querySelectorAll('.cp_tabs button').forEach(b => b.addEventListener('click', () => {
            overlay.querySelectorAll('.cp_tabs button').forEach(x => x.classList.toggle('on', x === b));
            overlay.querySelectorAll('.cp_pane').forEach(p => { p.style.display = p.dataset.pane === b.dataset.tab ? '' : 'none'; });
        }));

        // 图片来源与裁剪缩放
        $('#cp_upload').addEventListener('click', () => pickFile('image/*', async f => {
            try { setRawImage(await loadImage(URL.createObjectURL(f))); render(); } catch (err) { toast(err.message); }
        }));
        $('#cp_crop_open').addEventListener('click', openCropModal);
        $('#cp_img_zoom').addEventListener('input', e => {
            const z = Number(e.target.value) / 100;
            const nw = 1 / z, nh = 1 / z;
            const cx = S.crop.x + S.crop.w / 2, cy = S.crop.y + S.crop.h / 2;
            S.crop = {
                x: clamp(cx - nw / 2, 0, 1 - nw),
                y: clamp(cy - nh / 2, 0, 1 - nh),
                w: nw,
                h: nh,
            };
            rebuildCroppedImage();
            scheduleRender();
        });
        $('#cp_avatar').addEventListener('click', async () => {
            const x = getCtx();
            const ch = x && x.characters && x.characters[x.characterId];
            if (!ch || !ch.avatar) return toast('当前没有选中角色');
            try { setRawImage(await loadImage('/characters/' + encodeURIComponent(ch.avatar))); render(); } catch (err) { toast(err.message); }
        });
        $('#cp_bg').addEventListener('click', async () => {
            const el = document.getElementById('bg1') || document.body;
            const m = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
            if (!m) return toast('当前没有聊天背景图');
            try { setRawImage(await loadImage(m[1])); render(); } catch (err) { toast(err.message); }
        });
        $('#cp_urlgo').addEventListener('click', async () => {
            const u = $('#cp_url').value.trim(); if (!u) return;
            try { setRawImage(await loadImage(u)); render(); } catch (err) { toast('加载失败（可能是跨域），请改用上传'); }
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
            downloadCanvas(cv, `cutout_${Date.now()}.png`);
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
            downloadBlob(new Blob([JSON.stringify({ cutoutPoster: 1, template: st.template, params: st.params, customFont: st.customFont }, null, 2)], { type: 'application/json' }), 'cutout_preset.json');
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
            S.keep = null; S.slots = new Set(); S.extract = { sel: new Set(), items: {} };
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
