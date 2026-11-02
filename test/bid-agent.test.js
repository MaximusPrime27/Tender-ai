// Агент заявок: задание текстом → настройки, отбор закупок, прогон до пакета (с подменой разбора, поиска, расчёта и
// заявки), замечания со ссылками на место, уроки из своих ошибок, итоги торгов, решения человека, утреннее расписание.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createBidAgent, parseTask, floorPrice, judgeOutcome, cleanSettings, DEFAULTS } = require('../server/tenders/bid-agent');

const NICHES = [
  { id: 'office', title: 'Оргтехника и расходные материалы', keywords: ['картридж', 'МФУ', 'принтер'] },
  { id: 'computers', title: 'Компьютерное оборудование', keywords: ['компьютер', 'монитор'] },
  { id: 'g-furniture', title: 'Мебель', keywords: ['мебель', 'стеллаж'] },
];

test('задание текстом → настройки: ниши, регионы, цена, сложность, маржа, число закупок; понятое перечислено', () => {
  const { settings: s, understood } = parseTask('Картриджи и оргтехника, Москва и область, до 150 тыс., простые и средние, маржа от 8%, 5 закупок, только российские', cleanSettings({}), NICHES);
  assert.deepEqual(s.niches, ['office']);
  assert.deepEqual(s.regions, [77, 50]);
  assert.equal(s.price_max, 150000);
  assert.deepEqual(s.difficulty, ['simple', 'medium']);
  assert.equal(s.margin_min, 8);
  assert.equal(s.per_run, 5);
  assert.equal(s.foreign_when_restricted, false);
  assert.ok(understood.length >= 6);
  // любая сложность и вся Россия; мебель — другая ниша
  const any = parseTask('мебель по всей России, любой сложности, от 50 тыс до 300 тыс', cleanSettings({}), NICHES).settings;
  assert.deepEqual(any.niches, ['g-furniture']);
  assert.deepEqual(any.regions, []);
  assert.deepEqual(any.difficulty, ['simple', 'medium', 'complex']);
  assert.equal(any.price_min, 50000);
  assert.equal(any.price_max, 300000);
});

test('цена «не ниже»: безубыточность и цена с маржой — с налогом УСН 15% и 6%; итог торгов против себестоимости', () => {
  assert.deepEqual(floorPrice(72773, 5, 'usn15'), { break_even: 72773, with_margin: 77322 });
  assert.deepEqual(floorPrice(94000, 10, 'usn6'), { break_even: 100000, with_margin: 111905 });
  assert.equal(judgeOutcome({ nmck: 80000, contractPrice: 60000, cost: 50000, marginMin: 5 }).status, 'would_profit');
  assert.equal(judgeOutcome({ nmck: 80000, contractPrice: 60000, cost: 50000 }).decline_pct, 25);
  assert.equal(judgeOutcome({ nmck: 80000, contractPrice: 48000, cost: 50000 }).status, 'below_cost');
  assert.equal(judgeOutcome({ nmck: 80000, contractPrice: 52000, cost: 50000, marginMin: 10 }).status, 'thin');
});

function setup(t, { offers = {}, econ = {}, contracts = {}, searchLog = null, bidCounts = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidagent-'));
  const repo = openDb(dir);
  t.after(() => { repo.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const now = new Date('2026-10-24T02:00:00Z'); // 05:00 по Москве
  const tender = (number, o = {}) => {
    const { id } = repo.upsertTender({ law: '44', number, title: o.title || 'Поставка картриджей', price: o.price ?? 60000, currency: 'RUB', region: o.region ?? 77, okpd2: [], ktru: [], customer_inn: null, published_at: '2026-10-23T08:00:00Z', deadline_at: o.deadline || '2026-11-03T06:00:00Z', stage: 1, eis_url: null });
    repo.db.prepare("UPDATE tenders SET status = 'scored', score = ?, direction = ? WHERE id = ?").run(o.score ?? 70, o.direction || 'office', id);
    repo.saveItems(id, (o.items || [{ name: 'Тонер-картридж для МФУ Pantum M6800FDW', quantity: 20, unit: 'шт', characteristics: [{ name: 'Ресурс', value: 'не менее 6000 стр.' }] }]).map((i) => ({ source: 'notification', ...i })));
    return id;
  };
  const analysisCard = (nr, pl) => ({ groups: [{ key: 'req', title: 'Требования', fields: [{ key: 'national_regime', label: 'Нацрежим', status: 'found', value: nr || 'не установлен' }, ...(pl ? [{ key: 'delivery_place', label: 'Место поставки', status: 'found', value: pl }] : [])] }] });
  const nr = {};
  const place = {};
  const docsFail = {};
  const analyses = {
    startFromTender({ tender: tt }) {
      const id = `a-${tt.id}`;
      repo.createAnalysis({ id, title: tt.title });
      if (docsFail[tt.id]) repo.failAnalysis(id, docsFail[tt.id]);
      else repo.finishAnalysis(id, { card: analysisCard(nr[tt.id], place[tt.id]), provider: 'test', model: 'test', durationMs: 1, tokensIn: 0, tokensOut: 0 });
      return id;
    },
  };
  const rechecked = [];
  const offerSvc = {
    async recheck(id) { rechecked.push(id); repo.setOfferMatch(id, { match: 'соответствует', notes: ['перепроверено'], checks: { rows: [] } }); return { ok: true }; },
    start(tenderId) {
      const sid = repo.createOfferSearch(tenderId);
      for (const it of repo.getItems(tenderId)) {
        for (const o of offers[tenderId] || []) {
          const oid = repo.insertOffer({ tender_id: tenderId, item_id: it.id, source: 'wholesale', domain: o.domain || 'opt.ru', title: o.title, url: `https://${o.domain || 'opt.ru'}/${encodeURIComponent(o.title)}`, price: o.price, match: o.match || 'соответствует', match_checks: { rows: o.rows || [{ name: 'Ресурс', need: '6000', verdict: 'yes', found: '6000' }] } });
          if (o.pick) repo.setItemOffer(it.id, repo.getOffer(oid), 'auto');
        }
      }
      repo.updateOfferSearch(sid, { status: 'done', finished: true, ...(searchLog ? { log: searchLog } : {}) });
      return sid;
    },
  };
  const details = {
    async computeEconomics(tenderId) {
      const items = repo.getItems(tenderId);
      const purchase = items.reduce((s, i) => s + (i.purchase_offer_id ? (repo.getOffer(i.purchase_offer_id).price * (i.quantity || 1)) : 0), 0);
      const missing = items.some((i) => !i.purchase_offer_id);
      return { economics: { result: { settings: { tax_mode: 'usn15' }, inputs: { nmck: repo.getTender(tenderId).price, decline_pct: econ.decline ?? 10 }, result: missing ? { purchase: null } : { purchase, logistics: econ.logistics ?? 1000, guarantee_cost: 10 } } } };
    },
  };
  // входные данные расчёта сделки для «позиции без товара — по цене заказчика»
  details.buildInput = (tender, items) => ({ nmck: tender.price, decline_pct: econ.decline ?? 10, logistics: econ.logistics ?? 1000, settings: { tax_mode: 'usn15' },
    items: repo.getItems(tender.id).map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, unit_price: i.unit_price, purchase_price: i.purchase_offer_id ? repo.getOffer(i.purchase_offer_id).price : null })) });
  const charsOf = {};
  const charService = {
    async view(tid) { return { tables: repo.getItems(tid).map((i) => ({ item_id: i.id, idx: i.idx, name: i.name, trademark: charsOf[tid]?.trademark ?? null, country: charsOf[tid]?.country ?? null, rows: charsOf[tid]?.rowsFor ? charsOf[tid].rowsFor(i.purchase_offer_id) : (charsOf[tid]?.rows || []) })), problems: [] }; },
    async save(tid, p) { charsOf[tid] = { ...(charsOf[tid] || {}), ...(p.trademark ? { trademark: p.trademark } : {}) }; return this.view(tid); },
  };
  const bids = {
    async open(tid) { return { view: { id: tid * 10 } }; },
    async draft(caseId) { return { id: caseId, status: 'needs_input', package: { built: { files: [{ path: 'Предложение о товаре.docx', todo: 0 }] } }, readiness: { counters: { mandatory: 10, mandatory_pass: 1 }, blockers: [] } }; },
  };
  const source = { async contractsByPurchase(number) { return contracts[number] || []; } };
  const sent = [];
  let clock = now;
  const agent = createBidAgent({
    repo, analyses, source, offers: offerSvc, details, bids, bidCounts, charService, config: { PUBLIC_BASE_URL: 'https://t.example', DIGEST_TZ: 'Europe/Moscow' },
    notify: async (html) => { sent.push(html); return true; }, clock: () => clock, log: { log() {}, warn() {} }, sleep: async () => {}, pollMs: 0,
  });
  return { repo, agent, tender, nr, place, charsOf, rechecked, docsFail, sent, setClock: (d) => { clock = d; } };
}

test('отбор: ниши, цена, запас дней, простые первыми; уже подготовленные не берутся снова', (t) => {
  const { repo, agent, tender } = setup(t);
  const a = tender('a-1', { price: 60000 });
  tender('a-2', { price: 400000 }); // дороже потолка
  tender('a-3', { price: 50000, deadline: '2026-10-25T06:00:00Z' }); // мало дней
  tender('a-4', { price: 50000, direction: 'computers' }); // не та ниша
  const b = tender('a-5', { price: 40000, items: Array.from({ length: 4 }, (_, i) => ({ name: `Картридж ${i}`, quantity: 1, unit: 'шт', characteristics: [] })) }); // средняя
  agent.saveSettings({ niches: ['office'], price_max: 150000, difficulty: ['simple', 'medium'], min_days: 3, platforms: 'all' });
  assert.deepEqual(agent.candidates().map((x) => x.id), [a, b], 'простая — первой, средняя — за ней');
  repo.db.prepare("INSERT INTO bid_agent_items (tender_id, status, created_at, updated_at) VALUES (?, 'ready', ?, ?)").run(a, '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z');
  assert.deepEqual(agent.candidates().map((x) => x.id), [b]);
});

test('прогон: готовая заявка — товар, прибыль, «не ниже», замечания со ссылкой на место; без товара и без маржи — отсеяно', async (t) => {
  const ok = 'b-ok';
  const { agent, tender, nr, sent, repo } = setup(t);
  const t1 = tender(ok, { price: 30000 });
  const t2 = tender('b-none', { price: 30000 });
  const t3 = tender('b-loss', { price: 30000 });
  nr[t1] = 'ограничение допуска иностранных товаров (ПП № 1875)';
  // предложения: у t1 — подходящий G&G TL-420X; у t2 — ничего; у t3 — дорогой
  const offersByTender = { [t1]: [{ title: 'Картридж G&G TL-420X', price: 866, pick: true }], [t3]: [{ title: 'Картридж Pantum TL-420X оригинал', price: 1450, pick: true }] };
  for (const [tid, list] of Object.entries(offersByTender)) for (const it of repo.getItems(Number(tid))) for (const o of list) {
    const oid = repo.insertOffer({ tender_id: Number(tid), item_id: it.id, source: 'wholesale', domain: 'opt.ru', title: o.title, url: `https://opt.ru/${encodeURIComponent(o.title)}`, price: o.price, match: 'соответствует', match_checks: { rows: [{ name: 'Ресурс', need: '6000', verdict: 'yes', found: '6000' }] } });
    repo.setItemOffer(it.id, repo.getOffer(oid), 'auto');
  }
  for (const tid of [t1, t2, t3]) { const sid = repo.createOfferSearch(tid); repo.updateOfferSearch(sid, { status: 'done', finished: true }); }
  agent.saveSettings({ niches: ['office'], margin_min: 5, profit_min: 1000, platforms: 'all', per_run: 5 });
  const r = await agent.run({ reason: 'manual' });
  assert.equal(r.stats.candidates, 3);
  const v = agent.view();
  const byTender = Object.fromEntries(v.items.map((x) => [x.tender_id, x]));
  const good = byTender[t1];
  assert.equal(good.status, 'needs_work', 'нет страны — заявку не примут: доработать');
  assert.equal(good.summary.items[0].offer.title, 'Картридж G&G TL-420X');
  assert.equal(good.summary.econ.cost, 20 * 866 + 1000 + 10);
  assert.ok(good.summary.econ.floor.with_margin > good.summary.econ.floor.break_even);
  assert.equal(good.summary.bid.id, t1 * 10);
  const country = good.findings.find((f) => f.code === 'no_country');
  assert.equal(country.href, `#tender/${t1}/bid`);
  assert.match(country.sel, /data-char-country/);
  assert.equal(good.findings.find((f) => f.code === 'unit_price'), undefined, 'количество есть');
  assert.equal(byTender[t2].status, 'rejected');
  assert.match(byTender[t2].reason, /нет подходящего товара/);
  assert.equal(byTender[t3].status, 'rejected');
  assert.match(byTender[t3].reason, /невыгодно/);
  // товарный знак подставлен из названия товара
  assert.match(sent[0], /Агент заявок — утро/);
  assert.match(sent[0], /#bidagent/);
});

test('самопроверка: товар дороже 1,5 цены заказчика и «100 Мбит» при «10/100/1000» — ошибки агента в журнале уроков', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t);
  const sw = tender('c-sw', { price: 30000, direction: 'office', items: [{ name: 'Коммутатор', quantity: 2, unit: 'шт', unit_price: 13000, characteristics: [{ name: 'Количество портов 10/100/1000', value: 'не менее 24' }] }] });
  for (const it of repo.getItems(sw)) {
    const oid = repo.insertOffer({ tender_id: sw, item_id: it.id, source: 'wholesale', domain: 'kns.ru', title: 'Коммутатор Tenda TEF1126P-24-250W, 24x100 Мбит/с', url: 'https://kns.ru/x', price: 11870, match: 'частично', match_checks: { total: 4, confirmed: 3, rows: [] } });
    repo.setItemOffer(it.id, repo.getOffer(oid), 'auto');
  }
  repo.updateOfferSearch(repo.createOfferSearch(sw), { status: 'done', finished: true });
  charsOf[sw] = { trademark: 'Tenda', country: 'Китай' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 0, profit_min: 0 });
  await agent.run({ reason: 'manual' });
  const it = agent.view().items[0];
  const speed = it.findings.find((f) => f.code === 'speed_mismatch');
  assert.ok(speed, JSON.stringify(it.findings));
  assert.match(speed.sel, /data-offer-cart/);
  assert.equal(it.status, 'needs_work');
  assert.ok(agent.view().learning.lessons.some((l) => l.code === 'speed_mismatch' && l.count === 1));
  // ложная тревога: человек отмечает замечание неверным — это тоже урок
  agent.dismissFinding(it.id, it.findings.indexOf(it.findings.find((f) => f.code === 'speed_mismatch')));
  assert.ok(agent.view().learning.lessons.some((l) => l.code === 'false_speed_mismatch'));
});

test('итоги торгов: контракт по номеру закупки → выиграли бы / ниже себестоимости; снижение по нише — из итогов', async (t) => {
  const { agent, repo, setClock } = setup(t, { contracts: { 'd-1': [{ price: 21000 }], 'd-2': [{ price: 14000 }], 'd-3': [{ price: 20000 }], 'd-4': [{ price: 19000 }] } });
  const add = (number, price, cost, status = 'ready', decision = null) => {
    const { id } = repo.upsertTender({ law: '44', number, title: 'Картриджи', price, currency: 'RUB', region: 77, okpd2: [], ktru: [], customer_inn: null, published_at: null, deadline_at: '2026-10-10T06:00:00Z', stage: 1, eis_url: null });
    repo.db.prepare("UPDATE tenders SET direction = 'office' WHERE id = ?").run(id);
    repo.db.prepare('INSERT INTO bid_agent_items (tender_id, status, summary_json, decision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, status, JSON.stringify({ econ: { cost, tax_mode: 'usn15' } }), decision, '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z');
  };
  add('d-1', 30000, 15000, 'rejected'); // выиграли бы: отсеяли зря
  add('d-2', 30000, 15000, 'ready', 'take'); // ниже себестоимости
  add('d-3', 30000, 15000);
  add('d-4', 30000, 15000, 'ready', 'skip');
  setClock(new Date('2026-10-24T02:00:00Z'));
  assert.equal(await agent.checkOutcomes(), 4);
  const L = agent.view().learning;
  assert.equal(L.outcomes.total, 4);
  assert.equal(L.outcomes.would_profit, 3);
  assert.equal(L.outcomes.below_cost, 1);
  assert.equal(L.missed.length, 2, 'отсеянная и «не беру» — упущенная выгода');
  assert.equal(L.wrong_take.length, 1);
  assert.equal(L.decline_by_niche.office.median, 35, "30, 33,3, 36,7 и 53,3% — медиана 35");
});

test('утреннее расписание: в час start_hour один раз за день; выключенный — не запускается', (t) => {
  const { agent, setClock } = setup(t);
  agent.saveSettings({ start_hour: 5 });
  setClock(new Date('2026-10-24T02:10:00Z'));
  assert.equal(agent.due(), true);
  setClock(new Date('2026-10-24T03:40:00Z'));
  assert.equal(agent.due(), true, '06:40 — час пропущен (сервер был занят) — прогон догоняет');
  setClock(new Date('2026-10-24T01:50:00Z'));
  assert.equal(agent.due(), false, '04:50 — ещё рано');
  setClock(new Date('2026-10-24T10:10:00Z'));
  assert.equal(agent.due(), false, '13:10 — уже поздно, ждём следующего утра');
  agent.saveSettings({ enabled: false, start_hour: 6 });
  assert.equal(agent.due(), false);
});

test('нацрежим: российский товар в минус, импорт выгоден — готово с предупреждением о риске и долей побед импорта; импорт почти не побеждает — отсеяно; минусовые — не предлагаются', async (t) => {
  const { agent, tender, nr, repo, charsOf } = setup(t, { econ: { decline: 22 } });
  const mon = (number, share) => {
    const id = tender(number, { price: 80000, direction: 'computers', items: [{ name: 'Монитор', quantity: 4, unit: 'шт', unit_price: 20000, okpd2_code: share.code, characteristics: [{ name: 'Диагональ', value: 'не менее 27' }] }] });
    nr[id] = 'ограничение допуска иностранных товаров (ПП № 1875)';
    for (const it of repo.getItems(id)) {
      const ru = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'ladrm.ru', title: 'Монитор Aquarius B27F1', url: `https://ladrm.ru/${number}`, price: 17520, match: 'соответствует', match_checks: { rows: [] } });
      repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'kns.ru', title: 'Монитор Philips 27E1N1100A', url: `https://kns.ru/${number}`, price: 9706, match: 'соответствует', match_checks: { rows: [] } });
      repo.setItemOffer(it.id, repo.getOffer(ru), 'auto');
    }
    repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
    repo.saveBenchmark(share.code, { origin: { contracts: share.n, russian: share.n - share.f, foreign: share.f, foreign_share: share.f / share.n } });
    charsOf[id] = { trademark: 'x', country: 'Китай' };
    return id;
  };
  const often = mon('n-1', { code: '26.20.17.110-00000007', n: 10, f: 4 });
  agent.saveSettings({ niches: ['computers'], platforms: 'all', margin_min: 5, profit_min: 1000 });
  await agent.run({ reason: 'manual', tenderIds: [often] });
  const a = agent.view().items.find((x) => x.tender_id === often);
  assert.equal(a.summary.strategy, 'foreign');
  assert.equal(a.summary.items[0].offer.title, 'Монитор Philips 27E1N1100A', 'выбран дешёвый импорт');
  assert.ok(a.summary.variants.ru.profit < 0, 'российский — в минус при снижении');
  const risk = a.findings.find((f) => f.code === 'nat_risk');
  assert.match(risk.text, /импорт побеждал в 40% \(4 из 10\)/);
  assert.equal(risk.href, `#tender/${often}/docs`);
  assert.notEqual(a.status, 'rejected');

  const rare = mon('n-2', { code: '26.20.17.110-00000099', n: 12, f: 1 });
  await agent.run({ reason: 'manual', tenderIds: [rare] });
  const b = agent.view().items.find((x) => x.tender_id === rare);
  assert.equal(b.status, 'rejected');
  assert.match(b.reason, /импорт по этому товару почти не побеждает — 8%/);

  // без нацрежима, но в минус при ожидаемом снижении — не предлагаем
  const loss = tender('n-3', { price: 30000, items: [{ name: 'Картридж', quantity: 20, unit: 'шт', unit_price: 1500, characteristics: [] }] });
  for (const it of repo.getItems(loss)) { const o = repo.insertOffer({ tender_id: loss, item_id: it.id, source: 'wholesale', domain: 'opt.ru', title: 'Картридж X', url: 'https://opt.ru/x', price: 1400, match: 'соответствует', match_checks: { rows: [] } }); repo.setItemOffer(it.id, repo.getOffer(o), 'auto'); }
  repo.updateOfferSearch(repo.createOfferSearch(loss), { status: 'done', finished: true });
  await agent.run({ reason: 'manual', tenderIds: [loss] });
  const c = agent.view().items.find((x) => x.tender_id === loss);
  assert.equal(c.status, 'rejected');
  assert.match(c.reason, /при ожидаемом снижении 22% прибыль -/);
});

test('выбор человека агент не меняет: в минус — предлагает выгодную замену ссылкой на строку; 24" при «не менее 27» не подходит; нацрежим по позициям — одним замечанием', async (t) => {
  const { agent, tender, nr, repo, charsOf } = setup(t, { econ: { decline: 22 } });
  const id = tender('u-1', { price: 80000, direction: 'computers', items: [
    { name: 'Монитор', quantity: 2, unit: 'шт', unit_price: 20000, okpd2_code: '26.20.17.110-00000007', characteristics: [{ name: 'Размер диагонали', value: 'не менее 27' }] },
    { name: 'Монитор', quantity: 2, unit: 'шт', unit_price: 20000, okpd2_code: '26.20.17.110-00000007', characteristics: [{ name: 'Размер диагонали', value: 'не менее 27' }] },
  ] });
  nr[id] = 'ограничение допуска иностранных товаров (ПП № 1875)';
  const ids = {};
  for (const it of repo.getItems(id)) {
    const ru = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'ladrm.ru', title: 'Монитор Aquarius B27F1', url: `https://ladrm.ru/${it.id}`, price: 17520, match: 'соответствует', match_checks: { rows: [] } });
    ids[it.id] = {
      small: repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'xcom.ru', title: 'Essential S3 S30GD S24D300GAI', url: `https://xcom.ru/${it.id}`, price: 7930, match: 'соответствует', match_checks: { rows: [] }, specs: [{ name: 'Диагональ экрана', value: '24 "' }] }),
      ph: repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'kns.ru', title: 'Монитор Philips 27E1N1100A', url: `https://kns.ru/${it.id}`, price: 9706, match: 'соответствует', match_checks: { rows: [] }, specs: [{ name: 'Диагональ экрана', value: '27 "' }] }),
    };
    repo.setItemOffer(it.id, repo.getOffer(ru), 'user');
  }
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  repo.saveBenchmark('26.20.17.110-00000007', { origin: { contracts: 10, russian: 6, foreign: 4, foreign_share: 0.4 } });
  charsOf[id] = { trademark: 'x', country: 'Китай' };
  agent.saveSettings({ niches: ['computers'], platforms: 'all', margin_min: 5, profit_min: 1000 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const a = agent.view().items.find((x) => x.tender_id === id);
  for (const it of repo.getItems(id)) assert.equal(repo.getOffer(it.purchase_offer_id).title, 'Монитор Aquarius B27F1', 'выбор человека остался');
  assert.equal(a.status, 'needs_work');
  const altF = a.findings.find((f) => f.code === 'alt_better');
  assert.match(altF.text, /Philips 27E1N1100A/, 'замена — 27", а не 24-дюймовый за 7 930');
  assert.match(altF.text, /импорт побеждал в 40%/);
  assert.equal(altF.sel, `[data-offer-cart="${ids[repo.getItems(id)[0].id].ph}"]`);
  assert.equal(altF.href, `#tender/${id}/suppliers`);
  assert.equal(a.findings.filter((f) => f.code === 'foreign').length, 1, 'нацрежим — одним замечанием на закупку');
  assert.match(a.findings.find((f) => f.code === 'foreign').text, /позиции 1, 2/);
});

test('задание: «доставка не более 2-3 дней» — предел доставки, а не запас до подачи; медленная доставка агентом не выбирается', async (t) => {
  const p = parseTask('маржа от 10%, до 150 тыс., Москва и Санкт-Петербург, доставка не более 2-3 дней', DEFAULTS, []);
  assert.equal(p.settings.max_delivery_days, 3);
  assert.equal(p.settings.min_days, DEFAULTS.min_days);
  assert.equal(p.settings.margin_min, 10);
  const { agent, tender, repo, charsOf } = setup(t);
  const id = tender('d-1', { price: 60000, items: [{ name: 'Картридж', quantity: 20, unit: 'шт', unit_price: 3000, characteristics: [] }] });
  for (const it of repo.getItems(id)) {
    repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'far.ru', title: 'Картридж далёкий', url: 'https://far.ru/1', price: 1000, delivery_days: 7, match: 'соответствует', match_checks: { rows: [] } });
    repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'near.ru', title: 'Картридж близкий', url: 'https://near.ru/1', price: 1200, delivery_days: 2, match: 'соответствует', match_checks: { rows: [] } });
  }
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', max_delivery_days: 3 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const a = agent.view().items.find((x) => x.tender_id === id);
  assert.equal(a.summary.items[0].offer.title, 'Картридж близкий');
});

test('место поставки вне ваших регионов — отсеяно до поиска поставщиков (заказчик в Москве, филиал в Новосибирске)', async (t) => {
  const { agent, tender, place, repo } = setup(t);
  const id = tender('pl-1', { price: 50000, region: 77 });
  place[id] = '630099, г. Новосибирск, ул. Ленина, д. 1';
  agent.saveSettings({ niches: ['office'], platforms: 'all', regions: [77, 50, 78, 47] });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const a = agent.view().items.find((x) => x.tender_id === id);
  assert.equal(a.status, 'rejected');
  assert.match(a.reason, /место поставки «630099, г. Новосибирск.*регион 54/);
  assert.equal(repo.lastOfferSearch(id), null, 'поиск поставщиков не запускался');
});

test('лимит платного поиска исчерпан — не «нет товара», а «не получилось»: прогон останавливается, закупка берётся снова в следующий раз', async (t) => {
  const { agent, tender } = setup(t, { searchLog: [{ level: 'warn', text: 'Исчерпан суточный лимит платных запросов к поисковику (200)' }] });
  tender('lim-1', { price: 50000 });
  tender('lim-2', { price: 50000 });
  agent.saveSettings({ niches: ['office'], platforms: 'all' });
  const r = await agent.run({ reason: 'manual' });
  assert.equal(r.stats.errors, 1);
  assert.equal(r.stats.stopped, 'лимит поиска');
  const x = agent.view().items[0];
  assert.equal(x.status, 'error');
  assert.match(x.reason, /суточный лимит платного поиска/);
  assert.ok(agent.candidates().some((c) => c.id === x.tender_id), 'в следующий прогон закупка снова кандидат');
});

test('доставка по оценке перевозчика дольше предела — товар не отбрасывается, а «уточните срок»', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t);
  const id = tender('de-1', { price: 60000, items: [{ name: 'Картридж', quantity: 20, unit: 'шт', unit_price: 3000, characteristics: [] }] });
  for (const it of repo.getItems(id)) repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'msk.ru', title: 'Картридж московский', url: 'https://msk.ru/1', price: 1000, delivery_days: 4, delivery_estimated: 1, match: 'соответствует', match_checks: { rows: [] } });
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', max_delivery_days: 3 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const a = agent.view().items.find((x) => x.tender_id === id);
  assert.equal(a.summary.items[0].offer.title, 'Картридж московский');
  assert.ok(a.findings.some((f) => f.code === 'delivery_estimate'));
});

test('замена не берёт товар с неподтверждённым числовым требованием (TL-420E при ресурсе от 3000)', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t, { econ: { decline: 10 } });
  const id = tender('tl-1', { price: 30000, items: [{ name: 'Тонер-картридж для МФУ Pantum M7310DN', quantity: 20, unit: 'шт', unit_price: 1500, characteristics: [{ name: 'Ресурс', value: 'не менее 3000 стр.' }] }] });
  for (const it of repo.getItems(id)) {
    const mine = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'a.ru', title: 'NV-TL-420H', url: 'https://a.ru/h', price: 1400, match: 'частично', match_checks: { rows: [{ name: 'Ресурс', need: 'не менее 3000', verdict: 'yes', found: '3000' }] } });
    repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'b.ru', title: 'Картридж SP TL-420E для Pantum', url: 'https://b.ru/e', price: 363, match: 'частично', match_checks: { rows: [{ name: 'Ресурс', need: 'не менее 3000', verdict: 'unknown', found: '' }] } });
    repo.setItemOffer(it.id, repo.getOffer(mine), 'user');
  }
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Китай' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 10 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const a = agent.view().items.find((x) => x.tender_id === id);
  assert.equal(a.summary.alt, undefined, 'TL-420E с неподтверждённым ресурсом заменой не предлагается');
  assert.equal(a.status, 'rejected');
});

test('снижение по прошлым торгам сильно больше расчётного и в минус — замечание и не «готово»', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t, { econ: { decline: 10 } });
  const id = tender('dh-1', { price: 60000, items: [{ name: 'Картридж', quantity: 20, unit: 'шт', unit_price: 3000, okpd2_code: '26.20.40.120', characteristics: [] }] });
  for (const it of repo.getItems(id)) { const o = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'a.ru', title: 'Картридж', url: 'https://a.ru/1', price: 2000, match: 'соответствует', match_checks: { rows: [] } }); repo.setItemOffer(it.id, repo.getOffer(o), 'auto'); }
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  repo.saveBenchmark('26.20.40.120', { decline: { median: 0.45, samples: 4 } });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 5 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const a = agent.view().items.find((x) => x.tender_id === id);
  const f = a.findings.find((x) => x.code === 'decline_history');
  assert.match(f.text, /падала на 45% \(4 контр\.\)/);
  assert.equal(f.level, 'block');
  assert.notEqual(a.status, 'ready');
  assert.equal(a.summary.verdict, null, 'по истории торгов минус — не «выгодно»');
});

test('несколько позиций: одна дороже цены заказчика (до 1,5 раза) — берётся, решает прибыль всей закупки', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t, { econ: { decline: 5 } });
  const id = tender('ov-1', { price: 50000, items: [
    { name: 'Элемент питания AA', quantity: 100, unit: 'шт', unit_price: 400, characteristics: [] },
    { name: 'Элемент питания CR2032', quantity: 100, unit: 'шт', unit_price: 37, characteristics: [] },
  ] });
  const [a, b] = repo.getItems(id);
  repo.insertOffer({ tender_id: id, item_id: a.id, source: 'wholesale', domain: 'a.ru', title: 'Батарейка AA', url: 'https://a.ru/aa', price: 200, match: 'соответствует', match_checks: { rows: [] } });
  repo.insertOffer({ tender_id: id, item_id: b.id, source: 'wholesale', domain: 'a.ru', title: 'Батарейка CR2032', url: 'https://a.ru/cr', price: 54, match: 'соответствует', match_checks: { rows: [] } });
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 10 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const x = agent.view().items.find((i) => i.tender_id === id);
  assert.notEqual(x.status, 'rejected', x.reason || '');
  assert.ok(x.findings.some((f) => f.code === 'item_over'));
});

test('запрет допуска иностранных: импорт не предлагается ни выбором, ни заменой', async (t) => {
  const { agent, tender, nr, repo, charsOf } = setup(t, { econ: { decline: 22 } });
  const id = tender('ban-1', { price: 80000, direction: 'computers', items: [{ name: 'Монитор', quantity: 4, unit: 'шт', unit_price: 20000, characteristics: [] }] });
  nr[id] = 'Национальный режим (ПП РФ № 1875): запрет допуска иностранных товаров — для всех позиций';
  for (const it of repo.getItems(id)) {
    const ru = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'ladrm.ru', title: 'Монитор Aquarius B27F1', url: 'https://ladrm.ru/b', price: 17520, match: 'соответствует', match_checks: { rows: [] } });
    repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'kns.ru', title: 'Монитор Philips 27E1N1100A', url: 'https://kns.ru/b', price: 9706, match: 'соответствует', match_checks: { rows: [] } });
    repo.setItemOffer(it.id, repo.getOffer(ru), 'user');
  }
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['computers'], platforms: 'all', margin_min: 5 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const a = agent.view().items.find((x) => x.tender_id === id);
  assert.equal(a.summary.alt, undefined, 'импортная замена при запрете не предлагается');
  assert.notEqual(a.summary.strategy, 'foreign');
  assert.equal(a.status, 'rejected');
});

test('доставка в расчёте дороже половины закупки — не отсеять, а «проверьте вес» с прибылью без неё', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t, { econ: { decline: 10, logistics: 30000 } });
  const id = tender('lg-1', { price: 60000, items: [{ name: 'Элемент питания AA', quantity: 20, unit: 'шт', unit_price: 3000, characteristics: [] }] });
  for (const it of repo.getItems(id)) { const o = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'a.ru', title: 'Батарейка AA', url: 'https://a.ru/1', price: 1000, match: 'соответствует', match_checks: { rows: [] } }); repo.setItemOffer(it.id, repo.getOffer(o), 'auto'); }
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 10 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const a = agent.view().items.find((x) => x.tender_id === id);
  assert.equal(a.status, 'needs_work');
  assert.match(a.reason, /доставка в расчёте подозрительно дорогая: 30\s000 ₽ при закупке 20\s000 ₽/);
  assert.ok(a.findings.some((f) => f.code === 'logistics_suspicious'));
});

test('позиция без товара не губит закупку: по цене заказчика, остальное по найденному — «выгодно, если найти поставщика»', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t, { econ: { decline: 5 } });
  const id = tender('pa-1', { price: 60000, items: [
    { name: 'Картридж HP CF280A', quantity: 20, unit: 'шт', unit_price: 2500, characteristics: [] },
    { name: 'Фотобарабан Pantum DL-5120', quantity: 2, unit: 'шт', unit_price: 5000, characteristics: [] },
  ] });
  const [a] = repo.getItems(id);
  repo.insertOffer({ tender_id: id, item_id: a.id, source: 'wholesale', domain: 'a.ru', title: 'Картридж CF280A совместимый', url: 'https://a.ru/1', price: 900, match: 'соответствует', match_checks: { rows: [] } });
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 10, per_run: 1 });
  const r = await agent.run({ reason: 'manual', tenderIds: [id] });
  const x = agent.view().items.find((i) => i.tender_id === id);
  assert.equal(x.status, 'needs_work', x.reason);
  assert.deepEqual(x.summary.assumed.positions, [2]);
  assert.match(x.summary.verdict, /выгодно, если найти поставщика для позиций 2/);
  assert.equal(r.stats.profitable, 1);
  assert.ok(x.findings.some((f) => f.code === 'no_offer' && /найдите поставщика/.test(f.text)));
});

test('в 5 раз дешевле цены заказчика — не тот товар: агент его не выбирает', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t);
  const id = tender('ch-1', { price: 48733, items: [{ name: 'Многофункциональное устройство (МФУ)', quantity: 1, unit: 'шт', unit_price: 48733, characteristics: [] }] });
  for (const it of repo.getItems(id)) {
    repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'a.ru', title: 'МФУ Canon Pixma MG2541S', url: 'https://a.ru/1', price: 6406, match: 'частично', match_checks: { total: 4, confirmed: 3, rows: [] } });
    repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'b.ru', title: 'МФУ Kyocera MA4000x', url: 'https://b.ru/1', price: 40894, match: 'частично', match_checks: { total: 4, confirmed: 3, rows: [] } });
  }
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Китай' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 5 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const x = agent.view().items.find((i) => i.tender_id === id);
  assert.equal(x.summary.items[0].offer.title, 'МФУ Kyocera MA4000x');
});

test('отклонённое только по ресурсу «нужно 10000, у товара 10400» перепроверяется заново и выбирается', async (t) => {
  const { agent, tender, repo, charsOf, rechecked } = setup(t, { econ: { decline: 5 } });
  const id = tender('rv-1', { price: 20000, items: [{ name: 'Картридж Brother TN-2375', quantity: 10, unit: 'шт', unit_price: 2000, characteristics: [] }] });
  const [it] = repo.getItems(id);
  repo.db.prepare('UPDATE tender_items SET spec_json = ? WHERE id = ?').run(JSON.stringify({ identity: { model: 'TN-2375' }, required: [{ name: 'Ресурс', value: '10000', comparator: '=' }] }), it.id);
  const mps = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'a.ru', title: 'Картридж Cactus CS-TN2375-MPS', url: 'https://a.ru/mps', price: 557, match: 'не соответствует', match_notes: ['Не подходит: Ресурс — нужно «10000», у товара «10400»'], match_checks: { rows: [] } });
  repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'b.ru', title: 'Картридж TN-2375 2600 стр', url: 'https://b.ru/s', price: 400, match: 'не соответствует', match_notes: ['Ресурс: нужно 10000, у товара 2600'], match_checks: { rows: [] } });
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 5 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  assert.deepEqual(rechecked, [mps], 'перепроверено только предложение с 10400');
  const x = agent.view().items.find((i) => i.tender_id === id);
  assert.equal(x.summary.items[0].offer.title, 'Картридж Cactus CS-TN2375-MPS');
});

test('совместимый картридж в 10 раз дешевле оригинала у заказчика — нормальная цена, выбирается', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t);
  const id = tender('cm-1', { price: 21524, items: [{ name: 'Картридж для электрографических печатающих устройств', quantity: 2, unit: 'шт', unit_price: 10762, characteristics: [] }] });
  for (const it of repo.getItems(id)) repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'a.ru', title: 'Картридж Pantum TL-5120X, 15K, Grafit', url: 'https://a.ru/1', price: 903, match: 'соответствует', match_checks: { rows: [] } });
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 5 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const x = agent.view().items.find((i) => i.tender_id === id);
  assert.equal(x.summary.items[0].offer?.title, 'Картридж Pantum TL-5120X, 15K, Grafit');
});

test('характеристика выбранного товара не проходит по ТЗ — агент берёт следующий подходящий', async (t) => {
  const { agent, tender, repo, charsOf } = setup(t, { econ: { decline: 5 } });
  const id = tender('cf-1', { price: 30000, items: [{ name: 'Мышь компьютерная', quantity: 10, unit: 'шт', unit_price: 3000, characteristics: [] }] });
  const [it] = repo.getItems(id);
  const cheap = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'a.ru', title: 'Мышь простая 2400 dpi', url: 'https://a.ru/1', price: 800, match: 'частично', match_checks: { total: 4, confirmed: 3, rows: [] } });
  repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'b.ru', title: 'Мышь игровая 12000 dpi', url: 'https://b.ru/1', price: 1500, match: 'частично', match_checks: { total: 4, confirmed: 3, rows: [] } });
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  // таблица заявки: у дешёвой мыши dpi не проходит (строки зависят от выбранного товара позиции)
  charsOf[id] = { trademark: 'x', country: 'Китай' };
  const svcRows = (offerId) => (offerId === cheap ? [{ name: 'Разрешение сенсора', status: 'conflict', tz: 'не менее 10000', product: '2400' }] : []);
  charsOf[id].rowsFor = svcRows;
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 5 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const x = agent.view().items.find((i) => i.tender_id === id);
  assert.equal(x.summary.items[0].offer.title, 'Мышь игровая 12000 dpi');
  assert.ok(agent.view().learning.lessons.some((l) => l.code === 'char_conflict_pick'));
});

test('выгодная закупка — сразу в ленту уведомлений («агент заявок») и в Telegram; повторно — не раньше чем через 7 дней', async (t) => {
  const { agent, tender, repo, charsOf, sent } = setup(t, { econ: { decline: 5 } });
  const id = tender('an-1', { price: 60000, items: [{ name: 'Картридж', quantity: 20, unit: 'шт', unit_price: 3000, characteristics: [] }] });
  for (const it of repo.getItems(id)) repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'a.ru', title: 'Картридж', url: 'https://a.ru/1', price: 1000, match: 'соответствует', match_checks: { rows: [] } });
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  repo.saveEconomics(id, { overrides: {}, result: { verdict: 'выгодно' }, confirmed: false });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['office'], platforms: 'all', margin_min: 5 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const alert = repo.listAlerts().find((a) => a.id === id);
  assert.equal(alert.alert_kind, 'agent');
  assert.ok(alert.alert_profit > 0);
  assert.ok(sent.some((h) => /Агент заявок: выгодно/.test(h) && /#tender\//.test(h)), 'отдельное сообщение в Telegram');
  const n = sent.length;
  await agent.run({ reason: 'manual', tenderIds: [id] });
  assert.equal(sent.filter((h) => /Агент заявок: выгодно/.test(h)).length, 1, 'о той же закупке повторно не пишем');
  assert.ok(sent.length > n, 'отчёт о прогоне приходит');
});

test('при замене товара граница «не ниже» в уведомлении — для нового товара', async (t) => {
  const { agent, tender, nr, repo, charsOf, sent } = setup(t, { econ: { decline: 22 } });
  const id = tender('fl-1', { price: 80000, direction: 'computers', items: [{ name: 'Монитор', quantity: 4, unit: 'шт', unit_price: 20000, characteristics: [] }] });
  nr[id] = 'не установлен';
  for (const it of repo.getItems(id)) {
    const mine = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'a.ru', title: 'Монитор Aquarius', url: 'https://a.ru/1', price: 17520, match: 'соответствует', match_checks: { rows: [] } });
    repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'b.ru', title: 'Монитор Philips', url: 'https://b.ru/1', price: 9706, match: 'соответствует', match_checks: { rows: [] } });
    repo.setItemOffer(it.id, repo.getOffer(mine), 'user');
  }
  repo.updateOfferSearch(repo.createOfferSearch(id), { status: 'done', finished: true });
  repo.saveEconomics(id, { overrides: {}, result: { verdict: 'на грани' }, confirmed: false });
  charsOf[id] = { trademark: 'x', country: 'Россия' };
  agent.saveSettings({ niches: ['computers'], platforms: 'all', margin_min: 10 });
  await agent.run({ reason: 'manual', tenderIds: [id] });
  const x = agent.view().items.find((i) => i.tender_id === id);
  const floor = x.summary.alt.floor.with_margin;
  assert.ok(floor < 80000 && floor < x.summary.econ.floor.with_margin);
  const msg = sent.find((h) => /Агент заявок: выгодно после замены/.test(h));
  assert.match(msg, /не ниже .*\(с заменой товара\)/);
  assert.ok(msg.includes(Math.round(floor).toLocaleString('ru-RU')));
});

test('ЕИС ответил 429 на документацию — прогон останавливается, остальные закупки — в следующий раз', async (t) => {
  const { agent, tender, docsFail } = setup(t);
  const a = tender('eis-1', { price: 50000 });
  tender('eis-2', { price: 50000 });
  docsFail[a] = 'Не удалось скачать документацию из ЕИС (4 файл.): ЕИС ответил 429. Откройте закупку в ЕИС';
  agent.saveSettings({ niches: ['office'], platforms: 'all' });
  const r = await agent.run({ reason: 'manual' });
  assert.equal(r.stats.stopped, 'ЕИС: слишком часто');
  assert.equal(agent.view().items.length, 1, 'вторую закупку не трогали');
});

test('подано заявок: 3 и больше — прибыль при снижении на 10 пунктов больше; в минус — предупреждение, статус не меняется', async (t) => {
  const counts = {};
  const asked = [];
  const bidCounts = { async refresh(tt) { asked.push(tt.number); return counts[tt.number] || null; } };
  const { agent, tender, repo } = setup(t, { bidCounts });
  const many = tender('c-many', { price: 30000 });
  const few = tender('c-few', { price: 30000 });
  const tight = tender('c-tight', { price: 16200 });
  const at = '2026-10-24T01:00:00Z';
  counts['c-many'] = { found: true, count: 5, platform: 'Сбербанк-АСТ', checked_at: at };
  counts['c-few'] = { found: true, count: 1, platform: 'Сбербанк-АСТ', checked_at: at };
  counts['c-tight'] = { found: true, count: 4, platform: 'Сбербанк-АСТ', checked_at: at };
  for (const tid of [many, few, tight]) {
    for (const it of repo.getItems(tid)) {
      const oid = repo.insertOffer({ tender_id: tid, item_id: it.id, source: 'wholesale', domain: 'opt.ru', title: 'Картридж G&G TL-420X', url: 'https://opt.ru/x', price: 600, match: 'соответствует', match_checks: { rows: [{ name: 'Ресурс', need: '6000', verdict: 'yes', found: '6000' }] } });
      repo.setItemOffer(it.id, repo.getOffer(oid), 'auto');
    }
    const sid = repo.createOfferSearch(tid);
    repo.updateOfferSearch(sid, { status: 'done', finished: true });
  }
  agent.saveSettings({ niches: ['office'], margin_min: 5, profit_min: 500, platforms: 'all', per_run: 5 });
  await agent.run({ reason: 'manual' });
  const by = Object.fromEntries(agent.view().items.map((x) => [x.tender_id, x]));
  assert.deepEqual(asked.sort(), ['c-few', 'c-many', 'c-tight']);
  const m = by[many];
  assert.equal(m.summary.competition.count, 5);
  assert.equal(m.summary.competition.stress.pct, m.summary.econ.decline_pct + 10);
  const f = m.findings.find((x) => x.code === 'competition');
  assert.equal(f.level, 'info', 'и при большем снижении в плюс — просто к сведению');
  assert.match(f.text, /подано заявок: 5/);
  assert.equal(by[few].summary.competition.count, 1);
  assert.equal(by[few].findings.find((x) => x.code === 'competition'), undefined, 'одна заявка — не предупреждаем');
  const tf = by[tight].findings.find((x) => x.code === 'competition');
  assert.ok(by[tight].summary.competition.stress.profit < 0, `при снижении на 10 пунктов больше — минус (${by[tight].summary.competition.stress.profit})`);
  assert.equal(tf.level, 'warn');
  assert.match(tf.text, /в минус/);
});

test('задание: «10 выгодных закупок» — число закупок за прогон; «150 тыс.» и «за 3 дня до подачи заявки» — нет', () => {
  const n = (text) => parseTask(text, cleanSettings({}), NICHES).settings.per_run;
  assert.equal(n('Найти 10 выгодных закупок'), 10);
  assert.equal(n('3 выгодные закупки за утро'), 3);
  assert.equal(n('10 закупок'), 10);
  assert.equal(n('Маржа от 10%, закупки до 150 тыс., вся Россия'), DEFAULTS.per_run);
  assert.equal(n('за 3 дня до подачи заявки'), DEFAULTS.per_run);
});

test('прогон, прерванный перезапуском: закрывается, закупка «в работе» возвращается в очередь', (t) => {
  const { agent, tender, repo } = setup(t);
  const a = tender('r-1', { price: 30000 });
  agent.saveSettings({ niches: ['office'], platforms: 'all' });
  repo.db.prepare("INSERT INTO bid_agent_runs (started_at, status, reason, settings_json) VALUES ('2026-10-24T01:00:00Z', 'running', 'manual', '{}')").run();
  repo.db.prepare("INSERT INTO bid_agent_items (run_id, tender_id, status, step, created_at, updated_at) VALUES (1, ?, 'running', 'suppliers', '2026-10-24T01:10:00Z', '2026-10-24T01:10:00Z')").run(a);
  assert.deepEqual(agent.candidates().map((x) => x.id), [], 'закупка «в работе» — не кандидат');
  assert.deepEqual(agent.recoverInterrupted(), { runs: 1, items: 1 });
  const run = repo.db.prepare('SELECT status, finished_at, stats_json FROM bid_agent_runs WHERE id = 1').get();
  assert.equal(run.status, 'error');
  assert.ok(run.finished_at);
  assert.match(run.stats_json, /прерван/);
  assert.deepEqual(agent.candidates().map((x) => x.id), [a], 'следующий прогон возьмёт её снова');
  assert.deepEqual(agent.recoverInterrupted(), { runs: 0, items: 0 });
});

test('закупка «со специальной проверкой»: обычный картридж из магазина — не выгодно, причина названа', async (t) => {
  const { agent, tender, repo } = setup(t);
  const id = tender('sp-1', { price: 69919.95, title: 'Поставка тонер-картриджей со специальной проверкой' });
  for (const it of repo.getItems(id)) {
    const oid = repo.insertOffer({ tender_id: id, item_id: it.id, source: 'wholesale', domain: 'opt.ru', title: 'Тонер-картридж совместимый', url: 'https://opt.ru/x', price: 1500, match: 'соответствует', match_checks: { rows: [{ name: 'Ресурс', need: '6000', verdict: 'yes', found: '6000' }] } });
    repo.setItemOffer(it.id, repo.getOffer(oid), 'auto');
  }
  const sid = repo.createOfferSearch(id);
  repo.updateOfferSearch(sid, { status: 'done', finished: true });
  agent.saveSettings({ niches: ['office'], margin_min: 5, profit_min: 500, platforms: 'all', per_run: 5 });
  await agent.run({ reason: 'manual' });
  const x = agent.view().items.find((i) => i.tender_id === id);
  assert.equal(x.summary.verdict, null, 'не выгодно: товар без спецпроверки');
  assert.match(x.findings.find((f) => f.code === 'special_check').text, /специальной проверкой/);
});
