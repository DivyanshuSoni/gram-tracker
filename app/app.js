/* Gram Tracker — offline app. Data lives in IndexedDB on this phone (db.js); labels are read on-device (label.js). */
const APP_VERSION = '1.2.2';
/* Inside the Android APK, the wrapper adds window.GramAndroid (file saving). Assets are bundled, so no service worker is needed. */
const IS_APK = !!window.GramAndroid;
/* GitHub repo the app updates from (owner/name). publish.py uploads each new version there. */
const UPDATE_REPO = 'DivyanshuSoni/gram-tracker';
const UPDATE_MANIFEST = `https://api.github.com/repos/${UPDATE_REPO}/contents/updates/manifest.json?ref=main`;

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const r0 = n => Math.round(n || 0);
const r1 = n => Math.round((n || 0) * 10) / 10;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const todayStr = () => ymd(new Date());
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
const prettyDate = s => { if (s === todayStr()) return 'Today'; if (s === addDays(todayStr(), -1)) return 'Yesterday';
  const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, {weekday:'short', day:'numeric', month:'short'}); };
const MEALS = ['Breakfast', 'Lunch', 'Snack', 'Dinner'];
/* Food icon: the product photo if there is one, otherwise its first letter. */
function iconHtml(x, size = ''){
  const cls = 'ficon' + (size ? ' ' + size : '') + (x?.kind === 'recipe' ? ' rec' : '');
  if (x?.photo) return `<img class="${cls}" src="${esc(x.photo)}" alt="">`;
  const letter = (String(x?.name || '?').match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase();
  return `<span class="${cls}" aria-hidden="true">${esc(letter)}</span>`;
}
/* Square, centre-cropped JPEG small enough to keep inside the food record (~10 KB). */
async function makeThumb(file, size = 192){
  const bmp = await createImageBitmap(file, {imageOrientation: 'from-image'});
  const side = Math.min(bmp.width, bmp.height), sx = (bmp.width - side) / 2, sy = (bmp.height - side) / 2;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.8);
}
const defaultMeal = () => { const h = new Date().getHours(); return h < 11 ? 'Breakfast' : h < 16 ? 'Lunch' : h < 19 ? 'Snack' : 'Dinner'; };
const NUTR = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'];
const nutrFor = (per100, g) => { const o = {}; NUTR.forEach(k => o[k] = (num(per100?.[k]) || 0) * g / 100); return o; };
const sumN = arr => { const o = {}; NUTR.forEach(k => o[k] = 0); arr.forEach(x => NUTR.forEach(k => o[k] += num(x?.[k]) || 0)); return o; };
const DEFAULT_SETTINGS = {id: 'settings', kcal: 2000, protein: 120, carbs: 220, fat: 65};
const cmpVer = (a, b) => { const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; };

function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600); }
function showBanner(t){ const b = $('#banner'); b.textContent = t; b.hidden = !t; }

/* ---------- state + storage ---------- */
const S = { foods: [], recipes: [], vessels: [], settings: {...DEFAULT_SETTINGS}, days: {}, date: todayStr(), view: 'today', foodsTab: 'foods', foodsQ: '', ready: false };
let pendingDel = null;
const byName = (a, b) => String(a.name).localeCompare(String(b.name));

const SEED_FOODS = [
  ['typ-rice', 'White rice, raw', 365, 7.1, 80, 0.7, 1.3, 0.1, 5],
  ['typ-toor', 'Toor dal, raw', 343, 21.7, 62.8, 1.5, 15, null, 17],
  ['typ-atta', 'Whole wheat atta', 340, 13.2, 72, 2.5, 10.7, 0.4, 2],
  ['typ-ghee', 'Ghee', 876, 0.3, 0, 99.5, 0, 0, 2],
  ['typ-oil', 'Sunflower oil', 884, 0, 0, 100, 0, 0, 0],
  ['typ-onion', 'Onion, raw', 40, 1.1, 9.3, 0.1, 1.7, 4.2, 4],
  ['typ-tomato', 'Tomato, raw', 18, 0.9, 3.9, 0.2, 1.2, 2.6, 5],
  ['typ-egg', 'Egg, whole, raw', 143, 12.6, 0.7, 9.5, 0, 0.4, 142],
  ['typ-chicken', 'Chicken breast, raw, skinless', 120, 22.5, 0, 2.6, 0, 0, 45],
].map(([id, name, kcal, protein, carbs, fat, fiber, sugar, sodium]) => ({id, name, brand: 'Typical value (USDA)', kcal, protein, carbs, fat, fiber, sugar, sodium,
  servingG: id === 'typ-egg' ? 50 : null, servingLabel: id === 'typ-egg' ? '1 egg (no shell)' : '', source: 'typical', updatedAt: 0}));

async function load(){
  try {
    const [foods, recipes, vessels, days, meta] = await Promise.all(['foods', 'recipes', 'vessels', 'days', 'meta'].map(s => DB.all(s)));
    if (!meta.some(m => m.id === 'seeded')) {
      for (const f of SEED_FOODS) await DB.put('foods', f);
      await DB.put('meta', {id: 'seeded', at: Date.now()});
      foods.push(...SEED_FOODS);
    }
    S.foods = foods.sort(byName); S.recipes = recipes.sort(byName); S.vessels = vessels.sort(byName);
    S.days = Object.fromEntries(days.map(d => [d.id, d]));
    S.settings = {...DEFAULT_SETTINGS, ...(meta.find(m => m.id === 'settings') || {})};
    S.ready = true;
  } catch (e) {
    console.error(e);
    showBanner('This browser won’t let the app store data (private browsing?). Open it in a normal tab or from the home-screen icon.');
  }
  renderAll();
  navigator.storage?.persist?.().catch(() => {});
}
async function saveDoc(store, obj){
  const o = {...obj, updatedAt: Date.now()};
  if (store === 'meta') { if (o.id === 'settings') S.settings = {...DEFAULT_SETTINGS, ...o}; }
  else if (store === 'days') S.days[o.id] = o;
  else { const a = S[store]; const i = a.findIndex(x => x.id === o.id); if (i >= 0) a[i] = o; else a.push(o); a.sort(byName); }
  renderAll();
  try { await DB.put(store, o); } catch (e) { console.error(e); toast('Couldn’t save on this phone. Is storage full?'); }
}
async function removeDoc(store, id){
  if (store === 'days') delete S.days[id]; else S[store] = S[store].filter(x => x.id !== id);
  renderAll();
  try { await DB.del(store, id); } catch (e) { console.error(e); toast('Couldn’t delete. Try again.'); }
}

/* ---------- derived ---------- */
const vesselById = id => S.vessels.find(v => v.id === id);
function vesselVolume(v){
  const R = (num(v?.topD) || 0) / 2, r = (num(v?.bottomD) ?? num(v?.topD) ?? 0) / 2, h = num(v?.depth) || 0;
  if (!R || !h) return null;
  return Math.PI * h / 3 * (R * R + R * r + r * r);
}
function per100Of(food){ const o = {}; NUTR.forEach(k => o[k] = num(food[k]) || 0); return o; }
function allItems(){
  const counts = {};
  Object.values(S.days).forEach(d => (d.entries || []).forEach(e => { if (e.refId) counts[e.refId] = (counts[e.refId] || 0) + 1; }));
  const items = [
    ...S.foods.map(f => ({kind:'food', id:f.id, name:f.name, photo: f.photo || null, brand:f.brand || '', per100: per100Of(f), servingG: num(f.servingG), servingLabel: f.servingLabel || '', packG: num(f.packG)})),
    ...S.recipes.map(r => ({kind:'recipe', id:r.id, name:r.name, brand:'Recipe', per100: r.per100 || {}, servingG:null})),
  ];
  items.forEach(i => i.uses = counts[i.id] || 0);
  return items;
}
function searchItems(q){
  const t = q.trim().toLowerCase();
  let list = allItems();
  if (t) list = list.filter(i => (i.name + ' ' + i.brand).toLowerCase().includes(t));
  return list.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)).slice(0, 40);
}
const dayEntries = date => (S.days[date]?.entries || []);
const dayTotals = date => sumN(dayEntries(date));

/* ---------- render: main views ---------- */
function renderAll(){
  $('#modeTag').textContent = S.ready ? 'v' + APP_VERSION + (navigator.onLine ? '' : ' · offline') : '';
  $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === S.view)));
  ['today', 'foods', 'bowls', 'settings'].forEach(v => $('#view-' + v).hidden = v !== S.view);
  $('#fab').hidden = S.view === 'settings' || !S.ready;
  $('#updBadge').hidden = !(UPD.state === 'available' || UPD.state === 'ready');
  if (!S.ready) return;
  if (S.view === 'today') renderToday();
  if (S.view === 'foods') renderFoods();
  if (S.view === 'bowls') renderBowls();
  if (S.view === 'settings') renderSettings();
}

function ringSvg(val, target){
  const C = 2 * Math.PI * 52, frac = target ? Math.min(val / target, 1) : 0;
  return `<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-track" cx="60" cy="60" r="52" stroke-width="11"/>
    ${frac > 0 ? `<circle class="ring-val ${val > target ? 'over' : ''}" cx="60" cy="60" r="52" stroke-width="11" stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}"/>` : ''}</svg>`;
}
function macroBar(cls, label, val, target){
  const pct = target ? Math.min(100, val / target * 100) : 0;
  return `<div class="macro ${cls}"><div class="top"><span><span class="dot ${cls}"></span>${label}</span><span class="num">${r0(val)} / ${r0(target)} g</span></div>
    <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div></div>`;
}
function weekChart(){
  const days = []; for (let i = 6; i >= 0; i--) days.push(addDays(S.date, -i));
  const vals = days.map(d => dayTotals(d).kcal), tgt = num(S.settings.kcal) || 2000;
  const max = Math.max(tgt * 1.25, ...vals) || 1;
  const W = 320, H = 130, top = 10, base = 108, bw = 28, gap = (W - 30 - bw * 7) / 6;
  const y = v => base - (v / max) * (base - top);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calories for the last 7 days against your target">`;
  s += `<line class="grid" x1="30" x2="${W}" y1="${base}" y2="${base}"/>`;
  s += `<line class="tgt" x1="30" x2="${W}" y1="${y(tgt).toFixed(1)}" y2="${y(tgt).toFixed(1)}"/><text x="0" y="${(y(tgt) + 3).toFixed(1)}">${r0(tgt)}</text>`;
  days.forEach((d, i) => {
    const x = 30 + i * (bw + gap), v = vals[i], h = Math.max(v ? 2 : 0, base - y(v));
    const [yy, mm, dd] = d.split('-').map(Number);
    const lbl = new Date(yy, mm - 1, dd).toLocaleDateString(undefined, {weekday:'narrow'});
    s += `<rect class="bar ${v > tgt ? 'over' : ''} ${d === S.date ? '' : 'past'}" x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="4"/>`;
    if (v) s += `<text x="${(x + bw / 2).toFixed(1)}" y="${(base - h - 3).toFixed(1)}" text-anchor="middle">${r0(v)}</text>`;
    s += `<text x="${(x + bw / 2).toFixed(1)}" y="${base + 16}" text-anchor="middle">${esc(lbl)}</text>`;
  });
  return s + '</svg>';
}
function entrySub(e){
  const parts = [r0(e.grams) + ' g'];
  if (e.vesselName && e.gross != null) parts.push(`${r0(e.gross)} − ${r0(e.prev)} in ${e.vesselName}`);
  parts.push(`P ${r1(e.protein)} · C ${r1(e.carbs)} · F ${r1(e.fat)}`);
  return parts.join(' · ');
}
function renderToday(){
  const t = dayTotals(S.date), st = S.settings, tgt = num(st.kcal) || 0, left = tgt - t.kcal;
  const entries = dayEntries(S.date);
  const photos = Object.fromEntries(S.foods.filter(f => f.photo).map(f => [f.id, f.photo]));
  let html = `<div class="datenav"><button class="iconbtn" data-act="day" data-d="-1" aria-label="Previous day">‹</button>
    <strong>${esc(prettyDate(S.date))}</strong>
    <button class="iconbtn" data-act="day" data-d="1" aria-label="Next day" ${S.date >= todayStr() ? 'disabled' : ''}>›</button></div>
  <div class="summary">
    <div class="ring">${ringSvg(t.kcal, tgt)}<div class="ring-label"><b>${r0(t.kcal)}</b><span>of ${r0(tgt)} kcal</span></div></div>
    <div class="macros">${macroBar('p', 'Protein', t.protein, num(st.protein))}${macroBar('c', 'Carbs', t.carbs, num(st.carbs))}${macroBar('f', 'Fat', t.fat, num(st.fat))}</div>
    <div class="remain"><span class="muted">${left >= 0 ? 'Remaining' : 'Over target'}</span><span class="num"><b>${r0(Math.abs(left))}</b> kcal · fiber ${r1(t.fiber)} g</span></div>
  </div>`;
  if (!entries.length) {
    html += `<div class="meal"><div class="list"><div class="empty">Nothing logged for ${esc(prettyDate(S.date).toLowerCase())} yet.<br>Tap <b>+ Log food</b>, pick your bowl and type what the scale reads.</div></div></div>`;
  }
  MEALS.forEach(m => {
    const es = entries.filter(e => e.meal === m); if (!es.length) return;
    const mt = sumN(es);
    html += `<div class="meal"><div class="meal-head"><h3>${m}</h3><span class="num small muted">${r0(mt.kcal)} kcal</span></div><div class="list">` +
      es.map(e => `<div class="item with-icon">${iconHtml({name: e.name, kind: e.kind, photo: photos[e.refId]})}<div class="name">${esc(e.name)}${e.kind === 'recipe' ? ' <span class="tag rec">recipe</span>' : ''}</div>
        <div class="right"><span class="kcal">${r0(e.kcal)}</span><button class="x ${pendingDel === e.id ? 'armed' : ''}" data-act="delentry" data-id="${esc(e.id)}" aria-label="Delete ${esc(e.name)}">${pendingDel === e.id ? 'Delete' : '×'}</button></div>
        <div class="sub">${esc(entrySub(e))}</div></div>`).join('') + '</div></div>';
  });
  html += `<div class="week"><div class="meal-head"><h3>Last 7 days</h3><span class="small muted">dashed line = target</span></div><div class="card">${weekChart()}</div></div>`;
  $('#view-today').innerHTML = html;
}

function renderFoods(){
  const tab = S.foodsTab, q = S.foodsQ.trim().toLowerCase();
  let html = `<div class="toolbar"><div class="seg" role="group" aria-label="Show">
      <button data-act="ftab" data-v="foods" aria-pressed="${tab === 'foods'}">Foods (${S.foods.length})</button>
      <button data-act="ftab" data-v="recipes" aria-pressed="${tab === 'recipes'}">Recipes (${S.recipes.length})</button></div>
    <div class="row-actions">${tab === 'foods' ? `<button class="btn sm primary" data-act="newfood" data-scan="1">Scan label</button><button class="btn sm" data-act="newfood">+ Food</button>` : `<button class="btn sm primary" data-act="newrecipe">+ Recipe</button>`}</div></div>
    <input class="search" id="foodsQ" type="search" placeholder="Search ${tab}" value="${esc(S.foodsQ)}" aria-label="Search">
    <p class="hint" style="margin-top:8px">All values are per 100 g${tab === 'recipes' ? ' of the cooked dish' : ''}.</p>`;
  const list = (tab === 'foods' ? S.foods : S.recipes).filter(x => !q || (x.name + ' ' + (x.brand || '')).toLowerCase().includes(q));
  html += `<div class="list" style="margin-top:10px">`;
  if (!list.length) {
    html += `<div class="empty">${q ? 'No matches.' : tab === 'foods'
      ? 'No foods yet. Tap <b>Scan label</b> to photograph a nutrition label, or <b>+ Food</b> to type one in.'
      : 'No recipes yet. Add the ingredients by weight, then weigh the cooked dish. The app works out calories per 100 g of the finished food.'}</div>`;
  }
  list.forEach(x => {
    const p = tab === 'foods' ? per100Of(x) : (x.per100 || {});
    const sub = tab === 'foods' ? [x.brand, x.servingG ? `serving ${r1(x.servingG)} g` : '', x.packG ? `pack ${r0(x.packG)} g` : ''].filter(Boolean).join(' · ')
      : `${(x.ingredients || []).length} ingredients · cooked ${r0(x.cookedG)} g`;
    html += `<div class="item with-icon tall clickable" data-act="${tab === 'foods' ? 'editfood' : 'editrecipe'}" data-id="${esc(x.id)}" tabindex="0" role="button">
      ${iconHtml({...x, kind: tab === 'foods' ? 'food' : 'recipe'})}<div class="name">${esc(x.name)}</div><div class="right"><span class="kcal">${r0(p.kcal)}<span class="small muted"> kcal</span></span></div>
      <div class="sub">${esc(sub)}</div>
      <div class="macro-mini"><b class="p">P ${r1(p.protein)}</b><b class="c">C ${r1(p.carbs)}</b><b class="f">F ${r1(p.fat)}</b>${p.fiber ? `<b>Fib ${r1(p.fiber)}</b>` : ''}${p.sugar ? `<b>Sug ${r1(p.sugar)}</b>` : ''}${p.sodium ? `<b>Na ${r0(p.sodium)} mg</b>` : ''}</div></div>`;
  });
  html += '</div>';
  const had = document.activeElement?.id === 'foodsQ';
  $('#view-foods').innerHTML = html;
  if (had) { const i = $('#foodsQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

function renderBowls(){
  let html = `<div class="toolbar"><h2>Bowls, plates & pots</h2><button class="btn sm primary" data-act="newvessel">+ Add</button></div>
    <p class="hint">Weigh each one empty and dry. When you log a meal, pick the bowl and type the full reading; its weight is taken off automatically.</p>
    <div class="list" style="margin-top:12px">`;
  if (!S.vessels.length) html += `<div class="empty">No bowls yet. Add the bowl you usually eat from.</div>`;
  S.vessels.forEach(v => {
    const vol = vesselVolume(v);
    html += `<div class="item clickable" data-act="editvessel" data-id="${esc(v.id)}" tabindex="0" role="button"><div class="name">${esc(v.name)} <span class="tag">${esc(v.type || 'bowl')}</span></div>
      <div class="right"><span class="kcal">${r0(v.weightG)} g</span></div>
      <div class="sub">${vol ? `⌀ ${r1(v.topD)} cm top · ${r1(v.bottomD)} cm base · ${r1(v.depth)} cm deep · ~${r0(vol)} ml` : 'No dimensions saved'}</div></div>`;
  });
  $('#view-bowls').innerHTML = html + '</div>';
}

/* ---------- picker (shared by log + recipe) ---------- */
function mountPicker(el, onPick, placeholder){
  el.innerHTML = `<input class="search" type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"><div class="pick-results"></div>`;
  const inp = $('input', el), res = $('.pick-results', el);
  const draw = () => {
    const items = searchItems(inp.value);
    res.innerHTML = items.length ? items.map((it, i) => `<button type="button" class="pick-item" data-i="${i}"><span class="pk-name">${iconHtml(it, 'sm')}<span>${esc(it.name)} ${it.kind === 'recipe' ? '<span class="tag rec">recipe</span>' : `<span class="small muted">${esc(it.brand)}</span>`}</span></span><span class="pk">${r0(it.per100.kcal)} kcal/100g</span></button>`).join('')
      : `<div class="empty">No match. <button type="button" class="chip" data-new="1">Add “${esc(inp.value)}” as a new food</button></div>`;
    res._items = items;
  };
  inp.addEventListener('input', draw);
  inp.addEventListener('focus', draw);
  res.addEventListener('mousedown', e => e.preventDefault());
  res.addEventListener('click', e => {
    const nb = e.target.closest('[data-new]');
    if (nb) { openFoodSheet(null, {name: inp.value, returnTo: currentSheet}); return; }
    const b = e.target.closest('.pick-item'); if (!b) return;
    onPick(res._items[+b.dataset.i]); inp.value = ''; res.innerHTML = '';
  });
  inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) res.innerHTML = ''; }, 150));
}

/* ---------- sheets ---------- */
let currentSheet = null;
function openSheet(title, html){
  $('#sheetTitle').textContent = title; $('#sheetBody').innerHTML = html; $('#sheet').hidden = false;
  document.body.classList.add('locked'); $('#sheetBody').scrollTop = 0;
}
function closeSheet(){ $('#sheet').hidden = true; document.body.classList.remove('locked'); currentSheet = null; ocrRun++; }

const vesselOptions = (sel, emptyLabel) => `<option value="">${esc(emptyLabel)}</option>` + S.vessels.map(v => `<option value="${esc(v.id)}" ${v.id === sel ? 'selected' : ''}>${esc(v.name)} (${r0(v.weightG)} g)</option>`).join('');
const mealOptions = sel => MEALS.map(m => `<option ${m === sel ? 'selected' : ''}>${m}</option>`).join('');
function lcd(cells){ return cells.map(c => c.op ? `<span class="op">${c.op}</span>` : `<div class="cell"><span>${c.label}</span><b class="${c.big ? 'big' : ''}">${c.v}<small>${c.u || ''}</small></b></div>`).join(''); }
function armButton(btn, action, armedText = 'Tap again to delete'){
  btn.onclick = () => {
    if (btn.classList.contains('armed')) return action();
    btn.classList.add('armed'); const t = btn.textContent; btn.textContent = armedText;
    setTimeout(() => { btn.classList.remove('armed'); btn.textContent = t; }, 3000);
  };
}
function setStatus(id, html, isErr){ const s = $(id); if (!s) return; s.hidden = !html; s.className = 'status' + (isErr ? ' err' : ''); s.innerHTML = html; }

/* --- Log sheet --- */
let L = null;
function lastVesselId(){ try { const v = localStorage.getItem('gt.vessel'); if (v !== null && (v === '' || vesselById(v))) return v; } catch {} return S.vessels[0]?.id || ''; }
function openLogSheet(){
  L = {date: S.date, meal: defaultMeal(), vesselId: lastVesselId(), rows: []};
  currentSheet = 'log';
  openSheet('Log food', `
    <div class="fields"><label class="f">Meal<select id="lMeal">${mealOptions(L.meal)}</select></label>
      <label class="f">Bowl<select id="lVessel">${vesselOptions(L.vesselId, 'No bowl: enter net grams')}</select></label></div>
    <div class="lcd" id="lLcd"></div>
    <p class="hint" id="lHint"></p>
    <div class="section-gap" id="lRows"></div>
    <div class="picker" id="lPicker"></div>
    <div class="row-actions"><button class="btn sm ghost" data-act="newfood" data-from="log">+ New food</button><button class="btn sm ghost" data-act="newfood" data-from="log" data-scan="1">Scan a label</button></div>
    <div class="sheet-foot"><span class="num" id="lSum"></span><button class="btn primary" id="lSave">Save to ${esc(prettyDate(L.date).toLowerCase())}</button></div>`);
  bindLog();
}
function bindLog(){
  $('#lMeal').onchange = e => L.meal = e.target.value;
  $('#lVessel').onchange = e => { L.vesselId = e.target.value; try { localStorage.setItem('gt.vessel', L.vesselId); } catch {} drawLogRows(); };
  mountPicker($('#lPicker'), it => { L.rows.push({key: uid(), item: it, reading: '', grams: ''}); drawLogRows(true); }, 'Add a food or recipe…');
  $('#lSave').onclick = saveLog;
  drawLogRows();
}
function logCalc(){
  const v = vesselById(L.vesselId); let prev = v ? num(v.weightG) || 0 : 0, broken = false;
  return L.rows.map(r => {
    let g = null, from = prev, err = '';
    if (v) {
      const rd = num(r.reading);
      if (rd == null) broken = true;
      else if (broken) err = 'Fill in the reading above first';
      else { g = rd - prev; if (g <= 0) err = `Must be more than ${r0(prev)} g (the last reading)`; prev = rd; }
    } else { g = num(r.grams); if (g != null && g <= 0) err = 'Enter more than 0 g'; }
    const ok = g != null && g > 0 && !err;
    return {g: ok ? g : null, from, gross: v ? num(r.reading) : null, err, n: ok ? nutrFor(r.item.per100, g) : null};
  });
}
function drawLogRows(focusLast){
  const v = vesselById(L.vesselId);
  $('#lHint').textContent = !L.rows.length ? (v ? 'The app already knows this bowl weighs ' + r0(v.weightG) + ' g. Add what you’re eating below.' : 'Add a food, then type how many grams you’re eating.')
    : v ? 'Add foods in the order they went into the bowl, and type the scale reading after each one.' : '';
  $('#lRows').innerHTML = L.rows.map((r, i) => `<div class="lrow">
      <div class="nmwrap">${iconHtml(r.item)}<div><div class="nm">${esc(r.item.name)} ${r.item.kind === 'recipe' ? '<span class="tag rec">recipe</span>' : ''}</div><div class="meta">${r0(r.item.per100.kcal)} kcal · P ${r1(r.item.per100.protein)} per 100 g</div></div></div>
      <button class="x" data-act="lrm" data-k="${r.key}" aria-label="Remove ${esc(r.item.name)}">×</button>
      <div class="ctl">${v ? `<span class="step">${i + 1}</span><label class="small muted" for="in-${r.key}">Scale reads</label>` : `<label class="small muted" for="in-${r.key}">Grams</label>`}
        <input class="inp num" id="in-${r.key}" inputmode="decimal" data-k="${r.key}" value="${esc(v ? r.reading : r.grams)}" placeholder="g">
        ${!v && r.item.servingG ? `<button type="button" class="chip" data-act="serv" data-k="${r.key}" data-g="${r.item.servingG}">${esc(r.item.servingLabel || '1 serving')} = ${r1(r.item.servingG)} g</button>` : ''}
        ${!v && r.item.packG ? `<button type="button" class="chip" data-act="serv" data-k="${r.key}" data-g="${r.item.packG}">Whole pack = ${r0(r.item.packG)} g</button>` : ''}
        <span class="calc" id="calc-${r.key}"></span></div>
      <div class="warn" id="err-${r.key}" style="grid-column:1/-1" hidden></div></div>`).join('');
  $$('#lRows input').forEach(inp => inp.addEventListener('input', () => {
    const r = L.rows.find(x => x.key === inp.dataset.k); if (vesselById(L.vesselId)) r.reading = inp.value; else r.grams = inp.value; updateLogCalc();
  }));
  updateLogCalc();
  if (focusLast && L.rows.length) $('#in-' + L.rows[L.rows.length - 1].key)?.focus();
}
function updateLogCalc(){
  const v = vesselById(L.vesselId), calc = logCalc();
  calc.forEach((c, i) => {
    const r = L.rows[i];
    $('#calc-' + r.key).innerHTML = c.n ? `${v ? '+' : ''}${r1(c.g)} g · <b>${r0(c.n.kcal)} kcal</b>` : '';
    const er = $('#err-' + r.key); er.textContent = c.err; er.hidden = !c.err;
  });
  const tot = sumN(calc.filter(c => c.n).map(c => c.n)), net = calc.reduce((a, c) => a + (c.g || 0), 0);
  const lastGross = [...calc].reverse().find(c => c.gross != null)?.gross;
  $('#lLcd').innerHTML = v
    ? lcd([{label:'Scale', v: lastGross != null ? r0(lastGross) : '—', u:'g'}, {op:'−'}, {label: 'Bowl', v: r0(v.weightG), u:'g'}, {op:'='}, {label:'Food', v: r0(net), u:'g', big:1}, {label:'Energy', v: r0(tot.kcal), u:'kcal', big:1}])
    : lcd([{label:'Food', v: r0(net), u:'g', big:1}, {label:'Energy', v: r0(tot.kcal), u:'kcal', big:1}, {label:'Protein', v: r1(tot.protein), u:'g'}]);
  $('#lSum').textContent = L.rows.length ? `${L.rows.length} item${L.rows.length > 1 ? 's' : ''} · ${r0(tot.kcal)} kcal` : '';
  $('#lSave').disabled = !L.rows.length || calc.some(c => !c.n);
}
async function saveLog(){
  const v = vesselById(L.vesselId), calc = logCalc();
  if (calc.some(c => !c.n)) return;
  const entries = L.rows.map((r, i) => {
    const c = calc[i], n = c.n;
    return {id: uid(), at: Date.now(), meal: L.meal, kind: r.item.kind, refId: r.item.id, name: r.item.name, grams: r1(c.g),
      kcal: r1(n.kcal), protein: r1(n.protein), carbs: r1(n.carbs), fat: r1(n.fat), fiber: r1(n.fiber), sugar: r1(n.sugar), sodium: r1(n.sodium),
      ...(v ? {vesselName: v.name, gross: c.gross, prev: c.from} : {})};
  });
  const date = L.date, meal = L.meal;
  closeSheet(); L = null;
  await saveDoc('days', {id: date, date, entries: [...dayEntries(date), ...entries]});
  toast(`Logged ${entries.length} item${entries.length > 1 ? 's' : ''} to ${meal.toLowerCase()}`);
}
function reopenLog(){ const saved = L; openLogSheet(); L = saved; $('#lMeal').value = L.meal; $('#lVessel').value = L.vesselId; drawLogRows(); }

/* --- Food sheet: label numbers are typed (or read) exactly as printed; the app converts to per 100 g. --- */
let F = null, ocrRun = 0;
const LABEL_FIELDS = [['kcal', 'Energy'], ['protein', 'Protein (g)'], ['carbs', 'Carbs (g)'], ['fat', 'Fat (g)'], ['fiber', 'Fiber (g)'], ['sugar', 'Total sugars (g)'], ['sodium', 'Sodium (mg)']];
function openFoodSheet(id, opts = {}){
  const f = id ? S.foods.find(x => x.id === id) : null;
  const lab = f?.label;
  F = {id: f?.id || uid(), isNew: !f, returnTo: opts.returnTo || null, basis: lab?.basis || '100', unit: lab?.unit || 'kcal', source: f?.source || 'manual', photo: f?.photo || null, picks: [], candidates: []};
  const vals = lab?.values || (f ? per100Of(f) : {});
  currentSheet = 'food';
  const v = k => esc(vals[k] ?? '');
  openSheet(f ? 'Edit food' : 'New food', `
    <div class="card section-gap">
      <div class="prod-row"><span id="fIcon">${iconHtml({name: f?.name || opts.name, photo: F.photo}, 'lg')}</span>
        <div class="section-gap" style="flex:1;min-width:0;gap:6px">
          <span class="btn filebtn" style="justify-self:start">Photo of product<input type="file" id="fProd" accept="image/*" aria-label="Photo of the product"></span>
          <button type="button" class="chip" id="fNoPhoto" ${F.photo ? '' : 'hidden'} style="justify-self:start">Remove photo</button>
        </div></div>
      <p class="hint">The product photo becomes this food\u2019s icon, and the name is read from the pack. Shoot the front, with the name filling most of the frame.</p>
      <div id="fNames" hidden></div>
      <hr class="divider">
      <div class="row-actions"><span class="btn filebtn primary">Photo of label<input type="file" id="fFile" accept="image/*" aria-label="Photo of the nutrition label"></span></div>
      <p class="hint">Fill the frame with the nutrition table, hold the phone flat and avoid glare. Everything is read on your phone, no internet needed. Check the numbers before saving.</p>
      <div class="thumbs" id="fThumbs"></div>
      <div class="progress" id="fProg" hidden><i></i></div>
      <div id="fStatus" hidden></div>
    </div>
    <div class="fields">
      <label class="f full">Name<input id="f_name" value="${esc(f?.name ?? opts.name ?? '')}" placeholder="e.g. Amul Malai Paneer"></label>
      <label class="f full">Brand or note<input id="f_brand" value="${esc(f?.brand ?? '')}" placeholder="optional"></label>
    </div>
    <h3>The label’s numbers are for</h3>
    <div class="pill-seg" role="group" aria-label="Label basis"><button type="button" data-basis="100" aria-pressed="${F.basis === '100'}">100 g</button><button type="button" data-basis="serving" aria-pressed="${F.basis === 'serving'}">One serving</button></div>
    <div class="fields">
      <label class="f">Serving size (g)<input class="num" id="f_servingG" inputmode="decimal" value="${esc(f?.servingG ?? '')}" placeholder="${F.basis === 'serving' ? 'needed' : 'optional'}"></label>
      <label class="f">Serving name<input id="f_servingLabel" value="${esc(f?.servingLabel ?? '')}" placeholder="e.g. 1 biscuit"></label>
    </div>
    <div class="fields three">
      ${LABEL_FIELDS.map(([k, label]) => k === 'kcal'
        ? `<label class="f">${label}<span class="unit-row"><input class="num" id="f_kcal" inputmode="decimal" value="${v('kcal')}"><select id="f_unit" aria-label="Energy unit"><option value="kcal" ${F.unit === 'kcal' ? 'selected' : ''}>kcal</option><option value="kj" ${F.unit === 'kj' ? 'selected' : ''}>kJ</option></select></span></label>`
        : `<label class="f">${label}<input class="num" id="f_${k}" inputmode="decimal" value="${v(k)}"></label>`).join('')}
      <label class="f">Pack size (g)<input class="num" id="f_packG" inputmode="decimal" value="${esc(f?.packG ?? '')}" placeholder="optional"></label>
    </div>
    <h3>Saved as per 100 g</h3>
    <div class="lcd" id="fLcd"></div>
    <div id="fCheck"></div>
    <p class="warn" id="fErr" hidden></p>
    <div class="sheet-foot">${f ? `<button class="btn danger" id="fDel">Delete</button>` : '<span></span>'}<button class="btn primary" id="fSave">${f ? 'Save changes' : 'Save food'}</button></div>`);
  $('#fFile').onchange = e => { const file = e.target.files[0]; e.target.value = ''; if (file) onLabelPhoto(file); };
  $('#fProd').onchange = e => { const file = e.target.files[0]; e.target.value = ''; if (file) onProductPhoto(file); };
  $('#fNoPhoto').onclick = () => { F.photo = null; drawFoodIcon(); };
  $('#f_name').addEventListener('input', () => { F.picks = []; drawNameChips(); drawFoodIcon(); });
  $$('[data-basis]').forEach(b => b.onclick = () => setBasis(b.dataset.basis));
  $$('#sheetBody input, #sheetBody select').forEach(i => i.addEventListener('input', updateFoodCalc));
  $('#f_unit').onchange = e => { F.unit = e.target.value; updateFoodCalc(); };
  $('#fSave').onclick = saveFood;
  if ($('#fDel')) armButton($('#fDel'), async () => { await removeDoc('foods', F.id); closeSheet(); toast('Food deleted'); });
  updateFoodCalc();
  if (opts.scan) setTimeout(() => $('#fFile').click(), 60);
  else LabelReader.warm().catch(() => {});
}
function setBasis(b){
  F.basis = b;
  $$('[data-basis]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.basis === b)));
  $('#f_servingG').placeholder = b === 'serving' ? 'needed' : 'optional';
  updateFoodCalc();
}
/* The core conversion: label values (as printed) -> per 100 g. */
function foodPer100(){
  const g = k => num($('#f_' + k).value);
  const servingG = g('servingG');
  const factor = F.basis === '100' ? 1 : (servingG > 0 ? 100 / servingG : null);
  const printed = {}; LABEL_FIELDS.forEach(([k]) => printed[k] = g(k));
  if (factor == null) return {printed, per100: null, err: 'Enter the serving size in grams so the app can convert to per 100 g.'};
  const per100 = {};
  LABEL_FIELDS.forEach(([k]) => { let x = printed[k]; if (x == null) { per100[k] = null; return; } if (k === 'kcal' && F.unit === 'kj') x = x / 4.184; per100[k] = x * factor; });
  return {printed, per100, factor, err: ''};
}
function updateFoodCalc(){
  const {per100, err} = foodPer100();
  const sv = num($('#f_servingG').value), pack = num($('#f_packG').value);
  if (!per100) { $('#fLcd').innerHTML = lcd([{label:'Energy', v:'—', u:'kcal', big:1}]); $('#fCheck').innerHTML = `<div class="check bad">${esc(err)}</div>`; return; }
  $('#fLcd').innerHTML = lcd([{label:'Energy', v: per100.kcal != null ? r0(per100.kcal) : '—', u:'kcal', big:1},
    {label:'Protein', v: r1(per100.protein), u:'g'}, {label:'Carbs', v: r1(per100.carbs), u:'g'}, {label:'Fat', v: r1(per100.fat), u:'g'},
    ...(sv > 0 && per100.kcal != null ? [{label:'Per serving', v: r0(per100.kcal * sv / 100), u:'kcal'}] : []),
    ...(pack > 0 && per100.kcal != null ? [{label:'Whole pack', v: r0(per100.kcal * pack / 100), u:'kcal'}] : [])]);
  // cross-check: energy from macros (Atwater: 4 / 4 / 9, fiber 2)
  const P = per100.protein || 0, C = per100.carbs || 0, Fa = per100.fat || 0, Fi = per100.fiber || 0;
  const est = 4 * P + 4 * C + 9 * Fa + 2 * Fi, msgs = [];
  if (P + C + Fa > 101) msgs.push({bad: 1, t: `Protein + carbs + fat come to ${r0(P + C + Fa)} g per 100 g, which is impossible. Check the numbers and whether they’re per 100 g or per serving.`});
  if (per100.kcal == null && est > 0) msgs.push({bad: 1, t: `No energy value yet. From the macros it would be about ${r0(est)} kcal per 100 g. <button type="button" class="chip" id="useEst">Use ${r0(est)} kcal</button>`});
  else if (per100.kcal > 0 && est > 0 && Math.abs(per100.kcal - est) / per100.kcal > 0.15) msgs.push({bad: 1, t: `The energy (${r0(per100.kcal)} kcal) doesn’t match the macros (about ${r0(est)} kcal). One number may be misread.`});
  else if (per100.kcal > 0 && est > 0) msgs.push({t: `Energy matches the protein, carbs and fat (about ${r0(est)} kcal). ✓`});
  $('#fCheck').innerHTML = msgs.map(m => `<div class="check ${m.bad ? 'bad' : ''}">${m.t}</div>`).join('');
  const ue = $('#useEst'); if (ue) ue.onclick = () => { const {factor} = foodPer100(); $('#f_unit').value = 'kcal'; F.unit = 'kcal'; $('#f_kcal').value = r1(est / factor); updateFoodCalc(); };
}
async function onLabelPhoto(file){
  const run = ++ocrRun;
  $('#fThumbs').innerHTML = `<img alt="Label photo" src="${URL.createObjectURL(file)}">`;
  const bar = $('#fProg'); bar.hidden = false; $('i', bar).style.width = '3%';
  setStatus('#fStatus', 'Reading the label on your phone… the first time takes a few extra seconds.');
  try {
    const res = await LabelReader.readLabel(file, p => { if (run === ocrRun) $('i', bar).style.width = Math.max(3, p * 100).toFixed(0) + '%'; });
    if (run !== ocrRun) return;
    bar.hidden = true;
    if (!res.found) {
      setStatus('#fStatus', 'Couldn’t find nutrition numbers in this photo. Try again closer, flat and well lit, with only the table in frame, or type the values.' + rawBlock(res.text), true);
      return;
    }
    setBasis(res.basis);
    if (res.servingG) $('#f_servingG').value = res.servingG;
    LABEL_FIELDS.forEach(([k]) => { if (res.values[k] != null) $('#f_' + k).value = res.values[k]; });
    $('#f_unit').value = 'kcal'; F.unit = 'kcal'; F.source = 'label';
    const missing = LABEL_FIELDS.filter(([k]) => res.values[k] == null).map(([, l]) => l.replace(/ \(.*\)/, '').toLowerCase());
    setStatus('#fStatus', `Read ${res.found} value${res.found > 1 ? 's' : ''} from the label${missing.length ? ` (not found: ${esc(missing.join(', '))})` : ''}. Compare with the photo and fix anything that’s off.` +
      (res.notes.length ? `<ul class="notes">${res.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '') + rawBlock(res.text), res.confidence === 'low');
    updateFoodCalc();
  } catch (e) {
    console.error(e); if (run !== ocrRun) return;
    bar.hidden = true;
    setStatus('#fStatus', 'The label reader couldn’t start on this phone. Type the values from the photo instead.', true);
  }
}
function drawFoodIcon(){
  $('#fIcon').innerHTML = iconHtml({name: $('#f_name').value, photo: F.photo}, 'lg');
  $('#fNoPhoto').hidden = !F.photo;
}
/* Name chips: tap the pieces of text in order to build the name; tap again to drop one. */
function drawNameChips(){
  const box = $('#fNames'), c = F.candidates || [];
  box.hidden = !c.length;
  box.innerHTML = c.length ? `<p class="hint" style="margin-bottom:6px">Text found on the pack. Tap the parts of the name in order:</p><div class="chips">${
    c.map((t, i) => `<button type="button" class="chip ${F.picks.includes(i) ? 'on' : ''}" data-pick="${i}">${esc(t)}</button>`).join('')}</div>` : '';
  $$('[data-pick]', box).forEach(b => b.onclick = () => {
    const i = +b.dataset.pick;
    F.picks = F.picks.includes(i) ? F.picks.filter(x => x !== i) : [...F.picks, i];
    $('#f_name').value = F.picks.map(x => c[x]).join(' ');
    drawNameChips(); drawFoodIcon();
  });
}
async function onProductPhoto(file){
  const run = ++ocrRun;
  try { F.photo = await makeThumb(file); drawFoodIcon(); } catch (e) { console.error(e); toast('Couldn\u2019t open that photo.'); return; }
  const bar = $('#fProg'); bar.hidden = false; $('i', bar).style.width = '3%';
  setStatus('#fStatus', 'Reading the product name\u2026');
  try {
    const res = await LabelReader.readProduct(file, p => { if (run === ocrRun) $('i', bar).style.width = Math.max(3, p * 100).toFixed(0) + '%'; });
    if (run !== ocrRun) return;
    bar.hidden = true;
    F.candidates = res.candidates; F.picks = [];
    if (!res.candidates.length) { setStatus('#fStatus', 'Photo saved as the icon. No clear product name was found on it, so type the name.', true); drawNameChips(); return; }
    if (!$('#f_name').value.trim()) { F.picks = res.suggested?.length ? res.suggested : [0]; $('#f_name').value = F.picks.map(i => res.candidates[i]).join(' '); }
    drawNameChips(); drawFoodIcon();
    setStatus('#fStatus', 'Photo saved as the icon. Check the name, or build it from the text found on the pack.');
  } catch (e) {
    console.error(e); if (run !== ocrRun) return;
    bar.hidden = true;
    setStatus('#fStatus', 'Photo saved as the icon. The name couldn\u2019t be read, so type it.', true);
  }
}
const rawBlock = text => text ? `<details class="raw"><summary>Show the text that was read</summary><pre>${esc(text)}</pre></details>` : '';
async function saveFood(){
  const name = $('#f_name').value.trim();
  const {printed, per100, err} = foodPer100();
  const e = $('#fErr');
  const msg = !name ? 'Give the food a name.' : err ? err : per100.kcal == null ? 'Enter the energy value.' : '';
  e.textContent = msg; e.hidden = !msg; if (msg) return;
  const food = {id: F.id, name, brand: $('#f_brand').value.trim(),
    kcal: r1(per100.kcal), protein: r1(per100.protein), carbs: r1(per100.carbs), fat: r1(per100.fat), fiber: r1(per100.fiber),
    sugar: per100.sugar == null ? null : r1(per100.sugar), sodium: per100.sodium == null ? null : r0(per100.sodium),
    servingG: num($('#f_servingG').value), servingLabel: $('#f_servingLabel').value.trim(), packG: num($('#f_packG').value),
    label: {basis: F.basis, unit: F.unit, values: printed}, source: F.source, photo: F.photo};
  const back = F.returnTo, isNew = F.isNew;
  await saveDoc('foods', food);
  toast(`${isNew ? 'Saved' : 'Updated'}: ${r0(food.kcal)} kcal per 100 g`);
  const item = allItems().find(i => i.id === food.id);
  if (back === 'log' && L) { reopenLog(); L.rows.push({key: uid(), item, reading: '', grams: ''}); drawLogRows(true); }
  else if (back === 'recipe' && R) { reopenRecipe(); R.ings.push({key: uid(), item, grams: ''}); drawRecipe(true); }
  else closeSheet();
}

/* --- Recipe sheet --- */
let R = null;
function openRecipeSheet(id, keep){
  const rc = id ? S.recipes.find(x => x.id === id) : null;
  const items = allItems();
  R = keep || {id: rc?.id || uid(), isNew: !rc, name: rc?.name || '', potId: rc?.potId || '', final: '',
    ings: (rc?.ingredients || []).map(g => ({key: uid(), grams: String(g.grams), item: items.find(i => i.id === g.foodId) || {kind:'food', id:g.foodId, name:g.name, per100: g.per100 || {}}}))};
  currentSheet = 'recipe';
  openSheet(R.isNew ? 'New recipe' : 'Cook again / edit recipe', `
    <label class="f">Recipe name<input id="rName" value="${esc(R.name)}" placeholder="e.g. Dal tadka"></label>
    <h3>1 · Ingredients, weighed raw</h3>
    <p class="hint">${R.isNew ? 'Tare the scale for each ingredient and type the grams.' : 'Change the amounts to what you used this time, then weigh the cooked dish again. Meals you already logged keep their old numbers.'}</p>
    <div class="section-gap" id="rIngs"></div>
    <div class="picker" id="rPicker"></div>
    <button class="btn sm ghost" data-act="newfood" data-from="recipe" style="justify-self:start">+ New ingredient</button>
    <h3>2 · Weigh the cooked dish</h3>
    <div class="fields"><label class="f">Pot<select id="rPot">${vesselOptions(R.potId, 'Weighed without the pot')}</select></label>
      <label class="f">Scale reading (g)<input class="num" id="rFinal" inputmode="decimal" value="${esc(R.final)}" placeholder="g"></label></div>
    <div class="lcd" id="rLcd"></div>
    <p class="warn" id="rErr" hidden></p>
    <div class="sheet-foot">${!R.isNew ? `<button class="btn danger" id="rDel">Delete</button>` : '<span></span>'}<button class="btn primary" id="rSave">${R.isNew ? 'Save recipe' : 'Update recipe'}</button></div>`);
  $('#rName').oninput = e => R.name = e.target.value;
  $('#rPot').onchange = e => { R.potId = e.target.value; updateRecipeCalc(); };
  $('#rFinal').oninput = e => { R.final = e.target.value; updateRecipeCalc(); };
  mountPicker($('#rPicker'), it => {
    if (it.kind === 'recipe' && it.id === R.id) return toast('A recipe can’t include itself');
    R.ings.push({key: uid(), item: it, grams: ''}); drawRecipe(true);
  }, 'Add an ingredient…');
  $('#rSave').onclick = saveRecipe;
  if ($('#rDel')) armButton($('#rDel'), async () => { await removeDoc('recipes', R.id); closeSheet(); toast('Recipe deleted'); });
  drawRecipe();
}
function drawRecipe(focusLast){
  $('#rIngs').innerHTML = R.ings.length ? R.ings.map(r => `<div class="lrow"><div><div class="nm">${esc(r.item.name)}</div><div class="meta">${r0(r.item.per100.kcal)} kcal/100 g</div></div>
      <button class="x" data-act="rrm" data-k="${r.key}" aria-label="Remove ${esc(r.item.name)}">×</button>
      <div class="ctl"><label class="small muted" for="ri-${r.key}">Grams</label><input class="inp num" id="ri-${r.key}" data-k="${r.key}" inputmode="decimal" value="${esc(r.grams)}" placeholder="g"><span class="calc" id="rc-${r.key}"></span></div></div>`).join('')
    : '<div class="empty">No ingredients yet. Search below to add the first one.</div>';
  $$('#rIngs input').forEach(inp => inp.addEventListener('input', () => { R.ings.find(x => x.key === inp.dataset.k).grams = inp.value; updateRecipeCalc(); }));
  updateRecipeCalc();
  if (focusLast && R.ings.length) $('#ri-' + R.ings[R.ings.length - 1].key)?.focus();
}
function recipeCalc(){
  const ings = R.ings.map(r => { const g = num(r.grams); return {r, g, n: g > 0 ? nutrFor(r.item.per100, g) : null}; });
  const total = sumN(ings.filter(x => x.n).map(x => x.n)), raw = ings.reduce((a, x) => a + (x.g > 0 ? x.g : 0), 0);
  const pot = vesselById(R.potId), reading = num(R.final);
  const cooked = reading != null ? reading - (pot ? num(pot.weightG) || 0 : 0) : null;
  const per100 = cooked > 0 ? Object.fromEntries(NUTR.map(k => [k, total[k] * 100 / cooked])) : null;
  return {ings, total, raw, pot, reading, cooked, per100};
}
function updateRecipeCalc(){
  const c = recipeCalc();
  c.ings.forEach(x => { const el = $('#rc-' + x.r.key); if (el) el.innerHTML = x.n ? `<b>${r0(x.n.kcal)} kcal</b>` : ''; });
  $('#rLcd').innerHTML = lcd([{label:'Raw total', v: r0(c.raw), u:'g'}, {label:'Energy', v: r0(c.total.kcal), u:'kcal'},
    ...(c.pot ? [{label:'Pot', v: r0(c.pot.weightG), u:'g'}] : []),
    {label:'Cooked', v: c.cooked > 0 ? r0(c.cooked) : '—', u:'g'}, {label:'Per 100 g cooked', v: c.per100 ? r0(c.per100.kcal) : '—', u:'kcal', big:1}]);
}
async function saveRecipe(){
  const c = recipeCalc(), name = R.name.trim();
  const err = !name ? 'Give the recipe a name.' : !c.ings.length ? 'Add at least one ingredient.' : c.ings.some(x => !x.n) ? 'Every ingredient needs its weight in grams.'
    : !(c.cooked > 0) ? (c.reading != null && c.pot ? `The reading must be more than the pot (${r0(c.pot.weightG)} g).` : 'Weigh the cooked dish and enter the reading.') : '';
  const e = $('#rErr'); e.textContent = err; e.hidden = !err; if (err) return;
  const rec = {id: R.id, name, potId: R.potId, finalReading: c.reading, cookedG: r1(c.cooked), rawG: r1(c.raw),
    ingredients: c.ings.map(x => ({foodId: x.r.item.id, name: x.r.item.name, grams: r1(x.g), per100: x.r.item.per100})),
    total: Object.fromEntries(NUTR.map(k => [k, r1(c.total[k])])), per100: Object.fromEntries(NUTR.map(k => [k, r1(c.per100[k])])), cookedAt: Date.now()};
  const isNew = R.isNew;
  await saveDoc('recipes', rec); closeSheet(); R = null;
  toast(`${isNew ? 'Recipe saved' : 'Recipe updated'}: ${r0(rec.per100.kcal)} kcal per 100 g cooked`);
}
function reopenRecipe(){ openRecipeSheet(null, R); }

/* --- Vessel sheet --- */
function openVesselSheet(id){
  const v = id ? vesselById(id) : null, vid = v?.id || uid();
  currentSheet = 'vessel';
  const val = k => esc(v?.[k] ?? '');
  openSheet(v ? 'Edit ' + (v.type || 'bowl') : 'Add a bowl, plate or pot', `
    <div class="fields">
      <label class="f full">Name<input id="v_name" value="${val('name')}" placeholder="e.g. White steel bowl"></label>
      <label class="f">Type<select id="v_type">${['bowl', 'plate', 'pot'].map(t => `<option ${t === (v?.type || 'bowl') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="f">Empty weight (g)<input class="num" id="v_weightG" inputmode="decimal" value="${val('weightG')}"></label>
    </div>
    <h3>Inside dimensions (optional)</h3>
    <p class="hint">Measure the inside, in cm. The app shows how much the bowl holds.</p>
    <div class="fields three">
      <label class="f">Top ⌀ (cm)<input class="num" id="v_topD" inputmode="decimal" value="${val('topD')}"></label>
      <label class="f">Base ⌀ (cm)<input class="num" id="v_bottomD" inputmode="decimal" value="${val('bottomD')}"></label>
      <label class="f">Depth (cm)<input class="num" id="v_depth" inputmode="decimal" value="${val('depth')}"></label>
    </div>
    <div class="lcd" id="vLcd"></div>
    <p class="warn" id="vErr" hidden></p>
    <div class="sheet-foot">${v ? `<button class="btn danger" id="vDel">Delete</button>` : '<span></span>'}<button class="btn primary" id="vSave">Save</button></div>`);
  const read = () => ({id: vid, name: $('#v_name').value.trim(), type: $('#v_type').value, weightG: num($('#v_weightG').value),
    topD: num($('#v_topD').value), bottomD: num($('#v_bottomD').value), depth: num($('#v_depth').value)});
  const upd = () => { const x = read(), vol = vesselVolume(x); $('#vLcd').innerHTML = lcd([{label:'Empty', v: x.weightG != null ? r0(x.weightG) : '—', u:'g'}, {label:'Full volume', v: vol ? r0(vol) : '—', u:'ml', big:1}]); };
  $$('#sheetBody input, #sheetBody select').forEach(i => i.addEventListener('input', upd)); upd();
  $('#vSave').onclick = async () => {
    const x = read(), err = !x.name ? 'Give it a name.' : !(x.weightG > 0) ? 'Enter its empty weight in grams.' : '';
    const e = $('#vErr'); e.textContent = err; e.hidden = !err; if (err) return;
    await saveDoc('vessels', x); closeSheet(); toast('Saved');
  };
  if ($('#vDel')) armButton($('#vDel'), async () => { await removeDoc('vessels', vid); closeSheet(); toast('Deleted'); });
}

/* ---------- updates (service worker) ---------- */
const UPD = {state: 'idle', remote: null, reg: null, msg: '', offlineReady: false};
async function setupSW(){
  if (IS_APK) {
    UPD.state = 'idle'; UPD.offlineReady = true;
    const U = window.GramUpdater;
    if (U) {
      const notice = U.updateNotice();
      if (notice === 'rolledback') toast('That update didn\u2019t start properly, so the previous version was put back.');
      else if (notice) toast('Updated to ' + notice);
      U.bootOk(APP_VERSION);
      if (navigator.onLine && !UPDATE_REPO.startsWith('OWNER')) apkCheck(true);
    }
    renderAll(); return;
  }
  if (!('serviceWorker' in navigator)) { UPD.state = 'unsupported'; return; }
  if (!window.isSecureContext) { UPD.state = 'insecure'; renderAll(); return; }
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    UPD.reg = reg;
    const watch = w => w && w.addEventListener('statechange', () => {
      if (w.state === 'installed') { if (navigator.serviceWorker.controller) { UPD.state = 'ready'; } else { UPD.offlineReady = true; } renderAll(); }
      if (w.state === 'redundant' && UPD.state === 'downloading') { UPD.state = 'error'; UPD.msg = 'The download stopped. Check your internet and try again.'; renderAll(); }
    });
    if (reg.waiting && navigator.serviceWorker.controller) UPD.state = 'ready';
    if (reg.installing) { if (navigator.serviceWorker.controller) UPD.state = 'downloading'; watch(reg.installing); }
    reg.addEventListener('updatefound', () => { if (navigator.serviceWorker.controller) UPD.state = 'downloading'; watch(reg.installing); renderAll(); });
    if (reg.active) UPD.offlineReady = true;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading && UPD.installing) { reloading = true; location.reload(); } });
    renderAll();
    if (navigator.onLine) checkUpdates(true);
  } catch (e) { console.error(e); UPD.state = 'error'; UPD.msg = 'Offline mode couldn’t be set up in this browser.'; renderAll(); }
}
/* APK updates: the Android shell downloads only the changed web files from GitHub, then reloads into them. */
let apkSilent = false;
function apkCheck(silent){
  if (!window.GramUpdater) return;
  if (!navigator.onLine) { if (!silent) { UPD.state = 'error'; UPD.msg = 'You\u2019re offline. Connect to the internet to check for updates.'; renderAll(); } return; }
  apkSilent = !!silent;
  if (!silent) { UPD.state = 'checking'; UPD.msg = ''; renderAll(); }
  GramUpdater.checkUpdate(UPDATE_MANIFEST);
}
function apkDownload(){ UPD.state = 'downloading'; UPD.done = 0; UPD.total = UPD.remote?.bytes || 0; renderAll(); GramUpdater.downloadUpdate(); }
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
window.gtNative = m => {
  const silent = apkSilent;
  if (m.state === 'checking') { if (silent) return; UPD.state = 'checking'; }
  else if (m.state === 'latest') { UPD.state = silent ? 'idle' : 'latest'; apkSilent = false; }
  else if (m.state === 'available') { UPD.state = 'available'; UPD.remote = {version: m.version, notes: m.notes || [], bytes: m.bytes || 0}; UPD.msg = ''; apkSilent = false; }
  else if (m.state === 'needs-app') { UPD.state = 'needs-app'; UPD.remote = {version: m.version}; apkSilent = false; }
  else if (m.state === 'error') { UPD.state = silent ? 'idle' : 'error'; UPD.msg = m.message || ''; apkSilent = false; }
  else if (m.state === 'downloading') {
    UPD.state = 'downloading'; UPD.done = m.done; UPD.total = m.total;
    const bar = $('#updBar');
    if (bar) { const pct = m.total ? Math.min(100, m.done / m.total * 100) : 100; $('i', bar).style.width = pct.toFixed(0) + '%'; $('#updTxt').textContent = `Downloading ${kb(m.done)} of ${kb(m.total)}\u2026`; return; }
  }
  else if (m.state === 'ready') { UPD.state = 'applying'; renderAll(); setTimeout(() => GramUpdater.applyUpdate(), 350); return; }
  renderAll();
};

async function checkUpdates(silent){
  if (!navigator.onLine) { if (!silent) { UPD.msg = 'You’re offline. Connect to the internet to check for updates.'; renderAll(); } return; }
  if (UPD.state === 'downloading' || UPD.state === 'ready') return;
  if (!silent) { UPD.state = 'checking'; renderAll(); }
  try {
    const r = await fetch('version.json?t=' + Date.now(), {cache: 'no-store'});
    if (!r.ok) throw new Error('http ' + r.status);
    UPD.remote = await r.json();
    if (cmpVer(UPD.remote.version, APP_VERSION) > 0) { UPD.state = 'available'; UPD.msg = ''; }
    else { UPD.state = 'latest'; UPD.msg = ''; }
  } catch (e) { if (!silent) { UPD.state = 'error'; UPD.msg = 'Couldn’t reach the update server. Try again later.'; } else UPD.state = 'idle'; }
  renderAll();
}
async function downloadUpdate(){
  if (!UPD.reg) return;
  UPD.state = 'downloading'; renderAll();
  try {
    await UPD.reg.update();
    if (UPD.reg.waiting) { UPD.state = 'ready'; renderAll(); }
    else if (!UPD.reg.installing) { UPD.state = 'error'; UPD.msg = 'No new files were found on the server yet. Try again in a minute.'; renderAll(); }
  } catch (e) { UPD.state = 'error'; UPD.msg = 'The download failed. Check your internet and try again.'; renderAll(); }
}
function installUpdate(){
  const w = UPD.reg?.waiting; if (!w) return;
  UPD.installing = true; w.postMessage('SKIP_WAITING');
}

/* ---------- backup / export ---------- */
function downloadFile(name, text, type){
  if (IS_APK) {
    try { return GramAndroid.saveFile(name, type, text) === 'ok' ? `Saved to Downloads/Gram Tracker: ${name}` : 'Couldn’t save the file. Check storage space.'; }
    catch (e) { console.error(e); return 'Couldn’t save the file.'; }
  }
  const url = URL.createObjectURL(new Blob([text], {type}));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'Downloaded ' + name;
}
async function exportBackup(){
  const data = {app: 'gram-tracker', appVersion: APP_VERSION, exportedAt: new Date().toISOString()};
  for (const s of DB.STORES) data[s] = await DB.all(s);
  const msg = downloadFile(`gram-tracker-backup-${todayStr()}.json`, JSON.stringify(data, null, 1), 'application/json');
  try { localStorage.setItem('gt.lastBackup', todayStr()); } catch {}
  toast(msg); renderAll();
}
function exportCsv(){
  const rows = [['date', 'meal', 'food', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'bowl', 'scale_reading_g']];
  Object.keys(S.days).sort().forEach(d => dayEntries(d).forEach(e => rows.push([d, e.meal, e.name, e.grams, e.kcal, e.protein, e.carbs, e.fat, e.fiber ?? '', e.sugar ?? '', e.sodium ?? '', e.vesselName || '', e.gross ?? ''])));
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
  toast(downloadFile(`gram-tracker-log-${todayStr()}.csv`, csv, 'text/csv'));
}
let pendingRestore = null;
async function readBackup(file){
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'gram-tracker' || !Array.isArray(data.foods)) throw new Error('not a backup');
    pendingRestore = data;
  } catch { pendingRestore = null; toast('That file isn’t a Gram Tracker backup.'); }
  renderSettings();
}
async function applyRestore(){
  const d = pendingRestore; if (!d) return;
  try { await DB.replaceAll(d); pendingRestore = null; await load(); toast('Backup restored'); }
  catch (e) { console.error(e); toast('Restore failed. Your current data was kept.'); }
}

/* ---------- settings view ---------- */
function renderSettings(){
  const s = S.settings;
  let last = ''; try { last = localStorage.getItem('gt.lastBackup') || ''; } catch {}
  const counts = `${S.foods.length} foods · ${S.recipes.length} recipes · ${S.vessels.length} bowls · ${Object.keys(S.days).length} days logged`;
  const u = UPD, remote = u.remote;
  let upd = '';
  if (IS_APK && u.state === 'available') upd = `<div class="kv"><span>New version</span><b>${esc(remote.version)}</b></div>${(remote.notes || []).length ? `<ul class="notes">${remote.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}<button class="btn primary" data-act="upd-download">Update now${remote.bytes ? ` (${kb(remote.bytes)})` : ''}</button>`;
  else if (IS_APK && u.state === 'downloading') { const pct = u.total ? Math.min(100, u.done / u.total * 100) : 0;
    upd = `<p class="hint" id="updTxt">Downloading ${kb(u.done || 0)} of ${kb(u.total || 0)}\u2026</p><div class="progress" id="updBar"><i style="width:${pct.toFixed(0)}%"></i></div>`; }
  else if (IS_APK && u.state === 'applying') upd = `<p class="hint">Installing\u2026 the app will refresh in a moment.</p><div class="progress"><i style="width:100%"></i></div>`;
  else if (IS_APK && u.state === 'needs-app') upd = `<p class="hint">Version ${esc(remote?.version || '')} needs a new app file. Ask Claude for the latest APK and install it once; after that, updates work from here again.</p>`;
  else if (u.state === 'insecure' || u.state === 'unsupported') upd = `<p class="hint">Offline mode and updates need the app to be opened from its https:// address. Right now it’s opened from a plain http:// link, so it won’t work without your PC.</p>`;
  else if (u.state === 'available') upd = `<div class="kv"><span>New version</span><b>${esc(remote.version)}</b></div>${(remote.notes || []).length ? `<ul class="notes">${remote.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}<button class="btn primary" data-act="upd-download">Download update</button>`;
  else if (u.state === 'downloading') upd = `<p class="hint">Downloading the update… keep the app open.</p><div class="progress"><i style="width:60%"></i></div>`;
  else if (u.state === 'ready') upd = `<p class="hint">Update${remote ? ' ' + esc(remote.version) : ''} is downloaded. Installing restarts the app; your data stays.</p><button class="btn primary" data-act="upd-install">Install update and restart</button>`;
  else upd = `<p class="hint">${u.state === 'checking' ? 'Checking…' : u.state === 'latest' ? '<span class="ok">You have the latest version.</span>' : esc(u.msg || 'Updates download only when you ask. Everything else works offline.')}</p><button class="btn" data-act="upd-check" ${u.state === 'checking' ? 'disabled' : ''}>Check for updates</button>`;
  if (u.msg && (u.state === 'error' || u.state === 'available' || u.state === 'ready')) upd += `<p class="warn">${esc(u.msg)}</p>`;

  $('#view-settings').innerHTML = `
    <div class="set-sec"><h3>Daily targets</h3><div class="card">
      <div class="fields">
        <label class="f">Energy (kcal)<input class="num" id="s_kcal" inputmode="decimal" value="${esc(s.kcal)}"></label>
        <label class="f">Protein (g)<input class="num" id="s_protein" inputmode="decimal" value="${esc(s.protein)}"></label>
        <label class="f">Carbs (g)<input class="num" id="s_carbs" inputmode="decimal" value="${esc(s.carbs)}"></label>
        <label class="f">Fat (g)<input class="num" id="s_fat" inputmode="decimal" value="${esc(s.fat)}"></label>
      </div><button class="btn primary" data-act="save-targets" style="justify-self:start">Save targets</button></div></div>

    <div class="set-sec"><h3>App updates</h3><div class="card">
      <div class="kv"><span>Installed version</span><b>${APP_VERSION}</b></div>
      ${WHATS_NEW.length ? `<details class="raw"><summary>What’s new in ${APP_VERSION}</summary><ul class="notes" style="margin-top:6px">${WHATS_NEW.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
      <div class="kv"><span>Works offline</span><span class="${u.offlineReady ? 'ok' : 'muted'}">${u.offlineReady ? 'Yes, everything is on this phone' : u.state === 'insecure' ? 'No (http link)' : 'Setting up…'}</span></div>
      ${upd}</div></div>

    <div class="set-sec"><h3>Your data</h3><div class="card">
      <p class="hint">${counts}. Stored only on this phone. ${last ? 'Last backup: ' + esc(last) + '.' : 'No backup yet: download one now and then.'}</p>
      <div class="row-actions"><button class="btn primary" data-act="backup">Download backup</button><button class="btn" data-act="csv">Download log (CSV)</button></div>
      <div class="row-actions"><span class="btn filebtn">Restore from backup<input type="file" id="restoreFile" accept="application/json,.json" aria-label="Choose a backup file"></span></div>
      ${pendingRestore ? `<div class="check bad">This replaces everything on this phone with the backup from ${esc((pendingRestore.exportedAt || '').slice(0, 10))} (${(pendingRestore.foods || []).length} foods, ${(pendingRestore.days || []).length} days).
        <div class="row-actions" style="margin-top:8px"><button class="btn sm danger armed" data-act="restore-yes">Replace my data</button><button class="btn sm" data-act="restore-no">Cancel</button></div></div>` : ''}
      <button class="btn danger sm" id="wipeBtn" style="justify-self:start">Delete all data</button>
    </div></div>
    <p class="hint" style="margin-top:22px">Gram Tracker ${APP_VERSION}. No account needed. The internet is used only to check for updates.</p>`;
  $('#restoreFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) readBackup(f); };
  armButton($('#wipeBtn'), async () => { await DB.clearAll(); await load(); toast('All data deleted'); }, 'Tap again: delete everything');
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-tab]');
  if (pendingDel && !(t && t.dataset.act === 'delentry')) { pendingDel = null; if (S.view === 'today') renderToday(); }
  if (!t) { if (e.target === $('#sheet')) closeSheet(); return; }
  if (t.dataset.tab) { S.view = t.dataset.tab; renderAll(); window.scrollTo(0, 0); return; }
  const a = t.dataset.act, id = t.dataset.id;
  if (a === 'close') closeSheet();
  else if (a === 'log') openLogSheet();
  else if (a === 'day') { const n = addDays(S.date, +t.dataset.d); if (n <= todayStr()) { S.date = n; renderToday(); } }
  else if (a === 'delentry') {
    if (pendingDel !== id) { pendingDel = id; renderToday(); return; }
    pendingDel = null;
    saveDoc('days', {id: S.date, date: S.date, entries: dayEntries(S.date).filter(x => x.id !== id)}); toast('Entry deleted');
  }
  else if (a === 'ftab') { S.foodsTab = t.dataset.v; renderFoods(); }
  else if (a === 'newfood') openFoodSheet(null, {scan: !!t.dataset.scan, returnTo: t.dataset.from || null});
  else if (a === 'editfood') openFoodSheet(id);
  else if (a === 'newrecipe') openRecipeSheet(null);
  else if (a === 'editrecipe') openRecipeSheet(id);
  else if (a === 'newvessel') openVesselSheet(null);
  else if (a === 'editvessel') openVesselSheet(id);
  else if (a === 'lrm') { L.rows = L.rows.filter(r => r.key !== t.dataset.k); drawLogRows(); }
  else if (a === 'rrm') { R.ings = R.ings.filter(r => r.key !== t.dataset.k); drawRecipe(); }
  else if (a === 'serv') { const r = L.rows.find(x => x.key === t.dataset.k); r.grams = t.dataset.g; drawLogRows(); }
  else if (a === 'save-targets') {
    const o = {id: 'settings'}; ['kcal', 'protein', 'carbs', 'fat'].forEach(k => o[k] = num($('#s_' + k).value) ?? DEFAULT_SETTINGS[k]);
    saveDoc('meta', o); toast('Targets saved');
  }
  else if (a === 'upd-check') IS_APK ? apkCheck(false) : checkUpdates(false);
  else if (a === 'upd-download') IS_APK ? apkDownload() : downloadUpdate();
  else if (a === 'upd-install') installUpdate();
  else if (a === 'backup') exportBackup();
  else if (a === 'csv') exportCsv();
  else if (a === 'restore-yes') applyRestore();
  else if (a === 'restore-no') { pendingRestore = null; renderSettings(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.item.clickable')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('input', e => { if (e.target.id === 'foodsQ') { S.foodsQ = e.target.value; renderFoods(); } });
window.addEventListener('online', renderAll);
window.addEventListener('offline', renderAll);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.date !== todayStr() && S.date === addDays(todayStr(), -1) && $('#sheet').hidden) { S.date = todayStr(); renderAll(); } });

/* Android back button: close a sheet first, then return to Today, else let Android close the app. */
window.gtBack = () => {
  if (!$('#sheet').hidden) { closeSheet(); return true; }
  if (S.view !== 'today') { S.view = 'today'; renderAll(); window.scrollTo(0, 0); return true; }
  return false;
};

/* Release notes of the installed version, read from the app's own files (works offline). */
let WHATS_NEW = [];
fetch('version.json').then(r => r.json()).then(v => { WHATS_NEW = v.notes || []; if (S.view === 'settings') renderSettings(); }).catch(() => {});

load().then(setupSW);
