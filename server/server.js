const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { z } = require('zod');

const defaultConfig = require('./config');
const { openDb } = require('./db');
const { createLlm } = require('./llm');
const { toMarkdown } = require('./analyze/export');
const { buildLetter } = require('./analyze/legal');
const { createAnalysisService } = require('./analyses-service');
const { createSources } = require('./sources');
const { createSyncService, SyncBusyError } = require('./tenders/sync');
const { createDigestService, startScheduler } = require('./tenders/digest-service');
const { setupTelegram } = require('./telegram');
const { createAlertService } = require('./tenders/alerts');
const directions = require('./tenders/directions');
const productGroups = require('./tenders/product-groups');
const { REGIONS } = require('./offers/logistics');
const { loadExtraCaCertificates } = require('./certs');
const { createTenderDetails } = require('./tenders/details');
const { createFunnel } = require('./tenders/funnel');
const { createReread } = require('./tenders/reread');
const { createDealService } = require('./deal');
const { MoneyError } = require('./deal/money');
const { cleanConflicts } = require('./analyze');
const { createOfferService } = require('./offers');
const { createSiteIndex } = require('./offers/site-index');
const { createRegistryModels } = require('./offers/registry-models');
const { createProductBase } = require('./offers/product-base');
const { createProductAgent } = require('./offers/product-agent');
const { createBidAgent } = require('./tenders/bid-agent');
const { createJournal } = require('./agents/journal');
const { createChecker } = require('./agents/checker');
const { createReaderLearner } = require('./agents/reader');
const { createApplicationAgent } = require('./agents/application');
const { createPackager } = require('./agents/packager');
const { createFixer } = require('./agents/fixer');
const { createFinance } = require('./finance/store');
const { createKindAgent } = require('./agents/kinds');
const { createMarksFinder } = require('./agents/marks');
const { createSourcesAgent } = require('./agents/sources');
const { createOutcomesAgent } = require('./agents/outcomes');
const { createManager } = require('./agents/manager');
const { createPageFetcher } = require('./offers/fetch-page');
const { createBidCounts } = require('./tenders/bid-counts');
const { createSberAstSource } = require('./sources/sberast');
const { createMerlion } = require('./offers/merlion');
const { createScout } = require('./offers/scout');
const { describeFunnel } = require('./offers/funnel');
const { SOURCE_PLATFORM } = require('./tenders/platforms');
const { createPhotoService } = require('./tenders/photos');
const { queriesFor } = require('./offers/sources/yandex-search');
const { readStoredFile, MIME: EXTRACT_MIME } = require('./extract');
const { createManualTenders, isManual } = require('./tenders/manual');
const { createBidService } = require('./bids');
const { createCharService } = require('./bids/char-service');
const { createComprehensiveService } = require('./comprehensive/service');
const { toDocx } = require('./comprehensive/export-docx');
const { toPdf } = require('./comprehensive/export-pdf');
const { toContract } = require('./comprehensive/contract');
const { toHtml } = require('./comprehensive/export-html');
const { createHistory } = require('./history');
const { docMarks } = require('./doc-marks');
const { createDossierService, KINDS: DOSSIER_KINDS, DOC_KINDS, FIELDS: DOSSIER_FIELDS, TAX_REGIMES, SME: SME_KINDS } = require('./bids/dossier');

// Busboy по умолчанию читает имя файла как latin1 — браузеры шлют UTF-8.
function fixName(name) {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('�') ? name : utf8;
}

const words = z.array(z.coerce.string().transform((s) => s.trim()).pipe(z.string().max(100)))
  .max(50).transform((a) => [...new Set(a.filter(Boolean))]);
const codeList = (max) => z.array(z.coerce.string().trim().regex(/^\d{2}[\d.\-]*$/, 'код ОКПД2/КТРУ, например 26.60 или 26.60.12.119-00000001')).max(max)
  .transform((a) => [...new Set(a)]);
// Направление — группа товаров со своим поиском: коды, слова и слова-исключения (с минусом в начале).
const DirectionSchema = z.object({
  id: z.coerce.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'служебное имя: латинские буквы, цифры, дефис'),
  title: z.coerce.string().trim().min(1, 'укажите название направления').max(80),
  short: z.coerce.string().trim().max(30).default(''),
  note: z.coerce.string().trim().max(400).default(''),
  enabled: z.boolean().default(true),
  codes: codeList(30).default([]),
  keywords: z.array(z.coerce.string().transform((s) => s.trim()).pipe(z.string().max(100))).max(80).transform((a) => [...new Set(a.filter(Boolean))]).default([]),
}).transform((d) => ({ ...d, short: d.short || d.title.slice(0, 30) }));
const optionalMoney = z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().min(0).nullable());

const pctField = (max = 100) => z.coerce.number().min(0).max(max);
const EconomicsSchema = z.object({
  tax_mode: z.enum(['usn6', 'usn15', 'osn']),
  vat_rate: pctField(),
  profit_tax_rate: pctField(),
  money_cost_rate: pctField(200),
  bank_guarantee_rate: pctField(),
  etp_fee_pct: pctField(),
  etp_fee_cap: z.coerce.number().min(0),
  expected_decline_pct: pctField(99),
  logistics_pct: pctField(),
  min_margin_pct: pctField(),
  min_profit: z.coerce.number().min(0),
  default_delivery_days: z.coerce.number().int().min(1).max(365),
  default_payment_days: z.coerce.number().int().min(0).max(365),
  bidding_days: z.coerce.number().int().min(0).max(120),
  min_days_to_deliver: z.coerce.number().int().min(0).max(60),
  delivery_km_per_day: z.coerce.number().min(50).max(2000),
  delivery_handling_days: z.coerce.number().int().min(0).max(30),
  delivery_min_cost: z.coerce.number().min(0),
  delivery_reserve_days: z.coerce.number().int().min(0).max(30),
}).partial();

/** Ручные значения калькулятора выгодности для одной закупки: число или пусто (= сбросить к автоматическому). */
const optNum = (max) => z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().min(0).max(max).nullable()).optional();
const OverridesSchema = z.object({
  price: optNum(1e13), // наша цена предложения: заказчик свою не назвал — она и есть цена; назвал — не выше его цены
  // что человек менял последним — цену или процент снижения: это одно число в двух видах, действует изменённое
  lead: z.enum(['price', 'decline']).optional(),
  decline_pct: optNum(99),
  logistics: optNum(1e12),
  bid_security_pct: optNum(100),
  contract_security_pct: optNum(100),
  warranty_security_pct: optNum(100),
  advance_pct: optNum(100),
  delivery_days: optNum(365),
  payment_days: optNum(365),
  items: z.array(z.object({ id: z.coerce.number().int(), purchase_price: optNum(1e12) })).optional(),
});

/** Поля закупки, добавленной вручную: всё необязательно; пусто — «не указано» (сервис попробует взять из документов). */
const optText = (max) => z.preprocess((v) => (v == null ? undefined : String(v).trim()), z.string().max(max).optional());
const ManualSchema = z.object({
  platform: optText(120),
  number: optText(80),
  title: optText(500),
  price: optNum(1e13),
  deadline_at: z.preprocess((v) => (v === undefined ? undefined : v === '' || v == null ? null : new Date(v)),
    z.date({ invalid_type_error: 'дата не распознана', errorMap: () => ({ message: 'дата не распознана' }) }).nullable().optional())
    .transform((d) => (d instanceof Date ? d.toISOString() : d)),
  region: z.preprocess((v) => (v === undefined ? undefined : v === '' || v == null ? null : Number(v)), z.number().int().min(1).max(99).nullable().optional()),
  customer_inn: z.preprocess((v) => (v == null ? undefined : String(v).replace(/\s/g, '')), z.string().regex(/^(\d{10}|\d{12})?$/, 'ИНН — это 10 или 12 цифр').optional()),
  url: z.preprocess((v) => (v == null ? undefined : String(v).trim()), z.string().max(1000).regex(/^(https?:\/\/\S+)?$/i, 'ссылка должна начинаться с http:// или https://').optional()),
  text: optText(300000),
  customer_name: optText(300),
  delivery_place: optText(500),
});
const MANUAL_LABELS = { platform: 'площадка', number: 'номер закупки', title: 'название', price: 'цена заказчика', deadline_at: 'срок подачи', region: 'регион поставки',
  customer_inn: 'ИНН заказчика', url: 'ссылка на закупку', text: 'текст из карточки', customer_name: 'заказчик', delivery_place: 'место поставки' };

const ProfileSchema = z.object({
  // resale — ищем закупки, на которых можно заработать перепродажей; profile — по профилю компании (коды, слова)
  mode: z.enum(['resale', 'profile']).optional(),
  description: z.coerce.string().max(5000).default(''),
  regions: z.array(z.coerce.number().int().min(1).max(99)).max(99).default([]),
  price_min: optionalMoney.default(null),
  price_max: optionalMoney.default(null),
  codes: z.array(z.coerce.string().trim().regex(/^\d{2}[\d.\-]*$/, 'код ОКПД2/КТРУ, например 26.60 или 26.60.12.119-00000001')).max(10).default([]),
  keywords: words.default([]),
  stop_words: words.default([]),
  min_days_to_deadline: z.coerce.number().int().min(0).max(60).default(2),
  laws: z.array(z.enum(['44', '223', 'com'])).min(1, 'выберите хотя бы один закон').default(['44', '223']),
  score_threshold: z.coerce.number().int().min(0).max(100).default(60),
  digest_size: z.coerce.number().int().min(1).max(50).default(15),
  economics: EconomicsSchema.optional(),
  // не пришли — остаются прежними
  directions: z.array(DirectionSchema).max(30).optional(),
}).refine((p) => !p.directions || new Set(p.directions.map((d) => d.id)).size === p.directions.length, {
  message: 'у двух направлений одинаковое служебное имя', path: ['directions'],
}).refine((p) => !(p.directions || []).some((d) => d.enabled && !d.codes.length && !d.keywords.some((w) => !w.startsWith('-'))), {
  message: 'у включённого направления должен быть хотя бы один код или одно ключевое слово', path: ['directions'],
}).refine((p) => p.price_min == null || p.price_max == null || p.price_min <= p.price_max, {
  message: 'минимальная НМЦК больше максимальной', path: ['price_min'],
});

/**
 * Собирает приложение. Всё внешнее (источник, LLM, бот) передаётся снаружи — так его можно подменить в тестах.
 */
function createApp({ config = defaultConfig, repo, analyses, sync, source, digest, details, offers, photos = null, alerts, agent = null, bidAgent = null, scout = null, manager = null, bidCounts = null, funnel = null, manual = null, bids = null, dossier = null, reread = null, deal = null, log = console, clock = () => new Date(), schedule = {} }) {
  const nowIso = () => clock().toISOString();
  const UPLOADS = path.join(config.DATA_DIR, 'uploads');

  const upload = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        const dir = path.join(UPLOADS, req.analysisId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename(req, file, cb) {
        file.originalname = fixName(file.originalname);
        const safe = file.originalname.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        cb(null, `${Date.now()}-${safe}`);
      },
    }),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 50 },
  });

  // Файлы закупки, добавленной вручную, — в своём каталоге (uploads/manual-…): он переживает повторные разборы.
  const uploadManual = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        const dir = path.join(UPLOADS, path.basename(req.manualDir));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename(req, file, cb) {
        file.originalname = fixName(file.originalname);
        const safe = file.originalname.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        cb(null, `${Date.now()}-${safe}`);
      },
    }),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 50, fieldSize: 2 * 1024 * 1024 },
  });

  // Документы участника закупок: загружаются во временную папку, в папку досье их переносит сервис анкеты.
  const uploadDossier = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        const dir = path.join(UPLOADS, 'dossier-incoming');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename(req, file, cb) {
        file.originalname = fixName(file.originalname);
        cb(null, `${Date.now()}-${file.originalname.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`);
      },
    }),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  });

  const app = express();
  app.use(express.static(config.PUBLIC_DIR));
  app.use('/api/finance/import', express.json({ limit: '4mb' })); // файл из демо бывает больше обычного запроса
  app.use(express.json({ limit: '1mb' }));

  // ---------- этап 1: разбор документации ----------
  app.post('/api/analyses',
    (req, res, next) => { req.analysisId = analyses.newId(); next(); },
    upload.array('files'),
    (req, res) => {
      if (!req.files?.length) return res.status(400).json({ error: 'Не выбраны файлы' });
      const title = (req.body.title || '').trim()
        || req.files.map((f) => f.originalname).join(', ').slice(0, 120);
      const files = req.files.map(({ originalname, path: p }) => ({ originalname, path: p }));
      analyses.startFromUploads({ id: req.analysisId, title, files });
      res.status(202).json({ id: req.analysisId });
    });

  app.get('/api/analyses', (req, res) => res.json(repo.listAnalyses()));

  app.get('/api/analyses/:id', (req, res) => {
    const a = repo.getAnalysis(req.params.id);
    if (!a) return res.status(404).json({ error: 'Разбор не найден' });
    // закупка этого разбора — чтобы со страницы разбора вернуться к ней
    const tender = repo.db.prepare('SELECT id, title, number FROM tenders WHERE analysis_id = ? ORDER BY id DESC LIMIT 1').get(a.id) || null;
    return res.json({ ...a, tender });
  });

  // Скачать документ закупки (ТЗ, проект контракта…) — как его скачал сервис; файл из ZIP достаётся из архива.
  app.get('/api/analyses/:id/files/:fileId/download', async (req, res) => {
    const f = repo.getFileMeta(req.params.id, Number(req.params.fileId));
    if (!f || !f.path || !fs.existsSync(f.path)) return res.status(404).json({ error: 'Файл не найден — документы хранятся только у закупок, документацию которых сервис скачивал' });
    let buf;
    try { buf = await readStoredFile(f.path, f.original_name); } catch (err) { return res.status(500).json({ error: `Не удалось прочитать файл: ${err.message}` }); }
    if (!buf) return res.status(404).json({ error: 'Файла нет в архиве' });
    const base = path.basename(String(f.original_name).split('/').pop());
    const ext = path.extname(base).toLowerCase();
    res.setHeader('Content-Disposition', `${ext === '.pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(base)}`);
    res.type(EXTRACT_MIME[ext] || f.mime || 'application/octet-stream').send(buf);
  });

  // Документ с оформлением — для просмотра в самой платформе, без скачивания: Word (.docx) — страницей HTML с таблицами
  // и заголовками (mammoth), Excel — таблицами по листам. Пометки разбора на него накладывает страница (как в текстовом
  // просмотре). Остальные форматы (PDF, .doc, сканы) — { html: null }: показывается текст с пометками.
  app.get('/api/analyses/:id/files/:fileId/html', async (req, res) => {
    const f = repo.getFileMeta(req.params.id, Number(req.params.fileId));
    if (!f || !f.path || !fs.existsSync(f.path)) return res.json({ html: null, reason: 'файла нет на сервере' });
    const ext = path.extname(String(f.original_name).split('/').pop()).toLowerCase();
    if (!['.docx', '.xlsx', '.xls', '.ods'].includes(ext)) return res.json({ html: null, reason: 'формат показывается текстом' });
    try {
      const buf = await readStoredFile(f.path, f.original_name);
      if (!buf) return res.json({ html: null, reason: 'файла нет в архиве' });
      if (ext === '.docx') {
        const { value } = await require('mammoth').convertToHtml({ buffer: buf });
        return res.json({ html: value });
      }
      const XLSX = require('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const html = wb.SheetNames.slice(0, 20).map((n) => `<h3>${n.replace(/[<>&]/g, '')}</h3>${XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' })}`).join('');
      res.json({ html });
    } catch (err) {
      res.json({ html: null, reason: `не удалось показать с оформлением: ${err.message}` });
    }
  });

  // документ целиком: все страницы и недочёты разбора, которые ссылаются на этот файл (их подсвечивают в тексте)
  app.get('/api/analyses/:id/files/:fileId/text', (req, res) => {
    const t = repo.getFileText(req.params.id, Number(req.params.fileId));
    if (!t) return res.status(404).json({ error: 'Файл не найден' });
    const card = repo.getAnalysis(req.params.id)?.card || null;
    return res.json({ ...t, marks: docMarks(card, Number(req.params.fileId), t.file) });
  });

  app.get('/api/analyses/:id/files/:fileId/pages/:page', (req, res) => {
    const p = repo.getFilePage(req.params.id, Number(req.params.fileId), Number(req.params.page));
    return p ? res.json(p) : res.status(404).json({ error: 'Страница не найдена' });
  });

  app.get('/api/analyses/:id/export.md', (req, res) => {
    const a = repo.getAnalysis(req.params.id);
    if (!a) return res.status(404).json({ error: 'Разбор не найден' });
    if (!a.card) return res.status(409).json({ error: 'Разбор ещё не готов' });
    const fname = `razbor-${a.id.slice(0, 8)}.md`;
    res.type('text/markdown; charset=utf-8').attachment(fname).send(toMarkdown(a));
  });

  // ----- правовой вывод по документации и письмо заказчику -----
  const tenderOfAnalysis = (analysisId) => {
    const row = repo.db.prepare('SELECT id FROM tenders WHERE analysis_id = ?').get(analysisId);
    return row ? repo.getTender(row.id) : null;
  };
  // Проверить заново: закон определяется по закупке, к которой относится разбор.
  app.post('/api/analyses/:id/legal', async (req, res) => {
    try {
      res.json(await analyses.reviewLegal(req.params.id, { tender: tenderOfAnalysis(req.params.id) }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
  // Письмо «О спорных вопросах и предложениях по их разрешению»: адресат — контактное лицо заказчика из извещения.
  // Только текст — сервис его не отправляет. 404 — письмо не нужно (замечаний нет или решено не участвовать).
  const letterFor = async (id) => {
    const a = repo.getAnalysis(id);
    if (!a) throw Object.assign(new Error('Разбор не найден'), { status: 404 });
    if (!a.card?.legal) throw Object.assign(new Error('Правовая проверка ещё не выполнена — нажмите «Проверить соответствие закону»'), { status: 409 });
    const tender = tenderOfAnalysis(id);
    const customer = tender && details?.ensureCustomer ? await details.ensureCustomer(tender).catch(() => ({})) : {};
    const letter = buildLetter({ legal: a.card.legal, tender, customer, title: a.title, now: clock() });
    if (!letter) throw Object.assign(new Error('Письмо не требуется: спорных условий нет либо рекомендовано отказаться от участия'), { status: 404 });
    return { letter, analysis: a };
  };
  app.get('/api/analyses/:id/letter', async (req, res) => {
    try { res.json((await letterFor(req.params.id)).letter); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });
  app.get('/api/analyses/:id/letter.md', async (req, res) => {
    try {
      const { letter, analysis } = await letterFor(req.params.id);
      res.type('text/markdown; charset=utf-8').attachment(`pismo-zakazchiku-${analysis.id.slice(0, 8)}.md`).send(`# ${letter.subject}\n\n${letter.body}\n`);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  // «Повторить непрочитанные части»: дочитать нераспознанные страницы и заново отправить только несостоявшиеся фрагменты.
  app.post('/api/analyses/:id/retry', (req, res) => {
    const a = repo.getAnalysis(req.params.id);
    if (!a) return res.status(404).json({ error: 'Разбор не найден' });
    const tender = tenderOfAnalysis(a.id);
    if (!analyses.retryUnread(a.id, { tender })) return res.status(409).json({ error: 'Этот разбор сейчас выполняется — дождитесь окончания' });
    // ТЗ после дочитывания читается заново: в непрочитанных страницах могли быть требования к товарам
    if (tender) repo.clearSpec(tender.id);
    res.status(202).json({ id: a.id });
  });
  // Человек проверил пробел сам: {key, confirmed, note}. Решение пересчитывается без обращения к нейросети.
  app.post('/api/analyses/:id/gaps', (req, res) => {
    const key = String(req.body?.key || '');
    if (!/^[0-9a-f]{12}$/.test(key)) return res.status(400).json({ error: 'Не указан пробел' });
    try { res.json(analyses.confirmGap(req.params.id, key, { confirmed: req.body?.confirmed !== false, note: req.body?.note })); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.delete('/api/analyses/:id', (req, res) => {
    const ok = repo.deleteAnalysis(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Разбор не найден' });
    const dir = path.join(UPLOADS, path.basename(req.params.id));
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true });
  });

  // ---------- этап 2: поиск тендеров ----------
  app.get('/api/profile', (req, res) => res.json(repo.getProfile()));

  // Готовые направления для перепродажи (config/directions.json): коды и ключевые слова для профиля.
  // Города регионов (столица региона по коду) — чтобы вместо «регион 38» показывать «Иркутск (38)».
  app.get('/api/regions', (req, res) => res.json(Object.fromEntries(Object.entries(REGIONS).map(([code, [city]]) => [code, city]))));

  // Направления профиля со счётчиками закупок в ленте — для переключателя и настройки в профиле.
  app.get('/api/directions', (req, res) => {
    const profile = repo.getProfile();
    const counts = repo.directionCounts(nowIso());
    res.json({
      items: profile.directions.map((d) => ({ ...d, count: counts[d.id] || 0 })),
      none: counts[''] || 0, // закупок в ленте без направления
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      active: directions.usesDirections(profile), // отбор идёт по направлениям (включено хотя бы одно)
      search_words_each: directions.searchWordsPerDirection(profile),
      standard: directions.loadStandard(), // исходные настройки — для кнопки «Вернуть стандартные»
    });
  });

  /** Пересчитать фильтры и оценки сохранённых закупок под новый профиль (если синхронизация идёт — сразу после неё). */
  const rescoreSoon = () => {
    const rescore = () => sync.run({ fetch: false });
    try {
      rescore();
    } catch (err) {
      if (!(err instanceof SyncBusyError)) throw err;
      sync.current().then(() => rescore()).catch(() => {});
    }
  };

  // Убрать направление с главного экрана или вернуть его: направление выключается (настройки и закупки остаются),
  // сервис перестаёт загружать и показывать такие закупки. Последнее включённое убрать нельзя: без направлений
  // сервис начал бы брать любой товар.
  app.post('/api/directions/:id/enabled', (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Направление: нужно enabled — true или false' });
    const profile = repo.getProfile();
    const dir = profile.directions.find((d) => d.id === req.params.id);
    if (!dir) return res.status(404).json({ error: 'Направление не найдено' });
    if (!enabled && dir.enabled && profile.directions.filter((d) => d.enabled).length <= 1) {
      return res.status(400).json({ error: 'Это единственное включённое направление — убрать его нельзя: без направлений сервис начнёт загружать закупки на любой товар. Сначала добавьте другое.' });
    }
    if (dir.enabled !== enabled) {
      repo.saveProfile({ ...profile, directions: profile.directions.map((d) => (d.id === dir.id ? { ...d, enabled } : d)) });
      groupCounts.at = 0;
      rescoreSoon();
    }
    res.json({ direction: repo.getProfile().directions.find((d) => d.id === dir.id) });
  });

  app.put('/api/profile', (req, res) => {
    const parsed = ProfileSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return res.status(400).json({ error: `Профиль: ${i.path.join('.') || 'поле'} — ${i.message}` });
    }
    // Настройки экономики, не пришедшие в запросе, сохраняются прежними.
    const economics = { ...repo.getProfile().economics, ...(parsed.data.economics || {}) };
    const profile = repo.saveProfile({ ...parsed.data, mode: parsed.data.mode ?? repo.getProfile().mode, economics });
    rescoreSoon();
    res.json(profile);
  });

  // Порог маржи для ленты — отдельно от профиля: версия профиля не меняется, переоценка закупок не запускается.
  app.put('/api/profile/feed', (req, res) => {
    const raw = req.body?.min_margin_pct;
    // пустое значение — не «0»: молча выключить отбор по ошибке было бы хуже, чем отказать
    const v = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ error: 'Маржа — число от 0 до 100 (0 — не отбирать)' });
    res.json({ feed_min_margin_pct: repo.setFeedMinMargin(Math.round(v * 10) / 10) });
  });

  // Каталог групп товаров для выпадающего списка в ленте: сколько закупок каждой группы сейчас в ленте и
  // загружает ли сервис такие закупки с площадок (covered). Счётчики держим минуту — пересчёт обходит всю ленту.
  let groupCounts = { at: 0, data: {} };
  app.get('/api/product-groups', (req, res) => {
    if (Date.now() - groupCounts.at > 60000) groupCounts = { at: Date.now(), data: productGroups.counts(repo, { nowIso: nowIso() }) };
    const profile = repo.getProfile();
    res.json({
      can_add: directions.usesDirections(profile), // группу можно одной кнопкой превратить в направление
      groups: productGroups.loadGroups().map((g) => {
        // ниша: включена ли (направление g-<группа> в профиле) и сколько у неё своих поставщиков с открытыми ценами
        const dir = (profile.directions || []).find((d) => d.id === productGroups.directionId(g.id));
        const own = offers.supplierCatalog(productGroups.directionId(g.id));
        return {
          id: g.id, title: g.title, section: g.section, aliases: g.aliases, image: g.image,
          count: groupCounts.data[g.id] || 0, covered: productGroups.isCovered(g, profile),
          niche_on: Boolean(dir?.enabled), suppliers: own.filter((c) => c.access_mode === 'public_site').length, companies: own.length,
        };
      }),
    });
  });
  // Сделать группу каталога направлением: сервис начнёт искать такие закупки на площадках.
  app.post('/api/product-groups/:id/direction', (req, res) => {
    const group = productGroups.loadGroups().find((g) => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Группа товаров не найдена' });
    const profile = repo.getProfile();
    if (!directions.usesDirections(profile)) return res.status(400).json({ error: 'Направления не используются: в профиле не включено ни одно — сервис и так берёт любой товар или отбирает по своим кодам и словам' });
    const id = productGroups.directionId(group.id);
    const dirs = profile.directions.some((d) => d.id === id)
      ? profile.directions.map((d) => (d.id === id ? { ...d, enabled: true } : d))
      : [...profile.directions, productGroups.toDirection(group)];
    const saved = repo.saveProfile({ ...profile, directions: dirs });
    groupCounts.at = 0;
    rescoreSoon();
    res.json({ direction: saved.directions.find((d) => d.id === id) });
  });

  // platforms — имена площадок через «|»; «?» — закупки, у которых площадка ещё не определена
  // «@mine» — мои площадки (где есть регистрация) и закупки, у которых площадка ещё уточняется; мои не заданы — без отбора
  const platformsOf = (v) => {
    if (!v) return undefined;
    if (String(v) === '@mine') { const mine = repo.getProfile().my_platforms || []; return mine.length ? [...mine, ''] : undefined; }
    return String(v).slice(0, 1000).split('|').map((s) => s.trim()).filter(Boolean).map((s) => (s === '?' ? '' : s));
  };
  // published — где опубликована закупка: eis (ЕИС, госзакупки) и/или com (вне ЕИС, коммерческие)
  const publishedOf = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter((s) => s === 'eis' || s === 'com') : undefined);

  app.get('/api/tenders', (req, res) => {
    const q = req.query;
    const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
    // groups=a,b — группы товаров из каталога: закупка подходит, если относится хотя бы к одной
    const groupIds = q.groups ? String(q.groups).slice(0, 2000).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const manualOnly = q.manual === '1';
    res.json({ ...repo.listTenders({
      manual: manualOnly,
      ids: groupIds.length ? productGroups.matchIds(repo, groupIds, { includeHidden: q.show_hidden === '1' || Boolean(q.status), nowIso: nowIso() }) : undefined,
      nowIso: nowIso(),
      status: q.status || undefined,
      minScore: num(q.min_score),
      law: q.law || undefined,
      q: q.q ? String(q.q).slice(0, 200) : undefined,
      sort: q.sort,
      limit: Math.min(num(q.limit) || 30, 100),
      offset: num(q.offset) || 0,
      showHidden: q.show_hidden === '1',
      profitableOnly: q.profitable === '1',
      direction: q.direction ? String(q.direction).slice(0, 40) : undefined,
      platforms: platformsOf(q.platforms),
      published: publishedOf(q.published),
      // difficulty — сложность через запятую: simple, medium, complex; «unknown» — ещё не известна
      difficulty: q.difficulty ? String(q.difficulty).split(',').map((s) => s.trim()).filter((s) => ['simple', 'medium', 'complex', 'unknown'].includes(s)).map((s) => (s === 'unknown' ? '' : s)) : undefined,
      // min_margin — скрыть закупки с посчитанной маржой ниже порога, %; без расчёта — остаются
      minMargin: Math.max(0, Math.min(num(q.min_margin) || 0, 100)),
      // price_min / price_max — цена закупки (НМЦК) от и до, рубли; закупки без цены при этом отборе не показываются
      priceMin: Number.isFinite(num(q.price_min)) && num(q.price_min) >= 0 ? num(q.price_min) : undefined,
      priceMax: Number.isFinite(num(q.price_max)) && num(q.price_max) >= 0 ? num(q.price_max) : undefined,
    }), manual_total: repo.countManualTenders() });
  });

  // Площадки, на которых идут закупки из ленты: имя, сайт, сколько закупок (в выбранном направлении).
  // Два вопроса — где опубликована и где идут торги — сужают друг друга, поэтому счётчики одного считаются
  // в пределах отмеченного в другом (?published=eis — площадки только по закупкам ЕИС, и наоборот).
  app.get('/api/platforms', (req, res) => {
    const direction = req.query.direction ? String(req.query.direction).slice(0, 40) : undefined;
    const rows = repo.platformCounts({ direction, published: publishedOf(req.query.published), nowIso: nowIso() });
    const pub = repo.publishedCounts({ direction, platforms: platformsOf(req.query.platforms), nowIso: nowIso() });
    const all = repo.publishedCounts({ direction, nowIso: nowIso() });
    res.json({
      // Где закупка опубликована. ЕИС — официальный сайт госзакупок: там все закупки по 44-ФЗ и 223-ФЗ,
      // через какой бы канал (ГосПлан или лента самого ЕИС) сервис о них ни узнал.
      published: [
        { id: 'eis', name: 'ЕИС — госзакупки по 44-ФЗ и 223-ФЗ', url: 'https://zakupki.gov.ru', count: pub.eis },
        { id: 'com', name: 'Вне ЕИС — коммерческие закупки', url: null, count: pub.com },
      ],
      items: rows.filter((r) => r.name),
      unknown: rows.find((r) => !r.name)?.count || 0, // площадка ещё не определена
      total: all.eis + all.com, // вся лента в этом направлении, без отметок
      filling: Boolean(funnel?.platformsBusy?.()), // сервис прямо сейчас узнаёт площадки
      // мои площадки (есть регистрация) и все известные — для выбора «моих»
      mine: repo.getProfile().my_platforms || [],
      known: require('./tenders/platforms').KNOWN.map((k) => ({ name: k.name, url: k.url })),
    });
  });
  // Узнать площадки у закупок из ленты, не дожидаясь очередных обновлений: {limit} — у скольких (по умолчанию 300).
  // Мои площадки (есть регистрация): {platforms: [имя, …]} — закупки других площадок скрыты в ленте по умолчанию,
  // о них нет уведомлений и платного автопоиска
  app.get('/api/my-platforms', (req, res) => res.json({ platforms: repo.getProfile().my_platforms || [] }));
  app.put('/api/my-platforms', (req, res) => {
    const list = Array.isArray(req.body?.platforms) ? req.body.platforms : null;
    if (!list) return res.status(400).json({ error: 'Нужен список площадок' });
    res.json({ platforms: repo.setMyPlatforms(list) });
  });
  app.post('/api/platforms/fill', (req, res) => {
    if (!funnel?.fillPlatforms) return res.status(503).json({ error: 'Недоступно' });
    const limit = Math.max(1, Math.min(Number(req.body?.limit) || 300, 3000));
    const already = funnel.platformsBusy();
    funnel.fillPlatforms({ limit }).catch((err) => log.warn?.(`[platforms] ${err.message}`));
    res.status(202).json({ started: !already, pending: repo.platformCandidates({ limit: 5000, nowIso: nowIso() }).length });
  });

  // ---------- закупка, добавленная вручную: свои документы с площадки (например, ЕАТ «Берёзка») ----------
  const manualFields = (body, res) => {
    const parsed = ManualSchema.safeParse(body || {});
    if (parsed.success) return parsed.data;
    const i = parsed.error.issues[0];
    res.status(400).json({ error: `${MANUAL_LABELS[i.path[0]] || 'поле'}: ${i.message}` });
    return null;
  };
  const uploaded = (req) => (req.files || []).map(({ originalname, path: fp }) => ({ originalname, path: fp }));
  const manualTender = (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) { res.status(404).json({ error: 'Закупка не найдена' }); return null; }
    if (!manual || !isManual(tender)) { res.status(400).json({ error: 'Это можно делать только с закупками, добавленными вручную' }); return null; }
    return tender;
  };

  app.post('/api/tenders/manual',
    (req, res, next) => { req.manualDir = `manual-${analyses.newId()}`; next(); },
    uploadManual.array('files'),
    (req, res) => {
      const dir = path.join(UPLOADS, req.manualDir);
      const drop = () => fs.rmSync(dir, { recursive: true, force: true });
      if (!manual) { drop(); return res.status(503).json({ error: 'Недоступно' }); }
      const fields = manualFields(req.body, res);
      if (!fields) return drop();
      const files = uploaded(req);
      if (!files.length && !fields.text) { drop(); return res.status(400).json({ error: 'Загрузите хотя бы один файл заказчика или вставьте текст из карточки закупки' }); }
      const r = manual.create({ dir: req.manualDir, files, fields });
      if (r.existing) return res.status(409).json({ error: 'Закупка с таким номером уже есть в сервисе. Откройте её — новые документы можно добавить там.', id: r.existing });
      res.status(201).json(r);
    });

  // Дозагрузить документы: всё читается заново, позиции собираются из документов снова.
  app.post('/api/tenders/:id/files',
    (req, res, next) => {
      const tender = manualTender(req, res);
      if (!tender) return;
      const dir = repo.getTenderRaw(tender.id)?.manual?.dir;
      if (!dir) return res.status(409).json({ error: 'У этой закупки нет каталога с файлами' });
      req.manualTender = tender;
      req.manualDir = dir;
      next();
    },
    uploadManual.array('files'),
    (req, res) => {
      const files = uploaded(req);
      const text = String(req.body?.text || '').trim().slice(0, 300000);
      if (!files.length && !text) return res.status(400).json({ error: 'Не выбраны файлы' });
      try { res.status(202).json({ analysisId: manual.addFiles(req.manualTender, { files, text }) }); }
      catch (err) { res.status(err.status || 500).json({ error: err.message }); }
    });

  // Поправить поля: цену, срок, регион, заказчика… Пустое значение — «не указано».
  app.put('/api/tenders/:id/manual', async (req, res) => {
    const tender = manualTender(req, res);
    if (!tender) return;
    const fields = manualFields(req.body, res);
    if (!fields) return;
    const { number, text, ...rest } = fields; // номер после создания не меняется: по нему закупка узнаётся
    await details.ensureItems(tender);
    manual.update(tender, rest);
    // цена и регион участвуют в расчёте; единственная позиция-«заглушка» несёт сумму закупки
    if (repo.getDetails(tender.id)?.items_source === 'fallback') await details.ensureItems(repo.getTender(tender.id), { force: true });
    await details.computeEconomics(tender.id, { fetch: false });
    const card = await details.getCard(tender.id);
    card.manual = manual.view(card.tender);
    res.json(card);
  });

  app.delete('/api/tenders/:id', (req, res) => {
    const tender = manualTender(req, res);
    if (!tender) return;
    const a = tender.analysis_id ? repo.getAnalysis(tender.analysis_id) : null;
    if ((a && ['queued', 'processing'].includes(a.status)) || manual.busy?.(tender.id)) return res.status(409).json({ error: 'Документы этой закупки сейчас читаются — дождитесь окончания и удалите после.' });
    manual.remove(tender);
    res.json({ ok: true });
  });

  // ---------- подготовка заявки: сценарий, реестр требований, несостыковки, готовность ----------
  // Сервис ничего не подаёт и не подписывает: он собирает и проверяет; действия на площадке выполняет человек.
  const bidCall = (fn) => async (req, res) => {
    if (!bids) return res.status(503).json({ error: 'Недоступно' });
    try { const r = await fn(req); return r == null ? res.status(404).json({ error: 'Дело не найдено' }) : res.json(r); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  };
  const BidAttestSchema = z.object({ requirement_id: z.string().min(1).max(200), by: z.coerce.string().max(120).optional(), note: z.coerce.string().max(500).optional(), revoke: z.boolean().optional(),
    statements: z.array(z.coerce.string().max(40)).max(40).optional() });
  const BidDecisionSchema = z.object({ requirement_id: z.string().min(1).max(200), decision: z.enum(['pass', 'not_applicable']).optional(), basis: z.coerce.string().max(1000).optional(),
    reviewer: z.coerce.string().max(120).optional(), role: z.coerce.string().max(120).optional(), revoke: z.boolean().optional() });
  const parseBody = (schema, body) => { const r = schema.safeParse(body || {}); if (!r.success) throw Object.assign(new Error(`${r.error.issues[0].path.join('.') || 'поле'}: ${r.error.issues[0].message}`), { status: 400 }); return r.data; };
  // Открыть дело по закупке: создаётся при первом обращении, при повторном — пересобирается
  app.post('/api/tenders/:id/bids', bidCall(async (req) => (await bids.open(Number(req.params.id))).view));
  app.get('/api/tenders/:id/bids', bidCall(async (req) => bids.forTender(Number(req.params.id)) || { none: true }));
  // Характеристики для заявки: «по ТЗ → в заявку» по позициям, товарный знак, страна, проверка, файл для площадки
  const charService = createCharService({ repo, source, log });
  // предложение о товаре в пакете заявки — из тех же характеристик, знака и страны, что на шаге «Заявка»
  bids?.setCharSource?.((tenderId) => charService.view(tenderId));
  const BidCharsSchema = z.object({ item_id: z.coerce.number().int().optional(), values: z.record(z.string().max(300), z.coerce.string().max(500)).optional(),
    trademark: z.coerce.string().max(200).optional(), country: z.coerce.string().max(120).optional(), all: z.boolean().optional() });
  app.get('/api/tenders/:id/bid-characteristics', bidCall(async (req) => charService.view(Number(req.params.id))));
  app.post('/api/tenders/:id/bid-characteristics', bidCall(async (req) => charService.save(Number(req.params.id), parseBody(BidCharsSchema, req.body))));
  app.get('/api/tenders/:id/bid-characteristics/export.:kind', async (req, res) => {
    const kind = req.params.kind === 'csv' ? 'csv' : 'txt';
    try {
      const body = await charService.exportFile(Number(req.params.id), kind);
      if (body == null) return res.status(404).json({ error: 'Закупка не найдена' });
      const t = repo.getTender(Number(req.params.id));
      res.setHeader('Content-Type', kind === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="zayavka-${encodeURIComponent(t?.number || req.params.id)}.${kind}"`);
      return res.send(body);
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  });
  // ---------- история: открытые закупки и на чём остановились ----------
  const history = createHistory({ repo, clock });
  const histCall = (fn) => (req, res) => { try { const r = fn(req); return r == null ? res.status(404).json({ error: 'Закупка не найдена' }) : res.json(r); } catch (err) { return res.status(err.status || 500).json({ error: err.message }); } };
  app.get('/api/history', histCall((req) => history.list({ limit: req.query.limit })));
  app.post('/api/tenders/:id/visit', histCall((req) => history.visit(Number(req.params.id), req.body?.step ? String(req.body.step) : null)));
  app.delete('/api/history/:id', histCall((req) => history.hide(Number(req.params.id))));

  // ---------- полный анализ закупки: неизменяемый снимок, история, актуальность, выгрузка JSON/DOCX/PDF ----------
  // Снимок сводит готовые результаты модулей (разбор, ТЗ, товары, расчёт, заявка); экран и файлы строятся из одного снимка.
  const comprehensive = createComprehensiveService({ repo, details, deal, bids, charService, clock, log });
  const caCall = (fn) => async (req, res) => {
    try { const r = await fn(req); return r == null ? res.status(404).json({ error: 'Закупка или снимок не найдены' }) : res.json(r); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  };
  app.post('/api/tenders/:id/comprehensive-analyses', caCall((req) => comprehensive.run(Number(req.params.id))));
  app.get('/api/tenders/:id/comprehensive-analyses', caCall(async (req) => {
    const id = Number(req.params.id);
    if (!repo.getTender(id)) return null;
    return { latest: await comprehensive.get(id), history: comprehensive.history(id) };
  }));
  app.get('/api/tenders/:id/comprehensive-analyses/:runId', caCall((req) => comprehensive.get(Number(req.params.id), req.params.runId)));
  app.get('/api/tenders/:id/reports/:snapshotId', caCall((req) => comprehensive.get(Number(req.params.id), req.params.snapshotId)));
  app.get('/api/tenders/:id/reports/:snapshotId/export', async (req, res) => {
    const format = String(req.query.format || 'json');
    if (!['json', 'docx', 'pdf', 'html'].includes(format)) return res.status(400).json({ error: 'Формат: json, docx, pdf или html' });
    try {
      // снимок берётся только у своей закупки — чужой id даёт 404
      const snap = await comprehensive.get(Number(req.params.id), req.params.snapshotId);
      if (!snap) return res.status(404).json({ error: 'Снимок не найден' });
      const opts = { freshness: snap.freshness, stale_reasons: snap.stale_reasons };
      const num = snap.report.scope.procurement_number;
      const name = `tender-analysis-${num}-${String(snap.id).replace(`${num}-`, '')}.${format}`.replace(/[^\w.-]/g, '_');
      // inline=1 — открыть в браузере (просмотр PDF), иначе скачать файлом
      res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${name}"`);
      // html — просмотр отчёта в браузере с кнопками «Скачать в Word» и «Открыть PDF» (браузер сам .docx не показывает)
      if (format === 'html') {
        const base = `/api/tenders/${req.params.id}/reports/${encodeURIComponent(snap.id)}/export`;
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(toHtml(snap.report, { ...opts, links: { docx: `${base}?format=docx`, pdf: `${base}?format=pdf&inline=1` } }));
      }
      // JSON — строго по контракту схемы отчёта (report.schema.json); полный снимок отдаёт GET …/reports/:snapshotId
      if (format === 'json') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.send(JSON.stringify(toContract(snap.report), null, 2)); }
      if (format === 'docx') { res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); return res.send(toDocx(snap.report, opts)); }
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(await toPdf(snap.report, opts));
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  });
  app.get('/api/bids/:id', bidCall(async (req) => bids.view(Number(req.params.id))));
  app.post('/api/bids/:id/validate', bidCall((req) => bids.rebuild(Number(req.params.id), { fresh: true })));
  app.post('/api/bids/:id/attestations', bidCall((req) => { const b = parseBody(BidAttestSchema, req.body); return bids.attest(Number(req.params.id), b.requirement_id, b); }));
  app.post('/api/bids/:id/review-decisions', bidCall((req) => { const b = parseBody(BidDecisionSchema, req.body); return bids.decide(Number(req.params.id), b.requirement_id, b); }));
  // Цена предложения: утверждает человек; берётся «своя цена» с шага «Расчёт», рекомендуемая сама не подставляется
  app.post('/api/bids/:id/price', bidCall((req) => bids.approvePrice(Number(req.params.id), { by: req.body?.by, revoke: req.body?.revoke === true })));
  // «Собрать черновик»: составить файлы заявки, прочитать каждый обратно, сохранить версию
  app.post('/api/bids/:id/draft', bidCall((req) => bids.draft(Number(req.params.id))));
  const attachment = (res, name) => res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  app.get('/api/bids/:id/files/:fileId', (req, res) => {
    const f = bids?.packageFile(Number(req.params.id), req.params.fileId);
    if (!f) return res.status(404).json({ error: 'Файл не найден — соберите черновик заново' });
    attachment(res, f.name);
    return res.sendFile(path.resolve(f.path));
  });
  // Архив для переноса: ?final=1 — итоговый (только когда всё готово), иначе черновик с пометкой «ЧЕРНОВИК»
  app.get('/api/bids/:id/export', async (req, res) => {
    if (!bids) return res.status(503).json({ error: 'Недоступно' });
    try {
      const z = await bids.exportZip(Number(req.params.id), { final: req.query.final === '1' });
      attachment(res, z.name);
      res.type('application/zip').send(z.buffer);
    } catch (err) { res.status(err.status || 500).json({ error: err.message, ...(err.blockers ? { blockers: err.blockers } : {}) }); }
  });

  // Решение человека по строке списка «что приложить»: другой документ или «не требуется» с причиной
  const BidChoiceSchema = z.object({ line_id: z.string().min(1).max(200), document_id: z.coerce.number().int().positive().optional(), not_required: z.boolean().optional(),
    reason: z.coerce.string().max(500).optional(), by: z.coerce.string().max(120).optional(), revoke: z.boolean().optional() });
  app.post('/api/bids/:id/checklist', bidCall((req) => { const b = parseBody(BidChoiceSchema, req.body); return bids.choose(Number(req.params.id), b.line_id, b); }));

  // ---------- анкета участника закупок и его документы ----------
  // Это сведения о том, кто подаёт заявку, — отдельно от профиля поиска. Реквизиты вводит сам участник.
  const dossierCall = (fn) => async (req, res) => {
    if (!dossier) return res.status(503).json({ error: 'Недоступно' });
    try { res.json(await fn(req)); } catch (err) { res.status(err.status || 500).json({ error: err.message, ...(err.fields ? { fields: err.fields } : {}) }); }
  };
  const dossierPayload = () => ({
    dossier: dossier.get(),
    kinds: DOSSIER_KINDS, doc_kinds: DOC_KINDS, tax_regimes: TAX_REGIMES, sme: SME_KINDS,
    fields: Object.fromEntries(Object.entries(DOSSIER_FIELDS).map(([k, list]) => [k, list.map(([key, label, required]) => ({ key, label, required }))])),
  });
  app.get('/api/dossier', dossierCall(() => dossierPayload()));
  app.put('/api/dossier', dossierCall((req) => { dossier.save({ kind: req.body?.kind, data: req.body?.data || {} }); return dossierPayload(); }));
  app.post('/api/dossier/documents', (req, res, next) => (dossier ? next() : res.status(503).json({ error: 'Недоступно' })), uploadDossier.single('file'), dossierCall((req) => {
    try {
      dossier.addDocument({ kind: req.body?.kind, title: req.body?.title, issued_at: req.body?.issued_at || null, valid_until: req.body?.valid_until || null, scope: req.body?.scope || null,
        replaces: req.body?.replaces || null, file: req.file ? { path: req.file.path, originalname: req.file.originalname } : null });
    } catch (err) { if (req.file?.path) fs.rmSync(req.file.path, { force: true }); throw err; }
    return dossierPayload();
  }));
  app.put('/api/dossier/documents/:id', dossierCall((req) => { dossier.updateDocument(Number(req.params.id), req.body || {}); return dossierPayload(); }));
  app.delete('/api/dossier/documents/:id', dossierCall((req) => { dossier.archiveDocument(Number(req.params.id)); return dossierPayload(); }));
  app.get('/api/dossier/documents/:id/download', (req, res) => {
    const f = dossier?.documentFile(Number(req.params.id));
    if (!f) return res.status(404).json({ error: 'Файл документа не найден' });
    res.setHeader('Content-Disposition', `${path.extname(f.name).toLowerCase() === '.pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return res.sendFile(path.resolve(f.path));
  });

  // Правила состава заявки: посмотреть и подтвердить (кто сверил с действующей редакцией закона)
  app.get('/api/bid-rules', bidCall(async () => bids.rules() || { rules: [] }));
  app.post('/api/bid-rules/:ruleId/verify', bidCall(async (req) => bids.verifyRule(req.params.ruleId, { by: req.body?.by, note: req.body?.note, revoke: req.body?.revoke === true })));

  // ---------- этап 3: карточка закупки и выгодность ----------
  // Заказчик закупки: организация, контактное лицо, место поставки (из извещения; у старых закупок дочитывается один раз).
  app.get('/api/tenders/:id/customer', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    res.json({ customer: await details.ensureCustomer(tender).catch(() => ({})) });
  });

  app.get('/api/tenders/:id', async (req, res) => {
    // Разбор сделан прежней версией или упал по временной причине — читаем документы заново, не дожидаясь кнопки.
    const opened = reread ? repo.getTender(Number(req.params.id)) : null;
    let rereadState = null;
    try { rereadState = opened ? reread.onOpen(opened) : null; } catch (err) { log.warn?.(`[reread] ${err.message}`); }
    const card = await details.getCard(Number(req.params.id));
    if (!card) return res.status(404).json({ error: 'Закупка не найдена' });
    if (rereadState) card.reread = rereadState;
    // Этап «поиск как у людей»: фото товаров из ТЗ и готовые запросы для ручного поиска в Яндексе.
    const list = photos ? photos.ensurePhotos(card.tender) : [];
    card.photos = list.map((ph) => ({ id: ph.id, item_idx: ph.item_idx, source_file: ph.source_file, size: ph.size, url: `/api/tenders/${card.tender.id}/photos/${ph.id}` }));
    // Документы закупки (скачанные для разбора) — ссылки «открыть ТЗ» в карточке. ТЗ — файлы, из которых взяты требования,
    // или похожие по названию («ТЗ», «описание объекта закупки», «спецификация»).
    const a = card.tender.analysis_id ? repo.getAnalysis(card.tender.analysis_id) : null;
    const used = new Set(card.items.flatMap((i) => (i.spec?.required || []).map((r) => r.source?.file).filter(Boolean)));
    const seenDocs = new Set(); // заказчик иногда выкладывает один файл дважды
    card.docs = (a?.files || []).filter((f) => (f.status === 'ok' || f.status === 'unsupported') && !seenDocs.has(f.original_name) && seenDocs.add(f.original_name)).map((f) => {
      const name = String(f.original_name).split('/').pop();
      return {
        id: f.id, name, full_name: f.original_name, url: `/api/analyses/${a.id}/files/${f.id}/download`,
        is_tz: used.has(f.original_name) || used.has(name) || /(^|[^а-яё])(тз|т\.з\.)([^а-яё]|$)|техническ|описание объекта|ооз|спецификац|потребност/i.test(name),
      };
    });
    if (manual && isManual(card.tender)) card.manual = manual.view(card.tender);
    card.search_queries = Object.fromEntries(card.items.map((i) => [i.id, queriesFor(i, 1, { spec: i.spec, title: card.tender.title })[0] || i.name]));
    res.json(card);
  });

  app.get('/api/tenders/:id/photos/:photoId', (req, res) => {
    const ph = repo.getTenderPhoto(Number(req.params.id), Number(req.params.photoId));
    if (!ph || !photos) return res.status(404).json({ error: 'Фото не найдено' });
    res.type(ph.mime || 'image/jpeg').sendFile(photos.photoPath(Number(req.params.id), ph));
  });

  // ---------- расчёт сделки: прибыль, деньги по датам, границы цены, экспресс-проверки (server/deal) ----------
  // Ничего не отправляет наружу; старый расчёт выгодности (/economics) работает как раньше.
  const dealCall = (fn) => async (req, res) => {
    if (!deal) return res.status(503).json({ error: 'Недоступно' });
    try { res.json(await fn(req)); }
    catch (err) { res.status(err instanceof MoneyError ? 400 : err.status || 500).json({ error: err.message }); }
  };
  app.get('/api/tenders/:id/deal', dealCall((req) => deal.view(Number(req.params.id))));
  app.put('/api/tenders/:id/deal', dealCall((req) => deal.save(Number(req.params.id), req.body || {})));
  app.post('/api/tenders/:id/deal/checks/:group', dealCall((req) => deal.setCheck(Number(req.params.id), req.params.group, req.body || {})));
  app.post('/api/tenders/:id/deal/approve', dealCall((req) => deal.approve(Number(req.params.id), req.body || {})));
  // выгрузка расчёта: тот же снимок, что на экране, — с версиями формул, источниками, допущениями и вопросами
  app.get('/api/tenders/:id/deal/export', async (req, res) => {
    if (!deal) return res.status(503).json({ error: 'Недоступно' });
    try {
      const v = await deal.view(Number(req.params.id));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`расчёт-сделки-${v.tender.number}.json`)}`);
      res.type('application/json').send(JSON.stringify({ exported_at: new Date().toISOString(), note: 'Внутренний расчёт: в заявку не прикладывается', ...v }, null, 2));
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.post('/api/tenders/:id/economics', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    const parsed = OverridesSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return res.status(400).json({ error: `Калькулятор: ${i.path.join('.') || 'поле'} — ${i.message}` });
    }
    const { items, lead, ...overrides } = parsed.data;
    if (tender.price > 0) {
      if (overrides.price > tender.price) {
        return res.status(400).json({ error: `Ваша цена ${overrides.price.toLocaleString('ru-RU')} ₽ выше цены заказчика ${Number(tender.price).toLocaleString('ru-RU')} ₽ — заказчик не заплатит больше своей цены. Введите цену не выше неё.` });
      }
      // Цена и снижение не должны разойтись: остаётся то, что меняли последним; второе стирается и считается из первого.
      if (lead === 'decline') overrides.price = null;
      else if (overrides.price > 0) overrides.decline_pct = null;
    }
    for (const it of items || []) repo.setItemManualPrice(tender.id, it.id, it.purchase_price ?? null);
    const recalc = await details.computeEconomics(tender.id, { overrides, fetch: req.query.refresh === '1' });
    res.json({ ...recalc, details: repo.getDetails(tender.id) });
  });

  // ---------- этап 4: поиск поставщиков ----------
  const ManualOfferSchema = z.object({
    item_id: z.coerce.number().int(),
    url: z.string().url().optional(),
    price: optNum(1e12),
    title: z.string().max(300).optional(),
    seller_name: z.string().max(300).optional(),
    seller_inn: z.string().regex(/^(\d{10}|\d{12})$/, 'ИНН — 10 или 12 цифр').optional().or(z.literal('')),
    seller_city: z.string().max(100).optional(),
    delivery_days: optNum(365),
    delivery_cost: optNum(1e9),
    same_model: z.string().trim().max(80).optional(), // карточка маркетплейса той же модели, что сверена с ТЗ
    mp_card: z.boolean().optional(), // карточка маркетплейса, сверенная с ТЗ автоматически: перенести её сверку
  }).refine((o) => o.url || o.price != null, { message: 'нужна ссылка на товар или цена' });

  // Воронку поиска отдаём с подписями причин — интерфейсу остаётся только показать.
  const searchView = (s) => (s ? { ...s, funnel: (s.funnel || []).map(describeFunnel) } : s);
  // Корзина с состоянием заявки по каждой закупке: из корзины путь продолжается до расчёта и заявки.
  const cartPayload = () => {
    const c = offers.cart();
    if (bids) for (const t of c.tenders) t.progress.bid = bids.statusFor(t.id);
    return c;
  };
  const offersPayload = (tenderId) => ({
    groups: offers.listForTender(tenderId),
    search: searchView(repo.lastOfferSearch(tenderId)),
    sources: offers.sourcesStatus(),
  });

  // Профильные компании для запроса цены. Это кандидаты: в расчёт выгодности они не попадают, пока нет предложения.
  // direction — office | network | cctv | computers. Черновик запроса КП (rfq) — только текст: ничего не отправляется
  // и отметка о работе с компанией не меняется.
  // Этап 2: для каждой группы товаров — откуда брать цену: сайты из списков и сайты, уже давшие цены в поиске
  app.get('/api/group-sources', (req, res) => {
    try { res.json(offers.groupSources({ fresh: req.query.fresh === '1' })); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/supplier-candidates', (req, res) => {
    try { res.json({ candidates: offers.supplierCatalog(typeof req.query.direction === 'string' ? req.query.direction : null) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  const supplierStateSchema = z.object({
    status: z.enum(['not_contacted', 'rfq_prepared', 'awaiting_reply', 'terms_received', 'blocked']),
    note: z.string().max(2000).default(''),
  });
  app.put('/api/supplier-candidates/:site', (req, res) => {
    const parsed = supplierStateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Некорректный статус или заметка' });
    try { res.json({ candidate: offers.updateSupplierCandidate(req.params.site, parsed.data) }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  // Товар и цена на сайтах компаний с открытыми ценами, у которых по позиции ещё ничего не найдено. Бесплатно: страницы
  // берутся из своего каталога страниц поставщиков. За вызов — несколько страниц; left — сколько ещё осталось.
  app.post('/api/tenders/:id/supplier-candidates/lookup', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    try {
      res.json({ ...(await offers.lookupCandidates(tender.id)), ...offersPayload(tender.id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
  app.get('/api/tenders/:id/supplier-candidates/:site/rfq', (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    const itemId = Number(req.query.item_id);
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    if (!Number.isSafeInteger(itemId) || itemId < 1) return res.status(400).json({ error: 'Нужна позиция закупки' });
    try { res.json(offers.supplierDraft(tender.id, itemId, req.params.site)); }
    catch (err) { res.status(404).json({ error: err.message }); }
  });

  app.post('/api/tenders/:id/offers/search', (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    const last = repo.lastOfferSearch(tender.id);
    if (last && ['queued', 'running'].includes(last.status)) return res.status(409).json({ error: 'Поиск по этой закупке уже идёт', searchId: last.id });
    res.status(202).json({ searchId: offers.start(tender.id) });
  });

  app.get('/api/offer-searches/:id', (req, res) => {
    const s = repo.getOfferSearch(Number(req.params.id));
    return s ? res.json(searchView(s)) : res.status(404).json({ error: 'Поиск не найден' });
  });

  app.get('/api/tenders/:id/offers', (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    res.json(offersPayload(tender.id));
  });

  // Дозаполнить контакты поставщиков у сохранённых предложений (телефон, почта, сайт).
  app.post('/api/tenders/:id/contacts', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    try {
      const r = await offers.ensureContacts(tender.id);
      res.json({ ...r, ...offersPayload(tender.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Дочитать остатки у предложений, найденных раньше (страницы товаров открываются заново; платных запросов нет).
  // модель, сверенная с ТЗ, на маркетплейсах: GET — сохранённое (бесплатно), POST — найти карточки (платный поиск Яндекса)
  const mpCall = (search) => async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    try { res.json(await offers.marketplaces(tender.id, Number(req.params.itemId), { search })); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  };
  app.get('/api/tenders/:id/items/:itemId/marketplaces', mpCall(false));
  // Маркетплейсы по позиции без подходящего товара: найти карточки (поиск Яндекса) и сверить их с ТЗ
  app.post('/api/tenders/:id/items/:itemId/marketplace-check', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    try { const r = await offers.marketplaceCheck(tender.id, Number(req.params.itemId)); res.json({ ...r, ...offersPayload(tender.id) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });
  app.post('/api/tenders/:id/items/:itemId/marketplaces', mpCall(true));
  // Модели из реестра под ТЗ позиции (ноутбук, ПК, моноблок, монитор): сверка заново
  // Подбор из своей базы товаров под ТЗ позиции (компьютеры, картриджи, оргтехника, комплектующие): сверка заново
  app.post('/api/tenders/:id/items/:itemId/product-base', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    try { const r = await offers.baseCheck(tender.id, Number(req.params.itemId)); res.json({ ...r, ...offersPayload(tender.id) }); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });
  app.get('/api/product-base', (req, res) => res.json({ base: offers.baseStatus(), registry: offers.registryStatus() }));

  app.post('/api/tenders/:id/offers/stock', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    try {
      res.json({ ...(await offers.refreshStock(tender.id, { selectedOnly: req.body?.selected === true })), ...offersPayload(tender.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // «Проверить ссылку»: что стало бы в поиске с товаром, найденным вручную. Бесплатно, ничего не сохраняет.
  app.post('/api/tenders/:id/offers/check-url', async (req, res) => {
    const parsed = z.object({ item_id: z.coerce.number().int().positive(), url: z.string().trim().max(2000).regex(/^https?:\/\/[^\s/]+\.[^\s/]+/i, 'нужна ссылка вида https://сайт/товар') }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: `Ссылка: ${parsed.error.issues[0].message}` });
    try {
      res.json(await offers.checkUrl(Number(req.params.id), parsed.data));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tenders/:id/offers', async (req, res) => {
    const parsed = ManualOfferSchema.safeParse(req.body || {});
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return res.status(400).json({ error: `Предложение: ${i.path.join('.') || 'поле'} — ${i.message}` });
    }
    try {
      const offer = await offers.addManual(Number(req.params.id), { ...parsed.data, seller_inn: parsed.data.seller_inn || null });
      res.status(201).json({ offer, ...offersPayload(offer.tender_id) });
    } catch (err) {
      res.status(err.status || (err.name === 'FetchSkipped' ? 400 : 500)).json({ error: err.message });
    }
  });

  // Найти товар поставщика по госконтракту на его сайте — прямая ссылка на страницу товара с ценой (1 платный запрос).
  // Товары лучших поставщиков по госконтрактам — на их сайтах (до 3 платных запросов, один раз на предложение).
  app.post('/api/tenders/:id/products', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    try {
      res.json({ ...(await offers.findProductsForTender(tender.id)), ...offersPayload(tender.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Перевыбрать лучшие предложения из уже найденных (после изменения сверки) — без нового поиска.
  app.post('/api/tenders/:id/offers/reselect', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    try {
      res.json({ ...(await offers.reselect(tender.id)), ...offersPayload(tender.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/offers/:id/product', async (req, res) => {
    try {
      const r = await offers.findOnSupplierSite(Number(req.params.id));
      const offer = repo.getOffer(Number(req.params.id));
      res.json({ ...r, ...offersPayload(offer.tender_id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // «Найти по модели»: адресный поиск недостающих характеристик в интернете (платно, свой суточный лимит)
  // Ручное подтверждение требования ТЗ: пользователь сам нашёл значение (с основанием; можно отменить)
  const confirmRowSchema = z.object({
    name: z.string().min(1).max(500), verdict: z.enum(['yes', 'no', 'reset']),
    source: z.string().max(500).optional().default(''), note: z.string().max(500).optional().default(''),
  });
  app.post('/api/offers/:id/confirm-row', (req, res) => {
    const parsed = confirmRowSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Некорректные данные подтверждения' });
    try {
      const r = offers.confirmRow(Number(req.params.id), parsed.data);
      const offer = repo.getOffer(Number(req.params.id));
      res.json({ ...r, ...offersPayload(offer.tender_id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/offers/:id/find-by-model', async (req, res) => {
    try {
      const r = await offers.findByModel(Number(req.params.id));
      const offer = repo.getOffer(Number(req.params.id));
      res.json({ ...r, ...offersPayload(offer.tender_id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // «Дочитать характеристики»: страница заново, вкладка «Характеристики» и PDF-паспорт, новая сверка с ТЗ
  app.post('/api/offers/:id/recheck', async (req, res) => {
    try {
      const r = await offers.recheck(Number(req.params.id));
      const offer = repo.getOffer(Number(req.params.id));
      res.json({ ...r, ...offersPayload(offer.tender_id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/offers/:id/select', async (req, res) => {
    try {
      const offer = await offers.select(Number(req.params.id), { clear: req.body?.clear === true });
      res.json(offersPayload(offer.tender_id));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Корзина: предложения, отложенные для сравнения. {in: true|false} — положить или убрать.
  app.post('/api/offers/:id/cart', (req, res) => {
    try {
      if (typeof req.body?.in !== 'boolean') return res.status(400).json({ error: 'Укажите in: true (в корзину) или false (убрать)' });
      const offer = offers.setCart(Number(req.params.id), req.body.in);
      res.json({ in: req.body.in, count: offers.cart().count, ...offersPayload(offer.tender_id) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
  // Корзина заявок: закупки, по которым вы работаете над заявкой, — в одном месте, чтобы к ним возвращаться
  repo.db.exec(`CREATE TABLE IF NOT EXISTS bid_cart (
    tender_id INTEGER PRIMARY KEY REFERENCES tenders(id) ON DELETE CASCADE, added_at TEXT NOT NULL)`);
  const J0 = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  function bidCartPayload() {
    const rows = repo.db.prepare(`SELECT c.tender_id, c.added_at, t.title, t.number, t.price, t.deadline_at, t.law, t.platform, t.direction, t.status,
        e.profit, e.margin_pct FROM bid_cart c JOIN tenders t ON t.id = c.tender_id LEFT JOIN tender_economics e ON e.tender_id = c.tender_id
      ORDER BY COALESCE(t.deadline_at, '9999'), c.added_at`).all();
    const one = (sql, id) => { try { return repo.db.prepare(sql).get(id); } catch { return null; } };
    return {
      items: rows.map((r) => {
        const bc = one('SELECT id, status, readiness_json, updated_at FROM bid_cases WHERE tender_id = ? ORDER BY id DESC LIMIT 1', r.tender_id);
        const ag = one('SELECT status, summary_json, decision FROM bid_agent_items WHERE tender_id = ? ORDER BY id DESC LIMIT 1', r.tender_id);
        const rd = J0(bc?.readiness_json, null);
        const s = J0(ag?.summary_json, {});
        const exp = s.alt && /замен/.test(s.verdict || '') ? { profit: s.alt.profit, margin_pct: s.alt.margin_pct } : s.econ?.expected || null;
        return {
          ...r,
          bid: bc ? { id: bc.id, status: bc.status, mandatory: rd?.counters?.mandatory ?? null, confirmed: rd?.counters?.mandatory_pass ?? null, blockers: (rd?.blockers || []).length, updated_at: bc.updated_at } : null,
          agent: ag ? { status: ag.status, verdict: s.verdict || null, decision: ag.decision || null, expected: exp, decline_pct: s.econ?.decline_pct ?? null } : null,
          bid_count: bidCounts?.get(r.tender_id) || null,
        };
      }),
    };
  }
  // ---------- раздел «Финансы»: своё хранилище, каждое сохранение проверяется проводками ----------
  const finance = createFinance({ db: repo.db, clock });
  const finState = (state) => ({ state, meta: finance.meta() });
  const finRoute = (fn) => (req, res) => {
    try { res.json(finState(fn(req))); } catch (err) { res.status(400).json({ error: err.message }); }
  };
  app.get('/finance-ledger.js', (req, res) => res.sendFile(path.join(__dirname, 'finance', 'ledger.js')));
  app.get('/api/finance', finRoute(() => finance.load()));
  app.post('/api/finance/change', finRoute((req) => finance.change(req.body || {})));
  app.post('/api/finance/settings', finRoute((req) => finance.saveSettings(req.body || {})));
  app.post('/api/finance/start', finRoute(() => finance.start()));
  app.post('/api/finance/import', finRoute((req) => finance.importState(req.body?.state)));
  app.get('/api/finance/export.json', (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="tender-ai-finance-v2.json"');
    res.json(finance.load());
  });
  app.get('/api/finance/export.csv', (req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tender-ai-operations.csv"' });
    res.send(finance.exportCsv());
  });

  app.get('/api/bid-cart', (req, res) => res.json(bidCartPayload()));
  // Сколько заявок подано по закупке (44-ФЗ, Сбербанк-АСТ): сохранённое число; устарело — спрашиваем площадку сейчас
  app.get('/api/tenders/:id/bid-count', async (req, res) => {
    const t = repo.getTender(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'Закупка не найдена' });
    if (!bidCounts) return res.json({ enabled: false });
    let row = bidCounts.get(t.id);
    let error = null;
    if (req.query.refresh !== '0') { try { row = await bidCounts.refresh(t); } catch (err) { error = `Сбербанк-АСТ не ответил: ${err.message}`; } }
    res.json({ enabled: true, applies: String(t.law) === '44', ...(row || {}), error });
  });
  // {on: true} — положить закупку в корзину заявок, {on: false} — убрать
  app.post('/api/bid-cart/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!repo.getTender(id)) return res.status(404).json({ error: 'Закупка не найдена' });
    if (req.body?.on === false) repo.db.prepare('DELETE FROM bid_cart WHERE tender_id = ?').run(id);
    else repo.db.prepare('INSERT OR IGNORE INTO bid_cart (tender_id, added_at) VALUES (?, ?)').run(id, nowIso());
    res.json({ in_cart: req.body?.on !== false, count: repo.db.prepare('SELECT COUNT(*) n FROM bid_cart').get().n });
  });
  app.get('/api/cart', (req, res) => res.json(cartPayload()));
  // Очистить корзину: {tender_id} — по одной закупке, {all: true} — целиком.
  app.post('/api/cart/clear', (req, res) => {
    const tenderId = Number(req.body?.tender_id);
    if (!(tenderId > 0) && req.body?.all !== true) return res.status(400).json({ error: 'Укажите tender_id или all: true' });
    const removed = repo.clearCart(tenderId > 0 ? tenderId : null);
    res.json({ removed, ...cartPayload() });
  });

  // Набор партии позиции вручную: {allocations: [{offer_id, qty}]}; пустой список — вернуть автоматический набор.
  app.put('/api/tenders/:id/items/:itemId/allocations', async (req, res) => {
    try {
      await offers.setAllocations(Number(req.params.id), Number(req.params.itemId), req.body?.allocations);
      res.json(offersPayload(Number(req.params.id)));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Отметка продавца по реестру недобросовестных поставщиков (ставит пользователь, проверив реестр по ссылке).
  app.post('/api/sellers/:inn/rnp', async (req, res) => {
    const status = req.body?.status;
    if (!/^(\d{10}|\d{12})$/.test(req.params.inn)) return res.status(400).json({ error: 'ИНН — 10 или 12 цифр' });
    if (!['clean', 'listed', 'none'].includes(status)) return res.status(400).json({ error: 'status: clean | listed | none' });
    res.json(await offers.sellerRnp(req.params.inn, status));
  });

  // Проверить продавца по реестру сейчас, вне очереди: результат появится в карточке через 1–3 минуты.
  app.post('/api/sellers/:inn/rnp/check', (req, res) => {
    const r = offers.checkRnpNow(req.params.inn);
    res.status(r.queued ? 202 : 409).json(r.queued ? r : { error: r.reason });
  });

  app.post('/api/sellers/:inn/decision', async (req, res) => {
    const decision = req.body?.decision;
    if (!/^(\d{10}|\d{12})$/.test(req.params.inn)) return res.status(400).json({ error: 'ИНН — 10 или 12 цифр' });
    if (!['trusted', 'blocked', 'none'].includes(decision)) return res.status(400).json({ error: 'decision: trusted | blocked | none' });
    res.json(await offers.sellerDecision(req.params.inn, decision));
  });

  app.post('/api/tenders/:id/refresh', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    const items = await details.ensureItems(tender, { force: true });
    for (const code of [...new Set(items.map((i) => i.ktru_code || i.okpd2_code).filter(Boolean))]) {
      await details.ensureBenchmark(code, { force: true });
    }
    await details.computeEconomics(tender.id, { fetch: false });
    res.json(await details.getCard(tender.id));
  });

  app.post('/api/tenders/:id/dismiss', (req, res) => (repo.dismissTender(Number(req.params.id))
    ? res.json({ ok: true })
    : res.status(404).json({ error: 'Закупка не найдена' })));

  // Этап 6b: прочитать ТЗ — если документация уже разобрана, сразу спецификация; иначе запустить разбор
  // (спецификация прочитается сама по его окончании).
  app.post('/api/tenders/:id/spec', async (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    const a = tender.analysis_id ? repo.getAnalysis(tender.analysis_id) : null;
    if (!a || a.status === 'error') {
      const analysisId = analyses.startFromTender({ tender, source });
      repo.setTenderAnalysis(tender.id, analysisId);
      if (manual && isManual(tender)) manual.track(tender.id, analysisId);
      return res.status(202).json({ status: 'analysis_started', analysisId });
    }
    if (a.status !== 'done') return res.status(202).json({ status: 'analysis_running', analysisId: a.id });
    try {
      const r = await details.ensureSpec(tender, { force: true });
      await details.resolveContractMatches(tender);
      await details.computeEconomics(tender.id, { fetch: false });
      res.json(r || { status: 'no_analysis' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/tenders/:id/analyze', (req, res) => {
    const tender = repo.getTender(Number(req.params.id));
    if (!tender) return res.status(404).json({ error: 'Закупка не найдена' });
    // Повторный разбор (например, раньше часть файлов не прочиталась): требования ТЗ после него читаются заново.
    if (tender.analysis_id) repo.clearSpec(tender.id);
    const analysisId = analyses.startFromTender({ tender, source });
    repo.setTenderAnalysis(tender.id, analysisId);
    if (manual && isManual(tender)) manual.track(tender.id, analysisId);
    res.status(202).json({ analysisId });
  });

  app.post('/api/sync', (req, res) => {
    try {
      // since_days — разово загрузить закупки за прошлые дни (1–14), например после расширения регионов.
      const days = Number(req.body?.since_days);
      sync.run(Number.isFinite(days) && days > 0 ? { sinceDays: Math.min(14, days) } : {});
      res.status(202).json({ ok: true });
    } catch (err) {
      if (err instanceof SyncBusyError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  app.get('/api/sync/status', (req, res) => {
    res.json({
      running: sync.isRunning(), last: repo.lastSyncRun(), source: source.name,
      progress: sync.progress?.() ?? null, // {pct, text} — ход идущего обновления
      // автообновление: раз в сколько минут (0 — выключено) и когда следующее
      interval_min: schedule.intervalMin ?? 0, next_at: schedule.nextAt ?? null,
    });
  });

  // Уведомления (выгодно / на грани / товар найден): список для колокольчика на сайте и проверка Telegram.
  app.get('/api/alerts', (req, res) => {
    const items = repo.listAlerts().map((t) => ({
      id: t.id, title: t.title, number: t.number, price: t.price, region: t.region, deadline_at: t.deadline_at,
      profit: t.econ_profit, margin_pct: t.econ_margin, alerted_at: t.alerted_at, still: t.still,
      // на момент уведомления — в истории видно, что именно сервис тогда нашёл
      alert_profit: t.alert_profit ?? t.econ_profit, alert_margin: t.alert_margin ?? t.econ_margin,
      kind: t.alert_kind, alert_purchase: t.alert_purchase, direction: t.direction ?? null,
      read: Boolean(t.alert_read_at), hidden: t.status === 'dismissed', law: t.law,
    }));
    res.json({ items, unread: items.filter((a) => !a.read).length, telegram: alerts ? alerts.telegramStatus() : 'no_token' });
  });
  // Прочитано: {ids: [id закупки, …]} или {all: true}
  app.post('/api/alerts/read', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 500) : null;
    if (!ids && !req.body?.all) return res.status(400).json({ error: 'Укажите ids или all' });
    res.json({ updated: repo.markAlertsRead(ids) });
  });
  // Агент заявок: настройки (отдельно от ленты и профиля), задание текстом, запуск, готовые заявки, решения, уроки
  const baCall = (fn) => async (req, res) => {
    if (!bidAgent) return res.status(400).json({ error: 'Агент заявок выключен' });
    try { res.json(await fn(req)); } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  };
  // к отчёту — свежее число поданных заявок по каждой закупке (из сохранённого, площадку здесь не спрашиваем)
  // управляющий агентами: состояние, расход поиска, уроки за неделю; отчёт в Telegram по кнопке
  app.get('/api/agents', (req, res) => (manager ? res.json(manager.view()) : res.status(400).json({ error: 'Управляющий выключен' })));
  app.post('/api/agents/report', async (req, res) => (manager ? res.json({ sent: await manager.sendReport() }) : res.status(400).json({ error: 'Управляющий выключен' })));
  app.get('/api/bid-agent', baCall(() => { const v = bidAgent.view(); for (const x of v.items || []) x.bid_count = bidCounts?.get(x.tender_id) || null; return v; }));
  app.put('/api/bid-agent/settings', baCall((req) => ({ settings: bidAgent.saveSettings(req.body || {}) })));
  app.post('/api/bid-agent/parse-task', baCall((req) => bidAgent.parseTask(String(req.body?.task || ''))));
  app.post('/api/bid-agent/run', baCall((req) => {
    const ids = Array.isArray(req.body?.tender_ids) ? req.body.tender_ids.map(Number).filter((x) => x > 0).slice(0, 20) : null;
    // fresh_search: true — искать поставщиков заново даже при свежем поиске (после правок поиска или доставки)
    if (config.AGENT_WORKER) { repo.setSetting('worker:bid_run', JSON.stringify({ at: new Date().toISOString(), tender_ids: ids && ids.length ? ids : null, fresh_search: req.body?.fresh_search === true })); return { started: true, queued: true }; }
    bidAgent.run({ reason: 'manual', tenderIds: ids && ids.length ? ids : null, freshSearch: req.body?.fresh_search === true }).catch(() => {});
    return { started: true };
  }));
  app.get('/api/bid-agent/candidates', baCall(() => ({ items: bidAgent.candidates().slice(0, 30).map((t) => ({ id: t.id, number: t.number, title: t.title, price: t.price, difficulty: t.difficulty, platform: t.platform, deadline: t.deadline_at || t.deadline_from, direction: t.direction })) })));
  app.post('/api/bid-agent/items/:id/decision', baCall((req) => bidAgent.decide(Number(req.params.id), req.body?.decision ?? null, req.body?.note)));
  app.post('/api/bid-agent/items/:id/findings/:idx/dismiss', baCall((req) => bidAgent.dismissFinding(Number(req.params.id), Number(req.params.idx))));
  app.get('/api/scout', (req, res) => res.json(scout ? scout.view() : { enabled: false, tasks: [] }));
  app.post('/api/bid-agent/read', baCall(() => ({ updated: bidAgent.markRead() })));

  // Ночной агент базы товаров: отчёты, расхождения на решение, запуск вручную
  app.get('/api/agent', (req, res) => res.json(agent ? agent.view() : { enabled: false, runs: [], conflicts: [], unread: 0 }));
  app.post('/api/agent/run', (req, res) => {
    if (!agent) return res.status(400).json({ error: 'Агент базы товаров выключен (AGENT_ENABLED=0)' });
    // агенты в рабочем процессе: оставляем заявку — он заберёт её в течение минуты
    if (config.AGENT_WORKER) { repo.setSetting('worker:agent_run', new Date().toISOString()); return res.json({ started: true, queued: true }); }
    agent.run({ reason: 'manual' }).catch(() => {});
    res.json({ started: true });
  });
  app.post('/api/agent/read', (req, res) => res.json({ updated: agent ? agent.markRead() : 0 }));
  app.post('/api/agent/conflicts/:id', (req, res) => {
    if (!agent) return res.status(400).json({ error: 'Агент базы товаров выключен' });
    try { res.json(agent.resolve(Number(req.params.id), req.body?.decision)); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });
  app.post('/api/alerts/test', async (req, res) => {
    try {
      res.json(await alerts.sendTest());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/digest/send', async (req, res) => {
    try {
      res.json(await digest.send());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Версия страницы — по времени изменения её файлов: открытая вкладка сверяет её и, если сервис обновился,
  // предлагает перезагрузиться (иначе человек днями смотрит старую страницу и не видит новых возможностей).
  const uiVersion = ['index.html', 'help.js'].map((f) => { try { return Math.round(fs.statSync(path.join(config.PUBLIC_DIR, f)).mtimeMs); } catch { return 0; } }).join('-');
  app.get('/api/health', (req, res) => res.json({
    version: uiVersion,
    // нужно интерфейсу до первой загрузки ленты и для ссылки на реестр в таблице предложений
    feedMinMarginPct: repo.getProfile().feed_min_margin_pct,
    rnpSearchUrl: config.RNP_SEARCH_URL,
    rnpAuto: Boolean(config.RNP_AUTO), // сервис сам проверяет продавцов по реестру
    ok: true, provider: config.LLM_PROVIDER, tenderSource: source.name, tenderSources: config.TENDER_SOURCES, telegram: Boolean(config.TELEGRAM_BOT_TOKEN),
  }));

  // Ошибки загрузки (размер файла и т.п.) — JSON, а не HTML-страница 500.
  app.use((err, req, res, next) => {
    const status = err instanceof multer.MulterError ? 400 : err.type === 'entity.parse.failed' ? 400 : 500;
    const message = err.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${config.MAX_UPLOAD_MB} МБ` : err.message;
    if (status === 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return app;
}

/** Полная сборка сервиса со всеми фоновыми процессами. */
function startServer(config = defaultConfig, { llmFactory = createLlm, sourceOverride, fetchImpl, log = console, scheduler = true, clock, notify = null } = {}) {
  loadExtraCaCertificates(config.EXTRA_CA_DIR, log);
  const repo = openDb(config.DATA_DIR);
  // После обновления сервиса или смены направлений метки у закупок появляются сразу, не дожидаясь синхронизации.
  directions.ensureTagged(repo, repo.getProfile(), log);
  const source = sourceOverride || createSources(config.TENDER_SOURCES, { log });
  const journal = createJournal({ repo, ...(clock ? { clock } : {}) });
  const readerLearner = createReaderLearner({ repo, journal, ...(clock ? { clock } : {}) });
  const analyses = createAnalysisService({
    repo,
    learner: readerLearner,
    uploadsDir: path.join(config.DATA_DIR, 'uploads'),
    maxChars: config.LLM_MAX_CHARS_PER_CHUNK,
    maxDownloadBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
    maxChunks: config.ANALYSIS_MAX_CHUNKS,
    reader: config.ANALYSIS_READER,
    llmFactory,
    fetchImpl,
    log,
  });
  const details = createTenderDetails({ repo, source, llmFactory, config, log, ...(clock ? { clock } : {}) });
  const photos = createPhotoService({ repo, dataDir: config.DATA_DIR, log });
  const dossier = createDossierService({ db: repo.db, dataDir: config.DATA_DIR, ...(clock ? { clock } : {}) });
  const bids = createBidService({ repo, source, log, dossier, dataDir: config.DATA_DIR, ...(clock ? { clock } : {}) });
  const deal = createDealService({ repo, details, dossier, bids, ...(clock ? { clock } : {}) });
  const manual = createManualTenders({ repo, analyses, uploadsDir: path.join(config.DATA_DIR, 'uploads'), log, ...(clock ? { clock } : {}) });
  // Собственный каталог страниц оптовых поставщиков (отдельная база suppliers.db): по модели находит товар сразу у всех.
  const siteIndex = config.SUPPLIER_INDEX === false ? null
    : createSiteIndex({ dataDir: config.DATA_DIR, log, ...(fetchImpl ? { fetchImpl } : {}), ...(clock ? { clock } : {}) });
  // Модели российских производителей компьютерной техники (страницы с их сайтов, та же база suppliers.db).
  const registry = config.REGISTRY_MODELS === false ? null
    : createRegistryModels({ dataDir: config.DATA_DIR, log, ...(fetchImpl ? { fetchImpl } : {}), ...(clock ? { clock } : {}) });
  // Своя база товаров: модели из реестра и товары, найденные при поиске, — подбор по ТЗ сначала из неё.
  const productBase = config.PRODUCT_BASE === false ? null : createProductBase({ db: repo.db, registry, log, knowledgeDir: config.KNOWLEDGE_DIR === '' ? null : (config.KNOWLEDGE_DIR || require('./offers/knowledge-seed').DIR), ...(clock ? { clock } : {}) });
  // знаток товара: виды учатся из всех позиций закупок, контрактов и поправок — при старте, раз в сутки и после прогона
  const kindAgent = createKindAgent({ repo, journal, log, ...(clock ? { clock } : {}) });
  const relearnKinds = () => { try { kindAgent.relearn(); } catch (err) { log.warn?.(`[знаток товара] ${err.message}`); } };
  relearnKinds();
  setInterval(relearnKinds, 24 * 3600 * 1000).unref();
  const offers = createOfferService({ repo, details, llmFactory, config, photos, source, siteIndex, registry, productBase, log, ...(fetchImpl ? { fetchImpl } : {}), ...(clock ? { clock } : {}) });
  const sync = createSyncService({
    repo, source, llmFactory, batchSize: config.SCORE_BATCH_SIZE, firstDays: config.SYNC_FIRST_DAYS, log, ...(clock ? { clock } : {}),
    // После синхронизации — в фоне: выгодность лучших закупок, в режиме перепродажи ещё и автопоиск поставщиков.
    // Пересчёт без загрузки (смена профиля) запускает воронку только в режиме перепродажи — там от оценки зависит, что искать.
    onFinished: (r, { fetched } = {}) => {
      if (r.status === 'error' || (!fetched && repo.getProfile().mode !== 'resale')) return;
      funnel.run().catch((err) => log.warn?.(`[funnel] ${err.message}`));
    },
  });
  const reread = createReread({ repo, analyses, source, manual, config, log, ...(clock ? { clock } : {}) });
  const funnel = createFunnel({ repo, details, offers, analyses, source, config, reread, log, ...(clock ? { clock } : {}) });
  // Закупки, найденные на самой площадке (Росэлторг), получают её сразу — не дожидаясь обновления ленты.
  repo.fillSourcePlatforms(SOURCE_PLATFORM);
  // Готовые разборы: «значение» без источника («не указано» без файла и цитаты) раньше попадало в противоречия.
  // Убираем такие и пересчитываем решение правилами — без нейросети. Повторный запуск ничего не меняет.
  try {
    const stale = repo.db.prepare(`SELECT id FROM analyses WHERE status = 'done' AND card_json LIKE '%"conflict":true%' AND card_json LIKE '%"file":""%'`).all();
    let fixed = 0;
    for (const { id } of stale) {
      const card = cleanConflicts(repo.getAnalysis(id)?.card);
      if (card) { repo.updateAnalysisCard(id, card); fixed++; }
    }
    if (fixed) log.log?.(`[analysis] убраны противоречия без источника: разборов ${fixed}`);
  } catch (err) { log.warn?.(`[analysis] чистка противоречий: ${err.message}`); }
  // id ручной закупки → обработка её готового разбора: чтобы не удалить закупку посреди неё (и для тестов)
  const manualPending = new Map();
  manual.busy = (id) => manualPending.has(id);
  // Разбор документации закупки закончился (по кнопке или в воронке) — сразу прочитать из него спецификацию ТЗ.
  analyses.onFinished((a) => {
    if (a?.status !== 'done') return;
    const row = repo.db.prepare('SELECT id FROM tenders WHERE analysis_id = ?').get(a.id);
    const tender = row && repo.getTender(row.id);
    if (tender) { try { photos.ensurePhotos(tender); } catch (err) { log.warn?.(`[photos] ${tender.number}: ${err.message}`); } }
    // Закупка добавлена вручную: недостающие поля берём из документов, позиции и требования ТЗ — тоже из них.
    if (tender && isManual(tender)) {
      manualPending.set(tender.id, (async () => {
        await details.ensureItems(tender);
        manual.applyAnalysis(tender, a);
        const fresh = repo.getTender(tender.id);
        // позиции из документов собираем заново, если дозагружены файлы или пока есть только заглушка
        if (manual.takeReread(tender.id) || repo.getDetails(tender.id)?.items_source === 'fallback') await details.ensureItems(fresh, { force: true });
        await details.ensureSpec(fresh, { force: true });
        await details.computeEconomics(tender.id, { fetch: false });
      })().catch((err) => log.warn?.(`[manual] ${tender.number}: ${err.message}`)).finally(() => manualPending.delete(tender.id)));
      return;
    }
    if (!tender || repo.getDetails(tender.id)?.spec_status) return;
    details.ensureSpec(tender)
      .then((r) => (r?.status === 'done' ? details.resolveContractMatches(tender).then(() => details.computeEconomics(tender.id, { fetch: false })) : null))
      .catch((err) => log.warn?.(`[spec] ${tender.number}: ${err.message}`));
  });
  // Поиск по кнопке сначала читает ТЗ: если документация закупки не разобрана — разбираем её и берём требования из неё.
  offers.setTzReader(async (tender, note) => {
    const d = repo.getDetails(tender.id);
    if (d?.spec_status === 'done' || d?.spec_status === 'no_docs') return d.spec_status;
    if (!source?.getAttachments) return 'unsupported';
    let a = tender.analysis_id ? repo.getAnalysis(tender.analysis_id) : null;
    // Разбор уже падал с ошибкой — заново сам не запускаю (кнопка «Разобрать документацию» остаётся).
    if (a?.status === 'error') { note('Документация закупки не прочиталась раньше — ищу по требованиям из извещения'); return 'error'; }
    if (!a) {
      note('Документация закупки ещё не прочитана — сначала читаю ТЗ (обычно 1–3 минуты)');
      repo.setTenderAnalysis(tender.id, analyses.startFromTender({ tender, source }));
    } else if (a.status !== 'done') {
      note('Документация закупки читается — жду окончания');
    }
    await analyses.idle();
    const fresh = repo.getTender(tender.id);
    a = fresh.analysis_id ? repo.getAnalysis(fresh.analysis_id) : null;
    if (a?.status !== 'done') { note('Документацию прочитать не удалось — ищу по требованиям из извещения'); return 'error'; }
    const r = await details.ensureSpec(fresh);
    if (r?.status === 'done') {
      await details.resolveContractMatches(fresh).catch(() => {});
      note(`ТЗ прочитано из документации: требования к товару уточнены (позиций сопоставлено: ${r.matched ?? '—'})`);
    } else if (r?.status === 'no_docs') {
      note('В документации закупки нет читаемого текста с требованиями — ищу по данным извещения');
    }
    return r?.status || 'none';
  });

  let bot = null;
  const digest = createDigestService({ repo, getBot: () => bot, tz: config.DIGEST_TZ, log });
  bot = setupTelegram({ config, repo, sync, digest, analyses, source, log, fetchImpl });
  // В Telegram — только закупки по заданию агента заявок: его собственные уведомления и закупки ленты с маржой и прибылью
  // не ниже заданных («на грани» и «цена заказчика не указана» остаются в ленте на сайте). Агент выключен — все, как раньше.
  const telegramOk = (t) => {
    if (t.alert_kind === 'agent') return true;
    const s = bidAgent?.settings();
    if (!s) return true;
    const e = repo.getEconomics(t.id);
    return e?.profit != null && e.margin_pct != null && e.margin_pct >= (s.margin_min ?? 0) && e.profit >= (s.profit_min ?? 0);
  };
  const alerts = createAlertService({ repo, getBot: () => bot, config, telegramOk, log, ...(clock ? { clock } : {}) });
  // Ночной агент базы товаров: сам ищет недостающие модели и характеристики, отчёт — на странице «Уведомления» и в Telegram.
  const agent = productBase && config.AGENT_ENABLED !== false ? createProductAgent({
    db: repo.db, productBase, siteIndex, config, log, ...(fetchImpl ? { fetchImpl } : {}), ...(clock ? { clock } : {}),
    // каталог Мерлиона: характеристики товаров (MERLION=0 выключает)
    merlion: config.MERLION === false ? null : createMerlion({ log, delayMs: config.MERLION_DELAY_MS ?? 1500, ...(fetchImpl ? { fetchImpl } : {}) }),
    official: config.KNOWLEDGE_DIR === '' ? [] : require('./offers/knowledge-seed').officialDomains(config.KNOWLEDGE_DIR || undefined),
    // рабочий процесс шлёт в Telegram сам (бот слушает только сервис): notify передаётся снаружи
    notify: notify || (async (html) => {
      if (!bot?.allowedChatIds.length) return false;
      for (const chatId of bot.allowedChatIds) await bot.sendMessage(chatId, html);
      return true;
    }),
  }) : null;

  // Один раз после обновления: цены победителей прошлых контрактов больше не считаются закупочными.
  if (repo.getSetting('competitors_unselected') !== '1') {
    repo.setSetting('competitors_unselected', '1');
    offers.dropCompetitorSelections()
      .then((r) => { if (r.items) log.log?.(`[offers] цена конкурента снята как закупочная: позиций ${r.items}, закупок пересчитано ${r.tenders}`); })
      .catch((err) => log.warn?.(`[offers] ${err.message}`));
  }

  // Один раз после обновления: автоматический выбор пересматривается по новым правилам — розничные сети, уценка,
  // товар «нет в наличии» и цена вдвое ниже обычной больше не берутся в расчёт сами.
  // 09.10.2026: в расчёт сам идёт только товар, у которого подтверждено каждое требование ТЗ (раньше хватало 80%).
  // Выбор, сделанный пользователем вручную, не трогается.
  if (repo.getSetting('auto_reselected') !== '2026-10-09-1') {
    repo.setSetting('auto_reselected', '2026-10-09-1');
    offers.reselectAuto()
      .then((r) => { if (r.changed) log.log?.(`[offers] автоматический выбор пересмотрен по новым правилам: закупок ${r.tenders}, выбор изменился в ${r.changed}`); })
      .catch((err) => log.warn?.(`[offers] ${err.message}`));
  }

  // Один раз после обновления: товар «нет в наличии» больше не выбирается автоматически как закупочная цена.
  if (repo.getSetting('out_of_stock_unselected') !== '1') {
    repo.setSetting('out_of_stock_unselected', '1');
    offers.dropOutOfStockSelections()
      .then((r) => { if (r.items) log.log?.(`[offers] предложения «нет в наличии» сняты как закупочные: позиций ${r.items}, закупок пересчитано ${r.tenders}`); })
      .catch((err) => log.warn?.(`[offers] ${err.message}`));
  }

  // Расписание автообновления — для строки состояния в ленте. Без планировщика (тесты) автообновления нет.
  const schedule = { intervalMin: scheduler ? config.SYNC_INTERVAL_MIN : 0, nextAt: null };
  // Агент заявок: утром сам готовит заявки по своим настройкам, отчёт — на странице «Агент заявок» и в Telegram
  // Сколько заявок подано: реестр Сбербанк-АСТ (только когда этот источник включён — в тестах его нет)
  const sbCounts = config.BID_COUNTS === false || !(config.TENDER_SOURCES || []).includes('sberast') ? null
    : createSberAstSource({ delayMs: config.SBERAST_DELAY_MS, log });
  const bidCounts = sbCounts ? createBidCounts({ repo, lookup: (n) => sbCounts.requestCount(n), staleMin: config.BID_COUNT_STALE_MIN, log, ...(clock ? { clock } : {}) }) : null;
  // журнал обучения агентов (journal создан до разборов — читатель учится в них), проверяющий находки и управляющий
  const checkFetcher = createPageFetcher({ ...(fetchImpl ? { fetchImpl } : {}), minIntervalMs: config.FETCH_MIN_INTERVAL_MS });
  const checker = config.CHECKER === false ? null : createChecker({ repo, journal, fetchPage: (u) => checkFetcher.fetchPage(u), log });
  const outcomesAgent = createOutcomesAgent({ repo, source, journal, config, log, ...(clock ? { clock } : {}) });
  const charService = require('./bids/char-service').createCharService({ repo, source, log });
  const application = createApplicationAgent({ repo, journal, charService, log, ...(clock ? { clock } : {}) });
  const marks = createMarksFinder({ repo, journal, fetchPage: (u) => checkFetcher.fetchPage(u), log, ...(clock ? { clock } : {}) });
  const packager = createPackager({ repo, auto: config.PACKAGE_AUTO !== false, journal, bids, marks, charService, log, ...(clock ? { clock } : {}) });
  const bidAgent = config.BID_AGENT_ENABLED === false ? null : createBidAgent({
    repo, analyses, source, offers, details, bids, bidCounts, checker, journal, application, packager, outcomes: outcomesAgent, charService, config, log, ...(clock ? { clock } : {}),
    notify: notify || (async (html) => {
      if (!bot?.allowedChatIds.length) return false;
      for (const chatId of bot.allowedChatIds) await bot.sendMessage(chatId, html);
      return true;
    }),
  });
  // Агент поиска поставщиков: попытки делает рабочий процесс (server/worker.js), сервис только показывает его работу
  const scout = config.SCOUT === false ? null : createScout({ repo, offers, bidAgent, config, log, ...(clock ? { clock } : {}) });
  const sourcesAgent = createSourcesAgent({ repo, journal, config, log, ...(clock ? { clock } : {}) });
  const toOwner = notify || (async (html) => {
    if (!bot?.allowedChatIds.length) return false;
    for (const chatId of bot.allowedChatIds) await bot.sendMessage(chatId, html);
    return true;
  });
  // наладчик: сам повторяет то, что сорвалось по известным причинам, остальное — владельцу (agents/fixer.js)
  const fixer = createFixer({ repo, journal, bidAgent, config, notify: toOwner, log, ...(clock ? { clock } : {}) });
  const manager = createManager({ repo, journal, reader: readerLearner, application, packager, fixer, kinds: kindAgent, sources: sourcesAgent, outcomes: outcomesAgent, config, log, ...(clock ? { clock } : {}),
    notify: toOwner });
  const app = createApp({ config, repo, analyses, sync, source, digest, details, offers, photos, alerts, agent, bidAgent, scout, manager, sourcesAgent, outcomesAgent, bidCounts, funnel, manual, bids, dossier, reread, deal, log, schedule, ...(clock ? { clock } : {}) });
  const server = app.listen(config.PORT, config.HOST || undefined, () => {
    log.log?.(`tender-ai: http://localhost:${server.address().port} (LLM_PROVIDER=${config.LLM_PROVIDER}, TENDER_SOURCE=${source.name})`);
  });

  let sched = null;
  if (scheduler) {
    sched = startScheduler({
      repo, sync, digest, alerts, hasBot: () => Boolean(bot),
      syncIntervalMin: config.SYNC_INTERVAL_MIN, digestTime: config.DIGEST_TIME, tz: config.DIGEST_TZ, log, schedule,
    });
  }
  bot?.start();

  // Каталог оптовых поставщиков обновляется сам: через минуту после запуска и дальше раз в сутки проверяем,
  // какие сайты не читались дольше недели, и перечитываем их карты (по одному сайту, с паузами: память сервера небольшая).
  let supplierTimer = null;
  if (scheduler && siteIndex) {
    // и официальные сайты производителей из базы знаний (не больше OFFICIAL_INDEX_MAX_PAGES страниц с сайта) — за характеристиками
    const official = config.KNOWLEDGE_DIR === '' ? [] : require('./offers/knowledge-seed').officialDomains(config.KNOWLEDGE_DIR || undefined)
      .filter((d) => !offers.supplierDomains().some((s) => String(s).replace(/^www\./, '') === d));
    const refreshSuppliers = () => siteIndex.refreshAll(offers.supplierDomains(), { maxAgeDays: config.SUPPLIER_INDEX_MAX_AGE_DAYS, concurrency: 1, official, officialMaxPages: config.OFFICIAL_INDEX_MAX_PAGES ?? 20000 })
      .then((list) => { if (list.length) log.log?.(`[suppliers] каталог обновлён: сайтов ${list.length}, всего страниц ${siteIndex.status().pages}`); })
      .catch((err) => log.warn?.(`[suppliers] ${err.message}`));
    const first = setTimeout(refreshSuppliers, 60000);
    first.unref?.();
    supplierTimer = setInterval(refreshSuppliers, 24 * 3600000);
    supplierTimer.unref?.();
  }
  // Модели из реестра: раз в сутки проверяем, каких производителей не читали дольше двух недель (через 5 минут после запуска).
  // Потом своя база товаров забирает новые модели и найденные страницы товаров (это быстро: только своя база, без сети).
  let registryTimer = null;
  if (scheduler && (registry || productBase)) {
    const refreshRegistry = () => (registry ? registry.refreshAll({ maxAgeDays: config.REGISTRY_MAX_AGE_DAYS }) : Promise.resolve([]))
      .then((list) => { if (list.length) log.log?.(`[registry] модели обновлены: производителей ${list.length}, всего моделей ${registry.status().models}`); })
      .catch((err) => log.warn?.(`[registry] ${err.message}`))
      .then(() => productBase?.refresh())
      .catch((err) => log.warn?.(`[products] ${err.message}`));
    const first = setTimeout(refreshRegistry, 5 * 60000);
    first.unref?.();
    registryTimer = setInterval(refreshRegistry, 24 * 3600000);
    registryTimer.unref?.();
  }

  // Ночной агент: раз в 10 минут проверяем, не наступил ли его час (AGENT_HOUR по часовому поясу сервиса).
  let agentTimer = null;
  let bidAgentTimer = null;
  if (scheduler && bidAgent && !config.AGENT_WORKER) {
    bidAgentTimer = setInterval(() => {
      if (!bidAgent.due()) return;
      log.log?.('[bid-agent] утренний прогон начат');
      bidAgent.run({ reason: 'morning' }).then((r) => log.log?.(`[bid-agent] утренний прогон закончен: ${JSON.stringify(r?.stats || {})}`)).catch((err) => log.warn?.(`[bid-agent] ${err.message}`));
    }, 10 * 60000);
    bidAgentTimer.unref?.();
  }
  if (scheduler && agent && !config.AGENT_WORKER) {
    agentTimer = setInterval(() => { if (agent.due()) agent.run({ reason: 'night' }).catch((err) => log.warn?.(`[agent] ${err.message}`)); }, 10 * 60000);
    agentTimer.unref?.();
  }

  return {
    server, repo, analyses, sync, digest, source, bot, details, offers, funnel, photos, alerts, siteIndex, registry, productBase, agent, bidAgent, scout, manager, fixer, kindAgent, sourcesAgent, outcomesAgent, packager, bidCounts, manual, bids, dossier,
    /** Дождаться обработки готовых разборов ручных закупок (для тестов). */
    manualIdle: () => Promise.all([...manualPending.values()]),
    close() {
      sched?.stop();
      offers.stop?.();
      if (supplierTimer) clearInterval(supplierTimer);
      if (registryTimer) clearInterval(registryTimer);
      if (agentTimer) clearInterval(agentTimer);
      if (bidAgentTimer) clearInterval(bidAgentTimer);
      bot?.stop();
      return new Promise((r) => server.close(r));
    },
  };
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer, ProfileSchema };
