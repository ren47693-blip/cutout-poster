/* 文字抽取成图 (Cutout Poster) v0.8 - SillyTavern 扩展
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
    function download(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
        s.customShapes ??= [];
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
    const TOKEN_RE = new RegExp(`{\\s*}|[${CJK}]|[^\\s${CJK}{]+|{`, 'g');
    let segmenter = null;
    function tokenizeLine(line, gran) {
        const out = [];
        if (gran === 'word' && window.Intl && Intl.Segmenter) {
            segmenter ??= new Intl.Segmenter(['zh', 'en'], { granularity: 'word' });
            for (const part of line.split(/({\s*})/)) {
                if (!part) continue;
                if (/^{\s*}$/.test(part)) { out.push({ t: part, slot: true, sp: false }); continue; }
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
            out.push({ t, slot: /^{\s*}$/.test(t), sp: !!nxt && /\s/.test(nxt) });
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
            case 'puzzle': {
                const sz = Math.min(w, h) * 0.65, r = sz * 0.17, d = r * 0.55, k = Math.sqrt(r * r - d * d), a = Math.atan2(d, k);
                const x0 = cx - sz / 2, y0 = cy - sz / 2, x1 = cx + sz / 2, y1 = cy + sz / 2, PI = Math.PI;
                c.moveTo(x0, y0); c.lineTo(cx - k, y0);
                c.arc(cx, y0 - d, r, PI - a, 2 * PI + a, false);
                c.lineTo(x1, y0); c.lineTo(x1, cy - k);
                c.arc(x1 + d, cy, r, 1.5 * PI - a, 2.5 * PI + a, false);
                c.lineTo(x1, y1); c.lineTo(cx + k, y1);
                c.arc(cx, y1 - d, r, a, PI - a, true);
                c.lineTo(x0, y1); c.lineTo(x0, cy + k);
                c.arc(x0 + d, cy, r, a + PI / 2, 1.5 * PI - a, true);
                c.closePath(); break;
            }
            case 'drop': {
                const r = w / 2, cyc = y + h - r, D = cyc - y, g = Math.acos(Math.min(0.99, r / Math.max(D, r + 1)));
                c.moveTo(cx, y);
                c.lineTo(cx + r * Math.cos(-Math.PI / 2 + g), cyc + r * Math.sin(-Math.PI / 2 + g));
                c.arc(cx, cyc, r, -Math.PI / 2 + g, 1.5 * Math.PI - g, false);
                c.closePath(); break;
            }
            case 'sparkle': {
                const k = 0.09;
                c.moveTo(cx, y);
                c.quadraticCurveTo(cx + w * k, cy - h * k, x + w, cy);
                c.quadraticCurveTo(cx + w * k, cy + h * k, cx, y + h);
                c.quadraticCurveTo(cx - w * k, cy + h * k, x, cy);
                c.quadraticCurveTo(cx - w * k, cy - h * k, cx, y);
                c.closePath(); break;
            }
            default: {
                if (typeof shape === 'string' && shape.startsWith('custom:')) {
                    const cs = (getSettings().customShapes || [])[+shape.slice(7)];
                    if (cs && cs.pts && cs.pts.length >= 3) {
                        const n = cs.pts.length;
                        const pt = i => { const q = cs.pts[((i % n) + n) % n]; return [cx + q[0] * w, cy + q[1] * h]; };
                        const a0 = pt(0), b0 = pt(1);
                        c.moveTo((a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2);
                        for (let i = 1; i <= n; i++) { const q = pt(i), r = pt(i + 1); c.quadraticCurveTo(q[0], q[1], (q[0] + r[0]) / 2, (q[1] + r[1]) / 2); }
                        c.closePath(); break;
                    }
                }
                c.rect(x, y, w, h);
            }
        }
    }

    /* ---------- 运行时状态 ---------- */
    const S = {
        text: '', img: null, imgId: 0, hits: [], geo: null,
        cut: { holes: [] }, sel: -1, slots: new Set(), keep: null, cells: null,
        edges: {}, tl: null, boxes: [], tmpBox: null, det: null, noGuides: false,
        detPos: {}, detLab: {}, boardImgs: [],
        vinylImgs: {}, consHoles: [], consSel: -1, consGeo: null,
        wsGrid: null, wsSeed: 1, wsMark: new Set(), wsGeo: null,
        cloze: newCloze(), clozeGeo: null, srcImg: null, closed: new Set(),
        drag: null, undo: [], ctls: {},
    };
    const TEMPLATES = {};
    const imgW = im => im.naturalWidth || im.width;
    const imgH = im => im.naturalHeight || im.height;

    /* ---------- 通用绘图/文字小工具 ---------- */
    function drawCover(c, img, x, y, w, h) {
        const sc = Math.max(w / imgW(img), h / imgH(img));
        const sw = w / sc, sh = h / sc;
        c.drawImage(img, (imgW(img) - sw) / 2, (imgH(img) - sh) / 2, sw, sh, x, y, w, h);
    }
    const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    function textLines(fallback) {
        const raw = (S.text || '').replace(/\r/g, '').trim() || fallback || SAMPLE;
        return raw.split('\n').map(t => t.trim());
    }
    const unitsOf = t => { t = t.trim(); return /\s/.test(t) ? t.split(/\s+/) : [...t]; };
    function romanize(n) {
        let r = '';
        for (const [v, t] of [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (n >= v) { r += t; n -= v; }
        return r;
    }
    const RATIOS = { '3:2': [3, 2], '16:9': [16, 9], '4:3': [4, 3], '1:1': [1, 1], '3:4': [3, 4], '2:3': [2, 3] };
    const RATIO_OPTS = [['3:2', '3:2 横'], ['16:9', '16:9 横'], ['4:3', '4:3 横'], ['1:1', '方形'], ['3:4', '3:4 竖'], ['2:3', '2:3 竖']];
    // 需要先设置 mctx.font；返回按宽度折行后的每行字符串
    function textBlock(text, maxW) {
        const spaceW = mctx.measureText(' ').width;
        const items = tokenize(text, 'char').map(tk => tk.nl ? { nl: true, w: 0 } : { t: tk.t, sp: tk.sp, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) });
        return wrap(items, maxW).map(l => l.items.filter(i => !i.nl).map(i => i.t + (i.sp ? ' ' : '')).join(''));
    }

    let noiseCv = null;
    function applyGrain(c, w, h, amount) {
        if (!amount) return;
        if (!noiseCv) {
            noiseCv = document.createElement('canvas'); noiseCv.width = noiseCv.height = 200;
            const nc = noiseCv.getContext('2d'), id = nc.createImageData(200, 200);
            for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
            nc.putImageData(id, 0, 0);
        }
        c.save(); c.globalAlpha = Math.min(1, amount / 100 * 0.35); c.globalCompositeOperation = 'overlay';
        c.fillStyle = c.createPattern(noiseCv, 'repeat'); c.fillRect(0, 0, w, h); c.restore();
    }
    /* ---------- 自定义形状：轮廓简化 / 从图片提取 ---------- */
    function simplifyPts(pts, eps) {
        if (pts.length < 3) return pts;
        const keep = new Uint8Array(pts.length);
        keep[0] = keep[pts.length - 1] = 1;
        const stack = [[0, pts.length - 1]];
        while (stack.length) {
            const [a, b] = stack.pop();
            const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay, len = Math.hypot(dx, dy) || 1e-9;
            let md = 0, mi = -1;
            for (let i = a + 1; i < b; i++) {
                const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
                if (d > md) { md = d; mi = i; }
            }
            if (mi >= 0 && md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
        }
        return pts.filter((_, i) => keep[i]);
    }
    function normalizeShape(raw) {
        const xs = raw.map(q => q[0]), ys = raw.map(q => q[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const bw = Math.max(1e-6, x1 - x0), bh = Math.max(1e-6, y1 - y0);
        let pts = raw.map(q => [(q[0] - x0) / bw - 0.5, (q[1] - y0) / bh - 0.5]);
        let eps = 0.006;
        pts = simplifyPts(pts, eps);
        while (pts.length > 70) { eps *= 1.4; pts = simplifyPts(pts, eps); }
        if (pts.length < 3) return null;
        return { pts: pts.map(q => [+q[0].toFixed(3), +q[1].toFixed(3)]), ratio: clamp(bh / bw, 0.2, 5) };
    }
    function largestComponent(mask, n) {
        const lab = new Int32Array(n * n);
        let best = 0, bestId = 0, id = 0;
        const stack = [];
        for (let i = 0; i < n * n; i++) {
            if (!mask[i] || lab[i]) continue;
            id++; let cnt = 0; stack.push(i); lab[i] = id;
            while (stack.length) {
                const j = stack.pop(); cnt++;
                const x = j % n, y = (j - x) / n;
                if (x > 0 && mask[j - 1] && !lab[j - 1]) { lab[j - 1] = id; stack.push(j - 1); }
                if (x < n - 1 && mask[j + 1] && !lab[j + 1]) { lab[j + 1] = id; stack.push(j + 1); }
                if (y > 0 && mask[j - n] && !lab[j - n]) { lab[j - n] = id; stack.push(j - n); }
                if (y < n - 1 && mask[j + n] && !lab[j + n]) { lab[j + n] = id; stack.push(j + n); }
            }
            if (cnt > best) { best = cnt; bestId = id; }
        }
        const out = new Uint8Array(n * n);
        for (let i = 0; i < n * n; i++) out[i] = lab[i] === bestId ? 1 : 0;
        return out;
    }
    function traceContour(mask, n) {
        const D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
        let sx = -1, sy = -1;
        outer: for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (mask[y * n + x]) { sx = x; sy = y; break outer; }
        if (sx < 0) return null;
        const at = (x, y) => x >= 0 && y >= 0 && x < n && y < n && mask[y * n + x];
        const pts = [[sx, sy]];
        let bx = sx, by = sy, back = 4;
        for (let step = 0; step < n * n * 2; step++) {
            let found = false;
            for (let i = 1; i <= 8; i++) {
                const d = (back + i) % 8, nx = bx + D[d][0], ny = by + D[d][1];
                if (at(nx, ny)) {
                    const pd = (back + i - 1 + 8) % 8, px = bx + D[pd][0], py = by + D[pd][1];
                    back = D.findIndex(v => v[0] === px - nx && v[1] === py - ny);
                    bx = nx; by = ny; found = true; break;
                }
            }
            if (!found) break;
            if (bx === sx && by === sy) break;
            pts.push([bx, by]);
        }
        return pts;
    }
    function shapeFromImage(im) {
        const n = 200, cv0 = document.createElement('canvas');
        cv0.width = cv0.height = n;
        const c0 = cv0.getContext('2d');
        const sc = Math.min(n / imgW(im), n / imgH(im)), w = imgW(im) * sc, h = imgH(im) * sc;
        c0.drawImage(im, (n - w) / 2, (n - h) / 2, w, h);
        let d;
        try { d = c0.getImageData(0, 0, n, n).data; } catch (e) { return null; }
        let transparent = 0;
        for (let i = 0; i < n * n; i++) if (d[i * 4 + 3] < 250) transparent++;
        const useAlpha = transparent > n * n * 0.02;
        const mask = new Uint8Array(n * n);
        for (let i = 0; i < n * n; i++) {
            const a = d[i * 4 + 3];
            if (useAlpha) mask[i] = a > 128 ? 1 : 0;
            else { const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; mask[i] = (a > 128 && l < 140) ? 1 : 0; }
        }
        const pts = traceContour(largestComponent(mask, n), n);
        if (!pts || pts.length < 8) return null;
        return normalizeShape(pts);
    }
    window.__cpGeo = { traceContour, largestComponent, normalizeShape, simplifyPts };
    const SAMPLE_CLOZE = '夫天地者，万物之逆旅也；\n光阴者，百代之过客也。\n而浮生若梦，为欢几何？';
    const SAMPLE_TIMELINE = '5/12  CONCEPT PHOTO #1\n5/15  CONCEPT PHOTO #2\n5/16  CONCEPT PHOTO #3\n\n5/22  TRACKLIST\n\n5/29  ALBUM RELEASE';
    const SAMPLE_DETECT = 'maybe we are all main characters\njust crossing paths in each others stories';
    const SAMPLE_BOARD = 'DESIGN AND RESEARCH\nThis design proposal developed out of the practice of making large-scale drawings, models and environments.\nTime-based plan of the proposed process\nSketch development\nModel, restoration hangar\nPortfolio, precedents\nBuilding components booklet\nRelief section';
    const SAMPLE_VINYL = 'MIDNIGHT SIDE\nside A\nFirst Light\nParade of Small Hours\nSalt and Static\nThe Long Way Round\nside B\nPaper Boats\nUndertow\nLast Train Home';
    const SAMPLE_CONS = 'we were never\nmeant to be\nconstellations';
    const SAMPLE_WS = 'LONGING\nSILENCE\nEMBER\nTIDE\nLANTERN\nVELVET';

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
    const BASE_SHAPES = [['square', '方形'], ['circle', '圆形'], ['rect', '长方形'], ['ellipse', '椭圆'], ['diamond', '菱形'], ['triangle', '三角'], ['star', '星形'], ['heart', '爱心'], ['puzzle', '拼图'], ['drop', '水滴'], ['sparkle', '四角星光']];
    function SHAPE_OPTS() {
        const cs = getSettings().customShapes || [];
        return [...BASE_SHAPES, ...cs.map((q, i) => q ? ['custom:' + i, '自定义 ' + (i + 1)] : null).filter(Boolean)];
    }
    const SHAPE_ASPECT = { drop: 1.35 };   // 高/宽
    function shapeRatio(P) {
        if (P.shape === 'rect' || P.shape === 'ellipse') return 1 / Math.max(0.2, P.aspect);
        if (typeof P.shape === 'string' && P.shape.startsWith('custom:')) {
            const cs = (getSettings().customShapes || [])[+P.shape.slice(7)];
            return cs ? clamp(cs.ratio, 0.2, 5) : 1;
        }
        return SHAPE_ASPECT[P.shape] || 1;
    }
    function holeGeom(P, h, IW, IH) {
        const w = (h.size ?? P.size) / 100;
        const hp = (IW * w * shapeRatio(P)) / IH;
        return {
            cx: clamp(h.cx, Math.min(w / 2, 0.5), Math.max(1 - w / 2, 0.5)),
            cy: clamp(h.cy, Math.min(hp / 2, 0.5), Math.max(1 - hp / 2, 0.5)),
            w, h: hp,
        };
    }
    // 碎片：rot = 碎片自己的角度；hrot = 洞的角度
    function drawFrag(c, P, g, dcx, dcy, dw, dh, rot, hrot, srcImg) {
        const img = srcImg || S.img, iwp = imgW(img), ihp = imgH(img);
        c.save();
        c.translate(dcx, dcy);
        if (rot) c.rotate(rot * Math.PI / 180);
        c.save();
        pathShape(c, P.shape, 0, 0, dw, dh);
        c.clip();
        if (hrot) c.rotate(-hrot * Math.PI / 180);
        const D = Math.hypot(g.w * iwp, g.h * ihp), D2 = Math.hypot(dw, dh);
        c.drawImage(img, g.cx * iwp - D / 2, g.cy * ihp - D / 2, D, D, -D2 / 2, -D2 / 2, D2, D2);
        c.restore();
        if (P.border) { pathShape(c, P.shape, 0, 0, dw, dh); c.lineWidth = 2; c.strokeStyle = P.fg; c.stroke(); }
        c.restore();
    }
    function drawRing(c, P, cx, cy, w, h, ang) {
        c.save(); c.translate(cx, cy); if (ang) c.rotate(ang * Math.PI / 180);
        c.setLineDash([10, 7]); c.lineWidth = 4; c.strokeStyle = '#3b9bff';
        pathShape(c, P.shape, 0, 0, w + 12, h + 12); c.stroke(); c.restore();
    }
    function fillHole(c, P, cx, cy, w, h, ang) {
        c.save(); c.translate(cx, cy); if (ang) c.rotate(ang * Math.PI / 180);
        pathShape(c, P.shape, 0, 0, w, h); c.fillStyle = P.bg; c.fill(); c.restore();
    }

    const cutout = {
        id: 'cutout',
        name: '挖洞置换',
        hint(P) {
            if (P.layout === 'slots') {
                return '点空白处挖洞；点洞选中（在「元素」里调大小、角度），按住洞可拖动，再点一下选中的洞删除。'
                    + (P.freeSlot
                        ? '点文字：在那个字的位置生成一块碎片，碎片浮在上层，可以拖到画面任何地方（文字不会消失）。'
                        : '点文字：这个字会被碎片替换（再点恢复）。槽位按文字顺序装入先挖的洞。');
            }
            return '点空白处挖洞；点洞选中（在「元素」里调大小、洞的角度、碎片的角度），按住洞可拖动，再点一下选中的洞删除。图外的碎片可以拖动。';
        },
        migrate(P) {
            if (P.layout === 'below') { P.layout = 'panel'; P.side = 'below'; }
            if (P.shape === 'bird') P.shape = 'circle';
            P.slotSide ??= 'below';
        },
        defaults: {
            layout: 'panel', side: 'below', arrange: 'mirror', panelPct: 100, framePct: 14, spread: 30, gridCols: 6,
            glyph: '', fillGlyph: true, fragScale: 100, gran: 'char', slotMode: 'replace', slotScale: 1.25,
            freeSlot: false, slotOpacity: 100, slotSide: 'below', slotImgPct: 100,
            shape: 'square', aspect: 1.5, size: 12,
            bg: '#f1efe6', fg: '#222222', glyphColor: '#ffffff', border: false, fontSize: 3.4, font: 'theme', grain: 0,
        },
        controls: [
            { group: '版面', key: 'layout', label: '碎片放在哪', type: 'select', options: [['panel', '图旁边的空白区'], ['frame', '图外一圈边框里'], ['slots', '文字里（替换 / 自由摆放）']] },
            { group: '版面', key: 'side', label: '空白区位置', type: 'select', options: [['below', '下方'], ['above', '上方'], ['right', '右边'], ['left', '左边']], show: P => P.layout === 'panel' },
            { group: '版面', key: 'arrange', label: '碎片排列', type: 'select', options: [['mirror', '对应原位置'], ['cluster', '聚拢成一堆'], ['grid', '整齐网格'], ['glyph', '排成一个字']], show: P => P.layout === 'panel' },
            { group: '版面', key: 'panelPct', label: '空白区大小 %', type: 'range', min: 30, max: 160, step: 5, show: P => P.layout === 'panel' },
            { group: '版面', key: 'framePct', label: '边框宽度 %', type: 'range', min: 5, max: 35, step: 1, show: P => P.layout === 'frame' },
            { group: '版面', key: 'spread', label: '聚拢程度 %', type: 'range', min: 5, max: 100, step: 5, show: P => P.layout === 'panel' && P.arrange === 'cluster' },
            { group: '版面', key: 'gridCols', label: '网格列数', type: 'range', min: 2, max: 12, step: 1, show: P => P.layout === 'panel' && P.arrange === 'grid' },
            { group: '版面', key: 'glyph', label: '要排成的字（空=取文字第一个字）', type: 'text', show: P => P.layout === 'panel' && P.arrange === 'glyph' },
            { group: '版面', key: 'fillGlyph', label: '碎片重复，铺满字形', type: 'checkbox', show: P => P.layout === 'panel' && P.arrange === 'glyph' },
            { group: '版面', key: 'fragScale', label: '碎片缩放 %', type: 'range', min: 30, max: 150, step: 5, show: P => P.layout !== 'slots' },
            { group: '版面', key: 'slotSide', label: '图片在文字的哪一边', type: 'select', options: [['below', '下方'], ['above', '上方'], ['right', '右边'], ['left', '左边']], show: P => P.layout === 'slots' },
            { group: '版面', key: 'slotImgPct', label: '图片区域大小 %', type: 'range', min: 40, max: 160, step: 5, show: P => P.layout === 'slots' && (P.slotSide === 'left' || P.slotSide === 'right') },
            { group: '版面', key: 'gran', label: '文字点选单位', type: 'select', options: [['char', '逐字'], ['word', '按词']], show: P => P.layout === 'slots', onChange() { S.slots = new Set(); } },
            { group: '版面', key: 'freeSlot', label: '碎片自由摆放（文字保留，碎片可拖到任意处）', type: 'checkbox', show: P => P.layout === 'slots' },
            { group: '版面', key: 'slotMode', label: '碎片放上去后', type: 'select', options: [['replace', '替换这个字（字消失）'], ['insert', '插在这个字后面（字保留）']], show: P => P.layout === 'slots' && !P.freeSlot },
            { group: '版面', key: 'slotScale', label: '文字里的碎片大小', type: 'range', min: 0.6, max: 4, step: 0.05, show: P => P.layout === 'slots' },
            { group: '版面', key: 'slotOpacity', label: '自由碎片不透明度 %', type: 'range', min: 20, max: 100, step: 5, show: P => P.layout === 'slots' && P.freeSlot },
            { group: '形状', key: 'shape', label: '洞的形状', type: 'select', options: SHAPE_OPTS },
            { group: '形状', key: 'aspect', label: '长宽比(长方形/椭圆)', type: 'range', min: 0.4, max: 3, step: 0.1, show: P => P.shape === 'rect' || P.shape === 'ellipse' },
            { group: '形状', key: 'drawShape', label: '手绘一个自定义形状', type: 'button', noUndo: true, onClick() { ui.openShapePad(); } },
            { group: '形状', key: 'imgShape', label: '用图片做形状（透明底或白底深色图案）', type: 'button', noUndo: true, onClick() { ui.pickShapeImage(); } },
            { group: '形状', key: 'delShape', label: '删除这个自定义形状', type: 'button', noUndo: true, show: P => String(P.shape).startsWith('custom:'), onClick(P) { ui.deleteCustomShape(P.shape); } },
            { group: '大小与角度', key: 'size', label: '新洞的默认大小 %', type: 'range', min: 3, max: 40, step: 1 },
            { group: '大小与角度', key: 'selSize', label: '选中的洞：大小 %', type: 'range', min: 2, max: 60, step: 1, show: () => S.sel >= 0,
              get(P) { const h = S.cut.holes[S.sel]; return h ? (h.size ?? P.size) : undefined; },
              set(v) { const h = S.cut.holes[S.sel]; if (h) h.size = v; } },
            { group: '大小与角度', key: 'selHoleRot', label: '选中的洞：洞的角度', type: 'range', min: -180, max: 180, step: 5, show: () => S.sel >= 0,
              get() { const h = S.cut.holes[S.sel]; return h ? (h.hrot || 0) : undefined; },
              set(v) { const h = S.cut.holes[S.sel]; if (h) h.hrot = v; } },
            { group: '大小与角度', key: 'selRot', label: '选中的碎片：碎片的角度', type: 'range', min: -180, max: 180, step: 5, show: () => S.sel >= 0,
              get() { const h = S.cut.holes[S.sel]; return h ? (h.rot || 0) : undefined; },
              set(v) { const h = S.cut.holes[S.sel]; if (h) h.rot = v; } },
            { group: '大小与角度', key: 'selFreeScale', label: '选中的自由碎片：大小 %', type: 'range', min: 20, max: 300, step: 5, show: P => P.layout === 'slots' && P.freeSlot && S.sel >= 0,
              get() { const h = S.cut.holes[S.sel]; return h ? (h.fs ?? 100) : undefined; },
              set(v) { const h = S.cut.holes[S.sel]; if (h) h.fs = v; } },
            { group: '大小与角度', key: 'delSel', label: '删除选中的洞', type: 'button', show: () => S.sel >= 0, onClick() { if (S.sel >= 0) S.cut.holes.splice(S.sel, 1); S.sel = -1; } },
            { group: '大小与角度', key: 'allSize', label: '所有洞改成默认大小', type: 'button', onClick(P) { S.cut.holes.forEach(h => { h.size = P.size; }); } },
            { group: '大小与角度', key: 'resetFree', label: '自由碎片放回默认位置', type: 'button', show: P => P.layout === 'slots' && P.freeSlot, onClick() { S.cut.holes.forEach(h => { delete h.fx; delete h.fy; }); } },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.5, max: 6, step: 0.1, show: P => P.layout === 'slots' },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS, show: P => P.layout === 'slots' || (P.layout === 'panel' && P.arrange === 'glyph') },
            { group: '颜色', key: 'bg', label: '底色/洞色', type: 'color' },
            { group: '颜色', key: 'fg', label: '文字/描边色', type: 'color' },
            { group: '颜色', key: 'glyphColor', label: '字形颜色', type: 'color', show: P => P.layout === 'panel' && P.arrange === 'glyph' },
            { group: '颜色', key: 'border', label: '碎片描边', type: 'checkbox' },
            { group: '质感', key: 'grain', label: '纸张颗粒 %', type: 'range', min: 0, max: 100, step: 5 },
        ],
        snap() { return JSON.stringify({ h: S.cut.holes, s: [...S.slots] }); },
        restore(str) { const d = JSON.parse(str); S.cut.holes = d.h; S.slots = new Set(d.s); S.sel = -1; },
        clear() { S.cut.holes = []; S.slots = new Set(); S.sel = -1; },
        render(cv, c, P) {
            const img = S.img, holes = S.cut.holes;
            const IW = 1200, IH = Math.round(IW * imgH(img) / imgW(img));
            if (S.sel >= holes.length) S.sel = -1;
            if (P.layout === 'slots') {
                const G0 = holes.map(h => holeGeom(P, h, IW, IH));
                renderSlotsAll(cv, c, P, IW, IH, holes, G0);
                applyGrain(c, cv.width, cv.height, P.grain);
                return;
            }
            let W, H, ix = 0, iy = 0, iw = IW, ih = IH, panel;
            if (P.layout === 'frame') {
                const m = Math.round(IW * P.framePct / 100);
                iw = IW - 2 * m; ih = Math.round(iw * imgH(img) / imgW(img));
                W = IW; H = ih + 2 * m; ix = m; iy = m; panel = { x: 0, y: 0, w: W, h: H };
            } else if (P.side === 'below' || P.side === 'above') {
                const ph = Math.round(IH * P.panelPct / 100);
                W = IW; H = IH + ph; iy = P.side === 'above' ? ph : 0;
                panel = { x: 0, y: P.side === 'above' ? 0 : IH, w: IW, h: ph };
            } else {
                const pw = Math.round(IW * P.panelPct / 100);
                W = IW + pw; H = IH; ix = P.side === 'left' ? pw : 0;
                panel = { x: P.side === 'left' ? 0 : IW, y: 0, w: pw, h: IH };
            }
            cv.width = W; cv.height = H;
            c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
            c.drawImage(img, ix, iy, iw, ih);
            S.geo = { x: ix, y: iy, w: iw, h: ih };
            const G = holes.map(h => holeGeom(P, h, iw, ih));
            G.forEach((g, i) => fillHole(c, P, ix + g.cx * iw, iy + g.cy * ih, g.w * iw, g.h * ih, holes[i].hrot || 0));
            const fsc = P.fragScale / 100;
            const sizes = G.map(g => ({ w: g.w * iw * fsc, h: g.h * ih * fsc }));
            let centers = null;
            if (P.layout === 'frame') {
                centers = G.map((g, i) => {
                    const sd = Math.floor(hash(i * 5 + 2) * 4), al = hash(i * 5 + 3), of = ix * 0.12 + hash(i * 5 + 4) * ix * 0.76;
                    if (sd === 0) return { x: ix + al * iw, y: of };
                    if (sd === 1) return { x: ix + al * iw, y: H - of };
                    if (sd === 2) return { x: of, y: iy + al * ih };
                    return { x: W - of, y: iy + al * ih };
                });
            } else if (P.arrange === 'cluster') {
                const cx0 = panel.x + panel.w / 2, cy0 = panel.y + panel.h / 2, sp = P.spread / 100;
                centers = G.map(g => ({ x: cx0 + (g.cx - 0.5) * panel.w * sp, y: cy0 + (g.cy - 0.5) * panel.h * sp }));
            } else if (P.arrange === 'grid') {
                const n = G.length, cols = Math.max(1, Math.min(P.gridCols, n || 1));
                const cell = Math.max(1, ...sizes.map(z => Math.max(z.w, z.h))) * 1.2, rows = Math.ceil(n / cols);
                const x0 = panel.x + panel.w / 2 - cols * cell / 2 + cell / 2, y0 = panel.y + panel.h / 2 - rows * cell / 2 + cell / 2;
                centers = G.map((g, i) => ({ x: x0 + (i % cols) * cell, y: y0 + Math.floor(i / cols) * cell }));
            } else if (P.arrange !== 'glyph') {
                centers = G.map(g => ({ x: panel.x + g.cx * panel.w, y: panel.y + g.cy * panel.h }));
            }
            if (centers) {
                G.forEach((g, i) => {
                    const o = holes[i];
                    const dx = centers[i].x + (o.ox || 0), dy = centers[i].y + (o.oy || 0);
                    drawFrag(c, P, g, dx, dy, sizes[i].w, sizes[i].h, o.rot || 0, o.hrot || 0);
                    S.hits.push({ kind: 'frag', i, x: dx - sizes[i].w / 2, y: dy - sizes[i].h / 2, w: sizes[i].w, h: sizes[i].h });
                });
                if (!S.noGuides && S.sel >= 0 && G[S.sel]) {
                    const o = holes[S.sel];
                    drawRing(c, P, centers[S.sel].x + (o.ox || 0), centers[S.sel].y + (o.oy || 0), sizes[S.sel].w, sizes[S.sel].h, o.rot || 0);
                }
            } else {
                const ch = (P.glyph || '').trim().slice(0, 2) || (S.text || '').trim().slice(0, 1) || '字';
                const gs = Math.min(panel.w, panel.h) * 0.78, fam = fontFamily(P.font);
                c.save(); c.fillStyle = P.glyphColor; c.font = `bold ${gs}px ${fam}`; c.textAlign = 'center'; c.textBaseline = 'middle';
                c.fillText(ch, panel.x + panel.w / 2, panel.y + panel.h / 2); c.restore();
                if (holes.length) {
                    const sc = 0.25, mk = document.createElement('canvas');
                    mk.width = Math.ceil(panel.w * sc); mk.height = Math.ceil(panel.h * sc);
                    const mc = mk.getContext('2d');
                    mc.font = `bold ${gs * sc}px ${fam}`; mc.textAlign = 'center'; mc.textBaseline = 'middle'; mc.fillStyle = '#000';
                    mc.fillText(ch, mk.width / 2, mk.height / 2);
                    let md = null;
                    try { md = mc.getImageData(0, 0, mk.width, mk.height).data; } catch (e) { md = null; }
                    const cell = Math.max(10, sizes.reduce((s0, z) => s0 + Math.max(z.w, z.h), 0) / sizes.length * 1.05);
                    const spots = [];
                    for (let yy = panel.y + cell / 2; yy < panel.y + panel.h; yy += cell) {
                        for (let xx = panel.x + cell / 2; xx < panel.x + panel.w; xx += cell) {
                            const px = Math.floor((xx - panel.x) * sc), py = Math.floor((yy - panel.y) * sc);
                            if (!md || md[(py * mk.width + px) * 4 + 3] > 100) spots.push({ x: xx, y: yy });
                        }
                    }
                    const n = holes.length, take = P.fillGlyph ? spots.length : Math.min(n, spots.length);
                    for (let k = 0; k < take; k++) {
                        const i = k % n, z = sizes[i], f = cell * 0.92 / Math.max(z.w, z.h);
                        drawFrag(c, P, G[i], spots[k].x, spots[k].y, z.w * f, z.h * f, holes[i].rot || 0, holes[i].hrot || 0);
                    }
                }
            }
            if (!S.noGuides && S.sel >= 0 && G[S.sel]) {
                const g = G[S.sel];
                drawRing(c, P, ix + g.cx * iw, iy + g.cy * ih, g.w * iw, g.h * ih, holes[S.sel].hrot || 0);
            }
            applyGrain(c, W, H, P.grain);
        },
        onDown(x, y, P) {
            const inside = h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
            for (let k = S.hits.length - 1; k >= 0; k--) {
                const h = S.hits[k];
                if ((h.kind === 'frag' || h.kind === 'free') && inside(h)) {
                    const ho = S.cut.holes[h.i];
                    S.sel = h.i;
                    S.drag = h.kind === 'free'
                        ? { kind: 'free', i: h.i, sx: x, sy: y, cx: h.x + h.w / 2, cy: h.y + h.h / 2, hw: h.w, hh: h.h }
                        : { kind: 'frag', i: h.i, sx: x, sy: y, ox: ho.ox || 0, oy: ho.oy || 0 };
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
            let hit = -1;
            for (let k = holes.length - 1; k >= 0; k--) {
                const q = holeGeom(P, holes[k], g.w, g.h);
                const a = -(holes[k].hrot || 0) * Math.PI / 180, dx = (fx - q.cx) * g.w, dy = (fy - q.cy) * g.h;
                const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
                if (Math.abs(lx) <= q.w * g.w / 2 && Math.abs(ly) <= q.h * g.h / 2) { hit = k; break; }
            }
            if (hit >= 0) {
                S.drag = { kind: 'hole', i: hit, sx: x, sy: y, cx0: holes[hit].cx, cy0: holes[hit].cy, moved: false, was: S.sel === hit };
                S.sel = hit;
                return true;
            }
            holes.push({ cx: fx, cy: fy, ox: 0, oy: 0, rot: 0, hrot: 0, size: P.size });
            S.sel = holes.length - 1;
            return true;
        },
        onMove(x, y) {
            const d = S.drag;
            if (!d) return false;
            const ho = S.cut.holes[d.i];
            if (!ho) return false;
            if (d.kind === 'frag') { ho.ox = d.ox + (x - d.sx); ho.oy = d.oy + (y - d.sy); return true; }
            if (d.kind === 'free') {
                const W2 = cv.width, H2 = cv.height;
                const nx = clamp(d.cx + (x - d.sx), d.hw / 2, W2 - d.hw / 2);
                const ny = clamp(d.cy + (y - d.sy), d.hh / 2, H2 - d.hh / 2);
                ho.fx = nx / W2; ho.fy = ny / H2;
                return true;
            }
            if (d.kind === 'hole') {
                const g = S.geo;
                if (Math.hypot(x - d.sx, y - d.sy) > 6) d.moved = true;
                if (d.moved && g) { ho.cx = clamp(d.cx0 + (x - d.sx) / g.w, 0, 1); ho.cy = clamp(d.cy0 + (y - d.sy) / g.h, 0, 1); }
                return true;
            }
            return false;
        },
        onUp() {
            const d = S.drag;
            if (d && d.kind === 'hole' && !d.moved && d.was) { S.cut.holes.splice(d.i, 1); S.sel = -1; }
            S.drag = null;
        },
    };

    // slots：先算出图片区和文字区的位置（图可在文字的下/上/左/右），再分派给两种排法
    function slotsFrame(P, IW, IH) {
        const side = P.slotSide || 'below';
        if (side === 'left' || side === 'right') {
            const iw = Math.round(IW * 0.52 * P.slotImgPct / 100);
            const ih = Math.round(iw * IH / IW);
            const tw = IW - iw;
            return { vert: false, iw, ih, tw, imgX: side === 'left' ? 0 : tw, txtX: side === 'left' ? iw : 0, side };
        }
        return { vert: true, iw: IW, ih: IH, tw: IW, imgX: 0, txtX: 0, side };
    }
    function renderSlotsAll(cv, c, P, IW, IH, holes, G) {
        const F = slotsFrame(P, IW, IH);
        if (P.freeSlot) renderSlotsFree(cv, c, P, IW, IH, holes, G, F);
        else renderSlots(cv, c, P, IW, IH, holes, G, F);
    }
    function renderSlots(cv, c, P, IW, IH, holes, G, F) {
        const W = IW, fs = Math.round(F.tw * P.fontSize / 100), fam = fontFamily(P.font);
        mctx.font = `${fs}px ${fam}`;
        const base = tokenize((S.text || '').trim() || SAMPLE, P.gran);
        const toks = [];
        base.forEach((t, i) => {
            if (!t.slot && !t.nl && S.slots.has(i)) {
                if (P.slotMode === 'insert') {
                    toks.push(Object.assign({}, t, { ti: i }));
                    toks.push({ t: '{ }', slot: true, sp: true, ti: -1, after: i });
                } else toks.push({ t: '{ }', slot: true, sp: t.sp, ti: -1, after: i, orig: t.t });
            } else toks.push(Object.assign({}, t, { ti: i }));
        });
        const spaceW = mctx.measureText(' ').width;
        let slotI = 0;
        const items = toks.map(tk => {
            if (tk.nl) return { nl: true, w: 0 };
            if (tk.slot) {
                const i = slotI++, g = G[i];
                if (!g && tk.orig !== undefined) {
                    return { t: tk.orig, pend: true, after: tk.after, w: mctx.measureText(tk.orig).width + (tk.sp ? spaceW : 0) };
                }
                let fh = fs * P.slotScale, fw = g ? fh * (g.w * F.iw) / (g.h * F.ih) : fh;
                const cap = F.tw * 0.5;
                if (fw > cap) { fw = cap; fh = g ? fw * (g.h * F.ih) / (g.w * F.iw) : fw; }
                return { slot: true, i, fw, fh, after: tk.after, w: fw + fs * 0.12 + (tk.sp ? spaceW : 0) };
            }
            return { t: tk.t, ti: tk.ti, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) };
        });
        const lines = wrap(items, F.tw * 0.84);
        lines.forEach(l => {
            const mf = Math.max(0, ...l.items.filter(i => i.slot).map(i => i.fh));
            l.lh = Math.max(fs * 1.9, mf ? mf + fs * 0.6 : 0);
        });
        const pad = fs * 2.5;
        const textH = Math.round(pad * 2 + lines.reduce((s0, l) => s0 + l.lh, 0));
        // 版面
        let H, imgY, txtY;
        if (F.vert) {
            H = textH + F.ih;
            imgY = F.side === 'above' ? 0 : textH;
            txtY = F.side === 'above' ? F.ih : 0;
        } else {
            H = Math.max(textH, F.ih);
            imgY = Math.round((H - F.ih) / 2); txtY = Math.round((H - textH) / 2);
        }
        cv.width = W; cv.height = H;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
        c.drawImage(S.img, F.imgX, imgY, F.iw, F.ih);
        S.geo = { x: F.imgX, y: imgY, w: F.iw, h: F.ih };
        G.forEach((g, i) => fillHole(c, P, F.imgX + g.cx * F.iw, imgY + g.cy * F.ih, g.w * F.iw, g.h * F.ih, holes[i].hrot || 0));
        if (!S.noGuides && S.sel >= 0 && G[S.sel]) {
            const g = G[S.sel];
            drawRing(c, P, F.imgX + g.cx * F.iw, imgY + g.cy * F.ih, g.w * F.iw, g.h * F.ih, holes[S.sel].hrot || 0);
        }
        c.font = `${fs}px ${fam}`; c.textBaseline = 'middle'; c.textAlign = 'left';
        let y = txtY + pad;
        lines.forEach(l => {
            let x = F.txtX + (F.tw - l.w) / 2;
            const cy = y + l.lh / 2;
            l.items.forEach(it => {
                if (it.nl) return;
                if (it.slot) {
                    const fx = x + fs * 0.06, g = G[it.i];
                    if (g) drawFrag(c, P, g, fx + it.fw / 2, cy, it.fw, it.fh, holes[it.i].rot || 0, holes[it.i].hrot || 0);
                    else if (!S.noGuides) {
                        c.save(); c.setLineDash([6, 5]); c.strokeStyle = P.fg;
                        c.strokeRect(fx, cy - it.fh / 2, it.fw, it.fh); c.restore();
                    }
                    if (it.after !== undefined) S.hits.push({ kind: 'sslot', i: it.after, x, y, w: it.w, h: l.lh });
                } else if (it.pend) {
                    c.fillStyle = P.fg; c.fillText(it.t, x, cy);
                    if (!S.noGuides) { c.save(); c.setLineDash([6, 5]); c.strokeStyle = '#3b9bff'; c.lineWidth = 2; c.strokeRect(x, cy - fs * 0.6, it.w, fs * 1.2); c.restore(); }
                    S.hits.push({ kind: 'sslot', i: it.after, x, y, w: it.w, h: l.lh });
                } else {
                    c.fillStyle = P.fg; c.fillText(it.t, x, cy);
                    S.hits.push({ kind: 'stok', i: it.ti, x, y, w: it.w, h: l.lh });
                }
                x += it.w;
            });
            y += l.lh;
        });
    }
    // 自由摆放：文字照常排版，碎片浮在上层，可拖到画布任意位置
    function renderSlotsFree(cv, c, P, IW, IH, holes, G, F) {
        const W = IW, fs = Math.round(F.tw * P.fontSize / 100), fam = fontFamily(P.font);
        mctx.font = `${fs}px ${fam}`;
        const toks = tokenize((S.text || '').trim() || SAMPLE, P.gran);
        const spaceW = mctx.measureText(' ').width;
        const items = toks.map((tk, i) => tk.nl ? { nl: true, w: 0 }
            : { t: tk.t, ti: i, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) });
        const lines = wrap(items, F.tw * 0.84);
        const lh = fs * 1.9, pad = fs * 2.5;
        const textH = Math.round(pad * 2 + lines.length * lh);
        let H, imgY, txtY;
        if (F.vert) {
            H = textH + F.ih;
            imgY = F.side === 'above' ? 0 : textH;
            txtY = F.side === 'above' ? F.ih : 0;
        } else {
            H = Math.max(textH, F.ih);
            imgY = Math.round((H - F.ih) / 2); txtY = Math.round((H - textH) / 2);
        }
        cv.width = W; cv.height = H;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
        c.drawImage(S.img, F.imgX, imgY, F.iw, F.ih);
        S.geo = { x: F.imgX, y: imgY, w: F.iw, h: F.ih };
        G.forEach((g, i) => fillHole(c, P, F.imgX + g.cx * F.iw, imgY + g.cy * F.ih, g.w * F.iw, g.h * F.ih, holes[i].hrot || 0));
        if (!S.noGuides && S.sel >= 0 && G[S.sel]) {
            const g = G[S.sel];
            drawRing(c, P, F.imgX + g.cx * F.iw, imgY + g.cy * F.ih, g.w * F.iw, g.h * F.ih, holes[S.sel].hrot || 0);
        }
        c.font = `${fs}px ${fam}`; c.textBaseline = 'middle'; c.textAlign = 'left';
        let y = txtY + pad;
        lines.forEach(l => {
            let x = F.txtX + (F.tw - l.w) / 2;
            const cy = y + lh / 2;
            l.items.forEach(it => {
                if (it.nl) return;
                c.fillStyle = P.fg; c.fillText(it.t, x, cy);
                S.hits.push({ kind: 'stok', i: it.ti, x, y, w: it.w, h: lh });
                x += it.w;
            });
            y += lh;
        });
        const picks = [...S.slots].sort((a, b) => a - b);
        c.save();
        c.globalAlpha = clamp(P.slotOpacity / 100, 0.2, 1);
        G.forEach((g, i) => {
            const o = holes[i], sc = (o.fs ?? 100) / 100;
            let fh = fs * P.slotScale * sc, fw = fh * (g.w * F.iw) / (g.h * F.ih);
            const cap = W * 0.6;
            if (fw > cap) { fw = cap; fh = fw * (g.h * F.ih) / (g.w * F.iw); }
            let dx, dy;
            if (o.fx !== undefined) { dx = o.fx * W; dy = o.fy * H; }
            else {
                const ti = picks[i];
                const at = ti !== undefined ? S.hits.find(h => h.kind === 'stok' && h.i === ti) : null;
                if (at) { dx = at.x + at.w / 2; dy = at.y + at.h / 2; }
                else { dx = F.txtX + F.tw * (0.2 + 0.6 * hash(i + 3)); dy = txtY + textH * (0.2 + 0.6 * hash(i + 11)); }
            }
            dx = clamp(dx, fw / 2, W - fw / 2);
            dy = clamp(dy, fh / 2, H - fh / 2);
            drawFrag(c, P, g, dx, dy, fw, fh, o.rot || 0, o.hrot || 0);
            S.hits.push({ kind: 'free', i, x: dx - fw / 2, y: dy - fh / 2, w: fw, h: fh });
        });
        c.restore();
        if (!S.noGuides && S.sel >= 0) {
            const h = S.hits.find(q => q.kind === 'free' && q.i === S.sel);
            if (h) drawRing(c, P, h.x + h.w / 2, h.y + h.h / 2, h.w, h.h, holes[S.sel].rot || 0);
        }
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
     * 模板 2：涂黑诗（解密档案风）
     * 点中的词 = 露出来可见；其余全部被黑条涂掉，字看不见
     * ===================================================== */
    const blackout = {
        id: 'blackout',
        name: '涂黑诗',
        hint: '点词语：这个词从涂黑里露出来；手指划过可连选。没点的地方会被黑条盖住，底下的字完全看不见。没有露字的行在导出时不会出现。',
        defaults: { gran: 'char', fontSize: 3.6, font: 'theme', gap: 20, pad: 14, redact: true, paper: '#f4efdc', ink: '#111111', bar: '#111111' },
        controls: [
            { group: '点选', key: 'gran', label: '点选单位', type: 'select', options: [['char', '逐字'], ['word', '按词(中文自动分词)']], onChange() { S.keep = null; } },
            { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.8, max: 7, step: 0.1 },
            { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
            { group: '文字', key: 'pad', label: '露字处左右留白 %', type: 'range', min: 0, max: 80, step: 2 },
            { group: '文字', key: 'gap', label: '黑条上下留白 %', type: 'range', min: 0, max: 50, step: 2 },
            { group: '文字', key: 'redact', label: '黑条断开（分段涂抹的感觉）', type: 'checkbox' },
            { group: '颜色', key: 'paper', label: '纸色', type: 'color' },
            { group: '颜色', key: 'ink', label: '露出来的字色', type: 'color' },
            { group: '颜色', key: 'bar', label: '黑条颜色', type: 'color' },
        ],
        exportOk() { return !!(S.keep && S.keep.set.size); },
        exportMsg: '还没有露出任何字，先点几个词吧',
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
            const guides = !S.noGuides;
            const shownAny = lines.map(l => l.items.some(it => !it.nl && S.keep.set.has(it.i)));
            // 预览显示所有行（便于点选）；导出只保留有露字的行并压紧
            const shown = [];
            lines.forEach((l, li) => { if (guides || shownAny[li]) shown.push(li); });
            const rows = Math.max(1, shown.length);
            cv.width = W; cv.height = Math.round(M * 2 + rows * lh);
            c.fillStyle = P.paper; c.fillRect(0, 0, W, cv.height);
            c.font = `${fs}px ${fam}`; c.textBaseline = 'middle';
            const pad = fs * P.pad / 100;                 // 露字处左右留白
            const barTop = lh * clamp(P.gap / 100 * 0.5, 0, 0.4);
            const barH = lh - barTop * 2;
            shown.forEach((li, row) => {
                const y = M + row * lh;
                const real = lines[li].items.filter(it => !it.nl);
                let x = M;
                const pos = real.map(it => { const p = { it, x }; x += it.w; return p; });
                const lineEnd = pos.length ? pos[pos.length - 1].x + pos[pos.length - 1].it.w : M;
                // 1) 先铺黑条：整行涂黑
                c.fillStyle = P.bar;
                if (P.redact) {
                    // 按「涂黑段」分别画，段与段之间留一点缝，像分次涂抹
                    let a = 0;
                    while (a < pos.length) {
                        if (S.keep.set.has(pos[a].it.i)) { a++; continue; }
                        let b = a;
                        while (b + 1 < pos.length && !S.keep.set.has(pos[b + 1].it.i)) b++;
                        const x0 = (a === 0 ? M : pos[a].x - pad), x1 = (b === pos.length - 1 ? lineEnd : pos[b].x + pos[b].it.w + pad);
                        c.fillRect(x0, y + barTop, Math.max(0, x1 - x0), barH);
                        a = b + 1;
                    }
                } else {
                    c.fillRect(M, y + barTop, lineEnd - M, barH);
                    // 在露字处挖回纸色窗口
                    c.fillStyle = P.paper;
                    let a = 0;
                    while (a < pos.length) {
                        if (!S.keep.set.has(pos[a].it.i)) { a++; continue; }
                        let b = a;
                        while (b + 1 < pos.length && S.keep.set.has(pos[b + 1].it.i)) b++;
                        const x0 = Math.max(M, pos[a].x - pad), x1 = Math.min(lineEnd, pos[b].x + pos[b].it.w + pad);
                        c.fillRect(x0, y + barTop, x1 - x0, barH);
                        a = b + 1;
                    }
                }
                // 2) 只画露出来的字（涂黑处的字根本不画，所以绝对看不见）
                c.fillStyle = P.ink;
                pos.forEach(p => { if (S.keep.set.has(p.it.i)) c.fillText(p.it.t, p.x, y + lh / 2); });
                // 3) 预览里在黑条上用暗灰描出轮廓，方便知道点哪儿
                if (guides) {
                    c.save(); c.globalAlpha = 0.34; c.fillStyle = '#9aa3ad';
                    pos.forEach(p => { if (!S.keep.set.has(p.it.i)) c.fillText(p.it.t, p.x, y + lh / 2); });
                    c.restore();
                }
                pos.forEach(p => S.hits.push({ kind: 'tok', i: p.it.i, x: p.x, y, w: p.it.w, h: lh }));
            });
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
 * 模板 4：文字塑形
 * ===================================================== */
function shapePlace(x, y, P, ui2) {
    const F = P.frame, IH = Math.round(1200 * imgH(S.img) / imgW(S.img));
    const fx = clamp((x - F) / 1200 * 100, 0, 100), fy = clamp((y - F) / IH * 100, 0, 100);
    if (P.mode === 'shape' || P.mode === 'ring') { ui2.setParam('sx', Math.round(fx)); ui2.setParam('sy', Math.round(fy)); }
    else if (P.mode === 'wave') ui2.setParam('waveY', Math.round(fy));
    else ui2.setParam('zone', Math.round(clamp(fx, 0, 95)));
}
function textRegion(c, P, T, IW, IH) {
    let data = null;
    try {
        const t = document.createElement('canvas'); t.width = IW; t.height = IH;
        const tc = t.getContext('2d'); tc.drawImage(S.img, 0, 0, IW, IH);
        data = tc.getImageData(0, 0, IW, IH).data;
    } catch (e) { data = null; }
    const zoneX = Math.floor(IW * P.zone / 100), { fs, lh } = T;
    const ok = (x, y) => {
        if (!data) return true;
        const i = ((y | 0) * IW + (x | 0)) * 4;
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        return P.invert ? l >= P.thr : l <= P.thr;
    };
    const sp = T.hasSp ? T.spaceW : 0;
    for (let y = 0; y + lh <= IH; y += lh) {
        const ys = [y + lh * 0.2, y + lh * 0.5, y + lh * 0.8].map(v => clamp(v, 0, IH - 1));
        let best = null, start = -1, gap = 0, last = -1;
        const take = () => { const seg = { a: start, b: last + 4 }; if (!best || seg.b - seg.a > best.b - best.a) best = seg; };
        for (let x = zoneX; x < IW; x += 4) {
            if (ys.every(yy => ok(x, yy))) { if (start < 0) start = x; last = x; gap = 0; }
            else if (start >= 0 && ++gap > 2) { take(); start = -1; gap = 0; }
        }
        if (start >= 0) take();
        if (!best) continue;
        const avail = best.b - best.a - fs * 0.2;
        if (avail < fs * 2) continue;
        const picks = [];
        let sum = 0;
        while (picks.length < 80) {
            const k = (T.cursor + picks.length) % T.units.length;
            const add = (picks.length ? sp : 0) + T.widths[k];
            if (sum + add > avail) break;
            sum += add; picks.push(k);
        }
        if (!picks.length) continue;
        T.cursor = (T.cursor + picks.length) % T.units.length;
        const total = picks.reduce((s0, k) => s0 + T.widths[k], 0);
        let gapW = sp, x0 = best.a + fs * 0.1;
        if (P.align === 'justify' && picks.length > 1) gapW = (avail - total) / (picks.length - 1);
        else {
            const used = total + gapW * (picks.length - 1);
            if (P.align === 'right') x0 = best.b - fs * 0.1 - used;
            else if (P.align === 'center') x0 = best.a + (avail - used) / 2;
        }
        let x = x0;
        picks.forEach(k => { c.fillText(T.units[k], x, y + lh / 2); x += T.widths[k] + gapW; });
    }
}
function textInShape(c, P, T, IW, IH) {
    const sw = IW * P.shapeSize / 100, sh = sw * shapeRatio({ shape: P.tshape, aspect: P.shapeAspect });
    const cx = IW * P.sx / 100, cy = IH * P.sy / 100, sp = T.hasSp ? T.spaceW : 0;
    c.save();
    pathShape(c, P.tshape, cx, cy, sw, sh);
    if (P.fillOn) { c.fillStyle = P.shapeFill; c.fill(); }
    c.clip();
    c.fillStyle = P.color;
    for (let y = cy - sh / 2 + T.lh * 0.5; y < cy + sh / 2 + T.lh; y += T.lh) {
        let x = cx - sw / 2 - T.fs;
        while (x < cx + sw / 2 + T.fs) {
            const k = T.cursor % T.units.length;
            c.fillText(T.units[k], x, y);
            x += T.widths[k] + sp; T.cursor++;
        }
    }
    c.restore();
}
function drawAlong(c, pts, T) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1], sp = T.hasSp ? T.spaceW : 0;
    let s0 = 0, seg = 1;
    while (s0 < total) {
        const k = T.cursor % T.units.length, w = T.widths[k], mid = s0 + w / 2;
        if (mid > total) break;
        while (seg < cum.length - 1 && cum[seg] < mid) seg++;
        const t = (mid - cum[seg - 1]) / Math.max(1e-6, cum[seg] - cum[seg - 1]);
        const x = pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * t, y = pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * t;
        const ang = Math.atan2(pts[seg][1] - pts[seg - 1][1], pts[seg][0] - pts[seg - 1][0]);
        c.save(); c.translate(x, y); c.rotate(ang); c.textAlign = 'center'; c.fillText(T.units[k], 0, 0); c.restore();
        s0 += w + sp; T.cursor++;
    }
}
function textWave(c, P, T, IW, IH) {
    const A = IH * P.amp / 100, L = Math.max(40, IW * P.wl / 100), n = P.waveN;
    for (let k = 0; k < n; k++) {
        const y0 = IH * P.waveY / 100 + (k - (n - 1) / 2) * T.lh * 1.25;
        const pts = [];
        for (let x = -40; x <= IW + 40; x += 3) pts.push([x, y0 + A * Math.sin(2 * Math.PI * x / L)]);
        drawAlong(c, pts, T);
    }
}
function textRing(c, P, T, IW, IH) {
    const cx = IW * P.sx / 100, cy = IH * P.sy / 100, R = IW * P.shapeSize / 200, rMin = Math.max(T.fs * 1.2, 4);
    const gapW = T.hasSp ? T.spaceW : 0;
    const put = (k, ang, r) => {
        c.save(); c.translate(cx + r * Math.cos(ang), cy + r * Math.sin(ang)); c.rotate(ang + Math.PI / 2);
        c.textAlign = 'center'; c.fillText(T.units[k], 0, 0); c.restore();
    };
    if (P.ringType === 'rings') {
        for (let r = R; r > rMin; r -= T.lh) {
            const circ = 2 * Math.PI * r, picks = [];
            let sum = 0;
            while (picks.length < 400) {
                const k = (T.cursor + picks.length) % T.units.length, add = T.widths[k] + gapW;
                if (sum + add > circ) break;
                sum += add; picks.push(k);
            }
            if (!picks.length) break;
            T.cursor = (T.cursor + picks.length) % T.units.length;
            const extra = (circ - sum) / picks.length;
            let s0 = 0;
            picks.forEach(k => { const w = T.widths[k]; put(k, -Math.PI / 2 + (s0 + w / 2) / r, r); s0 += w + gapW + extra; });
        }
    } else {
        let ang = -Math.PI / 2, r = R;
        const b = T.lh / (2 * Math.PI);
        for (let it = 0; it < 6000 && r > rMin; it++) {
            const k = T.cursor % T.units.length, w = T.widths[k] + gapW, dth = w / r;
            put(k, ang + dth / 2, r - b * dth / 2);
            ang += dth; r -= b * dth; T.cursor++;
        }
    }
}
function textVertical(c, P, T, IW, IH) {
    const zoneX = IW * P.zone / 100, col = T.lh, step = T.fs * 1.08;
    for (let x = IW - col / 2; x > zoneX; x -= col) {
        let y = T.fs * 0.6;
        while (y < IH - T.fs * 0.3) {
            const k = T.cursor % T.units.length;
            if (T.hasSp) {
                const w = T.widths[k];
                c.save(); c.translate(x, y + w / 2); c.rotate(Math.PI / 2); c.textAlign = 'center'; c.fillText(T.units[k], 0, 0); c.restore();
                y += w + T.spaceW;
            } else {
                c.save(); c.textAlign = 'center'; c.fillText(T.units[k], x, y + step / 2); c.restore();
                y += step;
            }
            T.cursor++;
        }
    }
}
const shape = {
    id: 'shape',
    name: '文字塑形',
    hint(P) {
        return ({
            region: '文字沿着画面里「暗色」的区域排布，亮色区域留空。在图上点一下，设置文字区域的左边界。',
            shape: '文字填满一个形状。点图或拖动，可以移动形状的位置。',
            wave: '文字沿着波浪线排布。点图或拖动，可以上下移动波浪。',
            ring: '文字绕成圆环或螺旋。点图或拖动，可以移动圆心。',
            vertical: '文字竖排，从右往左。点图可以设置竖排区域的左边界。',
        })[P.mode] || '';
    },
    defaults: {
        mode: 'region', zone: 40, thr: 140, invert: false, align: 'justify',
        tshape: 'circle', shapeAspect: 1, shapeSize: 60, sx: 50, sy: 50, fillOn: true, shapeFill: '#141414', ringType: 'spiral',
        waveN: 4, amp: 12, wl: 50, waveY: 50,
        fontSize: 2.3, lineGap: 1.3, upper: true, font: 'theme', color: '#f3dcc8', caption: '', dim: 10, frame: 60, frameColor: '#000000', grain: 0,
    },
    controls: [
        { group: '排字方式', key: 'mode', label: '类型', type: 'select', options: [['region', '沿画面暗/亮区域'], ['shape', '填满一个形状'], ['wave', '走成波浪线'], ['ring', '绕成圆环 / 螺旋'], ['vertical', '竖排（从右往左）']] },
        { group: '排布', key: 'zone', label: '文字区域左边界 %', type: 'range', min: 0, max: 95, step: 1, show: P => P.mode === 'region' || P.mode === 'vertical' },
        { group: '排布', key: 'thr', label: '亮度阈值', type: 'range', min: 20, max: 240, step: 1, show: P => P.mode === 'region' },
        { group: '排布', key: 'invert', label: '反转（改在亮色区排字）', type: 'checkbox', show: P => P.mode === 'region' },
        { group: '排布', key: 'align', label: '对齐方式', type: 'select', options: [['justify', '两端撑满'], ['left', '靠左'], ['right', '靠右'], ['center', '居中']], show: P => P.mode === 'region' },
        { group: '形状', key: 'tshape', label: '形状', type: 'select', options: SHAPE_OPTS, show: P => P.mode === 'shape' },
        { group: '形状', key: 'shapeAspect', label: '长宽比(长方形/椭圆)', type: 'range', min: 0.4, max: 3, step: 0.1, show: P => P.mode === 'shape' && (P.tshape === 'rect' || P.tshape === 'ellipse') },
        { group: '形状', key: 'shapeSize', label: '大小 %', type: 'range', min: 10, max: 100, step: 1, show: P => P.mode === 'shape' || P.mode === 'ring' },
        { group: '形状', key: 'fillOn', label: '形状里垫一层底色', type: 'checkbox', show: P => P.mode === 'shape' },
        { group: '形状', key: 'shapeFill', label: '底色', type: 'color', show: P => P.mode === 'shape' && P.fillOn },
        { group: '形状', key: 'ringType', label: '环的样式', type: 'select', options: [['spiral', '螺旋'], ['rings', '同心圆环']], show: P => P.mode === 'ring' },
        { group: '形状', key: 'drawShape', label: '手绘一个自定义形状', type: 'button', noUndo: true, show: P => P.mode === 'shape', onClick() { ui.openShapePad(); } },
        { group: '形状', key: 'imgShape', label: '用图片做形状', type: 'button', noUndo: true, show: P => P.mode === 'shape', onClick() { ui.pickShapeImage(); } },
        { group: '形状', key: 'delShape', label: '删除这个自定义形状', type: 'button', noUndo: true, show: P => P.mode === 'shape' && String(P.tshape).startsWith('custom:'), onClick(P) { ui.deleteCustomShape(P.tshape); } },
        { group: '波浪', key: 'waveN', label: '几行', type: 'range', min: 1, max: 12, step: 1, show: P => P.mode === 'wave' },
        { group: '波浪', key: 'amp', label: '起伏高度 %', type: 'range', min: 2, max: 40, step: 1, show: P => P.mode === 'wave' },
        { group: '波浪', key: 'wl', label: '波长 %', type: 'range', min: 15, max: 120, step: 1, show: P => P.mode === 'wave' },
        { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.2, max: 5, step: 0.1 },
        { group: '文字', key: 'lineGap', label: '行距', type: 'range', min: 1, max: 2, step: 0.05 },
        { group: '文字', key: 'upper', label: '英文转大写', type: 'checkbox' },
        { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
        { group: '文字', key: 'caption', label: '左上角小标题（空格分词，逐行错开）', type: 'text' },
        { group: '画面', key: 'dim', label: '压暗图片 %', type: 'range', min: 0, max: 70, step: 1 },
        { group: '画面', key: 'frame', label: '边框宽度', type: 'range', min: 0, max: 150, step: 2 },
        { group: '颜色', key: 'color', label: '文字颜色', type: 'color' },
        { group: '颜色', key: 'frameColor', label: '边框颜色', type: 'color' },
        { group: '质感', key: 'grain', label: '颗粒感 %', type: 'range', min: 0, max: 100, step: 5 },
    ],
    render(cv, c, P) {
        const img = S.img, IW = 1200, IH = Math.round(IW * imgH(img) / imgW(img)), F = P.frame;
        cv.width = IW + F * 2; cv.height = IH + F * 2;
        c.fillStyle = P.frameColor; c.fillRect(0, 0, cv.width, cv.height);
        c.drawImage(img, F, F, IW, IH);
        if (P.dim > 0) { c.fillStyle = `rgba(0,0,0,${P.dim / 100})`; c.fillRect(F, F, IW, IH); }
        const fam = fontFamily(P.font), fs = Math.round(IW * P.fontSize / 100), lh = fs * P.lineGap;
        c.font = `bold ${fs}px ${fam}`; mctx.font = c.font;
        const raw = ((S.text || '').trim() || SAMPLE).replace(/\s*\n\s*/g, ' ');
        const hasSp = /\s/.test(raw);
        let units = hasSp ? raw.split(/\s+/) : [...raw];
        if (P.upper) units = units.map(w => w.toUpperCase());
        const T = { units, widths: units.map(w => mctx.measureText(w).width), spaceW: hasSp ? mctx.measureText(' ').width : 0, hasSp, cursor: 0, fs, lh };
        c.save();
        c.translate(F, F); c.beginPath(); c.rect(0, 0, IW, IH); c.clip();
        c.fillStyle = P.color; c.textBaseline = 'middle'; c.textAlign = 'left'; c.font = `bold ${fs}px ${fam}`;
        if (P.mode === 'shape') textInShape(c, P, T, IW, IH);
        else if (P.mode === 'wave') textWave(c, P, T, IW, IH);
        else if (P.mode === 'ring') textRing(c, P, T, IW, IH);
        else if (P.mode === 'vertical') textVertical(c, P, T, IW, IH);
        else textRegion(c, P, T, IW, IH);
        c.restore();
        if (P.caption.trim()) {
            const cf = Math.round(IW * 0.016);
            c.font = `bold ${cf}px ${fam}`; c.fillStyle = P.color; c.textBaseline = 'middle'; c.textAlign = 'left';
            P.caption.trim().split(/\s+/).forEach((w, i) => c.fillText(P.upper ? w.toUpperCase() : w, F + IW * 0.07 + i * IW * 0.035, F + IH * 0.1 + i * cf * 1.5));
        }
        applyGrain(c, cv.width, cv.height, P.grain);
    },
    onDown(x, y, P, ui2) { shapePlace(x, y, P, ui2); S.drag = { place: true }; return true; },
    onMove(x, y, P, ui2) { if (!S.drag || !S.drag.place) return false; shapePlace(x, y, P, ui2); return true; },
    onUp() { S.drag = null; },
};

/* =====================================================
 * 模板 5：切边时间表
 * ===================================================== */
const timeline = {
    id: 'timeline',
    name: '切边时间表',
    hint: '每一行文字占一个色块，空行 = 空白色块。在图上左右拖动，可调整那一行切进画面的深度。',
    defaults: { ratio: '3:2', bands: 20, startBand: 1, jag: 50, fontSize: 1.7, font: 'theme', title: '', footer: '', panel: '#bfc0b8', ink: '#111111', grain: 0 },
    controls: [
        { group: '版面', key: 'ratio', label: '画面比例', type: 'select', options: RATIO_OPTS },
        { group: '版面', key: 'bands', label: '色块行数', type: 'range', min: 8, max: 40, step: 1 },
        { group: '版面', key: 'startBand', label: '文字从第几行开始', type: 'range', min: 0, max: 12, step: 1 },
        { group: '版面', key: 'jag', label: '默认错落程度', type: 'range', min: 0, max: 100, step: 5 },
        { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1, max: 3.5, step: 0.1 },
        { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
        { group: '文字', key: 'title', label: '右上角大标题', type: 'text' },
        { group: '文字', key: 'footer', label: '右下角小字（换行用 / ）', type: 'text' },
        { group: '颜色', key: 'panel', label: '色块颜色', type: 'color' },
        { group: '颜色', key: 'ink', label: '文字颜色', type: 'color' },
        { group: '质感', key: 'grain', label: '颗粒感 %', type: 'range', min: 0, max: 100, step: 5 },
    ],
    snap() { return JSON.stringify(S.edges); },
    restore(str) { S.edges = JSON.parse(str); },
    clear() { S.edges = {}; },
    render(cv, c, P) {
        const [rw, rh] = RATIOS[P.ratio] || [3, 2], W = 1200, H = Math.round(W * rh / rw);
        cv.width = W; cv.height = H;
        drawCover(c, S.img, 0, 0, W, H);
        const nb = P.bands, bh = H / nb, fs = Math.round(W * P.fontSize / 100), fam = fontFamily(P.font);
        const lines = textLines(SAMPLE_TIMELINE);
        const padX = fs * 0.9;
        S.tl = { bh, nb, W };
        c.textBaseline = 'middle'; c.textAlign = 'left';
        for (let b = 0; b < nb; b++) {
            const li = b - P.startBand;
            const txt = (li >= 0 && li < lines.length) ? lines[li] : '';
            const parts = txt ? txt.split(/\s{2,}|\t/) : [];
            let w1 = 0, w2 = 0;
            const colGap = fs * 1.2;
            if (txt) {
                mctx.font = `bold ${fs}px ${fam}`; w1 = mctx.measureText(parts[0]).width;
                if (parts.length > 1) { mctx.font = `${fs}px ${fam}`; w2 = mctx.measureText(parts.slice(1).join(' ')).width; }
            }
            const tw = w1 + (parts.length > 1 ? colGap + w2 : 0);
            let edge = W * clamp(0.5 + P.jag / 100 * 0.2 * (hash(b + 1) * 2 - 1), 0.1, 0.92);
            if (S.edges[b] !== undefined) edge = S.edges[b] * W;
            if (txt) edge = Math.min(edge, W - tw - padX * 2 - W * 0.02);
            c.fillStyle = P.panel;
            c.fillRect(Math.round(edge), Math.floor(b * bh), W - Math.round(edge) + 1, Math.ceil(bh) + 1);
            if (txt) {
                c.fillStyle = P.ink;
                c.font = `bold ${fs}px ${fam}`; c.fillText(parts[0], edge + padX, b * bh + bh / 2);
                if (parts.length > 1) { c.font = `${fs}px ${fam}`; c.fillText(parts.slice(1).join(' '), edge + padX + w1 + colGap, b * bh + bh / 2); }
            }
        }
        if (P.title.trim()) {
            const tf = Math.round(W * 0.05);
            c.font = `900 ${tf}px ${fam}`;
            const tw = c.measureText(P.title).width;
            c.fillStyle = P.panel; c.fillRect(W - tw - W * 0.06, 0, tw + W * 0.06, tf * 1.6);
            c.fillStyle = P.ink; c.textAlign = 'right'; c.fillText(P.title, W - W * 0.03, tf * 0.95); c.textAlign = 'left';
        }
        if (P.footer.trim()) {
            const ff = Math.round(W * 0.012), fl = P.footer.split('/').map(t => t.trim());
            c.font = `bold ${ff}px ${fam}`;
            const fw = Math.max(...fl.map(t => c.measureText(t).width));
            c.fillStyle = P.panel; c.fillRect(W - fw - W * 0.06, H - fl.length * ff * 1.5 - W * 0.03, fw + W * 0.06, fl.length * ff * 1.5 + W * 0.03);
            c.fillStyle = P.ink; c.textAlign = 'right';
            fl.forEach((t, i) => c.fillText(t, W - W * 0.03, H - W * 0.02 - (fl.length - 1 - i) * ff * 1.5));
            c.textAlign = 'left';
        }
        applyGrain(c, W, H, P.grain);
    },
    onDown(x, y) { const t = S.tl; if (!t) return false; setEdge(x, y); S.drag = { edge: true }; return true; },
    onMove(x, y) { if (!S.drag || !S.drag.edge) return false; setEdge(x, y); return true; },
    onUp() { S.drag = null; },
};
function setEdge(x, y) {
    const t = S.tl;
    const b = clamp(Math.floor(y / t.bh), 0, t.nb - 1);
    S.edges[b] = clamp(x / t.W, 0.05, 0.97);
}

/* =====================================================
 * 模板 6：检测框关系图
 * ===================================================== */
const detect = {
    id: 'detect',
    name: '检测框关系图',
    hint: '在上方图片上拖出方框（点一下方框可删除）。下方的碎片、以及图上和下方的文字标签，都可以按住拖到任意位置。',
    defaults: { k: 2, cropScale: 1, panelH: 100, fontSize: 2.4, font: 'theme', labels: true, box: '#2f5be8', label: '#1d4ed8', panel: '#1250e8', lineColor: '#ffffff' },
    controls: [
        { group: '关系图', key: 'k', label: '每个方块连向最近的几个', type: 'range', min: 0, max: 4, step: 1 },
        { group: '关系图', key: 'cropScale', label: '碎片缩放', type: 'range', min: 0.4, max: 2, step: 0.1 },
        { group: '关系图', key: 'panelH', label: '下方区域高度 %', type: 'range', min: 50, max: 140, step: 5 },
        { group: '关系图', key: 'resetLayout', label: '碎片和文字放回默认位置', type: 'button', onClick() { S.detPos = {}; S.detLab = {}; } },
        { group: '文字', key: 'labels', label: '显示文字标签', type: 'checkbox' },
        { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 1.2, max: 5, step: 0.1 },
        { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
        { group: '颜色', key: 'box', label: '方框颜色', type: 'color' },
        { group: '颜色', key: 'label', label: '图上文字颜色', type: 'color' },
        { group: '颜色', key: 'panel', label: '下方底色', type: 'color' },
        { group: '颜色', key: 'lineColor', label: '连线/下方文字色', type: 'color' },
    ],
    exportOk() { return S.boxes.length > 0; },
    exportMsg: '还没有画方框，先在图上拖出几个吧',
    snap() { return JSON.stringify({ b: S.boxes, p: S.detPos, l: S.detLab }); },
    restore(str) { const d = JSON.parse(str); S.boxes = d.b || []; S.detPos = d.p || {}; S.detLab = d.l || {}; },
    clear() { S.boxes = []; S.detPos = {}; S.detLab = {}; },
    render(cv, c, P) {
        const img = S.img, W = 1200, IW = W, IH = Math.round(W * imgH(img) / imgW(img)), PH = Math.round(IH * P.panelH / 100);
        cv.width = W; cv.height = IH + PH;
        c.drawImage(img, 0, 0, IW, IH);
        c.fillStyle = P.panel; c.fillRect(0, IH, W, PH);
        S.det = { IW, IH, PH };
        const boxes = S.boxes;
        c.lineWidth = 3; c.strokeStyle = P.box;
        boxes.forEach(b => c.strokeRect(b.x0 * IW, b.y0 * IH, (b.x1 - b.x0) * IW, (b.y1 - b.y0) * IH));
        if (!S.noGuides && S.tmpBox) {
            const b = S.tmpBox;
            c.save(); c.setLineDash([8, 6]); c.strokeRect(b.x0 * IW, b.y0 * IH, (b.x1 - b.x0) * IW, (b.y1 - b.y0) * IH); c.restore();
        }
        const pts = boxes.map((b, i) => {
            const ps = S.detPos[i];
            const w = (b.x1 - b.x0) * IW * P.cropScale, h = (b.y1 - b.y0) * IH * P.cropScale;
            return {
                i, b, w, h,
                x: ps ? ps.fx * W : (b.x0 + b.x1) / 2 * IW,
                y: ps ? IH + ps.fy * PH : IH + (b.y0 + b.y1) / 2 * PH,
            };
        });
        const pairs = new Set();
        pts.forEach((p, i) => {
            pts.map((q, j) => ({ j, d: Math.hypot(p.x - q.x, p.y - q.y) })).filter(o => o.j !== i)
                .sort((a, b) => a.d - b.d).slice(0, P.k).forEach(o => pairs.add(Math.min(i, o.j) + '-' + Math.max(i, o.j)));
        });
        c.strokeStyle = P.lineColor; c.lineWidth = 2; c.globalAlpha = 0.85;
        pairs.forEach(k => { const [a, b] = k.split('-').map(Number); c.beginPath(); c.moveTo(pts[a].x, pts[a].y); c.lineTo(pts[b].x, pts[b].y); c.stroke(); });
        c.globalAlpha = 1;
        pts.forEach(p => {
            c.fillStyle = '#fff'; c.fillRect(p.x - p.w / 2 - 3, p.y - p.h / 2 - 3, p.w + 6, p.h + 6);
            c.drawImage(img, p.b.x0 * imgW(img), p.b.y0 * imgH(img), (p.b.x1 - p.b.x0) * imgW(img), (p.b.y1 - p.b.y0) * imgH(img), p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
            S.hits.push({ kind: 'crop', i: p.i, x: p.x - p.w / 2 - 3, y: p.y - p.h / 2 - 3, w: p.w + 6, h: p.h + 6 });
        });
        if (P.labels) {
            const lines = textLines(SAMPLE_DETECT), fs = Math.round(W * P.fontSize / 100), fam = fontFamily(P.font);
            const L1 = unitsOf(lines[0] || ''), L2 = unitsOf(lines[1] || '');
            c.textBaseline = 'middle'; c.textAlign = 'left';
            const put = (key, i, w, x, y, color) => {
                const num = `(${i + 1}) `;
                c.font = `${fs}px ${fam}`; const nw = c.measureText(num).width;
                c.font = `bold ${fs}px ${fam}`; const ww = c.measureText(w).width;
                const ps = S.detLab[key];
                let xx = ps ? ps.fx * W : x, yy = ps ? ps.fy * cv.height : y;
                xx = clamp(xx, 10, W - nw - ww - 10);
                yy = clamp(yy, fs * 0.8, cv.height - fs * 0.8);
                c.fillStyle = color; c.font = `${fs}px ${fam}`; c.fillText(num, xx, yy);
                c.font = `bold ${fs}px ${fam}`; c.fillText(w, xx + nw, yy);
                S.hits.push({ kind: 'lab', key, x: xx, y: yy - fs * 0.7, w: nw + ww, h: fs * 1.4 });
            };
            L1.forEach((w, i) => { const t = L1.length > 1 ? i / (L1.length - 1) : 0; put('a' + i, i, w, IW * 0.1 + t * IW * 0.62, IH * 0.15 + t * IH * 0.6, P.label); });
            const zy = [0.1, 0.3, 0.06, 0.5, 0.88, 0.28, 0.92];
            L2.forEach((w, i) => { const t = L2.length > 1 ? i / (L2.length - 1) : 0.5; put('b' + i, i, w, IW * (0.06 + 0.8 * t), IH + PH * zy[i % zy.length], P.lineColor); });
        }
    },
    onDown(x, y) {
        const d = S.det;
        if (!d) return false;
        for (let k = S.hits.length - 1; k >= 0; k--) {
            const h = S.hits[k];
            if ((h.kind === 'crop' || h.kind === 'lab') && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
                S.drag = { move: h.kind, i: h.i, key: h.key, sx: x, sy: y, cx: h.x + h.w / 2, cy: h.y + h.h / 2, ty: h.y + h.h / 2 };
                return true;
            }
        }
        if (x < 0 || x > d.IW || y < 0 || y > d.IH) return false;
        const fx = x / d.IW, fy = y / d.IH;
        let hit = -1;
        for (let k = S.boxes.length - 1; k >= 0; k--) {
            const b = S.boxes[k];
            if (fx >= b.x0 && fx <= b.x1 && fy >= b.y0 && fy <= b.y1) { hit = k; break; }
        }
        S.drag = { box: true, x0: fx, y0: fy, hit, moved: false };
        S.tmpBox = null;
        return true;
    },
    onMove(x, y) {
        const dr = S.drag, d = S.det;
        if (!dr || !d) return false;
        if (dr.move === 'crop') {
            S.detPos[dr.i] = {
                fx: clamp((dr.cx + x - dr.sx) / cv.width, 0, 1),
                fy: clamp((dr.cy + y - dr.sy - d.IH) / d.PH, 0, 1),
            };
            return true;
        }
        if (dr.move === 'lab') {
            S.detLab[dr.key] = {
                fx: clamp((dr.cx + x - dr.sx) / cv.width, 0, 1),
                fy: clamp((dr.ty + y - dr.sy) / cv.height, 0, 1),
            };
            return true;
        }
        if (!dr.box) return false;
        const fx = clamp(x / d.IW, 0, 1), fy = clamp(y / d.IH, 0, 1);
        if (Math.abs(fx - dr.x0) * d.IW > 8 || Math.abs(fy - dr.y0) * d.IH > 8) dr.moved = true;
        if (dr.moved) S.tmpBox = { x0: Math.min(dr.x0, fx), y0: Math.min(dr.y0, fy), x1: Math.max(dr.x0, fx), y1: Math.max(dr.y0, fy) };
        return true;
    },
    onUp() {
        const dr = S.drag, d = S.det;
        if (dr && dr.box && d) {
            const b = S.tmpBox;
            if (!dr.moved && dr.hit >= 0) { S.boxes.splice(dr.hit, 1); S.detPos = {}; }
            else if (b && (b.x1 - b.x0) * d.IW > 10 && (b.y1 - b.y0) * d.IH > 10) S.boxes.push(b);
        }
        S.tmpBox = null; S.drag = null;
    },
};

/* =====================================================
 * 模板 7：图版标注（多图）
 * ===================================================== */
const board = {
    id: 'board',
    name: '图版标注',
    hint: '第1行 = 标题，第2行 = 说明，之后每一行是一条图例（自动编罗马数字）。可以用「追加一张图片」放多张图，按网格排列。',
    defaults: { ratio: '3:2', imgW: 66, cols: 2, gapPct: 1.5, fontSize: 1.15, font: 'theme', tick: true, bg: '#ffffff', ink: '#222222' },
    controls: [
        { group: '版面', key: 'ratio', label: '画面比例', type: 'select', options: RATIO_OPTS },
        { group: '版面', key: 'imgW', label: '图片区域宽度 %', type: 'range', min: 40, max: 85, step: 1 },
        { group: '版面', key: 'cols', label: '图片列数（多图时）', type: 'range', min: 1, max: 4, step: 1 },
        { group: '版面', key: 'gapPct', label: '图片间距 %', type: 'range', min: 0, max: 6, step: 0.25 },
        { group: '版面', key: 'addImg', label: '追加一张图片', type: 'button', noUndo: true, onClick() { ui.addBoardImage(); } },
        { group: '版面', key: 'clrImg', label: '只保留主图', type: 'button', noUndo: true, onClick() { S.boardImgs = []; } },
        { group: '版面', key: 'tick', label: '显示小刻度线', type: 'checkbox' },
        { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 0.8, max: 2.2, step: 0.05 },
        { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
        { group: '颜色', key: 'bg', label: '背景色', type: 'color' },
        { group: '颜色', key: 'ink', label: '文字颜色', type: 'color' },
    ],
    render(cv, c, P) {
        const img = S.img, [rw, rh] = RATIOS[P.ratio] || [3, 2], W = 1500, H = Math.round(W * rh / rw);
        cv.width = W; cv.height = H;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
        const fam = fontFamily(P.font), fs = Math.round(W * P.fontSize / 100);
        const M = W * 0.035, areaW = W * P.imgW / 100, areaX = W - M - areaW, areaTop = H * 0.12, areaH = H * 0.76;
        const pics = [img, ...S.boardImgs];
        const gap = W * P.gapPct / 100;
        const cols = Math.max(1, Math.min(P.cols, pics.length));
        const rows = Math.ceil(pics.length / cols);
        const cellW = (areaW - gap * (cols - 1)) / cols;
        const cellH = (areaH - gap * (rows - 1)) / rows;
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        pics.forEach((pi, k) => {
            const cxi = k % cols, cyi = Math.floor(k / cols);
            const gx = areaX + cxi * (cellW + gap), gy = areaTop + cyi * (cellH + gap);
            const s2 = Math.min(cellW / imgW(pi), cellH / imgH(pi));
            const w2 = imgW(pi) * s2, h2 = imgH(pi) * s2;
            const x2 = gx + (cellW - w2) / 2, y2 = gy + (cellH - h2) / 2;
            c.drawImage(pi, x2, y2, w2, h2);
            bx0 = Math.min(bx0, x2); by0 = Math.min(by0, y2);
            bx1 = Math.max(bx1, x2 + w2); by1 = Math.max(by1, y2 + h2);
        });
        const dx = bx0, dy = by0, dw = bx1 - bx0, dh = by1 - by0;
        const lines = textLines(SAMPLE_BOARD);
        const title = lines[0] || '', desc = lines[1] || '', entries = lines.slice(2).filter(Boolean);
        const n = entries.length, topN = Math.ceil(n / 2), botN = n - topN;
        c.fillStyle = P.ink; c.strokeStyle = P.ink; c.lineWidth = 1.2;
        c.textBaseline = 'middle'; c.textAlign = 'center'; c.font = `${fs * 0.85}px ${fam}`;
        for (let i = 0; i < topN; i++) {
            const x = dx + dw * (i + 0.5) / topN;
            c.fillText(romanize(i + 1), x, dy - fs * 1.7);
            if (P.tick) { c.beginPath(); c.moveTo(x, dy - fs * 0.9); c.lineTo(x, dy - fs * 0.2); c.stroke(); }
        }
        for (let j = 0; j < botN; j++) {
            const x = dx + dw * (j + 0.5) / botN;
            c.fillText(romanize(topN + j + 1), x, dy + dh + fs * 1.7);
            if (P.tick) { c.beginPath(); c.moveTo(x, dy + dh + fs * 0.9); c.lineTo(x, dy + dh + fs * 0.2); c.stroke(); }
        }
        c.textAlign = 'left';
        const colW = Math.max(80, areaX - M * 2) * 0.92, x0 = M;
        const flow = (k, draw) => {
            let y = H * 0.08;
            const f1 = fs * k, f2 = fs * 0.9 * k;
            if (title) {
                mctx.font = `${f1}px ${fam}`; c.font = mctx.font;
                if (draw && 'letterSpacing' in c) c.letterSpacing = (f1 * 0.08) + 'px';
                textBlock(title.toUpperCase(), colW).forEach(t => { if (draw) c.fillText(t, x0, y); y += f1 * 1.5; });
                if ('letterSpacing' in c) c.letterSpacing = '0px';
            }
            if (desc) {
                y = Math.max(y + f2 * 2, H * 0.3);
                mctx.font = `${f2}px ${fam}`; c.font = mctx.font;
                if (draw && 'letterSpacing' in c) c.letterSpacing = (f2 * 0.06) + 'px';
                textBlock(desc.toUpperCase(), colW).forEach(t => { if (draw) c.fillText(t, x0, y); y += f2 * 1.6; });
                if ('letterSpacing' in c) c.letterSpacing = '0px';
            }
            if (entries.length) {
                y += f2 * 1.2;
                mctx.font = `${f2}px ${fam}`; c.font = mctx.font;
                if (draw) c.fillText('KEY:', x0, y);
                y += f2 * 1.8;
                const rw2 = mctx.measureText('XVIII.').width + f2 * 0.6;
                entries.forEach((t, i) => {
                    if (draw) c.fillText(romanize(i + 1) + '.', x0, y);
                    textBlock(t, colW - rw2).forEach(l => { if (draw) c.fillText(l, x0 + rw2, y); y += f2 * 1.45; });
                    y += f2 * 0.3;
                });
            }
            return y;
        };
        let k = 1;
        for (let t = 0; t < 10 && flow(k, false) > H - M; t++) k *= 0.92;
        c.fillStyle = P.ink; flow(k, true);
    },
};

/* =====================================================
 * 模板 8：缺字填空（字块区可在上/下/左/右）
 * ===================================================== */
function newCloze() { return { order: [], pos: {}, bs: {}, ts: {}, rot: {}, sel: -1 }; }
function clozeRemove(i) {
    const Z = S.cloze;
    Z.order = Z.order.filter(v => v !== i);
    delete Z.pos[i]; delete Z.bs[i]; delete Z.ts[i]; delete Z.rot[i];
    if (Z.sel === i) Z.sel = -1;
}
const clozeSel = () => !!(S.cloze && S.cloze.sel >= 0 && S.cloze.order.includes(S.cloze.sel));
function clozeLayout(items, P, W, fs, y0, isTitle) {
    const out = [], lg = fs * P.letterGap / 100, M = W * P.marginX / 100;
    if (isTitle || P.dir !== 'v') {
        const lh = fs * (isTitle ? 1.5 : P.lineGap);
        const lines = wrap(items.map(it => it.nl ? it : Object.assign({}, it, { w: it.w + lg })), W - 2 * M);
        let y = y0;
        lines.forEach((l, li) => {
            const real = l.items.filter(it => !it.nl);
            const lineW = real.reduce((s0, it) => s0 + it.w, 0) - (real.length ? lg : 0);
            const endsPara = l.items.some(it => it.nl) || li === lines.length - 1;
            const al = isTitle ? 'center' : P.align;
            let x = al === 'center' ? (W - lineW) / 2 : al === 'right' ? W - M - lineW : M, gap = 0;
            if (al === 'justify' && !endsPara && real.length > 1) gap = (W - 2 * M - lineW) / (real.length - 1);
            real.forEach(it => {
                const cw = it.w - lg;
                out.push({ i: it.i, t: it.t, cx: x + cw / 2, cy: y + lh / 2, w: cw, h: lh, title: isTitle });
                x += it.w + gap;
            });
            y += lh;
        });
        return { placed: out, h: lines.length * lh };
    }
    const colW = fs * P.lineGap, step = fs * 1.08 + lg, rows = Math.max(1, Math.round(P.perCol));
    const cols = [];
    let cur = [];
    for (const it of items) {
        if (it.nl) { cols.push(cur); cur = []; continue; }
        if (cur.length >= rows) { cols.push(cur); cur = []; }
        cur.push(it);
    }
    if (cur.length) cols.push(cur);
    const blockW = cols.length * colW;
    const bx = P.align === 'left' ? M : P.align === 'right' ? W - M - blockW : (W - blockW) / 2;
    cols.forEach((col, k) => {
        const cx = bx + blockW - (k + 0.5) * colW;
        col.forEach((it, j) => out.push({ i: it.i, t: it.t, cx, cy: y0 + (j + 0.5) * step, w: fs * 1.05, h: step, title: false }));
    });
    return { placed: out, h: rows * step };
}
const CLOZE_PAL = {
    wine: { top: '#6b1a1f', ink: '#ffffff', blank: '#efe9e1', bottom: '#ece8e0', tileBg: '#6b1a1f', tileInk: '#ffffff' },
    cream: { top: '#d9d0bf', ink: '#111111', blank: '#7b2a2e', bottom: '#7b2a2e', tileBg: '#e9e2d0', tileInk: '#111111' },
    dusk: { top: '#050505', ink: '#f1f1f1', blank: '#9b1c10', bottom: '#0a0a0a', tileBg: '#000000', tileInk: '#ffffff' },
};
const cloze = {
    id: 'cloze',
    name: '缺字填空',
    hint: '点字：变成空洞并出现字块。再点一下选中的字放回；选中后到「元素」页单独调它的空洞/字块大小。按住字块可拖动位置。字块区可以放在文字的上/下/左/右。',
    migrate(P) { if (P.areaOrder === undefined) P.areaOrder = 'below'; },
    defaults: Object.assign({
        palette: 'wine', areaOrder: 'below', tileArea: 'color', textArea: 'color', dim: 25, bottomPct: 90, title: false,
        fontSize: 4.2, font: 'serif', dir: 'h', perCol: 8, align: 'left', lineGap: 1.5, letterGap: 0, marginX: 7.5, padTop: 8, padBottom: 6,
        shape: 'rect', aspect: 0.85, blankSize: 100, tileScale: 100, arrange: 'wave', tilt: 40, grain: 20,
    }, CLOZE_PAL.wine),
    controls: [
        { group: '版面', key: 'areaOrder', label: '字块区的位置', type: 'select', options: [['below', '在文字下方'], ['above', '在文字上方'], ['left', '在文字左边'], ['right', '在文字右边']] },
        { group: '版面', key: 'bottomPct', label: '字块区大小 %', type: 'range', min: 30, max: 160, step: 5 },
        { group: '版面', key: 'title', label: '第一行当标题（居中，不参与挖字）', type: 'checkbox', onChange() { S.cloze = newCloze(); } },
        { group: '背景', key: 'tileArea', label: '字块区背景', type: 'select', options: [['color', '纯色'], ['image', '用图片']] },
        { group: '背景', key: 'textArea', label: '文字区背景', type: 'select', options: [['color', '纯色'], ['image', '用图片']] },
        { group: '背景', key: 'dim', label: '文字区图片压暗 %', type: 'range', min: 0, max: 80, step: 1, show: P => P.textArea === 'image' },
        { group: '文字', key: 'fontSize', label: '文字大小', type: 'range', min: 2.5, max: 8, step: 0.1 },
        { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
        { group: '文字排版', key: 'dir', label: '文字方向', type: 'select', options: [['h', '横排'], ['v', '竖排（从右往左）']] },
        { group: '文字排版', key: 'perCol', label: '竖排：每列几个字', type: 'range', min: 3, max: 24, step: 1, show: P => P.dir === 'v' },
        { group: '文字排版', key: 'align', label: '对齐方式', type: 'select', options: [['left', '靠左'], ['center', '居中'], ['right', '靠右'], ['justify', '两端对齐（仅横排）']] },
        { group: '文字排版', key: 'lineGap', label: '行距（竖排=列距）', type: 'range', min: 1, max: 3, step: 0.05 },
        { group: '文字排版', key: 'letterGap', label: '字距 %', type: 'range', min: 0, max: 80, step: 1 },
        { group: '文字排版', key: 'marginX', label: '左右边距 %', type: 'range', min: 2, max: 30, step: 0.5 },
        { group: '文字排版', key: 'padTop', label: '上边距 %', type: 'range', min: 2, max: 30, step: 0.5 },
        { group: '文字排版', key: 'padBottom', label: '下边距 %', type: 'range', min: 2, max: 30, step: 0.5 },
        { group: '形状', key: 'shape', label: '空洞和字块的形状', type: 'select', options: SHAPE_OPTS },
        { group: '形状', key: 'aspect', label: '长宽比(长方形/椭圆)', type: 'range', min: 0.4, max: 3, step: 0.05, show: P => P.shape === 'rect' || P.shape === 'ellipse' },
        { group: '形状', key: 'drawShape', label: '手绘一个自定义形状', type: 'button', noUndo: true, onClick() { ui.openShapePad(); } },
        { group: '形状', key: 'imgShape', label: '用图片做形状', type: 'button', noUndo: true, onClick() { ui.pickShapeImage(); } },
        { group: '形状', key: 'delShape', label: '删除这个自定义形状', type: 'button', noUndo: true, show: P => String(P.shape).startsWith('custom:'), onClick(P) { ui.deleteCustomShape(P.shape); } },
        { group: '大小', key: 'blankSize', label: '空洞的默认大小 %', type: 'range', min: 40, max: 300, step: 5 },
        { group: '大小', key: 'tileScale', label: '字块的默认大小 %', type: 'range', min: 60, max: 220, step: 5 },
        { group: '大小', key: 'allSizes', label: '所有大小改回默认', type: 'button', onClick() { S.cloze.bs = {}; S.cloze.ts = {}; } },
        { group: '选中的字', key: 'selBlank', label: '空洞大小 %', type: 'range', min: 30, max: 400, step: 5, show: clozeSel,
          get(P) { return clozeSel() ? (S.cloze.bs[S.cloze.sel] ?? P.blankSize) : undefined; },
          set(v) { if (clozeSel()) S.cloze.bs[S.cloze.sel] = v; } },
        { group: '选中的字', key: 'selTile', label: '字块大小 %', type: 'range', min: 40, max: 300, step: 5, show: clozeSel,
          get(P) { return clozeSel() ? (S.cloze.ts[S.cloze.sel] ?? P.tileScale) : undefined; },
          set(v) { if (clozeSel()) S.cloze.ts[S.cloze.sel] = v; } },
        { group: '选中的字', key: 'selTileRot', label: '字块角度', type: 'range', min: -180, max: 180, step: 5, show: clozeSel,
          get() { return clozeSel() ? (S.cloze.rot[S.cloze.sel] ?? 0) : undefined; },
          set(v) { if (clozeSel()) S.cloze.rot[S.cloze.sel] = v; } },
        { group: '选中的字', key: 'selRestore', label: '放回这个字', type: 'button', show: clozeSel, onClick() { clozeRemove(S.cloze.sel); } },
        { group: '字块', key: 'arrange', label: '字块默认排列', type: 'select', options: [['row', '一排'], ['wave', '波浪'], ['scatter', '散落']] },
        { group: '字块', key: 'tilt', label: '字块默认倾斜程度', type: 'range', min: 0, max: 100, step: 5 },
        { group: '字块', key: 'resetPos', label: '字块排回默认位置', type: 'button', onClick() { S.cloze.pos = {}; } },
        { group: '颜色', key: 'palette', label: '配色方案', type: 'select', options: [['wine', '酒红'], ['cream', '米色'], ['dusk', '黑夜']], onChange(v) { const pl = CLOZE_PAL[v]; if (pl) Object.entries(pl).forEach(([k, val]) => ui.setParam(k, val)); } },
        { group: '颜色', key: 'top', label: '文字区底色', type: 'color' },
        { group: '颜色', key: 'ink', label: '文字颜色', type: 'color' },
        { group: '颜色', key: 'blank', label: '空洞颜色', type: 'color' },
        { group: '颜色', key: 'bottom', label: '字块区底色', type: 'color' },
        { group: '颜色', key: 'tileBg', label: '字块底色', type: 'color' },
        { group: '颜色', key: 'tileInk', label: '字块文字色', type: 'color' },
        { group: '质感', key: 'grain', label: '纸张颗粒 %', type: 'range', min: 0, max: 100, step: 5 },
    ],
    snap() { const Z = S.cloze; return JSON.stringify({ o: Z.order, p: Z.pos, b: Z.bs, t: Z.ts, r: Z.rot }); },
    restore(str) { const d = JSON.parse(str); S.cloze = Object.assign(newCloze(), { order: d.o, pos: d.p || {}, bs: d.b || {}, ts: d.t || {}, rot: d.r || {} }); },
    clear() { S.cloze = newCloze(); },
    render(cv, c, P) {
        const Z = (S.cloze ??= newCloze());
        Z.pos ??= {}; Z.bs ??= {}; Z.ts ??= {}; Z.rot ??= {};
        if (Z.sel === undefined) Z.sel = -1;
        const side = P.areaOrder, horiz = side === 'left' || side === 'right';
        const CW = 1200;
        const tw = horiz ? Math.round(CW / (1 + clamp(P.bottomPct, 30, 160) / 100)) : CW;   // 文字区宽度
        const fs = Math.round(tw * P.fontSize / 100), fam = fontFamily(P.font);
        mctx.font = `${fs}px ${fam}`;
        const toks = tokenize((S.text || '').trim() || SAMPLE_CLOZE, 'char');
        const titleEnd = P.title ? toks.findIndex(t => t.nl) : -1;
        const spaceW = mctx.measureText(' ').width;
        const all = toks.map((tk, i) => tk.nl ? { nl: true, w: 0 } : { i, t: tk.t, w: mctx.measureText(tk.t).width + (tk.sp ? spaceW : 0) });
        const tItems = P.title ? all.filter((it, i) => i < titleEnd) : [];
        const bItems = all.filter((it, i) => !(P.title && i <= titleEnd));
        const padT = tw * P.padTop / 100, padB = tw * P.padBottom / 100;
        const tl = clozeLayout(tItems, P, tw, fs, padT, true);
        const gapT = tl.h ? fs * 0.4 : 0;
        const bl = clozeLayout(bItems, P, tw, fs, padT + tl.h + gapT, false);
        const textH = Math.round(padT + tl.h + gapT + bl.h + padB);
        // 字块区尺寸
        const asp = imgH(S.img) / imgW(S.img);
        let tileW, tileH, W, H, tileX, tileY, textX, textY;
        if (horiz) {
            tileW = CW - tw;
            tileH = P.tileArea === 'image' ? Math.round(tileW * asp) : textH;
            W = CW; H = Math.max(textH, tileH);
            tileX = side === 'left' ? 0 : tw; textX = side === 'left' ? tileW : 0;
            tileY = Math.round((H - tileH) / 2); textY = Math.round((H - textH) / 2);
        } else {
            tileW = CW;
            tileH = P.tileArea === 'image' ? Math.round(CW * asp * P.bottomPct / 100) : Math.round(textH * P.bottomPct / 100);
            W = CW; H = textH + tileH;
            tileX = 0; textX = 0;
            tileY = side === 'above' ? 0 : textH; textY = side === 'above' ? tileH : 0;
        }
        cv.width = W; cv.height = H;
        const bg = (mode, color, x, y, w, h, dim) => {
            if (mode === 'image') { drawCover(c, S.img, x, y, w, h); if (dim > 0) { c.fillStyle = `rgba(0,0,0,${dim / 100})`; c.fillRect(x, y, w, h); } }
            else { c.fillStyle = color; c.fillRect(x, y, w, h); }
        };
        c.fillStyle = P.bottom; c.fillRect(0, 0, W, H);
        bg(P.textArea, P.top, textX, textY, tw, textH, P.dim);
        bg(P.tileArea, P.bottom, tileX, tileY, tileW, tileH, 0);
        const ratio = shapeRatio({ shape: P.shape, aspect: P.aspect });
        const placed = tl.placed.concat(bl.placed);
        c.font = `${fs}px ${fam}`; c.textBaseline = 'middle'; c.textAlign = 'center';
        placed.forEach(q => {
            if (!q.title && Z.order.includes(q.i)) return;
            c.fillStyle = P.ink; c.fillText(q.t, textX + q.cx, textY + q.cy);
        });
        placed.forEach(q => {
            if (q.title) return;
            S.hits.push({ kind: 'chr', i: q.i, x: textX + q.cx - q.w / 2, y: textY + q.cy - q.h / 2, w: q.w, h: q.h });
            if (!Z.order.includes(q.i)) return;
            const bsz = fs * 1.15 * (Z.bs[q.i] ?? P.blankSize) / 100;
            c.save(); pathShape(c, P.shape, textX + q.cx, textY + q.cy, bsz, bsz * ratio); c.fillStyle = P.blank; c.fill(); c.restore();
            if (!S.noGuides && Z.sel === q.i) drawRing(c, P, textX + q.cx, textY + q.cy, bsz, bsz * ratio, 0);
        });
        // 字块
        const n = Z.order.length, base = fs * 1.25 * P.tileScale / 100;
        const M = tileW * P.marginX / 100, cxB = tileX + tileW / 2, cyB = tileY + tileH / 2;
        S.clozeGeo = { tileX, tileY, tileW, tileH, horiz };
        Z.order.forEach((idx, k) => {
            const ch = toks[idx] ? toks[idx].t : '';
            const tsz = fs * 1.25 * (Z.ts[idx] ?? P.tileScale) / 100, th = tsz * ratio;
            const along = n > 1 ? k / (n - 1) : 0.5;
            let tx, ty;
            if (P.arrange === 'scatter') {
                tx = tileX + M + base / 2 + hash(idx * 3 + 7) * Math.max(1, tileW - 2 * M - base);
                ty = tileY + base / 2 + hash(idx * 3 + 9) * Math.max(1, tileH - base);
            } else if (horiz) {
                // 左右侧：字块竖着排
                ty = tileY + base / 2 + (tileH - base) * along;
                tx = cxB + (P.arrange === 'wave' ? Math.sin(k * 0.9) * tileW * 0.24 : 0);
            } else {
                tx = tileX + M + base / 2 + (tileW - 2 * M - base) * along;
                ty = cyB + (P.arrange === 'wave' ? Math.sin(k * 0.9) * tileH * 0.28 : 0);
            }
            const ps = Z.pos[idx];
            if (ps) { tx = tileX + ps.fx * tileW; ty = tileY + ps.fy * tileH; }
            tx = clamp(tx, tileX + tsz / 2, tileX + tileW - tsz / 2);
            ty = clamp(ty, tileY + th / 2, tileY + tileH - th / 2);
            const rotDeg = Z.rot[idx] !== undefined ? Z.rot[idx] : (hash(idx + 5) - 0.5) * (P.tilt / 100) * 0.35 * 180 / Math.PI;
            c.save(); c.translate(tx, ty); c.rotate(rotDeg * Math.PI / 180);
            pathShape(c, P.shape, 0, 0, tsz, th); c.fillStyle = P.tileBg; c.fill();
            c.fillStyle = P.tileInk; c.font = `${Math.min(tsz, th) * 0.72}px ${fam}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(ch, 0, 0);
            c.restore();
            if (!S.noGuides && Z.sel === idx) drawRing(c, P, tx, ty, tsz, th, rotDeg);
            S.hits.push({ kind: 'tile', idx, x: tx - tsz / 2, y: ty - th / 2, w: tsz, h: th });
        });
        applyGrain(c, W, H, P.grain);
    },
    onDown(x, y) {
        const Z = (S.cloze ??= newCloze());
        for (let k = S.hits.length - 1; k >= 0; k--) {
            const h = S.hits[k];
            if (h.kind === 'tile' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
                S.drag = { tile: h.idx, sx: x, sy: y, cx: h.x + h.w / 2, cy: h.y + h.h / 2, hw: h.w, hh: h.h, moved: false, was: Z.sel === h.idx };
                Z.sel = h.idx;
                return true;
            }
        }
        const h = S.hits.find(h => h.kind === 'chr' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
        if (!h) return false;
        if (!Z.order.includes(h.i)) { Z.order = [...Z.order, h.i]; Z.sel = h.i; S.drag = { cloze: true, val: true }; return true; }
        if (Z.sel !== h.i) { Z.sel = h.i; S.drag = null; return true; }
        clozeRemove(h.i); S.drag = { cloze: true, val: false };
        return true;
    },
    onMove(x, y) {
        const d = S.drag, g = S.clozeGeo, Z = S.cloze;
        if (!d) return false;
        if (d.tile !== undefined) {
            if (!g) return false;
            if (Math.hypot(x - d.sx, y - d.sy) > 6) d.moved = true;
            if (d.moved) {
                const nx = clamp(d.cx + (x - d.sx), g.tileX + d.hw / 2, g.tileX + g.tileW - d.hw / 2);
                const ny = clamp(d.cy + (y - d.sy), g.tileY + d.hh / 2, g.tileY + g.tileH - d.hh / 2);
                Z.pos[d.tile] = { fx: (nx - g.tileX) / g.tileW, fy: (ny - g.tileY) / g.tileH };
            }
            return true;
        }
        if (!d.cloze) return false;
        const h = S.hits.find(h => h.kind === 'chr' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
        if (!h) return false;
        const has = Z.order.includes(h.i);
        if (d.val && !has) { Z.order = [...Z.order, h.i]; return true; }
        if (!d.val && has) { clozeRemove(h.i); return true; }
        return false;
    },
    onUp() {
        const d = S.drag;
        if (d && d.tile !== undefined && !d.moved && d.was) clozeRemove(d.tile);
        S.drag = null;
    },
};

/* =====================================================
 * 模板 9：唱片封套（封套底图 / 中心标签图 各自可换）
 * 文字：第1行 = 专辑名；"side A/B" 之类单独一行作为分段；其余行 = 曲目
 * ===================================================== */
const VINYL_PAL = {
    cream: { bg: '#e7e0d1', ink: '#1a1a1a', disc: '#141414', groove: '#2e2e2e', lab: '#b8472f', labInk: '#f7efe2' },
    night: { bg: '#121218', ink: '#efefef', disc: '#000000', groove: '#2a2a33', lab: '#d8cf4a', labInk: '#17170f' },
    sand: { bg: '#cfa47a', ink: '#2b1a12', disc: '#1b1410', groove: '#33261e', lab: '#f0e6d2', labInk: '#2b1a12' },
};
const vinyl = {
    id: 'vinyl',
    name: '唱片封套',
    hint: '文字第1行 = 专辑名；写「side A」这样的行会作为分段标题；其余每行 = 一首曲目。封套底图和唱片中心的标签图可以分别替换；拖动唱片可以调它露出来多少。',
    defaults: Object.assign({
        ratio: '1:1', pullPct: 42, discPct: 78, discSide: 'right', sleeveImg: true, labelImg: true,
        labelPct: 34, holePct: 3.4, grooves: 26, spin: -12, shadow: true,
        title: '', subtitle: '', fontSize: 1.5, titleSize: 4.6, font: 'sans', upper: true, cols: 1, grain: 18,
    }, VINYL_PAL.cream),
    controls: [
        { group: '版面', key: 'ratio', label: '画面比例', type: 'select', options: RATIO_OPTS },
        { group: '版面', key: 'discSide', label: '唱片从哪一侧抽出', type: 'select', options: [['right', '右侧'], ['left', '左侧'], ['top', '上方'], ['bottom', '下方']] },
        { group: '版面', key: 'pullPct', label: '唱片抽出多少 %', type: 'range', min: 0, max: 100, step: 1 },
        { group: '版面', key: 'discPct', label: '唱片大小 %', type: 'range', min: 50, max: 100, step: 1 },
        { group: '版面', key: 'shadow', label: '唱片投影', type: 'checkbox' },
        { group: '背景', key: 'sleeveImg', label: '封套用图片（关掉=纯色）', type: 'checkbox' },
        { group: '背景', key: 'pickSleeve', label: '换封套底图', type: 'button', noUndo: true, onClick() { ui.pickVinylImage('sleeve'); } },
        { group: '背景', key: 'labelImg', label: '中心标签用图片', type: 'checkbox' },
        { group: '背景', key: 'pickLabel', label: '换中心标签图', type: 'button', noUndo: true, onClick() { ui.pickVinylImage('label'); } },
        { group: '背景', key: 'clrImgs', label: '清掉这两张图（回到主图/纯色）', type: 'button', noUndo: true, onClick() { S.vinylImgs = {}; } },
        { group: '唱片', key: 'labelPct', label: '中心标签大小 %', type: 'range', min: 18, max: 60, step: 1 },
        { group: '唱片', key: 'holePct', label: '中心孔大小 %', type: 'range', min: 0, max: 10, step: 0.2 },
        { group: '唱片', key: 'grooves', label: '纹路圈数', type: 'range', min: 0, max: 60, step: 1 },
        { group: '唱片', key: 'spin', label: '标签旋转角度', type: 'range', min: -180, max: 180, step: 2 },
        { group: '文字', key: 'title', label: '专辑名（留空=取文字第1行）', type: 'text' },
        { group: '文字', key: 'subtitle', label: '副标题 / 厂牌', type: 'text' },
        { group: '文字', key: 'titleSize', label: '专辑名大小', type: 'range', min: 2, max: 9, step: 0.1 },
        { group: '文字', key: 'fontSize', label: '曲目文字大小', type: 'range', min: 0.8, max: 3, step: 0.05 },
        { group: '文字', key: 'cols', label: '曲目分几栏', type: 'range', min: 1, max: 3, step: 1 },
        { group: '文字', key: 'upper', label: '英文转大写', type: 'checkbox' },
        { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
        { group: '颜色', key: 'palette', label: '配色方案', type: 'select', options: [['cream', '米色'], ['night', '黑夜'], ['sand', '沙色']], onChange(v) { const pl = VINYL_PAL[v]; if (pl) Object.entries(pl).forEach(([k, val]) => ui.setParam(k, val)); } },
        { group: '颜色', key: 'bg', label: '封套底色', type: 'color' },
        { group: '颜色', key: 'ink', label: '封套文字色', type: 'color' },
        { group: '颜色', key: 'disc', label: '唱片颜色', type: 'color' },
        { group: '颜色', key: 'groove', label: '纹路颜色', type: 'color' },
        { group: '颜色', key: 'lab', label: '标签底色', type: 'color' },
        { group: '颜色', key: 'labInk', label: '标签文字色', type: 'color' },
        { group: '质感', key: 'grain', label: '颗粒感 %', type: 'range', min: 0, max: 100, step: 5 },
    ],
    render(cv, c, P) {
        const [rw, rh] = RATIOS[P.ratio] || [1, 1];
        const W = 1200, H = Math.round(W * rh / rw);
        const side = P.discSide, horiz = side === 'left' || side === 'right';
        const sleeve = Math.min(W, H) * 0.86;
        const sx = horiz ? (side === 'left' ? W - sleeve - W * 0.04 : W * 0.04) : (W - sleeve) / 2;
        const sy = horiz ? (H - sleeve) / 2 : (side === 'top' ? H - sleeve - H * 0.04 : H * 0.04);
        const R = sleeve * P.discPct / 200;
        const pull = (sleeve / 2 + R) * P.pullPct / 100;
        const dcx = sx + sleeve / 2 + (side === 'right' ? pull : side === 'left' ? -pull : 0);
        const dcy = sy + sleeve / 2 + (side === 'bottom' ? pull : side === 'top' ? -pull : 0);
        cv.width = W; cv.height = H;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
        S.geo = { x: sx, y: sy, w: sleeve, h: sleeve, dcx, dcy, R, horiz, side, sleeve };
        const sleeveImg = S.vinylImgs.sleeve || S.img;
        const labelImg = S.vinylImgs.label || S.img;
        // 唱片（在封套下层）
        c.save();
        if (P.shadow) { c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = R * 0.12; c.shadowOffsetX = R * 0.03; c.shadowOffsetY = R * 0.04; }
        c.beginPath(); c.arc(dcx, dcy, R, 0, Math.PI * 2); c.fillStyle = P.disc; c.fill();
        c.restore();
        const labR = R * P.labelPct / 100;
        if (P.grooves > 0) {
            c.save(); c.strokeStyle = P.groove; c.globalAlpha = 0.55;
            for (let i = 0; i < P.grooves; i++) {
                const r = labR + (R * 0.97 - labR) * (i + 0.5) / P.grooves;
                c.lineWidth = i % 4 === 0 ? 2.2 : 1;
                c.beginPath(); c.arc(dcx, dcy, r, 0, Math.PI * 2); c.stroke();
            }
            c.restore();
        }
        // 中心标签
        c.save();
        c.translate(dcx, dcy); c.rotate(P.spin * Math.PI / 180);
        c.beginPath(); c.arc(0, 0, labR, 0, Math.PI * 2);
        if (P.labelImg) { c.save(); c.clip(); drawCover(c, labelImg, -labR, -labR, labR * 2, labR * 2); c.restore(); }
        else { c.fillStyle = P.lab; c.fill(); }
        const lines0 = textLines(SAMPLE_VINYL);
        const albumTitle = (P.title || lines0[0] || '').trim();
        const fam = fontFamily(P.font);
        const tt = P.upper ? albumTitle.toUpperCase() : albumTitle;
        if (tt && !P.labelImg) {
            c.fillStyle = P.labInk; c.textAlign = 'center'; c.textBaseline = 'middle';
            let lfs = labR * 0.3;
            mctx.font = `bold ${lfs}px ${fam}`;
            while (mctx.measureText(tt).width > labR * 1.5 && lfs > 8) { lfs -= 1; mctx.font = `bold ${lfs}px ${fam}`; }
            c.font = `bold ${lfs}px ${fam}`;
            c.fillText(tt, 0, -labR * 0.18);
            if (P.subtitle.trim()) {
                c.font = `${lfs * 0.6}px ${fam}`;
                c.fillText(P.upper ? P.subtitle.toUpperCase() : P.subtitle, 0, labR * 0.3);
            }
        }
        if (P.holePct > 0) {
            c.beginPath(); c.arc(0, 0, R * P.holePct / 100, 0, Math.PI * 2);
            c.fillStyle = P.bg; c.fill();
        }
        c.restore();
        // 封套（盖在唱片上）
        c.save();
        c.beginPath(); c.rect(sx, sy, sleeve, sleeve); c.clip();
        if (P.sleeveImg) drawCover(c, sleeveImg, sx, sy, sleeve, sleeve);
        else { c.fillStyle = P.bg; c.fillRect(sx, sy, sleeve, sleeve); }
        c.restore();
        c.save(); c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 2; c.strokeRect(sx, sy, sleeve, sleeve); c.restore();
        // 封套上的文字：专辑名 + 曲目
        const rest = lines0.slice(1).filter(Boolean);
        const tfs = Math.round(W * P.titleSize / 100), ffs = Math.round(W * P.fontSize / 100);
        c.fillStyle = P.ink; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        const padI = sleeve * 0.07;
        if (tt) {
            let k = tfs;
            mctx.font = `900 ${k}px ${fam}`;
            while (mctx.measureText(tt).width > sleeve - padI * 2 && k > 12) { k -= 2; mctx.font = `900 ${k}px ${fam}`; }
            c.font = `900 ${k}px ${fam}`;
            if ('letterSpacing' in c) c.letterSpacing = (k * 0.02) + 'px';
            c.fillText(tt, sx + padI, sy + padI + k * 0.85);
            if ('letterSpacing' in c) c.letterSpacing = '0px';
        }
        // 曲目：side 行加粗当分段，其余自动编号，可分栏
        const isSide = t => /^(side\s*[a-z0-9]|面[一二甲乙ab])/i.test(t.trim());
        const cols = Math.max(1, Math.min(P.cols, 3));
        const colW = (sleeve - padI * 2) / cols - ffs * 0.5;
        const perCol = Math.ceil(rest.length / cols) || 1;
        let num = 0;
        rest.forEach((t, i) => {
            const col = Math.min(cols - 1, Math.floor(i / perCol)), row = i - col * perCol;
            const bx = sx + padI + col * ((sleeve - padI * 2) / cols);
            const by = sy + sleeve - padI - (perCol - row - 1) * ffs * 1.75;
            const txt = P.upper ? t.toUpperCase() : t;
            if (isSide(t)) {
                c.font = `900 ${ffs * 1.05}px ${fam}`;
                c.fillText(txt, bx, by);
                num = 0;
            } else {
                num++;
                c.font = `${ffs * 0.9}px ${fam}`;
                const nn = String(num).padStart(2, '0') + '  ';
                c.fillText(nn, bx, by);
                const nw = c.measureText(nn).width;
                c.font = `${ffs}px ${fam}`;
                let s = txt;
                while (c.measureText(s).width > colW - nw && s.length > 2) s = s.slice(0, -2);
                c.fillText(s, bx + nw, by);
            }
        });
        applyGrain(c, W, H, P.grain);
    },
    onDown(x, y, P, ui2) {
        const g = S.geo;
        if (!g) return false;
        if (Math.hypot(x - g.dcx, y - g.dcy) <= g.R) { S.drag = { vinyl: true, sx: x, sy: y, p0: P.pullPct }; return true; }
        return false;
    },
    onMove(x, y, P, ui2) {
        const d = S.drag, g = S.geo;
        if (!d || !d.vinyl || !g) return false;
        const span = g.sleeve / 2 + g.R;
        const dv = g.horiz ? (x - d.sx) * (g.side === 'left' ? -1 : 1) : (y - d.sy) * (g.side === 'top' ? -1 : 1);
        ui2.setParam('pullPct', Math.round(clamp(d.p0 + dv / span * 100, 0, 100)));
        return true;
    },
    onUp() { S.drag = null; },
};

/* =====================================================
 * 模板 10：星座挖洞
 * 预设几种星座，也可以手动点出星点；每个星点是一块图片碎片
 * ===================================================== */
// 星座点位（0..1 归一化）与连线（点索引对）
const CONSTEL = {
    ursa: { name: '北斗七星', pts: [[0.08, 0.62], [0.24, 0.52], [0.41, 0.47], [0.57, 0.52], [0.68, 0.38], [0.86, 0.33], [0.93, 0.56]], lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]] },
    orion: { name: '猎户座', pts: [[0.22, 0.1], [0.74, 0.14], [0.3, 0.42], [0.47, 0.48], [0.63, 0.44], [0.16, 0.82], [0.8, 0.86], [0.47, 0.66]], lines: [[0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6], [3, 7], [7, 5], [7, 6]] },
    cass: { name: '仙后座 W', pts: [[0.06, 0.34], [0.28, 0.66], [0.5, 0.3], [0.72, 0.68], [0.94, 0.3]], lines: [[0, 1], [1, 2], [2, 3], [3, 4]] },
    cross: { name: '南十字', pts: [[0.5, 0.06], [0.5, 0.94], [0.16, 0.46], [0.84, 0.52], [0.62, 0.72]], lines: [[0, 1], [2, 3]] },
    lyra: { name: '天琴座', pts: [[0.5, 0.08], [0.3, 0.36], [0.68, 0.38], [0.34, 0.74], [0.66, 0.76]], lines: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 4]] },
    scorp: { name: '天蝎座', pts: [[0.12, 0.16], [0.22, 0.3], [0.34, 0.26], [0.4, 0.44], [0.5, 0.58], [0.62, 0.7], [0.76, 0.76], [0.88, 0.66], [0.9, 0.5]], lines: [[0, 1], [1, 2], [1, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8]] },
};
const CONS_OPTS = [['manual', '手动点（自己点星点）'], ...Object.entries(CONSTEL).map(([k, v]) => [k, v.name])];
function consPoints(P) {
    if (P.preset === 'manual') return { pts: S.consHoles.map(h => [h.cx, h.cy]), lines: S.consHoles.map((_, i) => i ? [i - 1, i] : null).filter(Boolean) };
    const d = CONSTEL[P.preset] || CONSTEL.ursa;
    // 预设点位先按「布局框」映射，再叠加手动微调偏移
    const pts = d.pts.map(([px, py], i) => {
        const o = S.consHoles[i];
        const bx = P.spanX / 100, by = P.spanY / 100;
        const x0 = (P.cx / 100) - bx / 2, y0 = (P.cy / 100) - by / 2;
        const x = x0 + px * bx, y = y0 + py * by;
        return o && o.dx !== undefined ? [clamp(x + o.dx, 0, 1), clamp(y + o.dy, 0, 1)] : [x, y];
    });
    return { pts, lines: P.lines ? d.lines : [] };
}
const constellation = {
    id: 'cons',
    name: '星座挖洞',
    hint(P) {
        return P.preset === 'manual'
            ? '在图上点一下 = 放一颗星（自动按顺序连线）。按住星点可拖动；点一下选中的星点删除它。'
            : '选了预设星座：在「版面」里调整整体位置和大小，按住某颗星可以单独微调它的位置。';
    },
    defaults: {
        preset: 'ursa', cx: 50, cy: 50, spanX: 72, spanY: 60, lines: true, lineW: 2, lineAlpha: 55,
        starSize: 9, shape: 'circle', aspect: 1, glow: true, glowPct: 60, numbering: false,
        dim: 42, caption: '', capPos: 'bottom', fontSize: 2.2, font: 'serif', frame: 40,
        bg: '#070a16', fg: '#e8e3d2', lineColor: '#9fb6d6', border: false, grain: 16,
    },
    controls: [
        { group: '版面', key: 'preset', label: '星座', type: 'select', options: CONS_OPTS, onChange() { S.consHoles = []; S.consSel = -1; } },
        { group: '版面', key: 'cx', label: '整体水平位置 %', type: 'range', min: 5, max: 95, step: 1, show: P => P.preset !== 'manual' },
        { group: '版面', key: 'cy', label: '整体垂直位置 %', type: 'range', min: 5, max: 95, step: 1, show: P => P.preset !== 'manual' },
        { group: '版面', key: 'spanX', label: '整体宽度 %', type: 'range', min: 20, max: 100, step: 1, show: P => P.preset !== 'manual' },
        { group: '版面', key: 'spanY', label: '整体高度 %', type: 'range', min: 20, max: 100, step: 1, show: P => P.preset !== 'manual' },
        { group: '版面', key: 'resetPts', label: '清掉所有微调 / 星点', type: 'button', onClick() { S.consHoles = []; S.consSel = -1; } },
        { group: '连线', key: 'lines', label: '画连线', type: 'checkbox' },
        { group: '连线', key: 'lineW', label: '线宽', type: 'range', min: 1, max: 8, step: 0.5, show: P => P.lines },
        { group: '连线', key: 'lineAlpha', label: '线的不透明度 %', type: 'range', min: 10, max: 100, step: 5, show: P => P.lines },
        { group: '形状', key: 'shape', label: '星点形状', type: 'select', options: SHAPE_OPTS },
        { group: '形状', key: 'aspect', label: '长宽比(长方形/椭圆)', type: 'range', min: 0.4, max: 3, step: 0.1, show: P => P.shape === 'rect' || P.shape === 'ellipse' },
        { group: '形状', key: 'drawShape', label: '手绘一个自定义形状', type: 'button', noUndo: true, onClick() { ui.openShapePad(); } },
        { group: '形状', key: 'imgShape', label: '用图片做形状', type: 'button', noUndo: true, onClick() { ui.pickShapeImage(); } },
        { group: '形状', key: 'delShape', label: '删除这个自定义形状', type: 'button', noUndo: true, show: P => String(P.shape).startsWith('custom:'), onClick(P) { ui.deleteCustomShape(P.shape); } },
        { group: '大小与角度', key: 'starSize', label: '星点默认大小 %', type: 'range', min: 2, max: 30, step: 0.5 },
        { group: '大小与角度', key: 'selSize', label: '选中的星点：大小 %', type: 'range', min: 1, max: 40, step: 0.5, show: () => S.consSel >= 0,
          get(P) { const h = S.consHoles[S.consSel]; return h ? (h.size ?? P.starSize) : undefined; },
          set(v) { const h = S.consHoles[S.consSel]; if (h) h.size = v; } },
        { group: '大小与角度', key: 'selRot', label: '选中的星点：角度', type: 'range', min: -180, max: 180, step: 5, show: () => S.consSel >= 0,
          get() { const h = S.consHoles[S.consSel]; return h ? (h.rot || 0) : undefined; },
          set(v) { const h = S.consHoles[S.consSel]; if (h) h.rot = v; } },
        { group: '大小与角度', key: 'delSel', label: '删除选中的星点', type: 'button', show: P => P.preset === 'manual' && S.consSel >= 0, onClick() { if (S.consSel >= 0) S.consHoles.splice(S.consSel, 1); S.consSel = -1; } },
        { group: '画面', key: 'glow', label: '星点发光', type: 'checkbox' },
        { group: '画面', key: 'glowPct', label: '发光强度 %', type: 'range', min: 10, max: 100, step: 5, show: P => P.glow },
        { group: '画面', key: 'numbering', label: '给星点编号', type: 'checkbox' },
        { group: '画面', key: 'dim', label: '压暗背景 %', type: 'range', min: 0, max: 90, step: 1 },
        { group: '画面', key: 'frame', label: '边框宽度', type: 'range', min: 0, max: 150, step: 2 },
        { group: '文字', key: 'caption', label: '题字（留空=取选中的文字）', type: 'text' },
        { group: '文字', key: 'capPos', label: '题字位置', type: 'select', options: [['bottom', '下方'], ['top', '上方'], ['none', '不显示']] },
        { group: '文字', key: 'fontSize', label: '题字大小', type: 'range', min: 1, max: 5, step: 0.1 },
        { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
        { group: '颜色', key: 'bg', label: '边框 / 底色', type: 'color' },
        { group: '颜色', key: 'fg', label: '题字颜色', type: 'color' },
        { group: '颜色', key: 'lineColor', label: '连线颜色', type: 'color' },
        { group: '颜色', key: 'border', label: '星点描边', type: 'checkbox' },
        { group: '质感', key: 'grain', label: '颗粒感 %', type: 'range', min: 0, max: 100, step: 5 },
    ],
    snap() { return JSON.stringify(S.consHoles); },
    restore(str) { S.consHoles = JSON.parse(str); S.consSel = -1; },
    clear() { S.consHoles = []; S.consSel = -1; },
    render(cv, c, P) {
        const img = S.img, IW = 1200, IH = Math.round(IW * imgH(img) / imgW(img)), F = P.frame;
        const fam = fontFamily(P.font), cfs = Math.round(IW * P.fontSize / 100);
        const capTxt = (P.caption || '').trim() || textLines(SAMPLE_CONS).join(' ');
        const capOn = P.capPos !== 'none' && !!capTxt;
        mctx.font = `${cfs}px ${fam}`;
        const capLines = capOn ? textBlock(capTxt, IW * 0.8) : [];
        const capH = capOn ? Math.round(capLines.length * cfs * 1.5 + cfs * 1.4) : 0;
        const W = IW + F * 2, H = IH + F * 2 + capH;
        const iy = F + (P.capPos === 'top' ? capH : 0);
        cv.width = W; cv.height = H;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
        c.drawImage(img, F, iy, IW, IH);
        if (P.dim > 0) { c.fillStyle = `rgba(4,6,14,${P.dim / 100})`; c.fillRect(F, iy, IW, IH); }
        S.consGeo = { x: F, y: iy, w: IW, h: IH };
        const { pts, lines } = consPoints(P);
        const px = pts.map(([fx, fy]) => [F + fx * IW, iy + fy * IH]);
        // 连线
        if (P.lines && lines.length) {
            c.save();
            c.strokeStyle = P.lineColor; c.lineWidth = P.lineW; c.globalAlpha = P.lineAlpha / 100;
            c.lineCap = 'round';
            lines.forEach(([a, b]) => {
                if (!px[a] || !px[b]) return;
                c.beginPath(); c.moveTo(px[a][0], px[a][1]); c.lineTo(px[b][0], px[b][1]); c.stroke();
            });
            c.restore();
        }
        // 星点 = 图片碎片
        const ratio = shapeRatio(P);
        pts.forEach(([fx, fy], i) => {
            const o = S.consHoles[i] || {};
            const sw = IW * (o.size ?? P.starSize) / 100, sh = sw * ratio;
            const g = { cx: fx, cy: fy, w: sw / IW, h: sh / IH };
            const cx2 = px[i][0], cy2 = px[i][1];
            if (P.glow) {
                c.save();
                const gr = c.createRadialGradient(cx2, cy2, 0, cx2, cy2, Math.max(sw, sh) * 1.5);
                gr.addColorStop(0, `rgba(255,255,240,${P.glowPct / 100 * 0.55})`);
                gr.addColorStop(1, 'rgba(255,255,240,0)');
                c.fillStyle = gr;
                c.beginPath(); c.arc(cx2, cy2, Math.max(sw, sh) * 1.5, 0, Math.PI * 2); c.fill();
                c.restore();
            }
            drawFrag(c, P, g, cx2, cy2, sw, sh, o.rot || 0, 0);
            if (P.numbering) {
                c.save();
                c.fillStyle = P.fg; c.font = `${Math.max(12, sw * 0.5)}px ${fam}`;
                c.textAlign = 'left'; c.textBaseline = 'middle';
                c.fillText(String(i + 1), cx2 + sw * 0.7, cy2 - sh * 0.5);
                c.restore();
            }
            if (!S.noGuides && S.consSel === i) drawRing(c, P, cx2, cy2, sw, sh, o.rot || 0);
            S.hits.push({ kind: 'star', i, x: cx2 - sw / 2, y: cy2 - sh / 2, w: sw, h: sh });
        });
        // 题字
        if (capOn) {
            c.fillStyle = P.fg; c.font = `${cfs}px ${fam}`; c.textAlign = 'center'; c.textBaseline = 'middle';
            let y = P.capPos === 'top' ? F + cfs * 1.1 : iy + IH + cfs * 1.1;
            capLines.forEach(t => { c.fillText(t, W / 2, y); y += cfs * 1.5; });
        }
        applyGrain(c, W, H, P.grain);
    },
    onDown(x, y, P) {
        for (let k = S.hits.length - 1; k >= 0; k--) {
            const h = S.hits[k];
            if (h.kind === 'star' && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
                const was = S.consSel === h.i;
                S.consSel = h.i;
                S.consHoles[h.i] ??= {};
                const g = S.consGeo;
                S.drag = { star: h.i, sx: x, sy: y, moved: false, was, manual: P.preset === 'manual',
                           cx0: (h.x + h.w / 2 - g.x) / g.w, cy0: (h.y + h.h / 2 - g.y) / g.h,
                           dx0: S.consHoles[h.i].dx || 0, dy0: S.consHoles[h.i].dy || 0 };
                return true;
            }
        }
        const g = S.consGeo;
        if (!g || x < g.x || x > g.x + g.w || y < g.y || y > g.y + g.h) return false;
        if (P.preset !== 'manual') return false;
        S.consHoles.push({ cx: (x - g.x) / g.w, cy: (y - g.y) / g.h, size: P.starSize, rot: 0 });
        S.consSel = S.consHoles.length - 1;
        return true;
    },
    onMove(x, y, P) {
        const d = S.drag, g = S.consGeo;
        if (!d || d.star === undefined || !g) return false;
        if (Math.hypot(x - d.sx, y - d.sy) > 6) d.moved = true;
        if (!d.moved) return false;
        const h = S.consHoles[d.star];
        if (!h) return false;
        if (d.manual) {
            h.cx = clamp(d.cx0 + (x - d.sx) / g.w, 0, 1);
            h.cy = clamp(d.cy0 + (y - d.sy) / g.h, 0, 1);
        } else {
            h.dx = d.dx0 + (x - d.sx) / g.w;
            h.dy = d.dy0 + (y - d.sy) / g.h;
        }
        return true;
    },
    onUp() {
        const d = S.drag;
        if (d && d.star !== undefined && !d.moved && d.was && d.manual) { S.consHoles.splice(d.star, 1); S.consSel = -1; }
        S.drag = null;
    },
};

/* =====================================================
 * 模板 11：找词游戏（word search）
 * 文字每一行 = 一个要藏的词；点格子可以高亮出答案
 * ===================================================== */
const WS_DIRS = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]];
const WS_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function wsWords(P) {
    const raw = textLines(SAMPLE_WS);
    const out = [];
    raw.forEach(t => {
        const w = t.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
        if (w.length >= 2 && w.length <= P.size) out.push(w);
    });
    return out.slice(0, 24);
}
function wsBuild(P) {
    const n = P.size, words = wsWords(P);
    const rng = mulberry32((S.wsSeed | 0) * 7919 + n * 131 + words.join('').length);
    const grid = Array.from({ length: n }, () => new Array(n).fill(''));
    const dirs = P.diag ? WS_DIRS.slice(0, P.back ? 8 : 4) : (P.back ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : [[1, 0], [0, 1]]);
    const placed = [];
    words.forEach(w => {
        for (let tries = 0; tries < 400; tries++) {
            const d = dirs[Math.floor(rng() * dirs.length)];
            const r0 = Math.floor(rng() * n), c0 = Math.floor(rng() * n);
            const r1 = r0 + d[1] * (w.length - 1), c1 = c0 + d[0] * (w.length - 1);
            if (r1 < 0 || r1 >= n || c1 < 0 || c1 >= n) continue;
            let ok = true;
            for (let i = 0; i < w.length; i++) {
                const rr = r0 + d[1] * i, cc = c0 + d[0] * i;
                if (grid[rr][cc] && grid[rr][cc] !== w[i]) { ok = false; break; }
            }
            if (!ok) continue;
            const cells = [];
            for (let i = 0; i < w.length; i++) {
                const rr = r0 + d[1] * i, cc = c0 + d[0] * i;
                grid[rr][cc] = w[i]; cells.push(rr * n + cc);
            }
            placed.push({ w, cells });
            return;
        }
        placed.push({ w, cells: null });   // 放不下
    });
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (!grid[r][k]) grid[r][k] = WS_LETTERS[Math.floor(rng() * 26)];
    return { n, grid, placed };
}
const wordsearch = {
    id: 'wordsearch',
    name: '找词游戏',
    hint: '文字每一行 = 一个要藏进方阵的词。点格子可以把答案高亮出来（手指划过可连选）；「换一种排法」会重新藏一次。',
    defaults: {
        size: 12, diag: true, back: true, imgFill: true, imgDim: 55, showList: true, listCols: 3, autoMark: false,
        ratio: '3:4', title: 'WORD SEARCH', fontSize: 100, font: 'mono', upper: true,
        bg: '#f3efe4', ink: '#1b1b1b', mark: '#d8563a', markAlpha: 65, grid: 18, grain: 12,
    },
    controls: [
        { group: '网格', key: 'size', label: '方阵边长（格数）', type: 'range', min: 8, max: 20, step: 1, onChange() { S.wsGrid = null; S.wsMark = new Set(); } },
        { group: '网格', key: 'diag', label: '允许斜着藏', type: 'checkbox', onChange() { S.wsGrid = null; } },
        { group: '网格', key: 'back', label: '允许反向藏', type: 'checkbox', onChange() { S.wsGrid = null; } },
        { group: '网格', key: 'reroll', label: '换一种排法', type: 'button', noUndo: true, onClick() { S.wsSeed = (S.wsSeed | 0) + 1; S.wsGrid = null; S.wsMark = new Set(); } },
        { group: '网格', key: 'grid', label: '格线不透明度 %', type: 'range', min: 0, max: 100, step: 5 },
        { group: '选区', key: 'autoMark', label: '一键高亮全部答案', type: 'button', onClick(P) {
            const g = S.wsGrid || (S.wsGrid = wsBuild(P));
            const s = new Set();
            g.placed.forEach(p => { if (p.cells) p.cells.forEach(i => s.add(i)); });
            S.wsMark = s;
        } },
        { group: '选区', key: 'clrMark', label: '清掉高亮', type: 'button', onClick() { S.wsMark = new Set(); } },
        { group: '版面', key: 'ratio', label: '画面比例', type: 'select', options: RATIO_OPTS },
        { group: '版面', key: 'imgFill', label: '字母用图片填色（关掉=纯色字）', type: 'checkbox' },
        { group: '版面', key: 'imgDim', label: '图片压暗 %', type: 'range', min: 0, max: 90, step: 1, show: P => P.imgFill },
        { group: '版面', key: 'showList', label: '显示要找的词清单', type: 'checkbox' },
        { group: '版面', key: 'listCols', label: '清单分几栏', type: 'range', min: 1, max: 4, step: 1, show: P => P.showList },
        { group: '文字', key: 'title', label: '标题', type: 'text' },
        { group: '文字', key: 'fontSize', label: '字母大小 %', type: 'range', min: 50, max: 140, step: 2 },
        { group: '文字', key: 'font', label: '字体', type: 'select', options: FONT_OPTS },
        { group: '文字', key: 'upper', label: '清单转大写', type: 'checkbox' },
        { group: '颜色', key: 'bg', label: '底色', type: 'color' },
        { group: '颜色', key: 'ink', label: '字母 / 文字色', type: 'color' },
        { group: '颜色', key: 'mark', label: '高亮颜色', type: 'color' },
        { group: '颜色', key: 'markAlpha', label: '高亮不透明度 %', type: 'range', min: 20, max: 100, step: 5 },
        { group: '质感', key: 'grain', label: '颗粒感 %', type: 'range', min: 0, max: 100, step: 5 },
    ],
    snap() { return JSON.stringify({ m: [...S.wsMark], s: S.wsSeed }); },
    restore(str) { const d = JSON.parse(str); S.wsMark = new Set(d.m); S.wsSeed = d.s; S.wsGrid = null; },
    clear() { S.wsMark = new Set(); },
    render(cv, c, P) {
        const G = (S.wsGrid && S.wsGrid.n === P.size) ? S.wsGrid : (S.wsGrid = wsBuild(P));
        const n = G.n;
        const [rw, rh] = RATIOS[P.ratio] || [3, 4];
        const W = 1200, H = Math.round(W * rh / rw);
        cv.width = W; cv.height = H;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
        const fam = fontFamily(P.font);
        const M = W * 0.07;
        // 标题
        let top = M;
        if (P.title.trim()) {
            const tfs = Math.round(W * 0.048);
            c.fillStyle = P.ink; c.font = `900 ${tfs}px ${fam}`; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
            if ('letterSpacing' in c) c.letterSpacing = (tfs * 0.1) + 'px';
            c.fillText(P.upper ? P.title.toUpperCase() : P.title, M, top + tfs * 0.9);
            if ('letterSpacing' in c) c.letterSpacing = '0px';
            top += tfs * 1.9;
        }
        // 清单高度预估
        const words = G.placed.map(p => p.w);
        const lfs = Math.round(W * 0.021);
        const lCols = Math.max(1, Math.min(P.listCols, 4));
        const lRows = P.showList && words.length ? Math.ceil(words.length / lCols) : 0;
        const listH = lRows ? Math.round(lRows * lfs * 1.7 + lfs * 2.2) : 0;
        // 方阵
        const avail = Math.min(W - M * 2, H - top - listH - M);
        const cell = avail / n, gx = (W - cell * n) / 2, gy = top;
        S.wsGeo = { gx, gy, cell, n };
        // 字母：可以用图片填色（把图裁进方阵范围，再用字母当遮罩）
        const letterFs = cell * clamp(P.fontSize / 100, 0.5, 1.4) * 0.72;
        const drawLetters = ctx => {
            ctx.font = `bold ${letterFs}px ${fam}`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) {
                ctx.fillText(G.grid[r][k], gx + (k + 0.5) * cell, gy + (r + 0.5) * cell);
            }
        };
        // 高亮层（在字母下面）
        if (S.wsMark.size) {
            c.save();
            c.globalAlpha = P.markAlpha / 100;
            c.fillStyle = P.mark;
            S.wsMark.forEach(i => {
                const r = Math.floor(i / n), k = i % n;
                const pad = cell * 0.06;
                c.beginPath();
                const rx = gx + k * cell + pad, ry = gy + r * cell + pad, rw2 = cell - pad * 2, rh2 = cell - pad * 2, rr = cell * 0.22;
                c.moveTo(rx + rr, ry);
                c.arcTo(rx + rw2, ry, rx + rw2, ry + rh2, rr);
                c.arcTo(rx + rw2, ry + rh2, rx, ry + rh2, rr);
                c.arcTo(rx, ry + rh2, rx, ry, rr);
                c.arcTo(rx, ry, rx + rw2, ry, rr);
                c.closePath(); c.fill();
            });
            c.restore();
        }
        // 格线
        if (P.grid > 0) {
            c.save();
            c.globalAlpha = P.grid / 100; c.strokeStyle = P.ink; c.lineWidth = 1;
            for (let i = 0; i <= n; i++) {
                c.beginPath(); c.moveTo(gx + i * cell, gy); c.lineTo(gx + i * cell, gy + n * cell); c.stroke();
                c.beginPath(); c.moveTo(gx, gy + i * cell); c.lineTo(gx + n * cell, gy + i * cell); c.stroke();
            }
            c.restore();
        }
        if (P.imgFill) {
            const lay = document.createElement('canvas');
            lay.width = W; lay.height = H;
            const lc = lay.getContext('2d');
            lc.fillStyle = '#000';
            drawLetters(lc);
            lc.globalCompositeOperation = 'source-in';
            drawCover(lc, S.img, gx, gy, cell * n, cell * n);
            if (P.imgDim > 0) {
                lc.globalCompositeOperation = 'source-atop';
                lc.fillStyle = `rgba(0,0,0,${P.imgDim / 100})`;
                lc.fillRect(gx, gy, cell * n, cell * n);
            }
            c.drawImage(lay, 0, 0);
        } else {
            c.fillStyle = P.ink;
            drawLetters(c);
        }
        // 命中区
        for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) {
            S.hits.push({ kind: 'wsc', i: r * n + k, x: gx + k * cell, y: gy + r * cell, w: cell, h: cell });
        }
        // 清单
        if (lRows) {
            let y = gy + n * cell + lfs * 2;
            c.fillStyle = P.ink; c.textAlign = 'left'; c.textBaseline = 'middle';
            c.font = `bold ${Math.round(lfs * 0.9)}px ${fam}`;
            if ('letterSpacing' in c) c.letterSpacing = (lfs * 0.12) + 'px';
            c.fillText('FIND:', M, y - lfs * 0.9);
            if ('letterSpacing' in c) c.letterSpacing = '0px';
            const colW = (W - M * 2) / lCols;
            c.font = `${lfs}px ${fam}`;
            G.placed.forEach((p, i) => {
                const col = Math.floor(i / lRows), row = i % lRows;
                const bx = M + col * colW, by = y + row * lfs * 1.7;
                const found = p.cells && p.cells.every(q => S.wsMark.has(q));
                c.fillStyle = P.ink;
                c.globalAlpha = p.cells ? 1 : 0.4;
                const tx = P.upper ? p.w.toUpperCase() : p.w;
                c.fillText(tx, bx + lfs * 0.9, by);
                // 小标记：已全部高亮的词划掉
                if (found) {
                    const tw = c.measureText(tx).width;
                    c.save(); c.strokeStyle = P.mark; c.lineWidth = 2;
                    c.beginPath(); c.moveTo(bx + lfs * 0.8, by); c.lineTo(bx + lfs * 1.0 + tw, by); c.stroke(); c.restore();
                }
                c.beginPath(); c.arc(bx + lfs * 0.3, by, lfs * 0.16, 0, Math.PI * 2);
                c.fillStyle = found ? P.mark : P.ink; c.fill();
                c.globalAlpha = 1;
            });
        }
        applyGrain(c, W, H, P.grain);
    },
    onDown(x, y) { return paintDown('wsc', S.wsMark, x, y); },
    onMove: paintMove,
    onUp() { S.drag = null; },
};

/* ---------- 模板注册 ---------- */
function register(t) {
    TEMPLATES[t.id] = t;
    if (overlay) refreshTplSelect();
}
[cutout, blackout, captcha, shape, timeline, detect, board, cloze, vinyl, constellation, wordsearch]
    .forEach(t => TEMPLATES[t.id] = t);
window.CutoutPoster = {
    register, templates: TEMPLATES,
    util: { S, pathShape, tokenize, wrap, fontFamily, mulberry32, clamp, paintDown, paintMove, drawFrag, drawCover, textBlock, applyGrain },
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
function setImage(im, isCrop) {
    S.img = im; if (!isCrop) S.srcImg = im;
    S.imgId++;
    S.cut.holes = []; S.sel = -1; S.boxes = [];
    S.detPos = {}; S.detLab = {}; S.boardImgs = [];
    S.consHoles = []; S.consSel = -1;
    S.undo = [];
}

/* =====================================================
 * 面板
 * ===================================================== */
let overlay = null, cv = null, c2d = null, rafPending = false;
const panelPos = { x: 0, y: 0 };
const fontLoading = new Set();
const $ = sel => overlay.querySelector(sel);

function curTpl() { return TEMPLATES[getSettings().template] || TEMPLATES.cutout; }
function params() {
    const st = getSettings(), tpl = curTpl();
    st.params[tpl.id] = Object.assign({}, tpl.defaults, st.params[tpl.id]);
    if (tpl.migrate) tpl.migrate(st.params[tpl.id]);
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
    syncControls();
    updateVisibility();
}
function renderExport() {
    const tpl = curTpl(), P = params();
    const off = document.createElement('canvas');
    S.noGuides = true;
    try { tpl.render(off, off.getContext('2d'), P); } finally { S.noGuides = false; }
    render();
    return off;
}
const ui = {
    setParam(key, val) {
        params()[key] = val; saveSettings();
        const el = S.ctls[key];
        if (el) { if (el.type === 'checkbox') el.checked = val; else el.value = val; if (el._out) el._out.textContent = ' ' + val; }
    },
};
const TABS = [['src', '素材'], ['layout', '版面'], ['elem', '元素'], ['text', '文字'], ['look', '外观'], ['more', '更多']];
const GROUP_TAB = {
    '版面': 'layout', '背景': 'layout', '排字方式': 'layout', '排布': 'layout', '点选': 'layout', '网格': 'layout', '波浪': 'layout', '关系图': 'layout', '画面': 'layout', '连线': 'layout',
    '形状': 'elem', '大小与角度': 'elem', '大小': 'elem', '选中的字': 'elem', '字块': 'elem', '选区': 'elem', '唱片': 'elem',
    '文字': 'text', '文字排版': 'text',
    '颜色': 'look', '质感': 'look',
};
function activateTab(key) {
    overlay.querySelectorAll('.cp_tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === key));
    overlay.querySelectorAll('.cp_pane').forEach(pn => { pn.style.display = pn.dataset.pane === key ? '' : 'none'; });
}
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
    TABS.forEach(([k]) => {
        if (k === 'src' || k === 'more') return;
        const pane = overlay.querySelector(`.cp_pane[data-pane=<q>"${k}"</q>]`), btn = overlay.querySelector(`.cp_tabs button[data-tab=<q>"${k}"</q>]`);
        if (!pane || !btn) return;
        const any = [...pane.querySelectorAll('.cp_card')].some(cd => cd.style.display !== 'none');
        btn.style.display = any
