/* Gram Tracker — add a food from a shop's product link (Blinkit and similar). Needs internet.
   The Android app downloads the page and photo (window.GramNet); everything here is parsing, so it can be
   improved with a normal app update. Order of trust: the shop's own "per 100 g" attributes, then schema.org
   nutrition data, then the page's visible text read like a label. */
(function () {
  const NUT = [
    ['kcal', /^(energy|calories?)\b/i],
    ['protein', /^protein/i],
    ['carbs', /^(total\s*)?carbo|^carbs?\b/i],
    ['sugar', /^(total\s*)?sugars?\b/i],
    ['fiber', /fib(re|er)/i],
    ['fat', /^(total\s*)?fats?\b/i],
    ['sodium', /^sodium/i],
  ];
  const SKIP = /added|saturat|trans|mono|poly|unsat|omega|cholest/i;

  const round = n => Math.round(n * 100) / 100;
  function amount(s) {
    const m = String(s || '').replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(kcal|kj|cal|mg|mcg|µg|g|kg|ml|l)?\b/i);
    return m ? { v: parseFloat(m[1]), unit: (m[2] || '').toLowerCase() } : null;
  }
  function grams(s) {
    const a = amount(s); if (!a) return null;
    if (a.unit === 'kg' || a.unit === 'l') return a.v * 1000;
    return !a.unit || a.unit === 'g' || a.unit === 'ml' ? a.v : null;
  }
  function setNutrient(out, key, raw) {
    const a = amount(raw); if (!a || out[key] != null) return;
    let v = a.v;
    if (key === 'kcal' && a.unit === 'kj') v /= 4.184;
    if (key === 'sodium' && a.unit === 'g') v *= 1000;
    if (key !== 'kcal' && key !== 'sodium' && a.unit === 'mg') v /= 1000;
    out[key] = round(v);
  }
  const unescapeJson = s => { try { return JSON.parse('"' + s + '"'); } catch { return s; } };
  function decodeEntities(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }

  /* Blinkit-style attribute cards: {"title":{"text":"Protein Per 100 g"},...,"subtitle":{"text":"7 g"}} */
  function attributePairs(html) {
    const pairs = [], re = /"title":\{"text":"((?:[^"\\]|\\.){2,80})"/g;
    let m;
    while ((m = re.exec(html))) {
      const sub = html.slice(re.lastIndex, re.lastIndex + 1500).match(/"subtitle":\{"text":"((?:[^"\\]|\\.){0,120})"/);
      if (sub) pairs.push([unescapeJson(m[1]), unescapeJson(sub[1])]);
    }
    return pairs;
  }
  function fromPairs(pairs) {
    const values = {}, out = { values };
    const seen = new Set();
    for (const [title, val] of pairs) {
      if (seen.has(title)) continue;   // the first card is the product itself; later ones belong to suggestions
      seen.add(title);
      const per100 = /per\s*100\s*(g|gm|ml)\b/i.test(title);
      const name = title.replace(/\s*per\s*100\s*(g|gm|ml)\b.*$/i, '').replace(/\(.*?\)/g, '').trim();
      if (per100) {
        if (SKIP.test(name)) continue;
        for (const [k, re] of NUT) if (re.test(name)) { setNutrient(values, k, val); break; }
      } else if (/^serv(e|ing)\s*size$/i.test(title)) out.servingG = out.servingG ?? grams(val);
      else if (/^(unit|net\s*(weight|wt|quantity|qty)|weight|pack\s*size|quantity)$/i.test(title)) out.packG = out.packG ?? grams(val);
    }
    return out;
  }

  /* schema.org NutritionInformation (values are per serving; converted with servingSize). */
  function fromJsonLd(html) {
    const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const b of blocks) {
      let data; try { data = JSON.parse(b[1]); } catch { continue; }
      const stack = [data];
      while (stack.length) {
        const o = stack.pop();
        if (!o || typeof o !== 'object') continue;
        if (o.nutrition || o['@type'] === 'NutritionInformation') {
          const n = o.nutrition || o, values = {};
          const map = { kcal: n.calories, protein: n.proteinContent, carbs: n.carbohydrateContent, sugar: n.sugarContent, fiber: n.fiberContent, fat: n.fatContent, sodium: n.sodiumContent };
          for (const [k, raw] of Object.entries(map)) if (raw != null) setNutrient(values, k, raw);
          const serving = grams(n.servingSize);
          if (serving && !/100\s*(g|ml)/i.test(String(n.servingSize))) for (const k in values) values[k] = round(values[k] * 100 / serving);
          else if (!serving && n.servingSize) continue;   // unknown serving: can't convert safely
          return { values, servingG: serving && serving !== 100 ? serving : undefined };
        }
        Object.values(o).forEach(v => { if (v && typeof v === 'object') stack.push(v); });
      }
    }
    return null;
  }

  /* Visible text of the page, one block per line, then read like a label. */
  function pageText(html) {
    const doc = new DOMParser().parseFromString(html.replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '$&\n'), 'text/html');
    doc.querySelectorAll('script,style,noscript,svg').forEach(e => e.remove());
    return (doc.body ? doc.body.textContent : '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
  }

  function meta(html, prop) {
    const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
    return a ? decodeEntities(a[1]) : '';
  }
  function cleanName(t) {
    return t.replace(/\s+(price|buy online|online at best price)\b.*$/i, '')
      .replace(/\s*[|–—-]\s*(blinkit|zepto|bigbasket|amazon|flipkart|swiggy|instamart|jiomart|dmart)\b.*$/i, '').trim();
  }

  function parseProductPage(html, url) {
    let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { }
    let r = fromPairs(attributePairs(html)), method = 'shop data';
    if (Object.keys(r.values).length < 2) { const j = fromJsonLd(html); if (j && Object.keys(j.values).length >= 2) { r = j; method = 'schema'; } }
    if (Object.keys(r.values).length < 2 && window.LabelReader) {
      const p = LabelReader.parseLabel(pageText(html));
      if (p.found >= 3 && p.basis === '100') { r = { values: p.values, servingG: p.servingG }; method = 'page text'; }
    }
    const name = cleanName(meta(html, 'og:title') || decodeEntities((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || ''));
    return { host, name, image: meta(html, 'og:image'), method, ...r };
  }

  /* ---------- talking to the Android app ---------- */
  const pending = new Map();
  window.gtNet = r => { const done = pending.get(r.id); if (done) { pending.delete(r.id); done(r); } };
  function nativeFetch(url, binary) {
    return new Promise(resolve => {
      const id = Math.random().toString(36).slice(2);
      pending.set(id, resolve);
      GramNet.fetch(id, url, !!binary);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: 'timeout' }); } }, 45000);
    });
  }
  const available = () => !!window.GramNet;
  function online() {
    if (!navigator.onLine) return false;
    try { return window.GramNet ? GramNet.isOnline() : true; } catch { return true; }
  }
  function b64ToBlob(b64, type) {
    const bin = atob(b64), a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: String(type || 'image/jpeg').split(';')[0] });
  }
  /* The first web link inside pasted or shared text ("Check out ... https://blinkit.com/..."). */
  const findUrl = text => (String(text || '').match(/https?:\/\/[^\s"'<>]+/) || [''])[0];

  async function importLink(url) {
    if (!available()) return { ok: false, reason: 'needs-app' };
    if (!online()) return { ok: false, reason: 'offline' };
    const page = await nativeFetch(url, false);
    if (!page.ok) return { ok: false, reason: page.offline ? 'offline' : 'failed', detail: page.error || (page.status ? 'HTTP ' + page.status : '') };
    const data = parseProductPage(page.text || '', page.url || url);
    if (data.image) {
      try {
        const img = await nativeFetch(new URL(data.image, page.url || url).href, true);
        if (img.ok && img.base64) data.imageBlob = b64ToBlob(img.base64, img.type);
      } catch { }
    }
    return { ok: true, data };
  }

  window.ProductLink = { importLink, parseProductPage, available, online, findUrl };
})();
