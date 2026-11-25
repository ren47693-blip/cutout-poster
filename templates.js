/* 文字抽取成图 (Cutout Poster) v1.1 —— templates.js（第 1/2 段）
 * 模板定义。依赖 core.js 创建的 window.__CP。
 */
(() => {
    'use strict';
    const CP = window.__CP;
    if (!CP) { console.error('[CutoutPoster] core.js 没有先加载'); return; }
    const {
        SAMPLE, SAMPLES, clamp, hash, roundRect, mulberry32, getSettings,
        tokenize, wrap, mctx, textBlock, textLines, unitsOf, romanize,
        FONT_OPTS, fontFamily, pathShape, SHAPE_OPTS, shapeRatio,
        S, TEMPLATES, imgW, imgH, drawCover, applyGrain, RATIOS, RATIO_OPTS,
        holeGeom, drawFrag, drawRing, fillHole, paintDown, paintMove, ui,
        holeInnerShadow, setDropShadow,
    } = CP;

    /* =====================================================
     * 模板 1：挖洞置换
     * ===================================================== */
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
            return '点空白处挖洞；点洞选中后在「元素」里调大小和角度，按住洞可拖动，再点一下选中的洞删除。一个洞都不挖也可以。图外的碎片可以拖动。想加说明文字就到「附加文字」里写。';
        },
        migrate(P) {
            if (P.layout === 'below') { P.layout = 'panel'; P.side = 'below'; }
            if (P.shape === 'bird') P.shape = 'circle';
            P.slotSide ??= 'below';
            P.slotImgPct ??= 100;
            P.textA ??= ''; P.textB ??= '';
            P.textPos ??= 'vert';
            P.holeShadow ??= 0; P.fragShadow ??= 0; P.shadowAngle ??= 135;
        },
        defaults: {
            layout: 'panel', side: 'below', arrange: 'mirror', panelPct: 100, framePct: 14, spread: 30, gridCols: 6,
            glyph: '', fillGlyph: true, fragScale: 100, gran: 'char', slotMode: 'replace', slotScale: 1.25,
            freeSlot: false, slotOpacity: 100, slotSide: 'below', slotImgPct: 100,
            shape: 'square', aspect: 1.5, size: 12,
            holeShadow: 0, fragShadow: 0, shadowAngle: 135,
            textA: '', textB: '', textPos: 'vert', textSizeA: 2.6, textSizeB: 1.6, textAlign: 'center', textFont: 'theme', textColor: '#222222',
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
            { group: '阴影', key: 'holeShadow', label: '洞的内阴影 %（凹下去）', type: 'range', min: 0, max: 100, step: 5 },
            { group: '阴影', key: 'fragShadow', label: '碎片的投影 %（浮起来）', type: 'range', min: 0, max: 100, step: 5 },
            { group: '阴影', key: 'shadowAngle', label: '光照方向', type: 'range', min: 0, max: 360, step: 15, show: P => P.holeShadow > 0 || P.fragShadow > 0 },
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
            { group: '附加文字', key: 'textPos', label: '文字放在图的哪两边', type: 'select', options: [['vert', '上方 / 下方'], ['horiz', '左边 / 右边']], show: P => P.layout !== 'slots' },
            { group: '附加文字', key: 'textA', label: '文字一（上方 / 左边）', type: 'text', show: P => P.layout !== 'slots' },
            { group: '附加文字', key: 'textB', label: '文字二（下方 / 右边）', type: 'text', show: P => P.layout !== 'slots' },
            { group: '附加文字', key: 'textSizeA', label: '文字一大小', type: 'range', min: 0.8, max: 7, step: 0.1, show: P => P.layout !== 'slots' && !!P.textA },
            { group: '附加文字', key: 'textSizeB', label: '文字二大小', type: 'range', min: 0.8, max: 7, step: 0.1, show: P => P.layout !== 'slots' && !!P.textB },
            { group: '附加文字', key: 'textAlign', label: '对齐', type: 'select', options: [['center', '居中'], ['left', '靠左'], ['right', '靠右']], show: P => P.layout !== 'slots' && (!!P.textA || !!P.textB) },
            { group: '附加文字', key: 'textFont', label: '字体', type: 'select', options: FONT_OPTS, show: P => P.layout !== 'slots' && (!!P.textA || !!P.textB) },
            { group: '附加文字', key: 'textColor', label: '颜色', type: 'color', show: P => P.layout !== 'slots' && (!!P.textA || !!P.textB) },
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
                const F = slotsFrame(P, IW, IH);
                if (P.freeSlot) renderSlotsFree(cv, c, P, IW, IH, holes, G0, F);
                else renderSlots(cv, c, P, IW, IH, holes, G0, F);
                applyGrain(c, cv.width, cv.height, P.grain);
                return;
            }
            const tfam = fontFamily(P.textFont);
            const hasA = !!(P.textA || '').trim(), hasB = !!(P.textB || '').trim();
            const horizText = P.textPos === 'horiz';
            const fsA = Math.round(IW * P.textSizeA / 100), fsB = Math.round(IW * P.textSizeB / 100);
            let tAw = 0, tBw = 0, tAlines = [], tBlines = [];
            if (hasA) {
                mctx.font = `${fsA}px ${tfam}`;
                tAlines = horizText ? textBlock(P.textA, IW * 0.3) : textBlock(P.textA, IW * 0.9);
                tAw = Math.max(...tAlines.map(t => mctx.measureText(t).width));
            }
            if (hasB) {
                mctx.font = `${fsB}px ${tfam}`;
                tBlines = horizText ? textBlock(P.textB, IW * 0.3) : textBlock(P.textB, IW * 0.9);
                tBw = Math.max(...tBlines.map(t => mctx.measureText(t).width));
            }
            const tAh = hasA ? tAlines.length * fsA * 1.45 + fsA * 1.1 : 0;
            const tBh = hasB ? tBlines.length * fsB * 1.45 + fsB * 1.1 : 0;
            const padA = horizText ? (hasA ? tAw + fsA * 1.6 : 0) : tAh;
            const padB = horizText ? (hasB ? tBw + fsB * 1.6 : 0) : tBh;
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
            const offX = horizText ? padA : 0, offY = horizText ? 0 : padA;
            const CW = W + (horizText ? padA + padB : 0);
            const CH = H + (horizText ? 0 : padA + padB);
            cv.width = CW; cv.height = CH;
            S.cvW = CW; S.cvH = CH;
            c.fillStyle = P.bg; c.fillRect(0, 0, CW, CH);
            c.save();
            c.translate(offX, offY);
            c.drawImage(img, ix, iy, iw, ih);
            S.geo = { x: ix + offX, y: iy + offY, w: iw, h: ih };
            const G = holes.map(h => holeGeom(P, h, iw, ih));
            G.forEach((g, i) => {
                const hx = ix + g.cx * iw, hy = iy + g.cy * ih, hw = g.w * iw, hh = g.h * ih;
                fillHole(c, P, hx, hy, hw, hh, holes[i].hrot || 0);
                if (P.holeShadow > 0) {
                    c.save();
                    c.translate(hx, hy);
                    if (holes[i].hrot) c.rotate(holes[i].hrot * Math.PI / 180);
                    holeInnerShadow(c, P.shape, 0, 0, hw, hh, P);
                    c.restore();
                }
            });
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
                    c.save();
                    setDropShadow(c, Math.max(sizes[i].w, sizes[i].h), P);
                    drawFrag(c, P, g, dx, dy, sizes[i].w, sizes[i].h, o.rot || 0, o.hrot || 0);
                    c.restore();
                    S.hits.push({ kind: 'frag', i, x: dx - sizes[i].w / 2 + offX, y: dy - sizes[i].h / 2 + offY, w: sizes[i].w, h: sizes[i].h });
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
                        c.save();
                        setDropShadow(c, Math.max(z.w, z.h) * f, P);
                        drawFrag(c, P, G[i], spots[k].x, spots[k].y, z.w * f, z.h * f, holes[i].rot || 0, holes[i].hrot || 0);
                        c.restore();
                    }
                }
            }
            if (!S.noGuides && S.sel >= 0 && G[S.sel]) {
                const g = G[S.sel];
                drawRing(c, P, ix + g.cx * iw, iy + g.cy * ih, g.w * iw, g.h * ih, holes[S.sel].hrot || 0);
            }
            c.restore();
            if (hasA || hasB) {
                c.fillStyle = P.textColor; c.textBaseline = 'middle';
                const put = (lines, fs, bx, by, bw) => {
                    c.font = `${fs}px ${tfam}`;
                    const al = P.textAlign;
                    c.textAlign = al === 'center' ? 'center' : al === 'right' ? 'right' : 'left';
                    const ax = al === 'center' ? bx + bw / 2 : al === 'right' ? bx + bw : bx;
                    let y = by;
                    lines.forEach(t => { c.fillText(t, ax, y); y += fs * 1.45; });
                };
                if (horizText) {
                    if (hasA) put(tAlines, fsA, fsA * 0.8, CH / 2 - (tAlines.length - 1) * fsA * 0.72, padA - fsA * 1.6);
                    if (hasB) put(tBlines, fsB, CW - padB + fsB * 0.8, CH / 2 - (tBlines.length - 1) * fsB * 0.72, padB - fsB * 1.6);
                } else {
                    if (hasA) put(tAlines, fsA, CW * 0.05, fsA * 1.1, CW * 0.9);
                    if (hasB) put(tBlines, fsB, CW * 0.05, CH - tBh + fsB * 1.0, CW * 0.9);
                }
                c.textAlign = 'left';
            }
            applyGrain(c, CW, CH, P.grain);
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
                const W2 = S.cvW || 1200, H2 = S.cvH || 1200;
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
        S.cvW = W; S.cvH = H;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
        c.drawImage(S.img, F.imgX, imgY, F.iw, F.ih);
        S.geo = { x: F.imgX, y: imgY, w: F.iw, h: F.ih };
        G.forEach((g, i) => {
            const hx = F.imgX + g.cx * F.iw, hy = imgY + g.cy * F.ih, hw = g.w * F.iw, hh = g.h * F.ih;
            fillHole(c, P, hx, hy, hw, hh, holes[i].hrot || 0);
            if (P.holeShadow > 0) {
                c.save(); c.translate(hx, hy);
                if (holes[i].hrot) c.rotate(holes[i].hrot * Math.PI / 180);
                holeInnerShadow(c, P.shape, 0, 0, hw, hh, P);
                c.restore();
            }
        });
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
                    if (g) {
                        c.save(); setDropShadow(c, Math.max(it.fw, it.fh), P);
                        drawFrag(c, P, g, fx + it.fw / 2, cy, it.fw, it.fh, holes[it.i].rot || 0, holes[it.i].hrot || 0);
                        c.restore();
                    } else if (!S.noGuides) {
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
        S.cvW = W; S.cvH = H;
        c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
        c.drawImage(S.img, F.imgX, imgY, F.iw, F.ih);
        S.geo = { x: F.imgX, y: imgY, w: F.iw, h: F.ih };
        G.forEach((g, i) => {
            const hx = F.imgX + g.cx * F.iw, hy = imgY + g.cy * F.ih, hw = g.w * F.iw, hh = g.h * F.ih;
            fillHole(c, P, hx, hy, hw, hh, holes[i].hrot || 0);
            if (P.holeShadow > 0) {
                c.save(); c.translate(hx, hy);
                if (holes[i].hrot) c.rotate(holes[i].hrot * Math.PI / 180);
                holeInnerShadow(c, P.shape, 0, 0, hw, hh, P);
                c.restore();
            }
        });
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
            c.save(); setDropShadow(c, Math.max(fw, fh), P);
            drawFrag(c, P, g, dx, dy, fw, fh, o.rot || 0, o.hrot || 0);
            c.restore();
            S.hits.push({ kind: 'free', i, x: dx - fw / 2, y: dy - fh / 2, w: fw, h: fh });
        });
        c.restore();
        if (!S.noGuides && S.sel >= 0) {
            const h = S.hits.find(q => q.kind === 'free' && q.i === S.sel);
            if (h) drawRing(c, P, h.x + h.w / 2, h.y + h.h / 2, h.w, h.h, holes[S.sel].rot || 0);
        }
    }

    /* =====================================================
     * 模板 2：涂黑诗
     * ===================================================== */
    const blackout = {
        id: 'blackout',
        name: '涂黑诗',
        hint: '点词语：这个词从涂黑里露出来；手指划过可连选。涂黑的地方不会画字，所以完全看不见。预览时黑条上的小点只是提示可点位置，导出时不会出现。',
        defaults: { gran: 'char', fontSize: 3.6, font: 'theme', gap: 20, pad: 14, redact: true, dots: true, paper: '#f4efdc', ink: '#111111', bar: '#111111' },
        controls: [
            { group: '点选', key: 'gran', label: '点选单位', type: 'select', options: [['char', '逐字'], ['word', '按词(中文自动分词)']], onChange() { S.keep = null; } },
            { group: '点选', key: 'dots', label: '预览时显示可点提示点', type: 'checkbox' },
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
            const hasKept = lines.map(l => l.items.some(it => !it.nl && S.keep.set.has(it.i)));
            const shown = [];
            lines.forEach((l, li) => { if (guides || hasKept[li]) shown.push(li); });
            const rows = Math.max(1, shown.length);
            cv.width = W; cv.height = Math.round(M * 2 + rows * lh);
            S.cvW = cv.width; S.cvH = cv.height;
            c.fillStyle = P.paper; c.fillRect(0, 0, W, cv.height);
            c.font = `${fs}px ${fam}`; c.textBaseline = 'middle';
            const pad = fs * P.pad / 100;
            const barTop = lh * clamp(P.gap / 100 * 0.5, 0, 0.4);
            const barH = lh - barTop * 2;
            shown.forEach((li, row) => {
                const y = M + row * lh;
                const real = lines[li].items.filter(it => !it.nl);
                let x = M;
                const pos = real.map(it => { const p = { it, x }; x += it.w; return p; });
                const lineEnd = pos.length ? pos[pos.length - 1].x + pos[pos.length - 1].it.w : M;
                c.fillStyle = P.bar;
                if (P.redact) {
                    let a = 0;
                    while (a < pos.length) {
                        if (S.keep.set.has(pos[a].it.i)) { a++; continue; }
                        let b = a;
                        while (b + 1 < pos.length && !S.keep.set.has(pos[b + 1].it.i)) b++;
                        const x0 = (a === 0 ? M : pos[a].x - pad);
                        const x1 = (b === pos.length - 1 ? lineEnd : pos[b].x + pos[b].it.w + pad);
                        c.fillRect(x0, y + barTop, Math.max(0, x1 - x0), barH);
                        a = b + 1;
                    }
                } else {
                    c.fillRect(M, y + barTop, lineEnd - M, barH);
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
                c.fillStyle = P.ink;
                pos.forEach(p => { if (S.keep.set.has(p.it.i)) c.fillText(p.it.t, p.x, y + lh / 2); });
                if (guides && P.dots) {
                    c.save(); c.fillStyle = 'rgba(255,255,255,.26)';
                    pos.forEach(p => {
                        if (S.keep.set.has(p.it.i)) return;
                        const r = Math.max(1.5, fs * 0.045);
                        c.beginPath(); c.arc(p.x + p.it.w / 2, y + lh / 2, r, 0, Math.PI * 2); c.fill();
                    });
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
     * 可批量上传图片，也可以从一张图里框选若干块当素材
     * ===================================================== */
    const captcha = {
        id: 'captcha',
        name: '验证码九宫格',
        hint: '点格子：选中/取消；手指划过可连选。标题留空则取选中的文字。「背景」里可以批量上传图片，或者用「从图里截一块」在一张图上框选若干块当素材。',
        migrate(P) { P.multi ??= 'seq'; },
        defaults: { cols: 4, rows: 4, gap: 8, title: '', sub: 'If there are none, click skip', blue: '#2f77e8', multi: 'seq' },
        controls: [
            { group: '文字', key: 'title', label: '大标题(留空=选中文字)', type: 'text' },
            { group: '文字', key: 'sub', label: '副标题', type: 'text' },
            { group: '网格', key: 'cols', label: '列数', type: 'range', min: 2, max: 8, step: 1, onChange() { S.cells = null; } },
            { group: '网格', key: 'rows', label: '行数', type: 'range', min: 2, max: 8, step: 1, onChange() { S.cells = null; } },
            { group: '网格', key: 'gap', label: '格间距', type: 'range', min: 0, max: 20, step: 1 },
            { group: '背景', key: 'cropImgs', label: '从图里截一块（可反复截）', type: 'button', noUndo: true, onClick() { ui.openCropPicker('captcha'); } },
            { group: '背景', key: 'addImgs', label: '上传一批图片（可多选）', type: 'button', noUndo: true, onClick() { ui.addCaptchaImages(); } },
            { group: '背景', key: 'clrImgs', label: '清掉这批素材（回到单张主图）', type: 'button', noUndo: true, onClick() { S.capImgs = []; } },
            { group: '背景', key: 'multi', label: '多图怎么分配', type: 'select', options: [['seq', '按格子顺序轮流'], ['rowwise', '每行换一张'], ['rand', '随机分配']] },
            { group: '颜色', key: 'blue', label: '主色', type: 'color' },
        ],
        snap() { return JSON.stringify([...(S.cells ? S.cells.set : [])]); },
        restore(str) { S.cells = { set: new Set(JSON.parse(str)) }; },
        clear() { S.cells = { set: new Set() }; },
        render(cv, c, P) {
            S.cells ??= { set: new Set() };
            S.capImgs ??= [];
            const pics = S.capImgs.length ? S.capImgs : [S.img];
            const W = 1000, pad = 40, gap = P.gap, cols = P.cols, rows = P.rows;
            const gw = W - pad * 2, cw = (gw - gap * (cols - 1)) / cols, gh = rows * cw + gap * (rows - 1);
            const headH = 280, footH = 170, y0 = pad + headH + gap, footY = y0 + gh + gap;
            cv.width = W; cv.height = Math.round(footY + footH);
            S.cvW = cv.width; S.cvH = cv.height;
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
            const single = pics.length === 1;
            let s = 1, sx0 = 0, sy0 = 0;
            if (single) {
                s = Math.max(gw / imgW(pics[0]), gh / imgH(pics[0]));
                sx0 = (imgW(pics[0]) - gw / s) / 2;
                sy0 = (imgH(pics[0]) - gh / s) / 2;
            }
            for (let r = 0; r < rows; r++) {
                for (let k = 0; k < cols; k++) {
                    const dx = pad + k * (cw + gap), dy = y0 + r * (cw + gap), idx = r * cols + k;
                    const sel = S.cells.set.has(idx);
                    const sc = sel ? 0.84 : 1, dw = cw * sc, off = (cw - dw) / 2;
                    if (single) {
                        c.drawImage(pics[0], sx0 + (dx - pad) / s, sy0 + (dy - y0) / s, cw / s, cw / s, dx + off, dy + off, dw, dw);
                    } else {
                        let pi;
                        if (P.multi === 'rowwise') pi = pics[r % pics.length];
                        else if (P.multi === 'rand') pi = pics[Math.floor(hash(idx * 3 + 1) * pics.length) % pics.length];
                        else pi = pics[idx % pics.length];
                        c.save();
                        c.beginPath(); c.rect(dx + off, dy + off, dw, dw); c.clip();
                        drawCover(c, pi, dx + off, dy + off, dw, dw);
                        c.restore();
                    }
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
