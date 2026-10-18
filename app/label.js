/* Gram Tracker — offline label reader.
   readLabel(file)  -> runs on-device OCR (Tesseract, bundled in /vendor) and returns parseLabel(text).
   parseLabel(text) -> pure function: finds the per-100 g / per-serving columns and the nutrient rows. */
(function () {
  let workerPromise = null;
  let progressCb = null;

  function getWorker() {
    if (workerPromise) return workerPromise;
    const base = new URL('vendor/', location.href).href;
    workerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core',
      langPath: base + 'lang',
      // The APK build unpacks eng.traineddata.gz into eng.traineddata, so read it uncompressed there
      gzip: !window.GramAndroid,
      workerBlobURL: false,
      logger: m => { if (progressCb && m.status === 'recognizing text') progressCb(m.progress); },
    }).then(async w => {
      await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
      return w;
    }).catch(e => { workerPromise = null; throw e; });
    return workerPromise;
  }

  /* Grayscale and stretch contrast. Labels: enlarge small print (up to 2200 px).
     Packaging: shrink so big names are ~50 px tall, use the darkest colour channel so white-on-colour text
     stands out, and optionally invert so light text on dark badges reads as dark on light. */
  async function prepare(file, opt = {}) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const long = Math.max(bmp.width, bmp.height);
    const scale = opt.fit ? Math.max(0.25, Math.min(3, opt.fit / long)) : opt.side ? Math.min(1, opt.side / long) : Math.min(3, Math.max(1, 2200 / long));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = opt.minChannel ? Math.min(d[i], d[i + 1], d[i + 2]) : (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      d[i] = g; hist[g]++;
    }
    if (opt.rows) {
      /* Striped tables (white text on coloured rows, dark text on white rows): find each row's background
         and whether its text is lighter or darker, flip the light-text rows, then even out the background
         so every row ends up as dark text on white. */
      const bg = new Float32Array(h), bright = new Float32Array(h + 1), dark = new Float32Array(h + 1);
      const hst = new Uint32Array(256);
      for (let y = 0; y < h; y++) {
        hst.fill(0);
        for (let x = 0; x < w; x++) hst[d[(y * w + x) * 4]]++;
        let acc2 = 0, med = 255;
        for (let v = 0; v < 256; v++) { acc2 += hst[v]; if (acc2 >= w / 2) { med = v; break; } }
        bg[y] = med;
        let b = 0, k = 0;
        for (let x = 0; x < w; x++) { const v = d[(y * w + x) * 4]; if (v > med + 45) b++; else if (v < med - 45) k++; }
        bright[y + 1] = bright[y] + b; dark[y + 1] = dark[y] + k;
      }
      const R = Math.max(6, Math.round(h * 0.012));
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
        const lightText = bright[y1] - bright[y0] > (dark[y1] - dark[y0]) * 1.2;
        const base = lightText ? 255 - bg[y] : bg[y];
        for (let x = 0; x < w; x++) {
          const i2 = (y * w + x) * 4;
          let v = lightText ? 255 - d[i2] : d[i2];
          v = Math.max(0, Math.min(255, v * 255 / Math.max(60, base)));
          d[i2] = d[i2 + 1] = d[i2 + 2] = v;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    }
    const total = w * h; let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) { let v = Math.max(0, Math.min(255, (d[i] - lo) * 255 / span)); if (opt.invert) v = 255 - v; d[i] = d[i + 1] = d[i + 2] = v; }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* One OCR job at a time on the shared worker. psm 6 = one block of text (labels), 11 = scattered text (packaging). */
  let queue = Promise.resolve();
  function queued(job) {
    const p = queue.then(job, job);
    queue = p.catch(() => {});
    return p;
  }
  function recognize(file, psm, onProgress, opt) {
    return queued(async () => {
      progressCb = onProgress || null;
      try {
        const [worker, canvas] = await Promise.all([getWorker(), prepare(file, opt)]);
        await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: '' });
        const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
        return { ...data, imgH: canvas.height, canvas };
      } finally { progressCb = null; }
    });
  }

  /* Text that is too small or too big both read badly, and photo sizes vary a lot. Read at a standard size first;
     if the numbers don't add up (energy vs. macros) or values are missing, try other sizes and keep the best.
     Striped tables (white text on coloured rows) are handled by flipping those rows (prepare: rows). */
  async function readLabel(file, onProgress) {
    const attempt = async (fit, rows) => {
      const data = await recognize(file, '6', p => onProgress && onProgress(p * 0.6), { fit, rows });
      let fixes = new Map();
      try { fixes = await refineNumbers(data, p => onProgress && onProgress(0.6 + p * 0.4)); }
      catch (e) { console.warn('number re-read skipped', e); }
      const text = rebuildText(data, fixes);
      const table = readTable(data, fixes, text);
      const lineRead = parseLabel(text);
      if (table && table.basis === lineRead.basis) {
        const added = [];
        for (const [k, v] of Object.entries(lineRead.values)) if (table.values[k] == null) { table.values[k] = v; added.push(k); }
        if (added.length) { table.found = Object.keys(table.values).length; table.energyOk = energyOk(table.values); }
      }
      const parsed = table && (table.found >= lineRead.found || table.crossOk) ? table : lineRead;
      return { text, ...parsed, score: parsed.found + (parsed.energyOk ? 3 : 0) + (parsed.crossOk ? 2 : 0) };
    };
    // striped-row handling first; plain reading and other sizes only if the numbers don't add up
    let best = await attempt(2000, true);
    for (const [fit, rows] of [[2000, false], [1400, true], [2800, true], [1400, false]]) {
      if (best.found >= 5 && best.energyOk) break;
      const r = await attempt(fit, rows);
      if (r.score > best.score) best = r;
    }
    return best;
  }

  /* Small decimal points get lost when the whole label is read at once (12.6 -> 126), and the unit "g"
     is often read as a 9 (2.52g -> 2529). Re-read each number on a nutrient row on its own: crop it, enlarge it,
     and read it allowing only digits, the point and unit letters. The re-read is accepted when it keeps the
     digits that were already read (it may add a missing point or digit, or drop a "g" read as 9). */
  const digitsOf = t => (t.match(/\d/g) || []).join('');
  const isSubsequence = (a, b) => { let i = 0; for (const ch of b) if (ch === a[i]) i++; return i === a.length; };
  const NUM_RE = /(\d+(?:[.,]\d+)?)\s*(kcal|kj|mcg|mg|g|%)?/i;
  function refineNumbers(data, onProgress) {
    return queued(async () => {
      const worker = await getWorker();
      const jobs = [];
      for (const l of linesOf(data)) {
        const lc = (l.text || '').toLowerCase();
        if (!ROWS.some(r => r.re.test(lc))) continue;
        for (const w of (l.words || [])) if (/\d/.test(w.text || '') && w.bbox) jobs.push(w);
      }
      const fixes = new Map();
      try {
        await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.,gmkcalKJ%*' });
        for (let i = 0; i < jobs.length; i++) {
          const w = jobs[i];
          const { data: r } = await worker.recognize(cropWord(data.canvas, w.bbox));
          const read = (r.text || '').trim().replace(/\s+/g, '');
          const m = read.match(NUM_RE);
          const orig = digitsOf(w.text);
          if (m) {
            let num = m[1].replace(',', '.'), unit = (m[2] || '').toLowerCase(), dg = digitsOf(num);
            // "25g" re-read as "259": the extra 9 is the unit, not a digit
            if (!unit && dg === orig + '9' && /\dg(?![a-z])/i.test(w.text)) { num = num.slice(0, -1).replace(/\.$/, ''); unit = 'g'; dg = orig; }
            const ok = dg === orig || (dg.length > orig.length && isSubsequence(orig, dg)) || (unit === 'g' && orig === dg + '9');
            if (ok) fixes.set(w, { num, unit, mark: /[*%]/.test(read) || /[*%]/.test(w.text) });
          }
          if (onProgress) onProgress((i + 1) / jobs.length);
        }
      } finally {
        await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
      }
      return fixes;
    });
  }
  /* The whole text again, with re-read numbers swapped in (shown under "Show the text that was read"). */
  function rebuildText(data, fixes) {
    if (!fixes.size) return data.text;
    return linesOf(data).map(l => {
      let t = (l.text || '').replace(/\n$/, '');
      for (const w of (l.words || [])) {
        const f = fixes.get(w); if (!f) continue;
        const at = t.indexOf(w.text);
        if (at >= 0) t = t.slice(0, at) + f.num + (f.unit ? ' ' + f.unit : '') + (f.mark ? '*' : '') + t.slice(at + w.text.length);
      }
      return t;
    }).join('\n');
  }

  /* ---------- table reading: columns by position on the page ---------- */
  const TABLE_KEYS = ['energy', 'protein', 'carbs', 'sugar', 'fat', 'fiber', 'sodium'];
  function cellValue(w, fixes, key) {
    const f = fixes.get(w);
    let num, unit;
    if (f) { num = parseFloat(f.num); unit = f.unit; }
    else { const m = (w.text || '').replace(',', '.').match(NUM_RE); if (!m) return null; num = parseFloat(m[1]); unit = (m[2] || '').toLowerCase(); }
    if (!isFinite(num)) return null;
    if (key === 'energy' && unit === 'kj') num /= 4.184;
    if (key === 'sodium' && unit === 'g') num *= 1000;
    return num;
  }
  function readTable(data, fixes, text) {
    const W = data.canvas ? data.canvas.width : 1;
    const lines = linesOf(data);
    const rows = [], cells = [];
    let firstRowY = Infinity;
    for (const l of lines) {
      const words = (l.words || []).filter(w => w.bbox);
      const labelText = clean(words.filter(w => !/\d/.test(w.text)).map(w => w.text).join(' '));
      const row = ROWS.find(r => r.re.test(labelText) && !(r.not && r.not.test(labelText)));
      if (!row || !TABLE_KEYS.includes(row.key)) continue;
      const nums = words.filter(w => /\d/.test(w.text) && !/^\W*\(/.test(w.text) && !/\)\W*$/.test(w.text));
      if (!nums.length) continue;
      firstRowY = Math.min(firstRowY, l.bbox ? l.bbox.y0 : Infinity);
      const r = { key: row.key, total: /tota/.test(labelText), nums };
      rows.push(r);
      nums.forEach(w => cells.push({ w, x: (w.bbox.x0 + w.bbox.x1) / 2 / W, mark: /[*%]/.test(w.text) || !!fixes.get(w)?.mark }));
    }
    if (rows.length < 3) return null;
    // columns = groups of numbers at the same x position
    const xs = cells.map(c => c.x).sort((a, b) => a - b), cols = [];
    for (const x of xs) { const c = cols[cols.length - 1]; if (c && x - c.max < 0.06) { c.max = x; c.xs.push(x); } else cols.push({ min: x, max: x, xs: [x] }); }
    cols.forEach(c => { c.x = c.xs.reduce((a, b) => a + b, 0) / c.xs.length; c.count = c.xs.length; });
    const real = cols.filter(c => c.count >= 3);
    if (!real.length) return null;
    const colOf = x => real.find(c => x >= c.min - 0.03 && x <= c.max + 0.03);
    cells.forEach(c => { const col = colOf(c.x); if (col) { col.marks = (col.marks || 0) + (c.mark ? 1 : 0); } });
    // header words above the first nutrient row name the columns
    const header = [];
    for (const l of lines) for (const w of (l.words || [])) if (w.bbox && w.bbox.y1 <= firstRowY + 2) header.push({ t: (w.text || '').toLowerCase(), x: (w.bbox.x0 + w.bbox.x1) / 2 / W });
    const near = (re, col) => header.some(h => re.test(h.t) && Math.abs(h.x - col.x) < 0.09);
    real.forEach(c => {
      if (near(/rda|%/, c) || (c.marks || 0) >= c.count * 0.5) c.role = 'rda';
      else if (near(/100/, c)) c.role = '100';
      else if (near(/serv|\(\d+\s*[g9]\)?|\d+\s*[g9]\)/, c)) c.role = 'serving';
    });
    const servingG = findServing(text);
    let num = real.filter(c => c.role !== 'rda');
    if (!num.length) return null;
    // no header luck: with two number columns, the one ~100/serving times larger is per 100 g
    if (!num.some(c => c.role === '100') && num.length >= 2) {
      const [a, b] = num;
      if (!a.role && !b.role) { a.role = '100'; b.role = 'serving'; }
    }
    if (!num.some(c => c.role)) num[0].role = num.length === 1 && /per\s*serv/i.test(text) && !/100\s*(g|ml)/i.test(text) ? 'serving' : '100';
    const tokensOf = role => {
      const col = num.find(c => c.role === role); if (!col) return null;
      if (col.decimals === undefined) {
        const seen = [0, 0, 0];
        for (const r of rows) for (const w of r.nums) {
          if (colOf((w.bbox.x0 + w.bbox.x1) / 2 / W) !== col) continue;
          const txt = fixes.get(w)?.num || w.text, m = String(txt).match(/\d\.(\d+)/);
          if (m) seen[Math.min(2, m[1].length)]++;
        }
        const top = seen.indexOf(Math.max(...seen));
        col.decimals = seen[top] >= 2 ? top : null;
      }
      const t = {};
      for (const r of rows) {
        const w = r.nums.find(w => colOf((w.bbox.x0 + w.bbox.x1) / 2 / W) === col); if (!w) continue;
        const key = r.key === 'energy' ? 'kcal' : r.key;
        if (t[key] && !(r.key === 'sugar' && r.total)) continue;
        t[key] = numCandidates(w, fixes.get(w), r.key, col.decimals);
      }
      return t;
    };
    const notes = [];
    const t100 = tokensOf('100'), tS = tokensOf('serving');
    if (t100 && tS) notes.push('The label has per-100 g and per-serving columns; both were read and checked against each other.');
    if (num.length < real.length) notes.push('The %RDA column was ignored.');
    const sol = solveTable(t100, tS, servingG);
    if (!sol) return null;
    if (sol.corrected.length) notes.push(`Missing decimal points were put back in ${sol.corrected.join(', ')} so that both columns and the energy agree. Double-check against the photo.`);
    const values = sol.v100 ? round2(sol.v100) : null, servingValues = sol.vS ? round2(sol.vS) : null;
    const basis = values ? '100' : 'serving', main = values || servingValues;
    const got = Object.keys(main).length;
    return { basis, servingG, values: main, servingValues, notes, found: got, energyOk: energyOk(main), crossOk: sol.crossOk,
      confidence: got >= 4 && energyOk(main) ? 'good' : got >= 2 ? 'partial' : 'low' };
  }

  /* Every value a misread number could really be: the printed point if there is one, or the same digits
     with 0, 1 or 2 decimals; a final 9 may be the unit "g". Lower penalty = more likely. */
  const MACROS = ['protein', 'carbs', 'fat', 'fiber', 'sugar'];
  function numCandidates(w, fix, key, prefK) {
    const out = new Map();
    const add = (v, pen) => { if (!isFinite(v) || v < 0) return; const k = Math.round(v * 1000) / 1000; if (!out.has(k) || out.get(k) > pen) out.set(k, pen); };
    const kj = /kj/i.test((w.text || '') + (fix?.unit || ''));
    for (const [src, base] of [[w.text, 0], [fix ? fix.num + (fix.unit || '') : '', 0.05]]) {
      if (!src) continue;
      const t = String(src).replace(',', '.');
      const core = (t.match(/\d[\d.]*/) || [''])[0].replace(/\.+$/, '');
      if (!core) continue;
      const hasG = /\d\s*g\b/i.test(t) && !/mg/i.test(t);
      const variants = [[core, base]];
      if (!hasG && core.replace('.', '').length >= 2 && /9$/.test(core)) variants.push([core.slice(0, -1).replace(/\.$/, ''), base + 0.3]);
      for (const [c, pen] of variants) {
        const dg = c.replace('.', '');
        if (!dg) continue;
        if (c.includes('.')) add(parseFloat(c), pen);
        for (let k = 0; k <= 2; k++) {
          if (dg.length <= k) continue;
          let p = pen + (c.includes('.') ? 0.6 : 0) + 0.15 * k;
          if (dg.length > 1 && dg[0] === '0' && k < dg.length - 1) p += 1.5;          // "042" can only be 0.42
          if (prefK != null && MACROS.includes(key) && k !== prefK) p += 0.35;      // columns print the same decimals
          add(parseInt(dg, 10) / 10 ** k, p);
        }
      }
    }
    let list = [...out].map(([v, pen]) => ({ v: kj && key === 'energy' ? v / 4.184 : v, pen }));
    if (key === 'energy' || key === 'sodium') list = list.map(c => ({ ...c, pen: c.pen + (Number.isInteger(c.v) ? 0 : 0.2) }));
    return list.sort((a, b) => a.pen - b.pen);
  }

  /* Choose one value per nutrient so that (1) per-100 g = per-serving x 100 / serving size, (2) protein, carbs,
     fat and fibre add up to the energy, and (3) nothing weighs more than 100 g per 100 g. */
  function solveTable(t100, tS, sg) {
    const f = sg > 0 ? 100 / sg : null, keys = new Set([...Object.keys(t100 || {}), ...Object.keys(tS || {})]);
    if (!keys.size) return null;
    const opts = {};
    for (const k of keys) {
      const A = t100?.[k], B = tS?.[k], o = [];
      if (A && B && f) {
        for (const a of A.slice(0, 12)) for (const b of B.slice(0, 12)) {
          const e = b.v * f, err = Math.abs(a.v - e) / Math.max(a.v, e, 0.05);
          if (err <= 0.025 || Math.abs(a.v - e) <= 0.06) o.push({ v100: a.v, vS: b.v, pen: a.pen + b.pen + err * 4, both: true });
        }
      }
      // columns that can't be matched: trust the per-100 g reading a little more (the energy check can still overrule)
      if (B && f) B.slice(0, 6).forEach(b => o.push({ v100: b.v * f, vS: b.v, pen: b.pen + 1.9 }));
      if (A) A.slice(0, 6).forEach(a => o.push({ v100: a.v, vS: f ? a.v / f : null, pen: a.pen + (B ? 1.6 : 0) }));
      if (!A && B && !f) B.slice(0, 6).forEach(b => o.push({ v100: null, vS: b.v, pen: b.pen }));
      opts[k] = o.sort((x, y) => x.pen - y.pen).slice(0, 8);
    }
    const per = o => o.v100 != null ? o.v100 : o.vS;          // the column we judge limits on
    const limit = t100 || f ? 100 : (sg || 100);
    const energy = opts.kcal?.[0];
    const macros = ['protein', 'carbs', 'fat'].filter(k => opts[k]);
    let best = null;
    const pick = {};
    const walk = i => {
      if (i === macros.length) {
        const v = k => pick[k] ? per(pick[k]) : 0;
        // everything solid must fit in the portion (fibre may already be counted inside carbs)
        if (v('protein') + v('carbs') + v('fat') + Math.max(0, v('fiber') - v('carbs')) > limit * 1.02) return;
        let score = macros.reduce((a, k) => a + pick[k].pen, 0);
        if (energy) {
          const kcal = per(energy), est = 4 * v('protein') + 4 * v('carbs') + 9 * v('fat') + 2 * v('fiber');
          score += Math.abs(est - kcal) / Math.max(kcal, 1) * 30;   // the energy has the final say
        }
        if (!best || score < best.score) best = { score, pick: { ...pick } };
        return;
      }
      for (const o of opts[macros[i]]) { if (per(o) > limit * 1.02) continue; pick[macros[i]] = o; walk(i + 1); }
      delete pick[macros[i]];
    };
    walk(0);
    const chosen = { ...(best ? best.pick : {}) };
    if (energy) chosen.kcal = energy;
    // fibre, sugar and sodium: their own most likely reading (sugar and fibre must fit inside carbs + 10 g)
    for (const k of ['fiber', 'sugar', 'sodium']) {
      if (!opts[k]) continue;
      const carbs = chosen.carbs ? per(chosen.carbs) : Infinity;
      chosen[k] = opts[k].find(o => k === 'sodium' || (k === 'sugar' ? per(o) <= carbs * 1.02 : per(o) <= carbs + 10)) || opts[k][0];
    }
    const v100 = {}, vS = {}, corrected = [];
    let both = 0, n = 0;
    for (const [k, o] of Object.entries(chosen)) {
      if (o.v100 != null) v100[k] = o.v100;
      if (o.vS != null) vS[k] = o.vS;
      n++; if (o.both) both++;
      const first = (t100?.[k] || tS?.[k] || [])[0];
      const shown = t100?.[k] ? o.v100 : o.vS;
      if (first && shown != null && Math.abs(first.v - shown) > Math.max(0.05, shown * 0.02)) corrected.push(k === 'kcal' ? 'energy' : k);
    }
    return { v100: t100 || f ? v100 : null, vS: tS || (t100 && f) ? vS : null, corrected, crossOk: n > 0 && both === n };
  }

  const round2 = v => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Math.round(x * 100) / 100]));
  function energyOk(v) {
    const m = 4 * (v.protein || 0) + 4 * (v.carbs || 0) + 9 * (v.fat || 0) + 2 * (v.fiber || 0);
    return v.kcal > 0 && m > 0 && Math.abs(m - v.kcal) / v.kcal <= 0.15;
  }


  function cropWord(src, b) {
    const h = b.y1 - b.y0, pad = Math.round(h * 0.35);
    const sx = Math.max(0, b.x0 - pad), sy = Math.max(0, b.y0 - pad);
    const sw = Math.min(src.width - sx, b.x1 - b.x0 + 2 * pad), sh = Math.min(src.height - sy, h + 2 * pad);
    const scale = Math.max(1, Math.min(4, 72 / Math.max(1, sh)));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale) + 24; c.height = Math.round(sh * scale) + 24;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, sw, sh, 12, 12, sw * scale, sh * scale);
    return c;
  }

  /* Front of the pack: the product name is usually the biggest text, so rank lines by letter height.
     Three passes: two sizes (text size in photos varies a lot) and one inverted pass for light-on-dark text. */
  const PRODUCT_PASSES = [
    { side: 450, minChannel: true },
    { side: 800, minChannel: true },
    { side: 450, minChannel: true, invert: true },
    { side: 800, minChannel: true, invert: true },
  ];
  async function readProduct(file, onProgress) {
    const all = [], texts = [], n = PRODUCT_PASSES.length;
    for (let i = 0; i < n; i++) {
      const d = await recognize(file, '11', p => onProgress && onProgress((i + p) / n), PRODUCT_PASSES[i]);
      all.push(...lineCandidates(d)); texts.push(d.text);
    }
    const merged = rankNames(all);
    return { text: texts.join('\n'), candidates: merged.list, suggested: merged.suggested };
  }

  function linesOf(data) {
    if (Array.isArray(data.lines) && data.lines.length) return data.lines;
    const out = [];
    (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => out.push(l))));
    return out;
  }
  const SKIP = /nutrition|ingredient|energy|protein|carbo|best before|use by|mfd|mfg|batch|mrp|net\s*(wt|weight|qty|quantity)|fssai|lic\.?\s*no|www\.|\.com|customer care|store in|veg(etarian)?\s*mark|incl\.? of all taxes|marketed by|manufactured/i;
  function tidy(t) {
    if (t === t.toUpperCase() && /[A-Z]{2}/.test(t)) t = t.toLowerCase().replace(/(^|[\s\-&])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    return t;
  }
  function nameCandidates(data) { return rankNames(lineCandidates(data)).list; }

  /* Biggest text first; near-duplicates from different passes keep the most confident spelling.
     The suggested name joins the phrases nearly as big as the biggest, in reading order. */
  function rankNames(cands) {
    const uniq = [];
    for (const c of cands.sort((a, b) => b.conf - a.conf)) {
      const k = c.text.toLowerCase();
      const twin = uniq.find(u => { const j = u.text.toLowerCase(); return j === k || (Math.min(j.length, k.length) >= 4 && lev(j, k) <= 1); });
      if (twin) { twin.h = Math.max(twin.h, c.h); continue; }
      uniq.push({ ...c });
    }
    const list = uniq.sort((a, b) => b.h - a.h).slice(0, 6);
    if (!list.length) return { list: [], suggested: [] };
    const maxH = list[0].h;
    const suggested = list.map((c, i) => ({ c, i })).filter(x => x.c.h >= maxH * 0.75).sort((a, b) => a.c.y - b.c.y).slice(0, 3).map(x => x.i);
    return { list: list.map(c => c.text), suggested };
  }
  function lev(a, b) {
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  /* A believable word: mostly letters, has a vowel, no stutters like "EEE". */
  function goodWord(w) {
    const t = (w.text || '').replace(/^[^A-Za-z0-9&]+|[^A-Za-z0-9&'.]+$/g, '');
    if ((w.confidence ?? 0) < 72 || t.length < 2) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9'&.\-]*$/.test(t) || !/[A-Za-z]{2}/.test(t)) return null;
    if (/(.)\1\1/i.test(t) || (t.length >= 3 && !/[aeiouy]/i.test(t)) || /^([A-Z])\1$/i.test(t)) return null;
    return t;
  }
  /* Group words into phrases ourselves (Tesseract often merges lines of different sizes):
     same phrase = vertically aligned and similar letter height, ordered left to right. */
  function lineCandidates(data) {
    const H = data.imgH || 1;
    const words = [];
    for (const l of linesOf(data)) for (const w of (l.words || [])) {
      const t = goodWord(w); if (!t || !w.bbox) continue;
      const h = w.bbox.y1 - w.bbox.y0;
      words.push({ t, h, cy: (w.bbox.y0 + w.bbox.y1) / 2, x: w.bbox.x0, y: w.bbox.y0, conf: w.confidence });
    }
    words.sort((a, b) => a.cy - b.cy);
    const groups = [];
    for (const w of words) {
      const g = groups.find(g => Math.abs(g.cy - w.cy) < 0.5 * Math.max(g.h, w.h) && w.h / g.h > 0.65 && w.h / g.h < 1.5);
      if (g) { g.ws.push(w); g.h = Math.max(g.h, w.h); } else groups.push({ cy: w.cy, h: w.h, ws: [w] });
    }
    const out = [];
    for (const g of groups) {
      const ws = g.ws.sort((a, b) => a.x - b.x);
      const t = ws.map(w => w.t).join(' ');
      if (t.length < 3 || t.length > 40 || SKIP.test(t)) continue;
      out.push({ text: tidy(t), h: g.h / H, y: Math.min(...ws.map(w => w.y)) / H, conf: ws.reduce((a, w) => a + w.conf, 0) / ws.length });
    }
    return out;
  }

  /* ---------- parsing ---------- */
  const ROWS = [
    // order matters: more specific patterns first
    { key: 'sugar', re: /sugars?\b/, not: /add|ded\b|free|alcohol/ },
    { key: 'satfat', re: /saturat/ },
    { key: 'transfat', re: /\btrans\b/ },
    { key: 'fiber', re: /fib(re|er)|dietary/ },
    { key: 'carbs', re: /carbo|\bcarbs?\b/ },
    { key: 'protein', re: /prot[eo]in/ },
    { key: 'fat', re: /\b(total\s*)?fat\b|\bfats\b|\blipid/, not: /saturat|trans|mono|poly|unsat/ },
    { key: 'sodium', re: /sodium/ },
    { key: 'salt', re: /\bsalt\b/ },
    { key: 'energy', re: /energ|calor|\bkcal\b|\bkj\b/ },
  ];

  function clean(line) {
    return line.toLowerCase()
      .replace(/[|\[\]{}]/g, ' ')
      .replace(/(\d)\s*[,·]\s*(\d)/g, '$1.$2')           // 7,5 -> 7.5
      .replace(/(\d)[oO](?=\d|\s|g|$)/g, '$10')          // 1O -> 10
      .replace(/\b[oO](?=\.\d)/g, '0')                  // O.5 -> 0.5
      .replace(/(\d)\s+\.\s*(\d)/g, '$1.$2')
      .replace(/\s+/g, ' ').trim();
  }

  /* Numbers on a row, ignoring %RDA values and unit hints like "(g)". Each: {v, unit} */
  function numbersIn(line) {
    const out = [];
    const re = /(<\s*)?(\d+(?:\.\d+)?)\s*(kcal|kj|cal|mg|mcg|µg|g|ml|%)?/g;
    let m;
    while ((m = re.exec(line))) {
      const unit = (m[3] || '').replace('µg', 'mcg');
      if (unit === '%') continue;
      const after = line.slice(re.lastIndex, re.lastIndex + 2);
      if (/^\s*[%*]/.test(after)) continue;
      out.push({ v: parseFloat(m[2]), unit, lt: !!m[1] });
    }
    return out;
  }

  function findServing(text) {
    const t = text.toLowerCase().replace(/,/g, '.');
    const pats = [
      /serv(?:ing|e)?\s*size[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(g|ml)\b/,
      /per\s*serv(?:ing|e)?\s*\(?\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(g|ml)\b/,
      /serv(?:ing|e)?[^0-9\n]{0,15}\(\s*(\d+(?:\.\d+)?)\s*(g|ml)\s*\)/,
      /per\s*(?:piece|biscuit|bar|portion|cup|scoop|pack)[^0-9\n]{0,10}\(?\s*(\d+(?:\.\d+)?)\s*(g|ml)\b/,
      /serv(?:ing|e)?\s*size[^\n]{0,30}?\(\s*(\d+(?:\.\d+)?)\s*(g|ml)\s*\)/,   // Serving size 2 biscuits (25g)
      /serv(?:ing|e)?[^\n]{0,30}?(\d+(?:\.\d+)?)\s*(g|ml)\b/,
    ];
    for (const p of pats) { const m = t.match(p); if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 2000) return v; } }
    return null;
  }

  /* Which column holds per-100 g values? Look at the header for "per 100" vs "per serving". */
  function findColumns(lines) {
    for (const raw of lines) {
      const l = raw.replace(/serv(ing|e)?s?\s*size\s*:?\s*[\d.]+\s*(g|ml)?|total\s*serv\w*\s*:?\s*[\d.]+/g, ' ');
      const i100 = l.search(/(per|\/)\s*100\s*(g|gm|ml|grams?)\b|100\s*(g|ml)\b/);
      const iSrv = l.search(/serv|portion|piece|biscuit|scoop|per\s*pack|per\s*bar/);
      if (i100 >= 0 && iSrv >= 0) return { has100: true, hasServing: true, idx100: i100 < iSrv ? 0 : 1 };
      if (i100 >= 0) return { has100: true, hasServing: false, idx100: 0 };
    }
    for (const l of lines) if (/per\s*serv|serving size|per\s*(piece|portion|scoop|bar)/.test(l)) return { has100: false, hasServing: true, idx100: -1 };
    return { has100: false, hasServing: false, idx100: 0 };
  }

  function parseLabel(raw) {
    const lines = String(raw || '').split(/\n+/).map(clean).filter(Boolean);
    const cols = findColumns(lines);
    const servingG = findServing(raw || '');
    const found = {};
    const notes = [];
    for (const line of lines) {
      const row = ROWS.find(r => r.re.test(line) && !(r.not && r.not.test(line)));
      // keep the first match, except that a "Total sugars" line always wins over a plain "Sugars" line
      if (!row || (found[row.key] && !(row.key === 'sugar' && /tota/.test(line) && !found.sugar.total))) continue;
      // drop the label words so "(g)" or "per 100 g" in the row name isn't read as a value
      // OCR often reads the unit "(g)" as "(9)" or "(q)"
      const body = line.replace(row.re, ' ').replace(/\(\s*(g|9|q|mg|m9|mq|kcal|kj|mcg)\s*\)/g, ' ');
      let nums = numbersIn(body);
      if (row.key === 'energy') {
        const kcal = nums.filter(n => n.unit === 'kcal' || n.unit === 'cal');
        const kj = nums.filter(n => n.unit === 'kj');
        const plain = nums.filter(n => !n.unit);
        const lineIsKj = /\bkj\b/.test(line) && !/kcal/.test(line);
        if (kcal.length) nums = kcal;
        else if (kj.length || lineIsKj) { nums = (kj.length ? kj : plain).map(n => ({ v: n.v / 4.184, unit: 'kcal', fromKj: true })); notes.push('Energy was printed in kJ and converted to kcal.'); }
        else nums = plain;
      } else {
        nums = nums.filter(n => n.unit !== 'kcal' && n.unit !== 'kj');
      }
      if (!nums.length) continue;
      const idx = cols.has100 && cols.hasServing ? cols.idx100 : 0;
      const pick = nums[Math.min(idx, nums.length - 1)];
      let v = pick.v;
      if (row.key === 'sodium' && pick.unit === 'g') v = v * 1000;
      found[row.key] = { v, all: nums.map(n => n.v), unit: pick.unit, total: /tota/.test(line) };
    }
    if (!found.sodium && found.salt) found.sodium = { v: found.salt.v * 400, all: [], unit: 'mg' };
    repairDecimals(found, cols, servingG, notes);
    sanityRepairs(found, cols, servingG, notes);

    const values = {};
    ['energy', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'].forEach(k => { if (found[k]) values[k === 'energy' ? 'kcal' : k] = round(found[k].v); });
    const basis = cols.has100 ? '100' : cols.hasServing ? 'serving' : '100';
    if (!cols.has100 && !cols.hasServing) notes.push('Couldn’t see “per 100 g” or “per serving” on the label. Check which one the numbers are for.');
    if (cols.has100 && cols.hasServing) notes.push('The label has both per-100 g and per-serving columns; the per-100 g column was used.');
    const got = Object.keys(values).length;
    const v = values, macroKcal = 4 * (v.protein || 0) + 4 * (v.carbs || 0) + 9 * (v.fat || 0) + 2 * (v.fiber || 0);
    const energyOk = v.kcal > 0 && macroKcal > 0 && Math.abs(macroKcal - v.kcal) / v.kcal <= 0.15;
    return { basis, servingG, values, notes, found: got, energyOk, confidence: got >= 4 && energyOk ? 'good' : got >= 2 ? 'partial' : 'low' };
  }
  const round = n => Math.round(n * 100) / 100;

  /* Physical limits: nothing weighs more than 100 g per 100 g, sugars sit inside carbs, saturated fat inside fat,
     and protein + carbs + fat must fit too. A value that breaks a limit almost always lost its decimal point. */
  function sanityRepairs(found, cols, servingG, notes) {
    const fixed = [];
    const limit = cols.has100 || !servingG ? 100 : servingG;
    const shrink = (k, max) => {
      const f = found[k]; if (!f || !(f.v > max)) return;
      for (const d of [10, 100]) if (f.v / d <= max) { f.v = f.v / d; fixed.push(k); return; }
    };
    ['protein', 'carbs', 'fat', 'fiber', 'sugar', 'satfat'].forEach(k => shrink(k, limit));
    if (found.carbs) shrink('sugar', found.carbs.v);
    if (found.fat) shrink('satfat', found.fat.v);
    // energy check over every combination of "decimal point lost" for the main macros
    const E = found.energy?.v, keys = ['protein', 'carbs', 'fat', 'fiber'].filter(k => found[k]);
    const at = vals => 4 * (vals.protein || 0) + 4 * (vals.carbs || 0) + 9 * (vals.fat || 0) + 2 * (vals.fiber || 0);
    const base = Object.fromEntries(keys.map(k => [k, found[k].v]));
    const sum = () => (found.protein?.v || 0) + (found.carbs?.v || 0) + (found.fat?.v || 0);
    if (E > 0 && keys.length >= 2 && (Math.abs(at(base) - E) / E > 0.15 || sum() > limit)) {
      let best = null;
      const n = keys.length;
      for (let mask = 1; mask < (1 << n); mask++) {
        const vals = { ...base };
        let okMask = true;
        keys.forEach((k, i) => { if (mask & (1 << i)) { if (vals[k] < 10 || vals[k] % 1) okMask = false; vals[k] /= 10; } });
        if (!okMask) continue;
        const err = Math.abs(at(vals) - E) / E;
        if (err < 0.1 && (!best || err < best.err)) best = { vals, err, mask };
      }
      if (best) keys.forEach((k, i) => { if (best.mask & (1 << i)) { found[k].v = best.vals[k]; fixed.push(k); } });
    }
    if (fixed.length) notes.push(`${[...new Set(fixed)].join(', ')} looked too big (a missing decimal point) and ${fixed.length > 1 ? 'were' : 'was'} divided by 10. Double-check against the photo.`);
  }

  /* OCR sometimes drops a decimal point (7.4 -> 74). Put it back when the other column or the energy proves it. */
  function repairDecimals(found, cols, servingG, notes) {
    const fixed = [];
    const close = (a, b) => Math.abs(a - b) <= Math.max(0.2, Math.abs(b) * 0.12);
    if (cols.has100 && cols.hasServing && servingG > 0) {
      const iS = cols.idx100 === 0 ? 1 : 0, ratio = 100 / servingG;
      ['energy', 'protein', 'carbs', 'fat', 'fiber', 'sugar'].forEach(k => {
        const f = found[k]; if (!f || !f.all || f.all.length < 2) return;
        const s = f.all[iS]; if (s == null) return;
        const expected = [s, s / 10, s / 100].map(x => x * ratio);
        if (expected.some(e => close(f.v, e))) return;
        for (const c of [f.v / 10, f.v / 100]) if (expected.some(e => close(c, e))) { f.v = c; fixed.push(k === 'energy' ? 'energy' : k); return; }
      });
    }
    const E = found.energy?.v;
    if (E > 0) {
      const keys = ['protein', 'carbs', 'fat', 'fiber'];
      const at = () => 4 * (found.protein?.v || 0) + 4 * (found.carbs?.v || 0) + 9 * (found.fat?.v || 0) + 2 * (found.fiber?.v || 0);
      if (Math.abs(at() - E) / E > 0.15) {
        let best = null;
        keys.forEach(k => { const f = found[k]; if (!f || f.v < 10 || f.v % 1) return;
          const old = f.v; f.v = old / 10; const err = Math.abs(at() - E) / E; f.v = old;
          if (err < 0.08 && (!best || err < best.err)) best = { k, err }; });
        if (best) { found[best.k].v /= 10; fixed.push(best.k); }
      }
    }
    if (fixed.length) notes.push(`A decimal point looked missing in ${fixed.join(', ')} and was put back (checked against the other column and the energy). Double-check ${fixed.length > 1 ? 'these' : 'it'}.`);
  }

  window.LabelReader = { readLabel, readProduct, parseLabel, nameCandidates, warm: () => getWorker() };
})();
