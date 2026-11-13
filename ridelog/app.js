'use strict';
/* RIDELOG — личный учёт смен, денег и мотоцикла. Все данные хранятся локально (localStorage). */

const APP_VERSION = '0.2.0';
const KEY = 'ridelog_private_v1';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------- Утилиты ----------
const dateKey = d => d.toLocaleDateString('en-CA'); // YYYY-MM-DD в локальном часовом поясе
const today = () => dateKey(new Date());
const money = n => '₩' + Math.round(Number(n) || 0).toLocaleString('en-US');
const fmtDate = s => new Date(s + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const num = v => Number(v) || 0;
const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------- Хранилище ----------
const freshData = () => ({ entries: [], shifts: [], services: [], serviceLog: null, odo: 0, settings: {}, activeSession: null });

function normalize(obj) {
  const d = { ...freshData(), ...(obj || {}) };
  for (const k of ['entries', 'shifts', 'services']) if (!Array.isArray(d[k])) d[k] = [];
  d.settings = d.settings && typeof d.settings === 'object' ? d.settings : {};
  // Миграция v0.1: история обслуживания была тем же списком, что и интервалы.
  if (!Array.isArray(d.serviceLog)) {
    d.serviceLog = d.services.map(s => ({ id: uid(), serviceId: s.id, name: s.name, atOdo: num(s.atOdo), cost: num(s.cost), date: s.date || today() }));
  }
  return d;
}

function load() {
  try { return normalize(JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { return normalize({}); }
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch { toast('Не удалось сохранить: память браузера переполнена'); }
}

function save() { persist(); renderAll(); }

let data = load();
let watchId = null, lastPosition = null, sessionTimer = null, wakeLock = null;
let calDate = new Date(), selectedDay = today();

// ---------- Агрегаты ----------
const shiftIncome = s => num(s.income) + num(s.bonus);
const incomeOf = (entries, shifts) => sum(entries.filter(x => x.type === 'income'), x => num(x.amount)) + sum(shifts, shiftIncome);
const expenseOf = entries => sum(entries.filter(x => x.type === 'expense'), x => num(x.amount));
const dayEntries = d => data.entries.filter(x => x.date === d);
const dayShifts = d => data.shifts.filter(x => x.date === d);

function totals(entries, shifts) {
  return {
    income: incomeOf(entries, shifts),
    expense: expenseOf(entries),
    orders: sum(shifts, x => num(x.orders)),
    km: sum(shifts, x => num(x.km)),
    hours: sum(shifts, x => num(x.duration)) / 3600000,
  };
}
const dayTotals = d => totals(dayEntries(d), dayShifts(d));

function periodData(days) {
  if (days === 'all') return { entries: data.entries, shifts: data.shifts };
  const from = new Date();
  from.setDate(from.getDate() - (Number(days) - 1));
  const cutoff = dateKey(from);
  return { entries: data.entries.filter(x => x.date >= cutoff), shifts: data.shifts.filter(x => x.date >= cutoff) };
}

// ---------- Навигация ----------
function setView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'ai') renderAI();
  if (name === 'calendar') renderCalendar();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
$$('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$$('[data-go]').forEach(b => b.addEventListener('click', () => setView(b.dataset.go)));
$('#settingsBtn').onclick = () => setView('settings');

function renderHeaderDate() {
  $('#todayLabel').textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long' }).toUpperCase();
  $('#dateChip').textContent = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

// ---------- Обзор ----------
function entryRow(x, { deletable = false } = {}) {
  const sign = x.type === 'income' ? '+' : '−';
  const meta = [fmtDate(x.date), x.source, x.note].filter(Boolean).map(esc).join(' · ');
  return `<div class="entry-row"><div class="entry-main"><b>${esc(x.category)}</b><small>${meta}</small></div>`
    + `<span class="entry-amount ${x.type === 'income' ? 'positive' : 'negative'}">${sign}${money(x.amount)}</span>`
    + (deletable ? `<button class="text-btn danger" data-del-entry="${esc(x.id)}" aria-label="Удалить">×</button>` : '')
    + `</div>`;
}

function renderDashboard() {
  renderHeaderDate();
  const t = dayTotals(today());
  $('#todayNet').textContent = money(t.income - t.expense);
  $('#todayIncome').textContent = money(t.income);
  $('#todayExpenses').textContent = money(t.expense);
  $('#todayOrders').textContent = t.orders;
  $('#todayKm').textContent = t.km.toFixed(1) + ' км';
  $('#todayHours').textContent = t.hours.toFixed(1) + ' ч';
  $('#todayPerHour').textContent = money(t.hours ? t.income / t.hours : 0);
  const s = data.activeSession;
  $('#liveDot').textContent = s ? (s.end ? '● СМЕНА НА ПАУЗЕ' : '● GPS ACTIVE') : '● OFFLINE';
  $('#liveDot').style.color = s ? (s.end ? 'var(--orange2)' : 'var(--green)') : 'var(--muted)';

  const recent = [
    ...data.entries,
    ...data.shifts.map(x => ({ ...x, type: 'income', category: 'Рабочая смена', amount: shiftIncome(x), source: x.platform, note: `${num(x.orders)} заказов` })),
  ].sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date)).slice(0, 5);
  $('#recentList').innerHTML = recent.length ? recent.map(x => entryRow(x)).join('') : 'Пока нет записей. Добавь первый доход или расход.';
}

// ---------- Финансы ----------
const expenseCats = ['Бензин', 'Еда', 'Сигареты', 'Парковка', 'Мойка', 'Ремонт', 'Масло', 'Шины', 'Аренда', 'Телефон', 'Страховка', 'Другое'];
const incomeCats = ['Coupang Eats', 'Baemin Connect', 'Бонусы / миссии', 'Другая работа', 'Другое'];

function renderFinance() {
  const income = incomeOf(data.entries, data.shifts), expenses = expenseOf(data.entries);
  $('#allIncome').textContent = money(income);
  $('#allExpenses').textContent = money(expenses);
  $('#allNet').textContent = money(income - expenses);
  const filter = $('#filterType').value;
  const list = data.entries.filter(x => filter === 'all' || x.type === filter)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  $('#entryList').innerHTML = list.length ? list.map(x => entryRow(x, { deletable: true })).join('') : '<div class="list-empty">Записей пока нет.</div>';
}

function updateCats() {
  const type = $('input[name="type"]:checked').value;
  $('#entryCategory').innerHTML = (type === 'expense' ? expenseCats : incomeCats).map(x => `<option>${x}</option>`).join('');
}
$$('input[name="type"]').forEach(x => x.onchange = updateCats);
updateCats();
$('#entryForm').elements.date.value = today();

$('#entryForm').onsubmit = e => {
  e.preventDefault();
  const form = e.target, f = new FormData(form);
  const amount = num(f.get('amount'));
  if (amount <= 0) return toast('Укажи сумму больше нуля');
  data.entries.push({
    id: uid(), type: f.get('type'), category: f.get('category'), amount,
    date: f.get('date') || today(), source: f.get('source'), note: String(f.get('note') || '').trim(),
    createdAt: new Date().toISOString(),
  });
  form.elements.amount.value = '';
  form.elements.note.value = '';
  save();
  toast('Запись сохранена');
};
$('#filterType').onchange = renderFinance;
$('#addEntryTop').onclick = () => { setView('finance'); $('#entryForm').scrollIntoView({ behavior: 'smooth' }); };

// Делегирование удаления (финансы, календарь)
document.addEventListener('click', e => {
  const del = e.target.closest('[data-del-entry]');
  if (del && confirm('Удалить эту запись?')) {
    data.entries = data.entries.filter(x => x.id !== del.dataset.delEntry);
    save();
    toast('Запись удалена');
  }
  const delShift = e.target.closest('[data-del-shift]');
  if (delShift && confirm('Удалить эту смену? Километры в одометре не изменятся.')) {
    data.shifts = data.shifts.filter(x => x.id !== delShift.dataset.delShift);
    save();
    toast('Смена удалена');
  }
});

// ---------- GPS-смена ----------
const MAX_ACCURACY_M = 80;    // точки хуже этой точности игнорируем
const MIN_STEP_KM = 0.008;    // шум на месте
const MAX_SPEED_KMH = 160;    // всё, что быстрее, — скачок GPS

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function onPosition(pos) {
  const s = data.activeSession;
  if (!s || s.end) return;
  const c = { lat: pos.coords.latitude, lon: pos.coords.longitude, ts: pos.timestamp, accuracy: pos.coords.accuracy };
  $('#gpsStatus').textContent = c.accuracy > MAX_ACCURACY_M ? `Слабый (±${Math.round(c.accuracy)} м)` : 'Активен';
  if (c.accuracy > MAX_ACCURACY_M) return;
  if (!lastPosition) {
    lastPosition = c;
    s.coords.push(c);
    s.points = s.coords.length;
    persist();
    updateSessionUI();
    return;
  }
  const d = distance(lastPosition.lat, lastPosition.lon, c.lat, c.lon);
  const hours = Math.max((c.ts - lastPosition.ts) / 3600000, 1 / 3600);
  if (d < MIN_STEP_KM) return;                     // стоим на месте — точку не меняем
  if (d / hours > MAX_SPEED_KMH) return;           // нереальная скорость — скачок сигнала
  s.km += d;
  s.coords.push(c);
  s.points = s.coords.length;
  lastPosition = c;
  persist();
  updateSessionUI();
}

function onGeoError(err) {
  const msgs = { 1: 'Нет разрешения', 2: 'GPS недоступен', 3: 'Тайм-аут GPS' };
  const msg = msgs[err.code] || 'Ошибка';
  $('#gpsStatus').textContent = msg;
  if (err.code === 1) toast(msg + ' — разреши геолокацию в настройках Safari'); // кратковременные сбои сигнала не показываем
}

function startTracking() {
  stopTracking();
  const coords = data.activeSession?.coords || [];
  lastPosition = coords.length ? coords[coords.length - 1] : null;
  if (navigator.geolocation) {
    $('#gpsStatus').textContent = 'Запрос доступа…';
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  } else {
    $('#gpsStatus').textContent = 'Нет GPS';
  }
  sessionTimer = setInterval(updateSessionUI, 1000);
  requestWakeLock();
}

function stopTracking() {
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(sessionTimer);
  sessionTimer = null;
  releaseWakeLock();
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* не поддерживается или отказано */ }
}
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderDashboard();
    if (data.activeSession && !data.activeSession.end) requestWakeLock();
  }
});

function sessionDuration(s) {
  if (!s) return 0;
  const end = s.end ? new Date(s.end).getTime() : Date.now();
  return Math.max(0, end - new Date(s.start).getTime() - num(s.pausedMs));
}

function startSession() {
  if (data.activeSession) return;
  if (!navigator.geolocation) toast('Геолокация не поддерживается — время смены всё равно будет записано');
  data.activeSession = { start: new Date().toISOString(), end: null, pausedMs: 0, km: 0, points: 0, coords: [] };
  save();
  startTracking();
  toast('Смена началась');
}

function finishSession() {
  const s = data.activeSession;
  if (!s || s.end) return;
  s.end = new Date().toISOString();
  stopTracking();
  save();
  $('#shiftForm').scrollIntoView({ behavior: 'smooth' });
  toast('GPS остановлен. Заполни итоги смены.');
}

function resumeSession() {
  const s = data.activeSession;
  if (!s || !s.end) return;
  s.pausedMs = num(s.pausedMs) + (Date.now() - new Date(s.end).getTime());
  s.end = null;
  save();
  startTracking();
  toast('Смена продолжается');
}

function cancelSession() {
  if (!data.activeSession || !confirm('Отменить текущую смену? Время и GPS-километры не сохранятся.')) return;
  stopTracking();
  data.activeSession = null;
  lastPosition = null;
  save();
  toast('Смена отменена');
}

function fmtDuration(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), sec = Math.floor(ms % 60000 / 1000);
  return [h, m, sec].map(x => String(x).padStart(2, '0')).join(':');
}

function updateSessionUI() {
  const s = data.activeSession, active = !!s, paused = !!s?.end;
  $('#startWork').classList.toggle('hidden', active);
  $('#finishWork').classList.toggle('hidden', !active || paused);
  $('#resumeWork').classList.toggle('hidden', !paused);
  $('#cancelWork').classList.toggle('hidden', !active);
  $('#workStatus').textContent = !active ? 'Смена не начата' : paused ? 'Смена завершена — сохрани итоги' : 'Смена идёт';
  $('#sessionKm').innerHTML = (s ? s.km : 0).toFixed(2) + ' <small>км</small>';
  $('#gpsPoints').textContent = s ? s.points : 0;
  $('#sessionStart').textContent = s ? new Date(s.start).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';
  $('#sessionTime').textContent = fmtDuration(sessionDuration(s));
  if (!active) $('#gpsStatus').textContent = 'Ожидание';
  else if (paused) $('#gpsStatus').textContent = 'Остановлен';
  $('#routeInfo').textContent = s
    ? `Записано ${s.points} GPS-точек. Пройдено ${s.km.toFixed(2)} км. Маршрут хранится только на этом устройстве.`
    : 'Маршрут появится после запуска GPS.';
  renderRoute(s?.coords || []);
}

function renderRoute(coords) {
  const box = $('#routeMap');
  if (coords.length < 2) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  if (box.dataset.count === String(coords.length)) return; // ничего не изменилось
  box.dataset.count = coords.length;
  const W = 320, H = 200, P = 14;
  const lat0 = coords[0].lat * Math.PI / 180;
  const pts = coords.map(c => [c.lon * Math.cos(lat0), c.lat]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((W - 2 * P) / ((maxX - minX) || 1e-6), (H - 2 * P) / ((maxY - minY) || 1e-6));
  const ox = (W - (maxX - minX) * scale) / 2, oy = (H - (maxY - minY) * scale) / 2;
  const xy = pts.map(([x, y]) => [ox + (x - minX) * scale, H - (oy + (y - minY) * scale)]);
  const path = xy.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const [sx, sy] = xy[0], [ex, ey] = xy[xy.length - 1];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Схема маршрута смены">
    <polyline points="${path}" fill="none" stroke="#ff791f" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${sx}" cy="${sy}" r="5" fill="#42c98a"/><circle cx="${ex}" cy="${ey}" r="5" fill="#f4f4f5" stroke="#ff791f" stroke-width="2"/></svg>`;
  box.classList.remove('hidden');
}

$('#startWork').onclick = startSession;
$('#finishWork').onclick = finishSession;
$('#resumeWork').onclick = resumeSession;
$('#cancelWork').onclick = cancelSession;

$('#shiftForm').onsubmit = e => {
  e.preventDefault();
  const form = e.target, f = new FormData(form), s = data.activeSession;
  const income = num(f.get('income')), orders = num(f.get('orders')), bonus = num(f.get('bonus'));
  if (!s && !income && !orders && !bonus) return toast('Нет активной смены — укажи хотя бы заказы или заработок');
  const now = new Date().toISOString();
  const end = s?.end || now;
  const km = num(s?.km);
  data.shifts.push({
    id: uid(),
    date: s ? dateKey(new Date(s.start)) : today(), // смена после полуночи остаётся в дне начала
    start: s?.start || now, end,
    duration: sessionDuration(s ? { ...s, end } : null),
    km, points: num(s?.points), orders, income, bonus,
    platform: f.get('platform'), note: String(f.get('note') || '').trim(),
    createdAt: now, coords: s?.coords || [],
  });
  if (km && f.get('addToOdo')) data.odo = Math.round((num(data.odo) + km) * 10) / 10;
  stopTracking();
  data.activeSession = null;
  lastPosition = null;
  form.reset();
  save();
  toast('Смена сохранена');
};

// ---------- Календарь ----------
function renderCalendar() {
  const y = calDate.getFullYear(), m = calDate.getMonth();
  $('#monthTitle').textContent = calDate.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const t0 = today();
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m, i - offset + 1);
    const key = dateKey(d), t = dayTotals(key), has = t.income || t.expense || t.orders;
    const cls = ['day-cell', d.getMonth() !== m && 'muted', key === selectedDay && 'selected', key === t0 && 'today'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-date="${key}">${d.getDate()}${has ? `<em class="${t.income - t.expense < 0 ? 'loss' : ''}"></em>` : ''}</button>`;
  }
  $('#calendarGrid').innerHTML = html;
  renderSelectedDay();
}
$('#calendarGrid').onclick = e => {
  const b = e.target.closest('.day-cell');
  if (!b) return;
  selectedDay = b.dataset.date;
  const d = new Date(selectedDay + 'T12:00:00');
  if (d.getMonth() !== calDate.getMonth()) calDate = new Date(d.getFullYear(), d.getMonth(), 1);
  renderCalendar();
};

function renderSelectedDay() {
  const t = dayTotals(selectedDay), sh = dayShifts(selectedDay), en = dayEntries(selectedDay);
  $('#selectedDateTitle').textContent = fmtDate(selectedDay);
  const shiftsHtml = sh.map(s => `<div class="entry-row"><div class="entry-main"><b>${esc(s.platform)} · ${num(s.orders)} заказов</b>`
    + `<small>${num(s.km).toFixed(1)} км · ${(num(s.duration) / 3600000).toFixed(1)} ч${s.note ? ' · ' + esc(s.note) : ''}</small></div>`
    + `<b class="positive">+${money(shiftIncome(s))}</b><button class="text-btn danger" data-del-shift="${esc(s.id)}" aria-label="Удалить смену">×</button></div>`).join('');
  $('#dayDetails').innerHTML = `<div class="report-grid">
    <div class="report-item"><small>Чистый результат</small><b>${money(t.income - t.expense)}</b></div>
    <div class="report-item"><small>Доход</small><b>${money(t.income)}</b></div>
    <div class="report-item"><small>Расходы</small><b>${money(t.expense)}</b></div>
    <div class="report-item"><small>Заказы / километры</small><b>${t.orders} / ${t.km.toFixed(1)}</b></div></div>`
    + shiftsHtml + en.map(x => entryRow(x, { deletable: true })).join('')
    + (!sh.length && !en.length ? '<div class="list-empty">В этот день записей нет.</div>' : '');
}
$('#prevMonth').onclick = () => { calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1); renderCalendar(); };
$('#nextMonth').onclick = () => { calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1); renderCalendar(); };

// ---------- Мотоцикл ----------
function serviceStatus(s) {
  const since = num(data.odo) - num(s.atOdo);
  if (!s.interval) return { left: null, pct: 0, since };
  const left = s.interval - since;
  return { left, pct: Math.max(0, Math.min(100, since / s.interval * 100)), since };
}

function renderBike() {
  $('#bikeOdo').textContent = num(data.odo).toLocaleString('ru-RU');
  const items = [...data.services].sort((a, b) => (serviceStatus(a).left ?? Infinity) - (serviceStatus(b).left ?? Infinity));
  $('#maintenanceList').innerHTML = items.length ? items.map(s => {
    const { left, pct } = serviceStatus(s);
    const leftTxt = left === null ? 'Без интервала' : left > 0 ? `Осталось ${left.toLocaleString('ru-RU')} км` : `Просрочено на ${(-left).toLocaleString('ru-RU')} км`;
    const badge = left === null ? '—' : left <= 0 ? 'Пора!' : left.toLocaleString('ru-RU') + ' км';
    return `<div class="service-row"><div class="entry-main"><b>${esc(s.name)}</b>`
      + `<small>${leftTxt}${s.interval ? ` · интервал ${num(s.interval).toLocaleString('ru-RU')} км` : ''} · последнее при ${num(s.atOdo).toLocaleString('ru-RU')} км</small>`
      + `<div class="service-progress"><i style="width:${pct}%;${left !== null && left <= 0 ? 'background:var(--red)' : ''}"></i></div></div>`
      + `<div class="service-actions"><span class="status-badge ${left !== null && left <= 200 ? 'orange' : ''}">${badge}</span>`
      + `<div class="row-actions"><button class="text-btn" data-service-done="${esc(s.id)}">✓ Сделано</button><button class="text-btn danger" data-service-del="${esc(s.id)}" aria-label="Удалить">×</button></div></div></div>`;
  }).join('') : '<div class="list-empty">Добавь масло, тормозные колодки, ремень, шины и другие работы.</div>';

  const log = [...data.serviceLog].sort((a, b) => b.date.localeCompare(a.date) || num(b.atOdo) - num(a.atOdo));
  $('#serviceHistory').innerHTML = log.length ? log.map(l => `<div class="entry-row"><div class="entry-main"><b>${esc(l.name)}</b>`
    + `<small>${fmtDate(l.date)} · при пробеге ${num(l.atOdo).toLocaleString('ru-RU')} км</small></div><b>${l.cost ? money(l.cost) : '—'}</b></div>`).join('')
    : 'Пока нет записей о ремонте.';
  const total = sum(data.serviceLog, l => num(l.cost));
  $('#serviceTotal').textContent = total ? 'ВСЕГО ' + money(total) : '';
}

$('#odoForm').onsubmit = e => {
  e.preventDefault();
  const v = num(new FormData(e.target).get('odo'));
  if (v < num(data.odo) && !confirm('Пробег меньше сохранённого. Всё равно заменить?')) return;
  data.odo = v;
  e.target.reset();
  save();
  toast('Пробег обновлён');
};

const dlg = $('#serviceDialog'), serviceForm = $('#serviceForm');
function openServiceDialog(service) {
  serviceForm.reset();
  const el = serviceForm.elements;
  el.serviceId.value = service?.id || '';
  el.name.value = service?.name || '';
  el.interval.value = service?.interval || '';
  el.atOdo.value = data.odo || '';
  $('#serviceDialogTitle').textContent = service ? 'Отметить обслуживание' : 'Добавить обслуживание';
  dlg.showModal();
}
$('#addService').onclick = () => openServiceDialog(null);

serviceForm.onsubmit = e => {
  if (e.submitter?.value === 'cancel') return; // method="dialog" закроет окно
  e.preventDefault();
  const f = new FormData(serviceForm);
  const name = String(f.get('name')).trim();
  const interval = num(f.get('interval')), cost = num(f.get('cost'));
  const atOdo = f.get('atOdo') === '' ? num(data.odo) : num(f.get('atOdo'));
  const date = today();
  let service = data.services.find(s => s.id === f.get('serviceId'))
    || data.services.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (service) Object.assign(service, { name, interval: interval || service.interval, atOdo, cost, date });
  else data.services.push(service = { id: uid(), name, interval, atOdo, cost, date });
  data.serviceLog.push({ id: uid(), serviceId: service.id, name, atOdo, cost, date });
  if (cost && f.get('asExpense')) {
    data.entries.push({ id: uid(), type: 'expense', category: 'Ремонт', amount: cost, date, source: 'Другое', note: name, createdAt: new Date().toISOString() });
  }
  if (atOdo > num(data.odo)) data.odo = atOdo;
  save();
  dlg.close();
  toast('Обслуживание записано');
};

$('#maintenanceList').onclick = e => {
  const done = e.target.closest('[data-service-done]');
  if (done) return openServiceDialog(data.services.find(s => s.id === done.dataset.serviceDone));
  const del = e.target.closest('[data-service-del]');
  if (del && confirm('Убрать этот пункт из обслуживания? История ремонтов останется.')) {
    data.services = data.services.filter(s => s.id !== del.dataset.serviceDel);
    save();
  }
};

// ---------- AI Analyst (локальный) ----------
function bestDay(shifts, entries) {
  const days = new Set([...shifts.map(s => s.date), ...entries.map(e => e.date)]);
  let best = null;
  for (const d of days) {
    const t = totals(entries.filter(x => x.date === d), shifts.filter(x => x.date === d));
    const net = t.income - t.expense;
    if (!best || net > best.net) best = { date: d, net, ...t };
  }
  return best;
}

function expenseByCategory(entries) {
  const map = {};
  for (const x of entries) if (x.type === 'expense') map[x.category] = (map[x.category] || 0) + num(x.amount);
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function renderAI() {
  const period = $('#aiPeriod').value;
  const { entries, shifts } = periodData(period);
  const t = totals(entries, shifts);
  const fuel = sum(entries.filter(x => x.type === 'expense' && x.category === 'Бензин'), x => num(x.amount));
  const workDays = new Set(shifts.map(s => s.date)).size;
  const best = bestDay(shifts, entries);
  const cats = expenseByCategory(entries);
  const maxCat = cats[0]?.[1] || 1;
  const tips = [];
  if (fuel) tips.push(`На бензин потрачено ${money(fuel)}${t.km ? ` (${money(fuel / t.km)} на км)` : ''}.`);
  if (t.orders) tips.push(`В среднем ${(t.km / t.orders).toFixed(1)} км и ${money(t.income / t.orders)} на заказ.`);
  if (t.hours) tips.push(`Доход на час работы: ${money(t.income / t.hours)}.`);
  else tips.push('Добавь завершённые смены, чтобы получить анализ эффективности.');
  if (workDays) tips.push(`Рабочих дней: ${workDays}, в среднем ${money((t.income - t.expense) / workDays)} чистыми за день.`);
  if (best && best.net > 0) tips.push(`Лучший день — ${fmtDate(best.date)}: ${money(best.net)} чистыми.`);
  $('#aiReport').innerHTML = `<div class="report-grid">
      <div class="report-item"><small>Чистый доход</small><b>${money(t.income - t.expense)}</b></div>
      <div class="report-item"><small>Общий доход</small><b>${money(t.income)}</b></div>
      <div class="report-item"><small>Расходы</small><b>${money(t.expense)}</b></div>
      <div class="report-item"><small>Рабочие часы</small><b>${t.hours.toFixed(1)} ч</b></div>
      <div class="report-item"><small>Заказы</small><b>${t.orders}</b></div>
      <div class="report-item"><small>GPS-пробег</small><b>${t.km.toFixed(1)} км</b></div></div>
    <p class="muted">${tips.join(' ')}</p>`
    + (cats.length ? `<div class="eyebrow" style="margin-top:14px">РАСХОДЫ ПО КАТЕГОРИЯМ</div><div class="bars">${cats.map(([c, v]) =>
      `<div class="bar-row"><span>${esc(c)}</span><div class="bar-track"><i style="width:${(v / maxCat * 100).toFixed(1)}%"></i></div><b>${money(v)}</b></div>`).join('')}</div>` : '');
}
$('#aiPeriod').onchange = renderAI;

function addChat(t, who) {
  const d = document.createElement('div');
  d.className = 'chat-bubble ' + who;
  d.textContent = t;
  $('#chatBox').append(d);
  d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function askPeriod(l) {
  if (/сегодня/.test(l)) return { days: 1, label: 'сегодня' };
  if (/недел|7 дн/.test(l)) return { days: 7, label: 'за 7 дней' };
  if (/месяц|30 дн/.test(l)) return { days: 30, label: 'за 30 дней' };
  if (/год/.test(l)) return { days: 365, label: 'за год' };
  return { days: 'all', label: 'за всё время' };
}

function answerQuestion(q) {
  const l = q.toLowerCase();
  const p = askPeriod(l);
  const { entries, shifts } = periodData(p.days);
  const t = totals(entries, shifts);
  const catSum = cat => sum(entries.filter(x => x.type === 'expense' && x.category === cat), x => num(x.amount));

  if (/масл|обслуж|ремонт|колод|шин|цеп|ремень/.test(l) && !/потрат|сколько/.test(l) || /когда менять/.test(l)) {
    if (!data.services.length) return 'Пунктов обслуживания пока нет. Добавь их в разделе «Мотоцикл» с интервалом в км.';
    return data.services.map(s => {
      const { left } = serviceStatus(s);
      return `${s.name}: ${left === null ? 'без интервала' : left > 0 ? `через ${left.toLocaleString('ru-RU')} км` : `пора (просрочено на ${(-left).toLocaleString('ru-RU')} км)`}`;
    }).join('\n');
  }
  if (/лучш|рекорд/.test(l)) {
    const b = bestDay(shifts, entries);
    return b ? `Лучший день ${p.label} — ${fmtDate(b.date)}: ${money(b.net)} чистыми, ${b.orders} заказов, ${b.km.toFixed(1)} км.` : 'Пока нет данных для сравнения дней.';
  }
  if (/категор/.test(l)) {
    const c = expenseByCategory(entries);
    return c.length ? `Расходы ${p.label}:\n` + c.map(([k, v]) => `${k} — ${money(v)}`).join('\n') : `Расходов ${p.label} нет.`;
  }
  if (/бенз|топлив|fuel/.test(l)) return `На бензин ${p.label}: ${money(catSum('Бензин'))}.`;
  if (/сигар/.test(l)) return `На сигареты ${p.label}: ${money(catSum('Сигареты'))}.`;
  if (/ед[аы]|еду|обед|кофе/.test(l)) return `На еду ${p.label}: ${money(catSum('Еда'))}.`;
  if (/заказ/.test(l)) return `Заказов ${p.label}: ${t.orders}${t.orders && t.hours ? ` (${(t.orders / t.hours).toFixed(1)} в час)` : ''}.`;
  if (/килом|пробег|км/.test(l)) return `GPS-пробег ${p.label}: ${t.km.toFixed(1)} км. Одометр мотоцикла: ${num(data.odo).toLocaleString('ru-RU')} км.`;
  if (/час/.test(l)) return `Отработано ${p.label}: ${t.hours.toFixed(1)} ч${t.hours ? `, ${money(t.income / t.hours)} в час` : ''}.`;
  if (/чист|прибыл|итог|баланс/.test(l)) return `Чистый результат ${p.label}: ${money(t.income - t.expense)}.`;
  if (/доход|заработ|получ/.test(l)) return `Доход ${p.label}: ${money(t.income)}.`;
  if (/расход|потрат|трат/.test(l)) return `Расходы ${p.label}: ${money(t.expense)}.`;
  return 'Я могу ответить о доходах, расходах (в т.ч. по категориям), бензине, заказах, часах, километрах, лучшем дне и обслуживании. Добавь период: «сегодня», «за неделю», «за месяц».';
}

$('#askForm').onsubmit = e => {
  e.preventDefault();
  const q = String(new FormData(e.target).get('question') || '').trim();
  if (!q) return;
  addChat(q, 'user');
  const answer = answerQuestion(q);
  setTimeout(() => addChat(answer, 'bot'), 180);
  e.target.reset();
};
$('#askChips').onclick = e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const q = chip.textContent;
  addChat(q, 'user');
  setTimeout(() => addChat(answerQuestion(q), 'bot'), 180);
};

// ---------- Настройки ----------
function renderSettings() {
  $('#appVersion').textContent = APP_VERSION;
  $('#lastBackup').textContent = data.settings.lastBackup ? new Date(data.settings.lastBackup).toLocaleString('ru-RU') : 'ещё не было';
}

$('#exportBtn').onclick = () => {
  data.settings.lastBackup = new Date().toISOString();
  persist();
  const blob = new Blob([JSON.stringify({ ...data, app: 'RIDELOG', version: APP_VERSION }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url;
  a.download = 'ridelog-backup-' + today() + '.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  renderSettings();
  toast('Резервная копия скачана');
};

$('#importFile').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (!Array.isArray(obj.entries) || !Array.isArray(obj.shifts)) throw Error('format');
    if (confirm('Заменить текущие данные импортированной копией?')) {
      stopTracking();
      delete obj.app; delete obj.version;
      data = normalize(obj);
      save();
      if (data.activeSession && !data.activeSession.end) startTracking();
      toast('Данные импортированы');
    }
  } catch { toast('Не удалось прочитать файл резервной копии'); }
  e.target.value = '';
};

$('#resetBtn').onclick = () => {
  if (!confirm('Удалить ВСЕ записи RIDELOG с этого устройства? Это нельзя отменить.')) return;
  stopTracking();
  lastPosition = null;
  data = normalize({});
  save();
  toast('Локальные данные удалены');
};

// ---------- Запуск ----------
function renderAll() {
  renderDashboard();
  renderFinance();
  renderCalendar();
  renderBike();
  if ($('#view-ai').classList.contains('active')) renderAI();
  renderSettings();
  updateSessionUI();
}

renderAll();
if (data.activeSession && !data.activeSession.end) startTracking(); // восстановить смену после перезагрузки

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          const b = document.createElement('button');
          b.className = 'update-banner';
          b.textContent = 'Доступна новая версия — обновить';
          b.onclick = () => location.reload();
          document.body.append(b);
        }
      });
    });
  }).catch(() => {});
}
