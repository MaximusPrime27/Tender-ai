// Подготовка заявки, часть А: анкета участника, хранилище его документов и список «что приложить» по закупке.
// Все реквизиты в тестах — вымышленные: номера собраны так, чтобы сходились контрольные разряды, и никому не принадлежат.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const baseConfig = require('../server/config');
const { startServer } = require('../server/server');
const { createFixtureSource } = require('../server/sources/fixture');
const { createLlm } = require('../server/llm');
const { fileCoverage } = require('../server/analyze/coverage');
const { createBidStore } = require('../server/bids/store');
const D = require('../server/bids/dossier');
const { buildChecklist, dossierChecked, applyChecklist, detectDocKinds } = require('../server/bids/checklist');

const FIX = path.join(__dirname, '..', 'samples', 'tenders');
const NOW = new Date('2026-09-17T09:00:00Z');

// ---------- тестовые реквизиты со сходящимися контрольными разрядами ----------
const w = (d, k) => k.reduce((n, x, i) => n + x * Number(d[i]), 0);
const inn12 = (base10) => { const a = base10 + String(w(base10, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11 % 10); return a + String(w(a, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11 % 10); };
const inn10 = (base9) => base9 + String(w(base9, [2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11 % 10);
const ogrnip = (base14) => base14 + String(Number(BigInt(base14) % 13n % 10n));
const ogrn = (base12) => base12 + String(Number(BigInt(base12) % 11n % 10n));
const BIK = '049999123';
/** Счёт, который сходится с БИК: подбирается контрольная цифра (девятая). */
const account = (prefix8, tail11, corr = false) => { for (let k = 0; k < 10; k++) { const a = `${prefix8}${k}${tail11}`; if (D.accountMatchesBik(a, BIK, corr)) return a; } throw new Error('счёт не подобран'); };
const IP = {
  fio: 'Тестов Тест Тестович', inn: inn12('9900000001'), ogrnip: ogrnip('39900000000001'), registered_at: '2020-03-02', address_reg: 'г. Тестовск, ул. Примерная, д. 1',
  phone: '+7 900 000-00-00', email: 'test@example.test', bank_name: 'Тестовый банк', bank_bik: BIK, bank_account: account('40802810', '00000000001'), bank_corr: account('30101810', '00000000123', true),
  tax_regime: 'usn_income', vat_payer: false, sme: 'micro', signer: 'self',
};

test('проверка реквизитов: контрольные разряды ИНН, ОГРНИП, ОГРН; БИК и счёт — по формату', () => {
  assert.ok(D.validInn12(IP.inn));
  assert.ok(!D.validInn12(IP.inn.slice(0, 11) + ((Number(IP.inn[11]) + 1) % 10)), 'одна неверная цифра — не сходится');
  assert.ok(!D.validInn12(inn10('990000001')), 'ИНН организации для ИП не подходит');
  assert.ok(D.validInn10(inn10('990000001')));
  assert.ok(D.validOgrnip(IP.ogrnip) && !D.validOgrnip(IP.ogrnip.slice(0, 14) + ((Number(IP.ogrnip[14]) + 1) % 10)));
  assert.ok(D.validOgrn(ogrn('199000000001')) && !D.validOgrn('1234567890123'.replace(/3$/, '9')));
  assert.ok(D.validBik(BIK) && !D.validBik('04999912') && !D.validBik('04999912A'));
  assert.ok(D.validAccount(IP.bank_account) && !D.validAccount('4080281000000000001') && !D.validAccount('4080281000000000001X'));
  assert.equal(D.accountMatchesBik(IP.bank_account, BIK), true);
  assert.equal(D.accountMatchesBik(IP.bank_corr, BIK, true), true);
  assert.equal(D.accountMatchesBik('1234', BIK), null, 'по неполному номеру не судим');
});

test('анкета ИП не требует ни одного поля организации; неверные ИНН, ОГРНИП, БИК и счёт отклоняются', () => {
  const ok = D.checkDossier('ip', D.normalizeData('ip', IP));
  assert.deepEqual([ok.complete, ok.errors, ok.missing, ok.warnings], [true, [], [], []]);
  const companyOnly = ['full_name', 'short_name', 'kpp', 'ogrn', 'head_fio', 'head_position'];
  assert.ok(!D.FIELDS.ip.some(([key]) => companyOnly.includes(key)), 'в анкете ИП нет полей организации');
  assert.ok(D.DOC_KINDS.filter((k) => ['charter', 'head_appointment', 'major_deal', 'egrul_extract'].includes(k.key)).every((k) => !k.for.includes('ip')), 'устав и решения — не документы ИП');
  // лишние поля отбрасываются, а не сохраняются
  assert.equal(D.normalizeData('ip', { ...IP, kpp: '990001001', passport: '0000 000000' }).kpp, undefined);
  assert.equal(D.normalizeData('ip', { ...IP, passport: '0000 000000' }).passport, undefined, 'паспортных данных в анкете нет');

  const bad = D.checkDossier('ip', D.normalizeData('ip', { ...IP, inn: '123456789012', ogrnip: '312345678901234', bank_bik: '12345', bank_account: '4080281', bank_corr: 'счёт' }));
  assert.deepEqual(bad.errors.map((e) => e.field).sort(), ['bank_account', 'bank_bik', 'bank_corr', 'inn', 'ogrnip']);
  assert.equal(bad.complete, false);
  // пустая анкета — не ошибка, а «не заполнено»
  const empty = D.checkDossier('ip', {});
  assert.deepEqual([empty.errors.length, empty.complete], [0, false]);
  assert.ok(empty.missing.some((m) => m.field === 'fio') && !empty.missing.some((m) => m.field === 'address_post'));
  // подписывает представитель — нужно его ФИО
  assert.ok(D.checkDossier('ip', D.normalizeData('ip', { ...IP, signer: 'representative' })).missing.some((m) => m.field === 'signer_fio'));
  // счёт от другого банка — предупреждение, не отказ
  const other = D.checkDossier('ip', D.normalizeData('ip', { ...IP, bank_account: '40802810100000000001' }));
  assert.ok(other.errors.length === 0 && (other.warnings.length === 1 || D.accountMatchesBik('40802810100000000001', BIK)));
});

// ---------- список «что приложить» ----------
const CLS = { supported: true, scenario: '44_eauction' };
const DEADLINE = '2026-10-10T09:00:00.000Z';
const doc = (o) => ({ id: 1, kind: 'egrip_extract', title: 'Выписка из ЕГРИП', file_name: 'выписка.pdf', issued_at: '2026-09-01', valid_until: null, verified_at: null, archived_at: null, ...o });
const dossierOf = (documents = [], data = IP) => ({ id: 1, kind: 'ip', name: 'ИП Тестов', data, state: D.checkDossier('ip', data), documents });
const req = (o) => ({ applicability: 'applies', obligation: 'mandatory', stage: 'application', channel: 'upload', origin: 'rule', legal_rule_ids: ['r'], sources: [], decision: 'unknown', verification_state: 'unverified', scope: { item_id: null }, evidence_ids: [], ...o });
const composition = req({ id: 'req-doc-application-composition', category: 'structure', origin: 'tender_document', evidence_kind: 'legal_review',
  requirement: 'Состав заявки по документации заказчика: предложение о товаре; выписка из ЕГРИП или выписка из ЕГРЮЛ; доверенность; решение об одобрении крупной сделки',
  sources: [{ file: 'Требования.docx', locator: { page: 2 }, quote: 'выписка из ЕГРИП', verification: 'exact' }] });
const lineOf = (lines, id) => lines.find((l) => l.id === id);

test('документ из хранилища закрывает требование, только если действует на день окончания подачи и проверен', () => {
  assert.deepEqual(detectDocKinds(composition.requirement).map((m) => m.kind), ['egrip_extract', 'egrul_extract', 'power_of_attorney', 'major_deal']);
  const build = (documents, extra = {}) => buildChecklist({ requirements: [composition], classification: CLS, dossier: dossierOf(documents), deadline: DEADLINE, now: NOW, ...extra });

  // документа нет
  let l = lineOf(build([]), 'doc-egrip_extract');
  assert.deepEqual([l.state, l.closure, l.document], ['missing', 'dossier_document', null]);
  assert.match(l.action, /egrul\.nalog\.ru/, 'сказано, где взять документ');
  assert.equal(l.basis.sources[0].file, 'Требования.docx', 'видно, откуда требование');
  // загружен, но не проверен
  assert.equal(lineOf(build([doc()]), 'doc-egrip_extract').state, 'needs_confirm');
  // проверен и действует
  l = lineOf(build([doc({ verified_at: '2026-09-16T10:00:00Z' })]), 'doc-egrip_extract');
  assert.deepEqual([l.state, l.document.id], ['ok', 1]);
  // срок истёк
  assert.equal(lineOf(build([doc({ verified_at: '2026-09-16T10:00:00Z', valid_until: '2026-09-10' })]), 'doc-egrip_extract').state, 'expired');
  // действует сегодня, но истечёт до окончания подачи
  assert.equal(lineOf(build([doc({ verified_at: '2026-09-16T10:00:00Z', valid_until: '2026-10-01' })]), 'doc-egrip_extract').state, 'expires_before_deadline');
  // из двух берётся годный: действующий проверенный, а не истёкший
  l = lineOf(build([doc({ id: 1, verified_at: '2026-09-01T10:00:00Z', valid_until: '2026-09-10' }), doc({ id: 2, verified_at: '2026-09-16T10:00:00Z', valid_until: '2026-12-31' })]), 'doc-egrip_extract');
  assert.deepEqual([l.state, l.document.id, l.candidates.length], ['ok', 2, 2]);
  // архивный документ в подборе не участвует
  assert.equal(lineOf(build([doc({ verified_at: '2026-09-16T10:00:00Z', archived_at: '2026-09-17T00:00:00Z' })]), 'doc-egrip_extract').state, 'missing');

  // документы организаций и доверенность — к сведению: к ИП, который подписывает сам, не относятся
  const lines = build([]);
  assert.equal(lineOf(lines, 'doc-egrul_extract').state, 'info');
  assert.equal(lineOf(lines, 'doc-major_deal').state, 'info');
  assert.equal(lineOf(lines, 'doc-power_of_attorney').state, 'info');
  // подписывает представитель — доверенность обязательна, строка одна
  const rep = buildChecklist({ requirements: [composition], classification: CLS, dossier: dossierOf([], { ...IP, signer: 'representative', signer_fio: 'Иванов И. И.' }), deadline: DEADLINE, now: NOW });
  assert.deepEqual([lineOf(rep, 'signer-poa').state, lineOf(rep, 'doc-power_of_attorney')], ['missing', undefined]);

  // человек выбрал другой документ или отметил «не требуется» — исходный вывод сервиса сохраняется
  const two = [doc({ id: 1, verified_at: '2026-09-16T10:00:00Z' }), doc({ id: 2 })];
  l = lineOf(build(two, { choices: [{ line_id: 'doc-egrip_extract', document_id: 2 }] }), 'doc-egrip_extract');
  assert.deepEqual([l.state, l.document.id, l.choice.document_id], ['needs_confirm', 2, 2]);
  l = lineOf(build([], { choices: [{ line_id: 'doc-egrip_extract', not_required: true, reason: 'Выписку передаёт площадка', by: 'Тестов' }] }), 'doc-egrip_extract');
  assert.deepEqual([l.state, l.auto_state, l.choice.reason], ['not_required', 'missing', 'Выписку передаёт площадка']);
});

test('участник и документы проверены — только при заполненной анкете, действующей регистрации и годных документах', () => {
  const operator = req({ id: 'req-44-43-participant-operator', category: 'participant', evidence_kind: 'registry_check', stage: 'registration', channel: 'operator_supplied', requirement: 'Сведения об участнике направляет оператор площадки' });
  const decl = req({ id: 'req-44-43-declaration', category: 'participant', evidence_kind: 'attestation', channel: 'action', requirement: 'Декларация о соответствии' });
  const price = req({ id: 'req-44-49-auction-price', category: 'price', evidence_kind: 'price_confirmation', stage: 'auction', channel: 'action', requirement: 'Цена подаётся на торгах' });
  const all = [operator, decl, price, composition];
  const run = (dossier) => { const lines = buildChecklist({ requirements: all, classification: CLS, dossier, deadline: DEADLINE, now: NOW }); return { lines, ok: dossierChecked(lines, dossier) }; };
  const good = [doc({ verified_at: '2026-09-16T10:00:00Z' })];
  const eruz = { eruz_number: '26000001', eruz_valid_until: '2028-01-01', eruz_checked_at: '2026-09-16' };

  // анкеты нет
  let r = run(null);
  assert.deepEqual([r.ok, lineOf(r.lines, 'dossier-data').state, lineOf(r.lines, 'line-req-44-43-participant-operator').state], [false, 'missing', 'missing']);
  // анкета есть, регистрация в реестре участников не сверена
  r = run(dossierOf(good));
  assert.deepEqual([r.ok, lineOf(r.lines, 'line-req-44-43-participant-operator').state], [false, 'needs_confirm']);
  // всё есть
  r = run(dossierOf(good, { ...IP, ...eruz }));
  assert.equal(r.ok, true);
  assert.equal(lineOf(r.lines, 'line-req-44-43-declaration').state, 'needs_confirm', 'декларация — отдельное подтверждение, на проверку участника не влияет');
  assert.equal(lineOf(r.lines, 'line-req-44-49-auction-price').state, 'info', 'цена на торгах в состав заявки не входит');
  // решение реестра получает основание из анкеты
  const applied = applyChecklist(all, r.lines).find((x) => x.id === operator.id);
  assert.deepEqual([applied.decision, applied.verification_state], ['pass', 'verified']);
  assert.match(applied.reason, /2028-01-01/);
  assert.equal(applyChecklist(all, r.lines).find((x) => x.id === decl.id).decision, 'unknown', 'декларацию анкета не подтверждает');
  // регистрация закончится до окончания подачи; документ не проверен; в анкете пропуск — каждый случай снимает «проверено»
  assert.equal(run(dossierOf(good, { ...IP, ...eruz, eruz_valid_until: '2026-10-01' })).ok, false);
  assert.equal(lineOf(run(dossierOf(good, { ...IP, ...eruz, eruz_valid_until: '2026-09-01' })).lines, 'line-req-44-43-participant-operator').state, 'expired');
  assert.equal(run(dossierOf([doc()], { ...IP, ...eruz })).ok, false);
  assert.equal(run(dossierOf(good, { ...IP, ...eruz, bank_account: undefined })).ok, false);
  // сценарий не поддержан — списка нет
  assert.deepEqual(buildChecklist({ requirements: all, classification: { supported: false }, dossier: dossierOf(good), deadline: DEADLINE, now: NOW }), []);
});

test('товар в списке — одной строкой на позицию: не выбран, не подтверждён, не соответствует', () => {
  const rule = req({ id: 'req-44-43-object-proposal-item-7', category: 'technical', evidence_kind: 'product', channel: 'etp_field', scope: { item_id: 7 }, requirement: 'Предложение о товаре — позиция «Коммутатор»' });
  const tz = (n, o) => req({ id: `req-item-7-${n}`, category: 'technical', origin: 'tender_document', evidence_kind: 'product', channel: 'etp_field', scope: { item_id: 7 }, requirement: `Показатель ${n}`, ...o });
  const build = (list) => lineOf(buildChecklist({ requirements: [rule, ...list], classification: CLS, dossier: dossierOf(), deadline: DEADLINE, now: NOW, itemNames: new Map([[7, 'Коммутатор управляемый']]) }), 'item-7');
  assert.deepEqual([build([tz(1, { reason: 'Товар для этой позиции не выбран' })]).state, build([tz(1, { reason: 'Товар для этой позиции не выбран' })]).closure], ['missing', 'product']);
  assert.equal(build([tz(1, { decision: 'fail' }), tz(2, { decision: 'pass' })]).state, 'missing');
  assert.match(build([tz(1, { decision: 'pass' }), tz(2)]).note, /не подтверждено документом изготовителя: 1/);
  const ok = build([tz(1, { decision: 'pass' }), tz(2, { decision: 'pass' })]);
  assert.deepEqual([ok.state, /Коммутатор управляемый/.test(ok.title)], ['ok', true]);
});

// ---------- через сервис ----------
function start() {
  const mock = createLlm('mock');
  let now = new Date(NOW);
  const config = {
    ...baseConfig, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-dossier-')), PORT: 0, LLM_PROVIDER: 'mock', TENDER_SOURCE: 'fixture', FIXTURES_DIR: FIX, TELEGRAM_BOT_TOKEN: '', SUPPLIER_INDEX: false,
    OFFER_SOURCES: 'manual', DADATA_API_KEY: '', YANDEX_SEARCH_API_KEY: '', ECONOMICS_MAX_PER_SYNC: 0, RESALE_ECONOMICS_PER_SYNC: 0, RESALE_AUTO_SEARCH_PER_SYNC: 0, REREAD_ON_OPEN_PER_DAY: 0, RESALE_DOCS_PER_SYNC: 0, PLATFORM_FETCH_PER_SYNC: 0, STAGE_CHECK_PER_SYNC: 0,
  };
  const s = startServer(config, { scheduler: false, llmFactory: () => mock, log: { log() {}, warn() {}, error() {} }, clock: () => now, sourceOverride: createFixtureSource({ dir: FIX }) });
  const url = (p) => `http://127.0.0.1:${s.server.address().port}${p}`;
  const api = async (p, opts = {}) => {
    const res = await fetch(url(p), { ...opts, headers: opts.json ? { 'Content-Type': 'application/json' } : opts.headers, body: opts.json ? JSON.stringify(opts.json) : opts.body });
    return { status: res.status, body: await res.json().catch(() => null), res };
  };
  const upload = (fields, name = 'выписка.pdf', content = '%PDF-1.4 тестовый файл') => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    fd.append('file', new Blob([content], { type: 'application/pdf' }), name);
    return api('/api/dossier/documents', { method: 'POST', body: fd });
  };
  return { s, api, upload, url, mock, config, tick: (days) => { now = new Date(now.getTime() + days * 86400000); } };
}

test('анкета и документы через сервис: сохранение, загрузка, замена, проверка, скачивание без изменений', async () => {
  const { s, api, upload, url, config } = start();
  try {
    assert.equal((await api('/api/dossier')).body.dossier, null);
    assert.equal((await upload({ kind: 'egrip_extract', title: 'Выписка' })).status, 409, 'сначала анкета');
    // неверный ИНН — отказ с названием поля; анкета не создаётся
    let r = await api('/api/dossier', { method: 'PUT', json: { kind: 'ip', data: { ...IP, inn: '123456789012' } } });
    assert.deepEqual([r.status, r.body.fields[0].field], [400, 'inn']);
    assert.equal((await api('/api/dossier')).body.dossier, null);
    // частично заполненная анкета сохраняется: видно, чего не хватает
    r = await api('/api/dossier', { method: 'PUT', json: { kind: 'ip', data: { fio: IP.fio, inn: IP.inn } } });
    assert.deepEqual([r.status, r.body.dossier.state.complete, r.body.dossier.name], [200, false, `ИП ${IP.fio}`]);
    r = await api('/api/dossier', { method: 'PUT', json: { kind: 'ip', data: IP } });
    assert.equal(r.body.dossier.state.complete, true);
    assert.ok(r.body.doc_kinds.some((k) => k.key === 'egrip_extract') && r.body.fields.ip.some((f) => f.key === 'ogrnip'));

    // документ: вид организации для ИП не принимается; без файла — отказ
    assert.equal((await upload({ kind: 'charter', title: 'Устав' })).status, 400);
    assert.equal((await api('/api/dossier/documents', { method: 'POST', body: (() => { const fd = new FormData(); fd.append('kind', 'egrip_extract'); return fd; })() })).status, 400);
    r = await upload({ kind: 'egrip_extract', title: 'Выписка из ЕГРИП от 01.09.2026', issued_at: '2026-09-01' });
    assert.equal(r.status, 200);
    const first = r.body.dossier.documents[0];
    assert.deepEqual([first.kind, first.file_name, first.verified_at, first.status, first.sha256.length], ['egrip_extract', 'выписка.pdf', null, 'ok', 64]);
    // файл лежит в папке досье, вне public, и отдаётся без изменений
    const stored = s.repo.db.prepare('SELECT path FROM participant_documents WHERE id = ?').get(first.id).path;
    assert.ok(stored.startsWith(path.join(config.DATA_DIR, 'uploads', `dossier-${r.body.dossier.id}`)) && !stored.includes(`${path.sep}public${path.sep}`));
    const got = await fetch(url(`/api/dossier/documents/${first.id}/download`));
    assert.equal(Buffer.from(await got.arrayBuffer()).toString('utf8'), '%PDF-1.4 тестовый файл');
    // отметка «проверено мной» — только с именем
    assert.equal((await api(`/api/dossier/documents/${first.id}`, { method: 'PUT', json: { verified: true } })).status, 400);
    r = await api(`/api/dossier/documents/${first.id}`, { method: 'PUT', json: { verified: true, by: 'Тестов', valid_until: '2026-09-30' } });
    const checked = r.body.dossier.documents[0];
    assert.deepEqual([checked.verified_by, checked.valid_until, checked.status], ['Тестов', '2026-09-30', 'expiring'], 'истекает в ближайшие 30 дней — отмечено');
    // замена: новая запись, прежняя в архиве, проверку нужно поставить заново
    r = await upload({ kind: 'egrip_extract', title: 'Выписка из ЕГРИП от 17.09.2026', issued_at: '2026-09-17', replaces: first.id }, 'выписка-новая.pdf', '%PDF-1.4 новый файл');
    assert.deepEqual(r.body.dossier.documents.map((d) => [d.title, d.verified_at]), [['Выписка из ЕГРИП от 17.09.2026', null]]);
    assert.ok(s.repo.db.prepare('SELECT archived_at FROM participant_documents WHERE id = ?').get(first.id).archived_at);
    // убрать в архив
    assert.equal((await api(`/api/dossier/documents/${r.body.dossier.documents[0].id}`, { method: 'DELETE' })).body.dossier.documents.length, 0);
  } finally { await s.close(); }
});

test('заявка: список «что приложить», проверка участника, устаревание при изменении анкеты или документа', async () => {
  const { s, api, upload, mock, tick } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0132600015226000103'").get().id;
    s.repo.db.prepare('UPDATE tenders SET deadline_at = ? WHERE id = ?').run('2026-10-10T09:00:00.000Z', id);
    const aId = 'a-dossier-1';
    s.repo.createAnalysis({ id: aId, title: 'Документация' });
    s.repo.addFile(aId, { name: 'Извещение.docx', status: 'ok', sha256: 'h1', coverage: fileCoverage({ unit: 'block', expected: 1, processed: 1 }),
      pages: [{ page: 1, text: 'Объект закупки: поставка коммутаторов. Заявка должна содержать: предложение участника в отношении объекта закупки, выписку из ЕГРИП для индивидуальных предпринимателей.' }] });
    const analysis = await require('../server/analyze').analyzeDocs(s.repo.getFilesFull(aId), mock, { maxChars: 24000 });
    s.repo.finishAnalysis(aId, { card: analysis.card, provider: 'mock', model: 'rules-v1', durationMs: 1 });
    s.repo.setTenderAnalysis(id, aId);

    // анкеты ещё нет: список построен, участник не проверен
    let v = (await api(`/api/tenders/${id}/bids`, { method: 'POST' })).body;
    const cond = (view, key) => view.readiness.conditions.find((c) => c.key === key).ok;
    assert.equal(v.dossier.exists, false);
    assert.deepEqual([lineOf(v.checklist, 'dossier-data').state, lineOf(v.checklist, 'doc-egrip_extract').state, cond(v, 'checks')], ['missing', 'missing', false]);
    assert.equal(lineOf(v.checklist, 'doc-egrip_extract').basis.sources[0].file, 'Извещение.docx');

    // анкета заполнена, документ загружен и проверен, регистрация в реестре участников сверена
    await api('/api/dossier', { method: 'PUT', json: { kind: 'ip', data: { ...IP, eruz_number: '26000001', eruz_valid_until: '2028-01-01', eruz_checked_at: '2026-09-16' } } });
    const docId = (await upload({ kind: 'egrip_extract', title: 'Выписка из ЕГРИП', issued_at: '2026-09-01' })).body.dossier.documents[0].id;
    v = (await api(`/api/tenders/${id}/bids`)).body;
    assert.equal(v.status, 'stale', 'анкета появилась после проверки — заявка устарела');
    v = (await api(`/api/bids/${v.id}/validate`, { method: 'POST' })).body;
    assert.deepEqual([v.stale, v.dossier.complete, lineOf(v.checklist, 'dossier-data').state, lineOf(v.checklist, 'doc-egrip_extract').state], [false, true, 'ok', 'needs_confirm']);
    await api(`/api/dossier/documents/${docId}`, { method: 'PUT', json: { verified: true, by: 'Тестов' } });
    v = (await api(`/api/bids/${v.id}/validate`, { method: 'POST' })).body;
    assert.deepEqual([lineOf(v.checklist, 'doc-egrip_extract').state, lineOf(v.checklist, 'line-req-44-43-participant-operator').state], ['ok', 'ok']);
    assert.equal(v.requirements.find((r) => r.id === 'req-44-43-participant-operator').decision, 'pass', 'проверенная регистрация закрывает требование без отдельной кнопки');
    // товар не выбран — условие «проверены участник и товары» ещё не выполнено, хотя участник проверен
    assert.equal(cond(v, 'checks'), false);
    assert.ok(v.checklist.filter((l) => l.closure === 'product').every((l) => l.state !== 'ok'));

    // изменение анкеты и замена документа — проверенная заявка устаревает
    await api('/api/dossier', { method: 'PUT', json: { kind: 'ip', data: { ...IP, phone: '+7 900 000-00-01', eruz_number: '26000001', eruz_valid_until: '2028-01-01', eruz_checked_at: '2026-09-16' } } });
    assert.equal((await api(`/api/bids/${v.id}`)).body.status, 'stale');
    v = (await api(`/api/bids/${v.id}/validate`, { method: 'POST' })).body;
    assert.equal(v.stale, false);
    await upload({ kind: 'egrip_extract', title: 'Выписка новая', issued_at: '2026-09-17', replaces: docId }, 'новая.pdf', '%PDF-1.4 другой файл');
    v = (await api(`/api/bids/${v.id}`)).body;
    assert.deepEqual([v.status, lineOf(v.checklist, 'doc-egrip_extract').state], ['stale', 'needs_confirm'], 'новый файл не проверен');

    // решение человека по строке: «не требуется» — только с причиной и именем; отзыв возвращает вывод сервиса
    v = (await api(`/api/bids/${v.id}/validate`, { method: 'POST' })).body;
    assert.equal((await api(`/api/bids/${v.id}/checklist`, { method: 'POST', json: { line_id: 'doc-egrip_extract', not_required: true, reason: 'мало' } })).status, 400);
    assert.equal((await api(`/api/bids/${v.id}/checklist`, { method: 'POST', json: { line_id: 'нет-такой', not_required: true, reason: 'Выписку передаёт площадка', by: 'Тестов' } })).status, 404);
    v = (await api(`/api/bids/${v.id}/checklist`, { method: 'POST', json: { line_id: 'doc-egrip_extract', not_required: true, reason: 'Выписку передаёт оператор площадки', by: 'Тестов' } })).body;
    assert.deepEqual([lineOf(v.checklist, 'doc-egrip_extract').state, lineOf(v.checklist, 'doc-egrip_extract').auto_state], ['not_required', 'needs_confirm']);
    v = (await api(`/api/bids/${v.id}/checklist`, { method: 'POST', json: { line_id: 'doc-egrip_extract', revoke: true } })).body;
    assert.equal(lineOf(v.checklist, 'doc-egrip_extract').state, 'needs_confirm');
    // выбрать можно только документ подходящего вида из хранилища
    assert.equal((await api(`/api/bids/${v.id}/checklist`, { method: 'POST', json: { line_id: 'doc-egrip_extract', document_id: 99999 } })).status, 400);
    assert.equal((await api(`/api/bids/${v.id}/checklist`, { method: 'POST', json: { line_id: 'dossier-data', document_id: docId } })).status, 409);

    // срок: документ с окончанием действия раньше окончания подачи заявку не закрывает
    const fresh = (await api('/api/dossier')).body.dossier.documents[0];
    await api(`/api/dossier/documents/${fresh.id}`, { method: 'PUT', json: { verified: true, by: 'Тестов', valid_until: '2026-10-01' } });
    v = (await api(`/api/bids/${v.id}/validate`, { method: 'POST' })).body;
    assert.equal(lineOf(v.checklist, 'doc-egrip_extract').state, 'expires_before_deadline');
    tick(20); // 7 октября: документ истёк
    assert.equal(lineOf((await api(`/api/bids/${v.id}`)).body.checklist, 'doc-egrip_extract').state, 'expired');
  } finally { await s.close(); }
});

test('хранилище заявок на прежней базе: новые таблица и колонка добавляются, данные не теряются', () => {
  const db = new DatabaseSync(':memory:');
  // база до этой доработки: таблица документов без имени файла
  db.exec(`CREATE TABLE participant_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, dossier_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, path TEXT, sha256 TEXT, issued_at TEXT, valid_until TEXT,
    scope TEXT, original INTEGER NOT NULL DEFAULT 0, verified_at TEXT, verified_by TEXT, source TEXT, restrictions TEXT, archived_at TEXT, created_at TEXT NOT NULL);
    INSERT INTO participant_documents (dossier_id, kind, title, created_at) VALUES (1, 'other', 'старый документ', '2026-01-01');`);
  createBidStore(db);
  createBidStore(db); // повторный запуск ничего не ломает
  assert.ok(db.prepare('PRAGMA table_info(participant_documents)').all().some((c) => c.name === 'file_name'));
  assert.equal(db.prepare('SELECT title FROM participant_documents').get().title, 'старый документ');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'bid_checklist_choices'").get().n, 1);
});

// ====================== часть Б: файлы заявки, повторное чтение, папка для переноса ======================
const AdmZip = require('adm-zip');
const { buildPackage, verifyFile, partFor, hasTodo } = require('../server/bids/package');
const { makeDocx } = require('../server/bids/docx-writer');
const { extractFile } = require('../server/extract');
const readBack = (f) => extractFile(f, 0, {});
const textOf = async (buffer, name = 'файл.docx') => (await readBack({ name, buffer })).flatMap((p) => p.pages.map((pg) => pg.text)).join('\n');
const sum = (buf) => require('node:crypto').createHash('sha256').update(buf).digest('hex');

const TENDER = { id: 1, law: '44', number: '0000000000000000001', title: 'Поставка коммутаторов (тест)', deadline_at: DEADLINE };
const ITEMS = [{ id: 7, name: 'Коммутатор управляемый', quantity: 4, unit: 'шт' }];
const tzReq = (n, field, value, o = {}) => req({ id: `req-item-7-${n}`, category: 'technical', origin: 'tender_document', evidence_kind: 'product', channel: 'etp_field', scope: { item_id: 7 },
  requirement: `${field}: ${value}`, normalized: { field, operator: '>=', value }, ...o });
const CHOSEN = new Map([[7, { offer: { id: 1, title: 'Коммутатор Тест-24G', seller: 'ООО Поставщик-тест', unit_price: 11111.11 }, rows: [] }]]);
const fileOf = (pkg, id) => pkg.files.find((f) => f.id === id);

test('части заявки по сценарию: товар, участник и цена не попадают в неподходящую часть', () => {
  assert.deepEqual(['product', 'participant', 'price'].map((k) => partFor(k, '44_eauction')), ['application', null, null], '44-ФЗ: сведения об участнике передаёт площадка, цена — на торгах');
  assert.equal(partFor('price', '44_equotation'), 'application');
  assert.deepEqual(['product', 'participant', 'price'].map((k) => partFor(k, '223_sme_eauction')), ['part-1', 'part-2', null]);
  assert.deepEqual(['product', 'participant', 'price'].map((k) => partFor(k, '223_sme_ecompetition')), ['part-1', 'part-2', 'price']);
  assert.deepEqual(['product', 'participant', 'price'].map((k) => partFor(k, '223_sme_equotation')), ['application', 'application', 'application']);
});

test('файлы составляются из подтверждённых данных; неизвестное — метка «заполнить»; цена — только утверждённая', async () => {
  const reqs = [tzReq(1, 'Число портов', 'не менее 24', { decision: 'pass', candidate_value: '24' }), tzReq(2, 'Скорость портов', '1 Гбит/с', { decision: 'unknown', candidate_value: '1 Гбит/с' }), tzReq(3, 'Гарантия', 'не менее 12 мес.'),
    req({ id: 'req-44-50-quotation-price', category: 'price', evidence_kind: 'price_confirmation', channel: 'etp_field', requirement: 'Ценовое предложение входит в состав заявки' }),
    req({ id: 'req-44-43-declaration', category: 'participant', evidence_kind: 'attestation', channel: 'action', requirement: 'Декларация' })];
  const base = { tender: TENDER, classification: { supported: true, scenario: '44_equotation', law: '44', procedure_title: 'запрос котировок' }, requirements: reqs, items: ITEMS, chosen: CHOSEN, dossier: dossierOf() };

  // цена не утверждена: в файле метка, а не «рекомендуемая» цена
  let pkg = buildPackage(base);
  let price = fileOf(pkg, 'price-proposal');
  assert.equal(price.part, 'application');
  assert.ok(hasTodo(price.expect[0].value) && price.todo >= 1);
  assert.match(await textOf(price.buffer), /\[ЗАПОЛНИТЬ: цена предложения/);
  assert.equal(pkg.fields.find((f) => f.key === 'price').filled, false);
  // утверждена — в файле именно она; НДС — только по ответу в анкете
  pkg = buildPackage({ ...base, price: { value: 300000.5, by: 'Тестов', at: '2026-09-17T09:00:00Z' } });
  price = fileOf(pkg, 'price-proposal');
  const priceText = await textOf(price.buffer);
  assert.match(priceText, /300\s000,50 руб\./);
  assert.match(priceText, /НДС не облагается/);
  assert.equal(price.todo, 0);
  assert.equal(hasTodo(fileOf(buildPackage({ ...base, dossier: dossierOf([], { ...IP, vat_payer: true }), price: { value: 1 } }), 'price-proposal').expect[1].value), true, 'плательщик НДС — ставку и сумму сервис не выдумывает');

  // предложение о товаре: подтверждённое значение — как есть; найденное у продавца — показано и посчитано; неизвестное — метка
  const product = fileOf(pkg, 'product-proposal');
  const text = await textOf(product.buffer);
  assert.match(text, /Коммутатор Тест-24G/);
  assert.match(text, /Число портов.*не менее 24.*24/);
  assert.match(text, /\[ЗАПОЛНИТЬ: «Гарантия»/);
  assert.match(text, /\[ЗАПОЛНИТЬ: страна происхождения/);
  assert.deepEqual([product.unconfirmed, product.todo > 0], [1, true]);
  assert.ok(pkg.problems.some((p) => p.kind === 'unconfirmed_values'));
  assert.equal(pkg.fields.find((f) => f.key === 'item-7-req-item-7-2').filled, false, 'неподтверждённое значение в поле площадки не подставляется');
  assert.equal(pkg.fields.find((f) => f.key === 'item-7-req-item-7-1').value, '24');
  // по 44-ФЗ сведения об участнике файлом не подаются, декларация — действие на площадке
  assert.equal(fileOf(pkg, 'participant-info'), undefined);
  assert.ok(pkg.actions.some((a) => a.kind === 'registry') && pkg.actions.some((a) => a.kind === 'declaration'));
  // таблица Excel читается и содержит те же строки
  assert.match(await textOf(fileOf(pkg, 'product-table').buffer, 'Показатели товара.xlsx'), /Число портов/);
  // закупочной цены, продавца и прибыли в файлах для площадки нет
  for (const f of pkg.files) assert.doesNotMatch(await textOf(f.buffer, f.path.split('/').pop()), /11\s?111|Поставщик-тест|прибыл|марж/i, f.path);

  // не выбран товар — метка вместо модели
  assert.ok(hasTodo(fileOf(buildPackage({ ...base, chosen: new Map() }), 'product-proposal').expect[0].value));
  // сценарий не поддержан или структура конкурса не установлена — файлов нет, причина названа
  const unsupported = buildPackage({ ...base, classification: { supported: false } });
  assert.deepEqual([unsupported.files.length, unsupported.problems[0].kind], [0, 'unsupported']);
  assert.equal(buildPackage({ ...base, classification: { supported: true, scenario: '44_ecompetition', variant: 'unknown' } }).problems[0].kind, 'structure_unknown');
});

test('закупка для малого бизнеса по 223-ФЗ: в первой части нет сведений об участнике, они — во второй', async () => {
  const pkg = buildPackage({ tender: { ...TENDER, law: '223' }, classification: { supported: true, scenario: '223_sme_eauction', law: '223' }, requirements: [tzReq(1, 'Число портов', 'не менее 24', { decision: 'pass', candidate_value: '24' })], items: ITEMS, chosen: CHOSEN, dossier: dossierOf() });
  const first = fileOf(pkg, 'product-proposal');
  assert.equal(first.part, 'part-1');
  const text = await textOf(first.buffer);
  assert.ok(!text.includes(IP.inn) && !text.includes(IP.fio), 'в первой части нет ИНН и ФИО участника');
  assert.equal((await verifyFile(first, readBack)).issues.some((i) => i.kind === 'leak'), false);
  const second = fileOf(pkg, 'participant-info');
  assert.equal(second.part, 'part-2');
  assert.ok((await textOf(second.buffer)).includes(IP.inn));
  assert.equal(fileOf(pkg, 'price-proposal'), undefined, 'в аукционе цена подаётся на торгах');
  // сведения об участнике, попавшие в первую часть, повторное чтение находит
  const leaked = { ...first, buffer: makeDocx([{ p: `Участник: ${IP.fio}, ИНН ${IP.inn}` }, { table: [['Показатель', 'Требование', 'Значение'], ...first.expect.map((e) => [e.label, '', e.value])] }]) };
  assert.ok((await verifyFile(leaked, readBack)).issues.some((i) => i.kind === 'leak'));
});

test('повторное чтение: потерянная строка, пустое обязательное поле, метка «заполнить», изменённый оригинал', async () => {
  const expect = [{ label: 'Число портов', value: '24', required: true }, { label: 'Скорость портов', value: '1 Гбит/с', required: true }, { label: 'Гарантия', value: '12 месяцев', required: true }];
  const make = (rows) => ({ kind: 'generated', path: 'uploads/application/Предложение о товаре.docx', expect, buffer: makeDocx([{ h: 'Предложение' }, { table: [['Показатель', 'Значение'], ...rows] }]) });
  const kinds = async (f) => (await verifyFile(f, readBack)).issues.map((i) => i.kind);
  // всё на месте
  assert.deepEqual(await verifyFile(make(expect.map((e) => [e.label, e.value])), readBack), { ok: true, issues: [] });
  // строка пропала
  assert.deepEqual(await kinds(make(expect.slice(0, 2).map((e) => [e.label, e.value]))), ['row_lost']);
  // подпись есть, значения нет
  assert.deepEqual(await kinds(make([['Число портов', '24'], ['Скорость портов', ''], ['Гарантия', '12 месяцев']])), ['value_lost']);
  // обязательное значение пустое уже в исходных данных
  assert.deepEqual(await kinds({ ...make([['Число портов', '']]), expect: [{ label: 'Число портов', value: '', required: true }] }), ['value_lost']);
  // осталась метка
  const marked = { ...make([['Число портов', '24'], ['Скорость портов', '1 Гбит/с'], ['Гарантия', '[ЗАПОЛНИТЬ: гарантия]']]), expect: [...expect.slice(0, 2), { label: 'Гарантия', value: '[ЗАПОЛНИТЬ: гарантия]', required: true }] };
  assert.deepEqual(await kinds(marked), ['placeholder']);
  // файл не читается
  assert.deepEqual(await kinds({ ...make([]), buffer: Buffer.from('не документ') }), ['unreadable']);
  // оригинал участника: сверяется контрольная сумма
  const orig = Buffer.from('%PDF-1.4 оригинал');
  assert.equal((await verifyFile({ kind: 'original', path: 'uploads/application/выписка.pdf', buffer: orig, expected_sha256: sum(orig) }, readBack)).ok, true);
  assert.deepEqual(await kinds({ kind: 'original', path: 'uploads/application/выписка.pdf', buffer: Buffer.from('%PDF-1.4 подменён'), expected_sha256: sum(orig) }), ['changed']);
});

test('через сервис: цена, черновик, повторная проверка, выгрузка — и чего в архиве для площадки нет', async () => {
  const { s, api, upload, url, mock } = start();
  try {
    await s.sync.run();
    const id = s.repo.db.prepare("SELECT id FROM tenders WHERE number = '0333200014626000140'").get().id; // запрос котировок: цена — в заявке
    const aId = 'a-pack-1';
    s.repo.createAnalysis({ id: aId, title: 'Документация' });
    s.repo.addFile(aId, { name: 'Извещение.docx', status: 'ok', sha256: 'h1', coverage: fileCoverage({ unit: 'block', expected: 1, processed: 1 }),
      pages: [{ page: 1, text: 'Объект закупки: поставка товара. Заявка должна содержать: предложение участника в отношении объекта закупки, выписку из ЕГРИП.' }] });
    const formPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ai-form-')), 'форма.docx');
    fs.writeFileSync(formPath, makeDocx([{ p: 'Форма заявки заказчика' }]));
    s.repo.addFile(aId, { name: 'Форма заявки на участие.docx', path: formPath, status: 'ok', sha256: 'h2', coverage: fileCoverage({ unit: 'block', expected: 1, processed: 1 }), pages: [{ page: 1, text: 'Форма заявки заказчика' }] });
    const analysis = await require('../server/analyze').analyzeDocs(s.repo.getFilesFull(aId), mock, { maxChars: 24000 });
    s.repo.finishAnalysis(aId, { card: analysis.card, provider: 'mock', model: 'rules-v1', durationMs: 1 });
    s.repo.setTenderAnalysis(id, aId);
    await api('/api/dossier', { method: 'PUT', json: { kind: 'ip', data: { ...IP, eruz_number: '26000001', eruz_valid_until: '2028-01-01', eruz_checked_at: '2026-09-16' } } });
    const docId = (await upload({ kind: 'egrip_extract', title: 'Выписка из ЕГРИП', issued_at: '2026-09-01' }, 'выписка.pdf', '%PDF-1.4 оригинал выписки')).body.dossier.documents[0].id;
    await api(`/api/dossier/documents/${docId}`, { method: 'PUT', json: { verified: true, by: 'Тестов' } });

    await api(`/api/tenders/${id}`); // карточка закупки: позиции загружаются из извещения
    await s.details.idle();
    assert.ok(s.repo.getItems(id).length > 0);
    let v = (await api(`/api/tenders/${id}/bids`, { method: 'POST' })).body;
    assert.equal(v.scenario.scenario, '44_equotation');
    const cond = (view, key) => view.readiness.conditions.find((c) => c.key === key).ok;
    assert.deepEqual([cond(v, 'price'), cond(v, 'postcheck'), v.package.built, v.package.price], [false, false, null, { own: null, approved: null }]);

    // цена: без своей цены утверждать нечего; рекомендуемая сама не подставляется
    assert.equal((await api(`/api/bids/${v.id}/price`, { method: 'POST', json: { by: 'Тестов' } })).status, 409);
    assert.equal((await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { price: 300000 } })).status, 200);
    assert.equal((await api(`/api/bids/${v.id}/price`, { method: 'POST', json: {} })).status, 400, 'нужно имя утверждающего');
    v = (await api(`/api/bids/${v.id}/price`, { method: 'POST', json: { by: 'Тестов' } })).body;
    assert.deepEqual([cond(v, 'price'), v.package.price.approved.price, v.requirements.find((r) => r.category === 'price').decision], [true, 300000, 'pass']);
    // изменили цену — утверждение больше не действует
    await api(`/api/tenders/${id}/economics`, { method: 'POST', json: { price: 290000 } });
    v = (await api(`/api/bids/${v.id}/validate`, { method: 'POST' })).body;
    assert.deepEqual([cond(v, 'price'), v.package.price], [false, { own: 290000, approved: null }]);
    v = (await api(`/api/bids/${v.id}/price`, { method: 'POST', json: { by: 'Тестов' } })).body;

    // декларация: каждое положение — отдельно; неполный список не принимается
    assert.ok(v.package.declaration.statements.length >= 8 && v.package.declaration.status === 'draft');
    assert.ok(!v.package.declaration.statements.some((x) => x.id === 'p7_1'), 'положение только для организаций у ИП не показывается');
    const ids = v.package.declaration.statements.map((x) => x.id);
    assert.equal((await api(`/api/bids/${v.id}/attestations`, { method: 'POST', json: { requirement_id: 'req-44-43-declaration', by: 'Тестов', statements: ids.slice(0, 3) } })).status, 400);
    v = (await api(`/api/bids/${v.id}/attestations`, { method: 'POST', json: { requirement_id: 'req-44-43-declaration', by: 'Тестов', statements: ids } })).body;
    assert.ok(v.package.declaration.statements.every((x) => x.confirmed));

    // черновик: файлы составлены, прочитаны обратно, в них метки — товар не выбран
    v = (await api(`/api/bids/${v.id}/draft`, { method: 'POST' })).body;
    const built = v.package.built;
    const byId = (fid) => built.files.find((f) => f.id === fid);
    assert.deepEqual([built.version, built.current, built.postcheck_ok, cond(v, 'postcheck')], [1, true, false, false]);
    assert.ok(byId('product-proposal').todo > 0 && byId('product-proposal').check.issues.some((i) => i.kind === 'placeholder'));
    assert.deepEqual([byId('price-proposal').todo, byId('price-proposal').check.ok, byId('price-proposal').part], [0, true, 'application']);
    assert.deepEqual([byId(`original-${docId}`).kind, byId(`original-${docId}`).check.ok], ['original', true]);
    assert.ok(built.files.some((f) => f.kind === 'form' && /Форма заявки на участие\.docx$/.test(f.path)), 'форма заказчика лежит как есть');
    assert.ok(built.actions.some((a) => a.kind === 'forms') && built.actions.some((a) => a.kind === 'declaration' && a.done));
    // составленный файл скачивается
    const one = await fetch(url(`/api/bids/${v.id}/files/price-proposal`));
    assert.match(await textOf(Buffer.from(await one.arrayBuffer())), /290\s000,00 руб\./);
    assert.equal((await fetch(url(`/api/bids/${v.id}/files/нет-такого`))).status, 404);

    // итоговая выгрузка с метками невозможна: причины названы
    const refused = await api(`/api/bids/${v.id}/export?final=1`);
    assert.equal(refused.status, 409);
    assert.ok(refused.body.blockers.some((b) => /незаполненные места/.test(b)) && refused.body.blockers.some((b) => /условие готовности/.test(b)));

    // черновик выгружается всегда и помечен
    const res = await fetch(url(`/api/bids/${v.id}/export`));
    assert.equal(res.status, 200);
    assert.match(decodeURIComponent(res.headers.get('content-disposition')), /ЧЕРНОВИК-заявка-0333200014626000140-v1\.zip/);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName);
    for (const n of ['application-transfer/manifest.json', 'application-transfer/etp-fields.json', 'application-transfer/etp-fields.csv', 'application-transfer/transfer-checklist.md',
      'review-internal/requirements.json', 'review-internal/requirement-evidence-matrix.csv', 'review-internal/coverage-report.json', 'review-internal/conflicts.md', 'review-internal/registry-checks.json',
      'review-internal/source-index.json', 'review-internal/reviewer-decisions.json', 'review-internal/fulfillment-risks.md']) assert.ok(names.includes(n), n);
    const manifest = JSON.parse(zip.readAsText('application-transfer/manifest.json'));
    assert.deepEqual([manifest.schema_version, manifest.kind, manifest.tender.number, manifest.package.version, manifest.approvals.price.price], [1, 'draft', '0333200014626000140', 1, 290000]);
    assert.ok(manifest.hashes.inputs && manifest.hashes.dossier && manifest.hashes.rule_pack && manifest.blockers.length > 0);
    // контрольные суммы в манифесте совпадают с файлами архива
    for (const f of manifest.files) assert.equal(sum(zip.readFile(`application-transfer/${f.path}`)), f.sha256, f.path);
    assert.match(zip.readAsText('application-transfer/transfer-checklist.md'), /ЧЕРНОВИК/);
    // оригинал участника в архиве — байт в байт
    assert.equal(zip.readFile(`application-transfer/${manifest.files.find((f) => f.kind === 'original').path}`).toString('utf8'), '%PDF-1.4 оригинал выписки');
    // в части для площадки нет закупочных цен, прибыли и данных поставщика
    const item = s.repo.getItems(id)[0];
    const offer = s.repo.insertOffer({ tender_id: id, item_id: item.id, source: 'manual', title: 'Товар Тест-1', price: 12345.67, unit_price: 12345.67, pack_qty: 1, total_cost: 12345.67, seller_name: 'ООО Секретный поставщик' });
    await api(`/api/offers/${offer}/select`, { method: 'POST', json: {} });
    const again = new AdmZip(Buffer.from(await (await fetch(url(`/api/bids/${v.id}/export`))).arrayBuffer()));
    for (const e of again.getEntries().filter((x) => x.entryName.startsWith('application-transfer/') && !x.isDirectory)) {
      const body = /\.(docx|xlsx)$/.test(e.entryName) ? await textOf(e.getData(), e.entryName.split('/').pop()) : e.getData().toString('utf8');
      assert.doesNotMatch(body, /12\s?345|Секретный поставщик|прибыл|марж|себестоим/i, e.entryName);
    }
    assert.match(again.readAsText('review-internal/fulfillment-risks.md'), /Секретный поставщик/, 'сведения о поставщике — только во внутренней части');
    assert.equal(JSON.parse(again.readAsText('application-transfer/manifest.json')).package.version, 2, 'данные изменились — пакет собран заново');
  } finally { await s.close(); }
});

test('сценарий не поддержан: ни списка, ни файлов, ни выгрузки', async () => {
  const { s, api } = start();
  try {
    const id = s.repo.createManualTender({ number: 'EAT-1', title: 'Малая закупка', price: 100000 });
    const v = (await api(`/api/tenders/${id}/bids`, { method: 'POST' })).body;
    assert.deepEqual([v.status, v.checklist, v.package.built], ['unsupported', [], null]);
    assert.equal((await api(`/api/bids/${v.id}/draft`, { method: 'POST' })).status, 409);
    assert.equal((await api(`/api/bids/${v.id}/export`)).status, 409);
  } finally { await s.close(); }
});

test('предложение о товаре — из характеристик для заявки: знак, страна, значения «по ТЗ → в заявку»; поля подписаны номером позиции', async () => {
  const items = [{ id: 11, idx: 0, name: 'Картридж', quantity: 12, unit: 'шт' }, { id: 12, idx: 1, name: 'Картридж', quantity: 4, unit: 'шт' }];
  const chars = { tables: [
    { item_id: 11, trademark: 'EasyPrint', country: 'Китай', offer: { title: 'EasyPrint LX-B230' },
      rows: [{ name: 'Цвет', tz: 'Черный', value: 'Черный', status: 'fixed' }, { name: 'Ресурс, страница', tz: 'не менее 6000', value: '6000', status: 'product' }] },
    { item_id: 12, trademark: null, country: null, offer: null, rows: [{ name: 'Цвет', tz: 'Черный', value: 'Черный', status: 'fixed' }] },
  ] };
  const pkg = buildPackage({ tender: TENDER, classification: { supported: true, scenario: '44_eauction', law: '44', procedure_title: 'аукцион' }, requirements: [], items, chosen: new Map(), dossier: dossierOf(), chars });
  const text = await textOf(fileOf(pkg, 'product-proposal').buffer);
  assert.match(text, /EasyPrint LX-B230/);
  assert.match(text, /Китай/);
  assert.match(text, /6000/);
  // у второй позиции нет товара, знака и страны — метки «заполнить», а не выдуманные значения
  assert.equal(fileOf(pkg, 'product-proposal').todo, 3);
  const labels = pkg.fields.map((f) => f.label);
  assert.ok(labels.includes('Позиция 1 — товарный знак') && labels.includes('Позиция 2 — страна происхождения'));
  assert.equal(pkg.fields.find((f) => f.label === 'Позиция 1 — страна происхождения').value, 'Китай');
});
