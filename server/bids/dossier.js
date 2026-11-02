// Анкета участника закупок («досье») и хранилище его документов.
// Это отдельные сведения от профиля поиска: профиль говорит, какие закупки искать, анкета — кто подаёт заявку.
// Реквизиты вводит сам участник; сервис проверяет только формат и контрольные разряды, а не «правду» сведений.
// Документы хранятся без изменений, рядом — sha256. Замена файла — новая запись, прежняя уходит в архив.
// Паспортные данные не запрашиваются.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KINDS = { ip: 'Индивидуальный предприниматель', company: 'Организация (ООО и другие)' };

// Виды документов участника. for — у кого такой документ бывает; where — где его взять (для подсказки).
const DOC_KINDS = [
  { key: 'egrip_extract', label: 'Выписка из ЕГРИП', for: ['ip'], where: 'Бесплатно на сайте налоговой egrul.nalog.ru: придёт PDF с электронной подписью' },
  { key: 'egrul_extract', label: 'Выписка из ЕГРЮЛ', for: ['company'], where: 'Бесплатно на сайте налоговой egrul.nalog.ru: придёт PDF с электронной подписью' },
  { key: 'registration', label: 'Лист записи ЕГРИП или свидетельство о регистрации', for: ['ip'], where: 'Выдан налоговой при регистрации ИП' },
  { key: 'tax_registration', label: 'Уведомление о постановке на учёт в налоговой', for: ['ip', 'company'], where: 'Выдано налоговой при регистрации; повторно — через личный кабинет налогоплательщика' },
  { key: 'usn_notice', label: 'Уведомление о применении упрощённой системы', for: ['ip', 'company'], where: 'Ваш экземпляр уведомления с отметкой налоговой или информационное письмо по форме 26.2-7' },
  { key: 'power_of_attorney', label: 'Доверенность на представителя', for: ['ip', 'company'], where: 'Оформляете сами, если заявку подписывает не сам предприниматель (руководитель)' },
  { key: 'sme_extract', label: 'Выписка из реестра малого и среднего предпринимательства', for: ['ip', 'company'], where: 'Бесплатно на сайте rmsp.nalog.ru' },
  { key: 'experience', label: 'Документы об опыте: исполненные контракты и акты', for: ['ip', 'company'], where: 'Ваши исполненные договоры с актами приёмки' },
  { key: 'license', label: 'Лицензия или разрешение', for: ['ip', 'company'], where: 'Выдаёт лицензирующий орган; нужна только если её требует закупка' },
  { key: 'sro', label: 'Выписка из реестра членов СРО', for: ['ip', 'company'], where: 'Выдаёт саморегулируемая организация; нужна только если её требует закупка' },
  { key: 'charter', label: 'Устав', for: ['company'], where: 'Действующая редакция устава организации' },
  { key: 'head_appointment', label: 'Решение о назначении руководителя', for: ['company'], where: 'Протокол или решение участника о назначении директора' },
  { key: 'major_deal', label: 'Решение об одобрении крупной сделки', for: ['company'], where: 'Решение участников; нужно только если сделка для организации крупная' },
  { key: 'other', label: 'Прочее', for: ['ip', 'company'], where: '' },
];
const DOC_KIND = new Map(DOC_KINDS.map((k) => [k.key, k]));

const TAX_REGIMES = { usn_income: 'УСН «доходы»', usn_income_expense: 'УСН «доходы минус расходы»', osno: 'Общая система', patent: 'Патент', ausn: 'АУСН', npd: 'Налог на профессиональный доход' };
const SME = { micro: 'микропредприятие', small: 'малое предприятие', medium: 'среднее предприятие', none: 'не относится к малому и среднему бизнесу' };

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const str = (v, max = 300) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(v).getTime());

// ---------- контрольные разряды ----------
const weighted = (d, w) => w.reduce((n, k, i) => n + k * Number(d[i]), 0);
/** ИНН физического лица и ИП — 12 цифр, два контрольных разряда. */
function validInn12(v) {
  const d = digits(v);
  if (d.length !== 12 || /^0+$/.test(d)) return false;
  const n11 = weighted(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11 % 10;
  const n12 = weighted(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11 % 10;
  return n11 === Number(d[10]) && n12 === Number(d[11]);
}
/** ИНН организации — 10 цифр, один контрольный разряд. */
function validInn10(v) {
  const d = digits(v);
  if (d.length !== 10 || /^0+$/.test(d)) return false;
  return weighted(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11 % 10 === Number(d[9]);
}
/** ОГРНИП — 15 цифр: остаток от деления первых 14 на 13, последняя его цифра. */
function validOgrnip(v) {
  const d = digits(v);
  return d.length === 15 && Number(BigInt(d.slice(0, 14)) % 13n % 10n) === Number(d[14]);
}
/** ОГРН — 13 цифр: остаток от деления первых 12 на 11, последняя его цифра. */
function validOgrn(v) {
  const d = digits(v);
  return d.length === 13 && Number(BigInt(d.slice(0, 12)) % 11n % 10n) === Number(d[12]);
}
const validBik = (v) => /^\d{9}$/.test(digits(v)) && digits(v).length === String(v ?? '').trim().length;
const validAccount = (v) => /^\d{20}$/.test(String(v ?? '').trim());
/**
 * Контрольный ключ счёта по БИК (порядок расчёта Банка России): сходится ли счёт с этим банком.
 * Расхождение — предупреждение, а не отказ: у счетов в подразделениях Банка России правило другое.
 */
function accountMatchesBik(account, bik, corr = false) {
  if (!validAccount(account) || !validBik(bik)) return null;
  const b = digits(bik);
  const s = (corr ? `0${b.slice(4, 6)}` : b.slice(6, 9)) + String(account).trim();
  const w = [7, 1, 3];
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += (Number(s[i]) * w[i % 3]) % 10;
  return sum % 10 === 0;
}

// ---------- поля анкеты ----------
// [ключ, подпись, обязательное]
const FIELDS = {
  ip: [
    ['fio', 'Фамилия, имя, отчество', true], ['inn', 'ИНН', true], ['ogrnip', 'ОГРНИП', true], ['registered_at', 'Дата регистрации ИП', true],
    ['address_reg', 'Адрес регистрации', true], ['address_post', 'Почтовый адрес', false], ['phone', 'Телефон', true], ['email', 'Электронная почта', true],
    ['bank_name', 'Банк', true], ['bank_bik', 'БИК', true], ['bank_account', 'Расчётный счёт', true], ['bank_corr', 'Корреспондентский счёт', true],
    ['tax_regime', 'Налоговый режим', true], ['vat_payer', 'Плательщик НДС', true], ['sme', 'Статус малого предпринимательства', false],
    ['signer', 'Кто подписывает заявку', true], ['signer_fio', 'ФИО представителя', false],
    ['eruz_number', 'Номер записи в едином реестре участников закупок', false], ['eruz_valid_until', 'Регистрация в реестре участников действует до', false], ['eruz_checked_at', 'Сведения в реестре участников сверены', false],
  ],
  company: [
    ['full_name', 'Полное наименование', true], ['short_name', 'Сокращённое наименование', false], ['inn', 'ИНН', true], ['kpp', 'КПП', true], ['ogrn', 'ОГРН', true],
    ['registered_at', 'Дата регистрации', true], ['address_reg', 'Юридический адрес', true], ['address_post', 'Почтовый адрес', false], ['phone', 'Телефон', true], ['email', 'Электронная почта', true],
    ['head_fio', 'Руководитель: ФИО', true], ['head_position', 'Руководитель: должность', true],
    ['bank_name', 'Банк', true], ['bank_bik', 'БИК', true], ['bank_account', 'Расчётный счёт', true], ['bank_corr', 'Корреспондентский счёт', true],
    ['tax_regime', 'Налоговый режим', true], ['vat_payer', 'Плательщик НДС', true], ['sme', 'Статус малого предпринимательства', false],
    ['signer', 'Кто подписывает заявку', true], ['signer_fio', 'ФИО представителя', false],
    ['eruz_number', 'Номер записи в едином реестре участников закупок', false], ['eruz_valid_until', 'Регистрация в реестре участников действует до', false], ['eruz_checked_at', 'Сведения в реестре участников сверены', false],
  ],
};

/** Привести присланные значения к полям анкеты этого типа: лишнее отбрасывается, строки обрезаются. */
function normalizeData(kind, raw = {}) {
  const out = {};
  for (const [key] of FIELDS[kind]) {
    const v = raw[key];
    if (v === undefined || v === null || v === '') continue;
    if (key === 'vat_payer') out[key] = v === true || v === 'true' || v === 'yes' || v === 1;
    else if (['inn', 'ogrnip', 'ogrn', 'kpp', 'bank_bik', 'bank_account', 'bank_corr'].includes(key)) out[key] = String(v).replace(/\s+/g, '');
    else out[key] = str(v, key.startsWith('address') || key === 'full_name' ? 500 : 200);
  }
  return out;
}

/**
 * Что с анкетой: ошибки формата (с ними анкета не сохраняется), незаполненные обязательные поля, предупреждения.
 * @returns {{errors: Array<{field, text}>, missing: Array<{field, label}>, warnings: string[], complete: boolean}}
 */
function checkDossier(kind, data = {}) {
  const errors = [];
  const warnings = [];
  const bad = (field, text) => errors.push({ field, text });
  if (!KINDS[kind]) return { errors: [{ field: 'kind', text: 'Тип участника: ИП или организация' }], missing: [], warnings, complete: false };
  if (data.inn && !(kind === 'ip' ? validInn12(data.inn) : validInn10(data.inn))) bad('inn', kind === 'ip' ? 'ИНН предпринимателя — 12 цифр; контрольные разряды не сходятся, проверьте номер' : 'ИНН организации — 10 цифр; контрольный разряд не сходится, проверьте номер');
  if (kind === 'ip' && data.ogrnip && !validOgrnip(data.ogrnip)) bad('ogrnip', 'ОГРНИП — 15 цифр; контрольный разряд не сходится, проверьте номер');
  if (kind === 'company' && data.ogrn && !validOgrn(data.ogrn)) bad('ogrn', 'ОГРН — 13 цифр; контрольный разряд не сходится, проверьте номер');
  if (kind === 'company' && data.kpp && !/^\d{9}$/.test(data.kpp)) bad('kpp', 'КПП — 9 цифр');
  if (data.bank_bik && !validBik(data.bank_bik)) bad('bank_bik', 'БИК — 9 цифр');
  if (data.bank_account && !validAccount(data.bank_account)) bad('bank_account', 'Расчётный счёт — 20 цифр');
  if (data.bank_corr && !validAccount(data.bank_corr)) bad('bank_corr', 'Корреспондентский счёт — 20 цифр');
  for (const key of ['registered_at', 'eruz_valid_until', 'eruz_checked_at']) if (data[key] && !isDate(data[key])) bad(key, 'Дата — в виде ГГГГ-ММ-ДД');
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) bad('email', 'Электронная почта — в виде имя@домен');
  if (data.tax_regime && !TAX_REGIMES[data.tax_regime]) bad('tax_regime', 'Выберите налоговый режим из списка');
  if (data.sme && !SME[data.sme]) bad('sme', 'Выберите статус из списка');
  if (data.signer && !['self', 'representative'].includes(data.signer)) bad('signer', 'Кто подписывает: сам участник или представитель по доверенности');

  if (accountMatchesBik(data.bank_account, data.bank_bik) === false) warnings.push('Расчётный счёт не сходится с БИК по контрольному разряду — проверьте оба номера по реквизитам банка');
  if (accountMatchesBik(data.bank_corr, data.bank_bik, true) === false) warnings.push('Корреспондентский счёт не сходится с БИК по контрольному разряду — проверьте оба номера по реквизитам банка');

  const missing = FIELDS[kind].filter(([key, , required]) => required && (data[key] === undefined || data[key] === '')).map(([field, label]) => ({ field, label }));
  if (data.signer === 'representative' && !data.signer_fio) missing.push({ field: 'signer_fio', label: 'ФИО представителя' });
  return { errors, missing, warnings, complete: !errors.length && !missing.length };
}

/**
 * Состояние документа на дату: действует ли он сейчас и будет ли действовать в день окончания подачи заявок.
 * @returns {'ok'|'expired'|'expires_before_deadline'|'expiring'} expiring — истекает в ближайшие 30 дней
 */
function docStatus(doc, { now = new Date(), deadline = null } = {}) {
  if (!doc.valid_until) return 'ok';
  const until = new Date(`${doc.valid_until}T23:59:59Z`).getTime();
  if (until < now.getTime()) return 'expired';
  if (deadline && until < new Date(deadline).getTime()) return 'expires_before_deadline';
  if (until - now.getTime() < 30 * 86400000) return 'expiring';
  return 'ok';
}

const safeName = (name) => String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-120);

function createDossierService({ db, dataDir, clock = () => new Date() }) {
  const now = () => clock().toISOString();
  const row = (r) => (r ? { id: r.id, kind: r.kind, name: r.name, data: JSON.parse(r.data_json || '{}'), created_at: r.created_at, updated_at: r.updated_at } : null);
  const docRow = (r) => ({
    id: r.id, dossier_id: r.dossier_id, kind: r.kind, kind_label: DOC_KIND.get(r.kind)?.label || r.kind, title: r.title, file_name: r.file_name || null, sha256: r.sha256,
    issued_at: r.issued_at, valid_until: r.valid_until, scope: r.scope, verified_at: r.verified_at, verified_by: r.verified_by, created_at: r.created_at, archived_at: r.archived_at,
    status: docStatus(r, { now: clock() }),
  });
  const active = () => db.prepare('SELECT * FROM participant_dossiers WHERE archived_at IS NULL ORDER BY id LIMIT 1').get();
  const documents = (dossierId, { archived = false } = {}) => db.prepare(`SELECT * FROM participant_documents WHERE dossier_id = ? ${archived ? '' : 'AND archived_at IS NULL'} ORDER BY kind, id DESC`).all(dossierId).map(docRow);
  const docById = (id) => db.prepare('SELECT * FROM participant_documents WHERE id = ?').get(id);
  const touch = (dossierId) => db.prepare('UPDATE participant_dossiers SET updated_at = ? WHERE id = ?').run(now(), dossierId);
  const fail = (status, message) => Object.assign(new Error(message), { status });

  function get() {
    const d = row(active());
    if (!d) return null;
    return { ...d, state: checkDossier(d.kind, d.data), documents: documents(d.id) };
  }

  return {
    get,
    /** Сохранить анкету. Незаполненные поля допустимы (анкета заполняется постепенно), неверный формат — нет. */
    save({ kind, data }) {
      if (!KINDS[kind]) throw fail(400, 'Тип участника: ИП или организация');
      const clean = normalizeData(kind, data);
      const state = checkDossier(kind, clean);
      if (state.errors.length) throw Object.assign(fail(400, state.errors.map((e) => e.text).join('; ')), { fields: state.errors });
      const name = kind === 'ip' ? (clean.fio ? `ИП ${clean.fio}` : 'ИП (ФИО не указано)') : clean.short_name || clean.full_name || 'Организация (название не указано)';
      const cur = active();
      if (cur) db.prepare('UPDATE participant_dossiers SET kind = ?, name = ?, data_json = ?, updated_at = ? WHERE id = ?').run(kind, name, JSON.stringify(clean), now(), cur.id);
      else db.prepare('INSERT INTO participant_dossiers (kind, name, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(kind, name, JSON.stringify(clean), now(), now());
      return get();
    },

    /**
     * Добавить документ. file — {path, originalname} загруженного файла; он переносится в папку досье без изменений.
     * replaces — id документа, который этот заменяет: прежний уходит в архив.
     */
    addDocument({ kind, title, issued_at = null, valid_until = null, scope = null, file, replaces = null }) {
      const d = active();
      if (!d) throw fail(409, 'Сначала сохраните анкету участника');
      const k = DOC_KIND.get(kind);
      if (!k) throw fail(400, 'Выберите вид документа из списка');
      if (!k.for.includes(d.kind)) throw fail(400, `Документ «${k.label}» к этому типу участника не относится`);
      if (!file?.path || !fs.existsSync(file.path)) throw fail(400, 'Приложите файл документа');
      for (const [v, label] of [[issued_at, 'Дата выдачи'], [valid_until, 'Срок действия']]) if (v && !isDate(v)) throw fail(400, `${label} — в виде ГГГГ-ММ-ДД`);
      if (issued_at && valid_until && valid_until < issued_at) throw fail(400, 'Срок действия раньше даты выдачи');
      const dir = path.join(dataDir, 'uploads', `dossier-${d.id}`);
      fs.mkdirSync(dir, { recursive: true });
      const buffer = fs.readFileSync(file.path);
      if (!buffer.length) throw fail(400, 'Файл пустой (0 байт)');
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const target = path.join(dir, `${crypto.randomUUID()}-${safeName(file.originalname)}`);
      fs.copyFileSync(file.path, target);
      if (path.resolve(file.path) !== path.resolve(target)) fs.rmSync(file.path, { force: true });
      const old = replaces ? docById(Number(replaces)) : null;
      if (replaces && (!old || old.dossier_id !== d.id)) throw fail(404, 'Заменяемый документ не найден');
      const r = db.prepare(`INSERT INTO participant_documents (dossier_id, kind, title, path, sha256, issued_at, valid_until, scope, original, source, file_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'upload', ?, ?)`).run(d.id, kind, str(title, 200) || k.label, target, sha256, issued_at || null, valid_until || null, str(scope, 300) || null, safeName(file.originalname), now());
      if (old) db.prepare('UPDATE participant_documents SET archived_at = ? WHERE id = ?').run(now(), old.id);
      touch(d.id);
      return docRow(docById(Number(r.lastInsertRowid)));
    },

    /** Изменить сведения о документе или отметку «проверено мной». Сам файл не меняется. */
    updateDocument(id, { title, issued_at, valid_until, scope, verified, by } = {}) {
      const doc = docById(Number(id));
      if (!doc || doc.archived_at) throw fail(404, 'Документ не найден');
      for (const [v, label] of [[issued_at, 'Дата выдачи'], [valid_until, 'Срок действия']]) if (v && !isDate(v)) throw fail(400, `${label} — в виде ГГГГ-ММ-ДД`);
      const next = {
        title: title !== undefined ? str(title, 200) || doc.title : doc.title,
        issued_at: issued_at !== undefined ? issued_at || null : doc.issued_at,
        valid_until: valid_until !== undefined ? valid_until || null : doc.valid_until,
        scope: scope !== undefined ? str(scope, 300) || null : doc.scope,
        verified_at: doc.verified_at, verified_by: doc.verified_by,
      };
      if (next.issued_at && next.valid_until && next.valid_until < next.issued_at) throw fail(400, 'Срок действия раньше даты выдачи');
      if (verified === true) {
        if (!str(by, 120)) throw fail(400, 'Укажите, кто проверил документ');
        next.verified_at = now(); next.verified_by = str(by, 120);
      } else if (verified === false) { next.verified_at = null; next.verified_by = null; }
      db.prepare('UPDATE participant_documents SET title = ?, issued_at = ?, valid_until = ?, scope = ?, verified_at = ?, verified_by = ? WHERE id = ?')
        .run(next.title, next.issued_at, next.valid_until, next.scope, next.verified_at, next.verified_by, doc.id);
      touch(doc.dossier_id);
      return docRow(docById(doc.id));
    },

    /** Убрать документ в архив: файл остаётся на диске, в подборе документов больше не участвует. */
    archiveDocument(id) {
      const doc = docById(Number(id));
      if (!doc || doc.archived_at) throw fail(404, 'Документ не найден');
      db.prepare('UPDATE participant_documents SET archived_at = ? WHERE id = ?').run(now(), doc.id);
      touch(doc.dossier_id);
      return true;
    },

    /** Файл документа для скачивания: {path, name} или null. */
    documentFile(id) {
      const doc = docById(Number(id));
      return doc?.path && fs.existsSync(doc.path) ? { path: doc.path, name: doc.file_name || path.basename(doc.path) } : null;
    },

    /** Отпечаток анкеты и документов: изменилось что-то из них — проверенные заявки устаревают. */
    fingerprint() {
      const d = get();
      if (!d) return null;
      return crypto.createHash('sha256').update(JSON.stringify([d.kind, d.data, d.documents.map((x) => [x.id, x.kind, x.sha256, x.issued_at, x.valid_until, x.verified_at])])).digest('hex').slice(0, 32);
    },
  };
}

module.exports = {
  createDossierService, checkDossier, normalizeData, docStatus, accountMatchesBik,
  validInn12, validInn10, validOgrnip, validOgrn, validBik, validAccount,
  KINDS, DOC_KINDS, DOC_KIND, FIELDS, TAX_REGIMES, SME,
};
