const fs = require('node:fs');
const { alertKind, KIND_RANK } = require('./tenders/alert-kind');
const directions = require('./tenders/directions');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ECONOMICS_DEFAULTS } = require('./tenders/economics');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analyses (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued | processing | done | error
  error        TEXT,
  progress     TEXT,                              -- JSON: {stage, current, total}
  provider     TEXT,
  model        TEXT,
  created_at   TEXT NOT NULL,
  finished_at  TEXT,
  duration_ms  INTEGER,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  card_json    TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id   TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  path          TEXT,
  mime          TEXT,
  status        TEXT NOT NULL,                    -- ok | unsupported | scan_no_text | error
  message       TEXT,
  pages_count   INTEGER NOT NULL DEFAULT 0,
  text_json     TEXT                              -- JSON: [{page, text}]
);
CREATE INDEX IF NOT EXISTS idx_files_analysis ON files(analysis_id);
-- Фрагменты, на которые документация нарезана для нейросети: что отправлено, что принято, что не разобрано.
-- По ним считается полнота разбора и повторяются только несостоявшиеся части; принятый результат хранится
-- по ключу «задача + версия промпта + текст фрагмента» и переиспользуется, пока текст документа не изменился.
CREATE TABLE IF NOT EXISTS analysis_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  task        TEXT NOT NULL,                      -- extract | items | spec
  chunk_id    TEXT NOT NULL,                      -- хеш текста фрагмента
  cache_key   TEXT NOT NULL,                      -- хеш (задача + версия промпта и схемы + текст фрагмента)
  status      TEXT NOT NULL,                      -- ok | failed | skipped
  attempts    INTEGER NOT NULL DEFAULT 0,
  error_kind  TEXT,                               -- transport | too_large | truncated | filtered | invalid_json | schema | unconfirmed | budget
  error       TEXT,
  model       TEXT,
  duration_ms INTEGER,
  ranges_json TEXT,                               -- [{fileId, file, page, from, to}]
  result_json TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_analysis ON analysis_chunks(analysis_id, task);
CREATE INDEX IF NOT EXISTS idx_chunks_cache ON analysis_chunks(cache_key, status);

-- Этап 2: поиск тендеров
CREATE TABLE IF NOT EXISTS profile (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  description          TEXT NOT NULL DEFAULT '',
  regions_json         TEXT NOT NULL DEFAULT '[]',   -- коды регионов
  price_min            REAL,
  price_max            REAL,
  codes_json           TEXT NOT NULL DEFAULT '[]',   -- префиксы ОКПД2 / КТРУ
  keywords_json        TEXT NOT NULL DEFAULT '[]',
  stop_words_json      TEXT NOT NULL DEFAULT '[]',
  min_days_to_deadline INTEGER NOT NULL DEFAULT 2,
  laws_json            TEXT NOT NULL DEFAULT '["44","223"]',
  score_threshold      INTEGER NOT NULL DEFAULT 60,
  digest_size          INTEGER NOT NULL DEFAULT 15,
  version              INTEGER NOT NULL DEFAULT 1,
  updated_at           TEXT
);
CREATE TABLE IF NOT EXISTS tenders (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  law                    TEXT NOT NULL,
  number                 TEXT NOT NULL,
  title                  TEXT NOT NULL,
  price                  REAL,
  currency               TEXT,
  region                 INTEGER,
  okpd2_json             TEXT NOT NULL DEFAULT '[]',
  ktru_json              TEXT NOT NULL DEFAULT '[]',
  customer_inn           TEXT,
  published_at           TEXT,
  deadline_at            TEXT,
  stage                  INTEGER,
  eis_url                TEXT,
  raw_json               TEXT,
  status                 TEXT NOT NULL DEFAULT 'new',  -- new | filtered | scored | score_failed | dismissed
  filter_reason          TEXT,
  score                  INTEGER,
  verdict                TEXT,
  reasons_json           TEXT,
  concerns_json          TEXT,
  score_error            TEXT,
  scored_profile_version INTEGER,
  analysis_id            TEXT,
  first_seen_at          TEXT NOT NULL,
  UNIQUE (law, number)
);
CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders(status, score);
CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,          -- running | done | error
  source      TEXT,
  fetched     INTEGER DEFAULT 0,
  new_count   INTEGER DEFAULT 0,
  filtered    INTEGER DEFAULT 0,
  scored      INTEGER DEFAULT 0,
  error       TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Этап 3: позиции закупки, рыночный ориентир, выгодность
CREATE TABLE IF NOT EXISTS tender_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id             INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  idx                   INTEGER NOT NULL,
  name                  TEXT NOT NULL,
  ktru_code             TEXT,
  okpd2_code            TEXT,
  characteristics_json  TEXT NOT NULL DEFAULT '[]',
  quantity              REAL,
  unit                  TEXT,
  unit_price            REAL,                 -- цена заказчика за единицу
  sum                   REAL,
  source                TEXT NOT NULL,        -- notification | llm
  purchase_price_manual REAL,                 -- закупочная цена за единицу, введённая вручную
  purchase_price_offer  REAL,                 -- закупочная цена из поиска поставщиков (этап 4)
  purchase_offer_label  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tender_items ON tender_items(tender_id, idx);
CREATE TABLE IF NOT EXISTS tender_details (
  tender_id        INTEGER PRIMARY KEY REFERENCES tenders(id) ON DELETE CASCADE,
  conditions_json  TEXT NOT NULL DEFAULT '{}',   -- обеспечения и прочее из извещения
  items_source     TEXT,
  error            TEXT,
  fetched_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS benchmarks (
  code        TEXT PRIMARY KEY,                  -- код КТРУ или ОКПД2
  data_json   TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offer_searches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id      INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,                  -- queued | running | done | error
  progress_json  TEXT,
  log_json       TEXT NOT NULL DEFAULT '[]',
  api_requests   INTEGER NOT NULL DEFAULT 0,
  pages_fetched  INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  error          TEXT
);
CREATE TABLE IF NOT EXISTS offers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id           INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  item_id             INTEGER NOT NULL,
  search_id           INTEGER,
  source              TEXT NOT NULL,             -- contracts | yandex | store | manual
  title               TEXT,
  url                 TEXT,
  domain              TEXT,
  price               REAL,
  unit                TEXT,
  pack_qty            REAL,
  unit_price          REAL,                      -- цена за единицу заказчика
  availability        TEXT,
  seller_name         TEXT,
  seller_inn          TEXT,
  seller_inn_on_site  INTEGER,
  seller_region       INTEGER,
  delivery_days       REAL,
  delivery_cost       REAL,
  delivery_note       TEXT,
  delivery_estimated  INTEGER,
  total_cost          REAL,
  in_time             INTEGER,                   -- 1 / 0 / NULL (не известно)
  match               TEXT,
  match_notes_json    TEXT NOT NULL DEFAULT '[]',
  trust               INTEGER,
  trust_reasons_json  TEXT NOT NULL DEFAULT '[]',
  extracted_by        TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_tender ON offers(tender_id, item_id);
CREATE TABLE IF NOT EXISTS sellers (
  inn         TEXT PRIMARY KEY,
  name        TEXT,
  egrul_json  TEXT,
  checked_at  TEXT,
  decision    TEXT,                              -- trusted | blocked | NULL
  decided_at  TEXT
);
CREATE TABLE IF NOT EXISTS tender_photos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id    INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  item_idx     INTEGER,                          -- номер позиции, к которой относится (NULL — к закупке в целом)
  file         TEXT NOT NULL,                    -- имя файла в data/photos/<tender_id>/
  mime         TEXT,
  size         INTEGER,
  source_file  TEXT,                             -- из какого документа
  context      TEXT                              -- текст перед картинкой в документе
);
CREATE INDEX IF NOT EXISTS idx_tender_photos ON tender_photos(tender_id, idx);
-- Набор партии: какими предложениями и в каком количестве закрыта позиция (один продавец на всё количество — одна строка).
CREATE TABLE IF NOT EXISTS item_allocations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tender_id     INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL,
  offer_id      INTEGER NOT NULL,
  qty           REAL NOT NULL,
  delivery_cost REAL,                              -- доставка этой части от продавца
  note          TEXT,                              -- что уточнить у продавца (например, наличие)
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_allocations ON item_allocations(tender_id, item_id);
CREATE TABLE IF NOT EXISTS tender_economics (
  tender_id       INTEGER PRIMARY KEY REFERENCES tenders(id) ON DELETE CASCADE,
  overrides_json  TEXT NOT NULL DEFAULT '{}',    -- ручные значения из калькулятора
  result_json     TEXT,
  verdict         TEXT,                          -- выгодно | на грани | невыгодно | нет данных
  profit          REAL,
  margin_pct      REAL,
  computed_at     TEXT
);
`;

/** Добавляет колонку, если её ещё нет (миграция существующей базы). */
function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function recoverAfterRestart(db) {
  db.prepare(`UPDATE offer_searches SET status = 'error', error = 'Поиск прерван перезапуском сервера', finished_at = ?
    WHERE status IN ('queued', 'running')`).run(new Date().toISOString());
  // Разборы, прерванные перезапуском сервера, не зависают в "processing" навсегда.
  db.prepare(
    `UPDATE analyses SET status = 'error', error = 'Обработка прервана перезапуском сервера'
     WHERE status IN ('queued', 'processing')`
  ).run();
  db.prepare(
    `UPDATE sync_runs SET status = 'error', error = 'Синхронизация прервана перезапуском сервера', finished_at = ?
     WHERE status = 'running'`
  ).run(new Date().toISOString());
}

/** @param {{recoverInterrupted?: boolean}} [opts] — false для служебных скриптов: не трогать разборы и поиски работающего сервера */
function openDb(dataDir, { recoverInterrupted = true } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
  db.exec(SCHEMA);
  addColumn(db, 'profile', 'economics_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn(db, 'tender_items', 'purchase_offer_id', 'INTEGER');
  addColumn(db, 'tender_items', 'purchase_offer_delivery', 'REAL');
  addColumn(db, 'tender_items', 'purchase_selected_by', 'TEXT'); // auto | user
  // Этап 5: режим перепродажи
  addColumn(db, 'profile', 'mode', "TEXT NOT NULL DEFAULT 'resale'"); // resale | profile
  addColumn(db, 'tender_economics', 'opportunity', 'REAL');        // ранг возможности заработать
  addColumn(db, 'tender_economics', 'confirmed', 'INTEGER');       // 1 — цены всех позиций от найденных поставщиков
  addColumn(db, 'offers', 'verified', 'INTEGER');
  addColumn(db, 'offer_searches', 'funnel_json', 'TEXT'); // воронка поиска по позициям (offers/funnel.js)
  addColumn(db, 'sellers', 'gov_contracts', 'INTEGER NOT NULL DEFAULT 0'); // сколько раз встречен победителем госконтрактов
  // Этап 6b: спецификация товара из ТЗ и сверка «тот же товар» с прошлыми контрактами
  addColumn(db, 'tender_items', 'spec_json', 'TEXT');
  // характеристики из карточки КТРУ в извещении с инструкцией заказчика (конкретное / не менять) — отдельно от
  // characteristics_json: по тому позиция узнаётся при обновлении, а чтение ТЗ его переписывает
  addColumn(db, 'tender_items', 'eis_chars_json', 'TEXT');
  addColumn(db, 'tender_items', 'eis_measure', 'TEXT'); // мера нацрежима позиции по отметкам извещения: запрет / ограничение / преимущество / нет
  addColumn(db, 'tender_items', 'contract_match_json', 'TEXT');   // {наименование из контракта: {verdict, reason}}
  addColumn(db, 'tender_details', 'spec_status', 'TEXT');         // done | no_docs | error | NULL (не читали)
  addColumn(db, 'tender_details', 'spec_note', 'TEXT');
  addColumn(db, 'tender_details', 'spec_at', 'TEXT');
  // Полнота чтения: у файла — версия (хеш содержимого) и отчёт об извлечении; у закупки — отдельные отчёты
  // по извлечению позиций и по чтению ТЗ (успех общего разбора их полноту не подтверждает).
  addColumn(db, 'files', 'sha256', 'TEXT');
  addColumn(db, 'files', 'coverage_json', 'TEXT');
  addColumn(db, 'tender_details', 'spec_coverage_json', 'TEXT');
  addColumn(db, 'tender_details', 'items_coverage_json', 'TEXT');
  addColumn(db, 'tenders', 'source', 'TEXT'); // этап 6a: из какого источника пришла закупка
  // нижняя граница срока подачи из ленты ЕИС: «окончание подачи не раньше этого дня» (точный срок — deadline_at)
  addColumn(db, 'tenders', 'deadline_from', 'TEXT');
  // этап из ленты ЕИС, на котором приём заявок закрыт («Определение поставщика отменено» и т. п.); NULL — не закрыт
  addColumn(db, 'tenders', 'closed_stage', 'TEXT');
  // когда этап закупки последний раз сверялся с ЕИС (по ленте или по номеру)
  addColumn(db, 'tenders', 'stage_checked_at', 'TEXT');
  // Срок подачи, взятый из извещения, раньше затирался пустым полем ленты при следующем обновлении — возвращаем его
  // из сохранённых условий закупки. Повторный запуск ничего не меняет.
  db.exec(`UPDATE tenders SET deadline_at = (SELECT json_extract(d.conditions_json, '$.deadline_at') FROM tender_details d WHERE d.tender_id = tenders.id)
    WHERE deadline_at IS NULL AND EXISTS (SELECT 1 FROM tender_details d WHERE d.tender_id = tenders.id AND json_extract(d.conditions_json, '$.deadline_at') IS NOT NULL)`);
  // Уведомления о выгодных закупках: когда закупка впервые стала выгодной и когда о ней написали в Telegram
  // Контакты поставщика: {phones, emails, site, contacts_url, checked}
  // На чём основана оценка закупки (отпечаток того, что видела нейросеть): если профиль менялся только фильтрами
  // (виды закупок, срок) — оценку не пересчитываем, а восстанавливаем.
  addColumn(db, 'tenders', 'score_basis', 'TEXT');
  // Дата цены предложения: дата госконтракта или день, когда цена взята с сайта магазина
  addColumn(db, 'offers', 'price_date', 'TEXT');
  addColumn(db, 'offers', 'contacts_json', 'TEXT');
  // Карточка товара у поставщика: фото и характеристики со страницы магазина или из строки контракта
  addColumn(db, 'offers', 'image_url', 'TEXT');
  // Товар на сайте поставщика по госконтракту: прямая ссылка, цена и название оттуда; product_checked_at — уже искали
  addColumn(db, 'offers', 'product_url', 'TEXT');
  addColumn(db, 'offers', 'product_price', 'REAL');
  addColumn(db, 'offers', 'product_title', 'TEXT');
  addColumn(db, 'offers', 'product_checked_at', 'TEXT');
  addColumn(db, 'offers', 'specs_json', 'TEXT');
  // Корзина: предложения, отложенные пользователем для сравнения (время добавления)
  addColumn(db, 'offers', 'cart_at', 'TEXT');
  // Сверка с ТЗ по каждому требованию: {total, confirmed, failed, unknown, rows: [{name, need, verdict, found}]}
  addColumn(db, 'offers', 'match_checks_json', 'TEXT');
  // Состояние товара, если он не новый: «уценка», «б/у», «восстановленный»
  addColumn(db, 'offers', 'condition', 'TEXT');
  addColumn(db, 'sellers', 'contacts_json', 'TEXT');
  // Количество в наличии со страницы товара: stock_qty — число (для «более N» — N), stock_note — «более 10», «под заказ».
  addColumn(db, 'offers', 'stock_qty', 'REAL');
  addColumn(db, 'offers', 'stock_note', 'TEXT');
  addColumn(db, 'offers', 'stock_checked_at', 'TEXT'); // когда остаток читали со страницы (у находок до 09.10.2026 — пусто)
  // Логистика: кто везёт (продавец / перевозчик), на чём основана цифра, вес и объём единицы товара.
  addColumn(db, 'offers', 'delivery_carrier', 'TEXT');
  addColumn(db, 'offers', 'delivery_basis', 'TEXT');
  addColumn(db, 'offers', 'unit_weight_kg', 'REAL');
  addColumn(db, 'offers', 'unit_volume_m3', 'REAL');
  addColumn(db, 'offers', 'cargo_estimated', 'INTEGER');
  // Отметка по реестру недобросовестных поставщиков: clean — в реестре нет, listed — в реестре, пусто — не проверяли.
  addColumn(db, 'sellers', 'rnp_status', 'TEXT');
  addColumn(db, 'sellers', 'rnp_checked_at', 'TEXT');
  // Кто поставил отметку (manual — пользователь, auto — проверка по реестру) и что нашла проверка (записи реестра).
  addColumn(db, 'sellers', 'rnp_source', 'TEXT');
  addColumn(db, 'sellers', 'rnp_note', 'TEXT');
  db.exec("UPDATE sellers SET rnp_source = 'manual' WHERE rnp_status IS NOT NULL AND rnp_source IS NULL");
  // Выбор предложения, сделанный до появления набора партии: позиция закрыта одним продавцом на всё количество.
  // Дописываем такую строку набора, если её ещё нет (повторный запуск ничего не меняет).
  db.prepare(`INSERT INTO item_allocations (tender_id, item_id, offer_id, qty, delivery_cost, note, created_at)
    SELECT i.tender_id, i.id, i.purchase_offer_id, COALESCE(NULLIF(i.quantity, 0), 1), i.purchase_offer_delivery, NULL, ?
    FROM tender_items i
    WHERE i.purchase_offer_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM offers o WHERE o.id = i.purchase_offer_id)
      AND NOT EXISTS (SELECT 1 FROM item_allocations a WHERE a.item_id = i.id)`).run(new Date().toISOString());
  addColumn(db, 'tender_economics', 'alerted_at', 'TEXT');
  addColumn(db, 'tender_economics', 'alert_tg_at', 'TEXT');
  addColumn(db, 'tender_economics', 'alert_read_at', 'TEXT');   // когда уведомление прочитано на сайте
  addColumn(db, 'tender_economics', 'alert_profit', 'REAL');     // прибыль и маржа на момент уведомления — для истории
  addColumn(db, 'tender_economics', 'alert_margin', 'REAL');
  // Вид уведомления (profit | edge | found — см. tenders/alert-kind.js) и себестоимость товара на момент уведомления
  addColumn(db, 'tender_economics', 'alert_kind', 'TEXT');
  addColumn(db, 'tender_economics', 'alert_purchase', 'REAL');
  // Прерванное перезапуском сервера не зависает в «идёт» навсегда. Скрипт рядом с работающим сервером это пропускает.
  // Направления (группы товаров): настройки каждого — в профиле, метка направления — у каждой закупки
  addColumn(db, 'profile', 'directions_json', 'TEXT');
  addColumn(db, 'tenders', 'direction', 'TEXT');
  // Площадка, на которой проходит закупка (куда подавать заявку): короткое имя, сайт и когда её определяли.
  // platform_checked_at пуст — площадку ещё не узнавали (она есть только в подробностях закупки).
  addColumn(db, 'tenders', 'platform', 'TEXT');
  addColumn(db, 'tenders', 'platform_url', 'TEXT');
  addColumn(db, 'tenders', 'platform_checked_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tenders_direction ON tenders(direction, status)');
  if (recoverInterrupted) recoverAfterRestart(db);
  db.prepare('INSERT OR IGNORE INTO profile (id, updated_at) VALUES (1, ?)').run(new Date().toISOString());
  seedDirections(db);
  return createRepo(db);
}

/**
 * Переход со старой версии, где было одно общее направление в полях профиля «Коды» и «Ключевые слова»: заводим
 * стандартные направления (см. tenders/directions.js → seedDirections). Версия профиля растёт — при следующей
 * синхронизации закупки будут перепроверены и получат метки направлений.
 */
function seedDirections(db) {
  const p = db.prepare('SELECT codes_json, keywords_json, directions_json, mode FROM profile WHERE id = 1').get();
  if (!p || p.directions_json != null) return;
  const dirs = directions.seedDirections({ codes: J(p.codes_json, []), keywords: J(p.keywords_json, []) });
  const enabled = dirs.filter((d) => d.enabled);
  if (p.mode !== 'profile' && enabled.length) {
    db.prepare('UPDATE profile SET directions_json = ?, codes_json = ?, keywords_json = ?, version = version + 1 WHERE id = 1')
      .run(JSON.stringify(dirs), JSON.stringify(directions.unionCodes(enabled)), JSON.stringify(directions.unionKeywords(enabled)));
  } else {
    db.prepare('UPDATE profile SET directions_json = ? WHERE id = 1').run(JSON.stringify(dirs));
  }
}

function createRepo(db) {
  const now = () => new Date().toISOString();
  return {
    db,
    createAnalysis({ id, title }) {
      db.prepare('INSERT INTO analyses (id, title, status, created_at) VALUES (?, ?, ?, ?)')
        .run(id, title, 'queued', now());
    },
    setProgress(id, progress) {
      db.prepare("UPDATE analyses SET status = 'processing', progress = ? WHERE id = ?")
        .run(JSON.stringify(progress), id);
    },
    finishAnalysis(id, { card, provider, model, durationMs, tokensIn, tokensOut }) {
      db.prepare(
        `UPDATE analyses SET status = 'done', progress = NULL, card_json = ?, provider = ?, model = ?,
         finished_at = ?, duration_ms = ?, tokens_in = ?, tokens_out = ? WHERE id = ?`
      ).run(JSON.stringify(card), provider, model, now(), durationMs, tokensIn ?? null, tokensOut ?? null, id);
    },
    /** Заменить карточку готового разбора (например, после повторной правовой проверки). */
    updateAnalysisCard(id, card) {
      db.prepare('UPDATE analyses SET card_json = ? WHERE id = ?').run(JSON.stringify(card), id);
    },
    failAnalysis(id, error) {
      db.prepare("UPDATE analyses SET status = 'error', progress = NULL, error = ?, finished_at = ? WHERE id = ?")
        .run(String(error), now(), id);
    },
    addFile(analysisId, f) {
      const r = db.prepare(
        `INSERT INTO files (analysis_id, original_name, path, mime, status, message, pages_count, text_json, sha256, coverage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(analysisId, f.name, f.path ?? null, f.mime ?? null, f.status, f.message ?? null,
        f.pages.length, JSON.stringify(f.pages), f.sha256 ?? null, f.coverage ? JSON.stringify(f.coverage) : null);
      return Number(r.lastInsertRowid);
    },
    /** Заменить текст файла после повторного чтения (дочитаны непрочитанные страницы). */
    updateFile(fileId, f) {
      db.prepare('UPDATE files SET status = ?, message = ?, pages_count = ?, text_json = ?, coverage_json = ? WHERE id = ?')
        .run(f.status, f.message ?? null, f.pages.length, JSON.stringify(f.pages), f.coverage ? JSON.stringify(f.coverage) : null, fileId);
    },
    /** Файлы разбора вместе с текстом страниц — для разбора и повторного чтения. */
    getFilesFull(analysisId) {
      return db.prepare('SELECT * FROM files WHERE analysis_id = ? ORDER BY id').all(analysisId).map((f) => ({
        id: f.id, name: f.original_name, path: f.path, mime: f.mime, status: f.status, message: f.message,
        pages: J(f.text_json, []), sha256: f.sha256, coverage: J(f.coverage_json, null),
      }));
    },
    // ---------- фрагменты разбора ----------
    saveChunk(analysisId, task, c) {
      db.prepare(`INSERT INTO analysis_chunks (analysis_id, task, chunk_id, cache_key, status, attempts, error_kind, error, model, duration_ms, ranges_json, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(analysisId, task, c.id, c.cache_key, c.status, c.attempts ?? 0, c.error_kind ?? null, c.error ?? null,
        c.model ?? null, c.duration_ms ?? null, JSON.stringify(c.ranges || []), c.result ? JSON.stringify(c.result) : null, now());
    },
    listChunks(analysisId, task) {
      return db.prepare('SELECT * FROM analysis_chunks WHERE analysis_id = ? AND task = ? ORDER BY id').all(analysisId, task)
        .map(({ ranges_json, result_json, chunk_id, ...c }) => ({ ...c, id: chunk_id, ranges: J(ranges_json, []), result: J(result_json, null) }));
    },
    clearChunks(analysisId, task) {
      db.prepare('DELETE FROM analysis_chunks WHERE analysis_id = ? AND task = ?').run(analysisId, task);
    },
    /** Принятый раньше результат того же фрагмента (тот же текст, та же задача, та же версия промпта). */
    cachedChunk(cacheKey) {
      const r = db.prepare("SELECT result_json, model FROM analysis_chunks WHERE cache_key = ? AND status = 'ok' AND result_json IS NOT NULL ORDER BY id DESC LIMIT 1").get(cacheKey);
      return r ? { result: J(r.result_json, null), model: r.model } : null;
    },
    listAnalyses() {
      return db.prepare(
        'SELECT id, title, status, created_at, card_json FROM analyses ORDER BY created_at DESC'
      ).all().map(({ card_json, ...a }) => ({
        ...a,
        recommendation: card_json ? JSON.parse(card_json).summary?.recommendation?.value ?? null : null,
      }));
    },
    getAnalysis(id) {
      const a = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
      if (!a) return null;
      const files = db.prepare(
        'SELECT id, original_name, mime, status, message, pages_count, sha256, coverage_json FROM files WHERE analysis_id = ? ORDER BY id'
      ).all(id).map(({ coverage_json, ...f }) => ({ ...f, coverage: J(coverage_json, null) }));
      return {
        ...a,
        progress: a.progress ? JSON.parse(a.progress) : null,
        card: a.card_json ? JSON.parse(a.card_json) : null,
        card_json: undefined,
        files,
      };
    },
    /** Файл разбора на диске — для скачивания (путь к загруженному файлу или к архиву, в котором он лежит). */
    getFileMeta(analysisId, fileId) {
      return db.prepare('SELECT id, analysis_id, original_name, path, mime, status FROM files WHERE analysis_id = ? AND id = ?').get(analysisId, fileId) || null;
    },
    /** Весь текст файла по страницам — для просмотра документа целиком. */
    getFileText(analysisId, fileId) {
      const f = db.prepare('SELECT original_name, text_json FROM files WHERE id = ? AND analysis_id = ?').get(fileId, analysisId);
      if (!f) return null;
      const pages = JSON.parse(f.text_json || '[]').map((p) => ({ page: p.page, text: p.text || '' }));
      return { file: f.original_name, pagesCount: pages.length, pages };
    },
    getFilePage(analysisId, fileId, page) {
      const f = db.prepare('SELECT original_name, text_json FROM files WHERE id = ? AND analysis_id = ?')
        .get(fileId, analysisId);
      if (!f) return null;
      const pages = JSON.parse(f.text_json || '[]');
      const p = pages.find((x) => x.page === page);
      return p ? { file: f.original_name, page, pagesCount: pages.length, text: p.text } : null;
    },
    deleteAnalysis(id) {
      return db.prepare('DELETE FROM analyses WHERE id = ?').run(id).changes > 0;
    },
    ...tendersRepo(db, now),
  };
}

const J = (v, d) => (v == null ? d : JSON.parse(v));

function offerRow(r) {
  if (!r) return null;
  const { match_notes_json, trust_reasons_json, seller_egrul_json, ...o } = r;
  return {
    ...o,
    // основной вид деятельности продавца по ЕГРЮЛ — по нему видно, производитель это, профильный торговец или посредник
    seller_okved: J(seller_egrul_json, null)?.okved ?? null, seller_gov_contracts: o.seller_gov_contracts ?? 0,
    seller_inn_on_site: Boolean(o.seller_inn_on_site), delivery_estimated: Boolean(o.delivery_estimated),
    in_time: o.in_time == null ? null : Boolean(o.in_time), verified: Boolean(o.verified), in_cart: Boolean(o.cart_at),
    match_notes: J(match_notes_json, []), trust_reasons: J(trust_reasons_json, []),
    contacts: J(o.contacts_json, null), contacts_json: undefined,
    specs: J(o.specs_json, []), specs_json: undefined,
    match_checks: J(o.match_checks_json, null), match_checks_json: undefined,
    // что нашла проверка по реестру недобросовестных поставщиков: {records, excluded, total}
    seller_rnp_info: J(o.seller_rnp_note, null), seller_rnp_note: undefined,
  };
}

function tenderRow(r) {
  if (!r) return null;
  const { okpd2_json, ktru_json, reasons_json, concerns_json, analysis_card, ...t } = r;
  return {
    ...t,
    okpd2: J(okpd2_json, []),
    ktru: J(ktru_json, []),
    reasons: J(reasons_json, []),
    concerns: J(concerns_json, []),
    analysis_recommendation: analysis_card ? JSON.parse(analysis_card).summary?.recommendation?.value ?? null : null,
  };
}

// Во сколько обойдётся товар по подтверждённым ценам (найденное предложение или цена вручную) — на всё количество.
const PURCHASE_SUM = '(SELECT SUM(COALESCE(i.purchase_price_manual, i.purchase_price_offer) * COALESCE(i.quantity, 1)) FROM tender_items i WHERE i.tender_id = t.id)';
// Ступени интереса для сортировки «сначала выгодные» — от самых выгодных к менее интересным:
//   7 — выгодно, цены подтверждены поставщиками    6 — на грани, цены подтверждены
//   5 — выгодно по оценке (цены прошлых контрактов)  4 — товар найден, заказчик цену не назвал (можно предлагать свою)
//   3 — на грани по оценке                           2 — расчёта пока нет    1 — невыгодно
const INTEREST_TIER = `CASE
  WHEN e.verdict = 'выгодно' AND e.confirmed = 1 THEN 7
  WHEN e.verdict = 'на грани' AND e.confirmed = 1 THEN 6
  WHEN e.verdict = 'выгодно' THEN 5
  WHEN e.verdict = 'нет данных' AND e.confirmed = 1 AND COALESCE(t.price, 0) = 0 THEN 4
  WHEN e.verdict = 'на грани' THEN 3
  WHEN e.verdict = 'невыгодно' THEN 1
  ELSE 2 END`;
// Внутри ступени: подтверждённые и убыточные — по прибыли в рублях; оценочные — по ожидаемой марже с учётом
// уверенности; «товар найден» — по сумме сделки (крупнее — интереснее); без расчёта — по оценке нейросети.
const INTEREST_ORDER = `${INTEREST_TIER} DESC, CASE ${INTEREST_TIER} WHEN 7 THEN e.profit WHEN 6 THEN e.profit WHEN 1 THEN e.profit
  WHEN 4 THEN ${PURCHASE_SUM} WHEN 2 THEN t.score ELSE e.opportunity END DESC, t.score IS NULL, t.score DESC, t.deadline_at`;

// Где опубликована закупка: 'eis' — ЕИС (все госзакупки: 44-ФЗ и 223-ФЗ), 'com' — вне ЕИС (коммерческие).
function wherePublished(published, where, args) {
  if (!published?.length) return;
  const laws = [...new Set(published.flatMap((p) => (p === 'eis' ? ['44', '223'] : p === 'com' ? ['com'] : [])))];
  where.push(laws.length ? `t.law IN (${laws.map(() => '?').join(', ')})` : '0');
  args.push(...laws);
}

// На какой площадке идут торги: имена площадок; пустая строка в списке — площадка ещё не определена.
function wherePlatforms(platforms, where, args) {
  if (!platforms?.length) return;
  const named = platforms.filter(Boolean);
  const parts = [];
  if (named.length) { parts.push(`t.platform IN (${named.map(() => '?').join(', ')})`); args.push(...named); }
  if (platforms.includes('')) parts.push('t.platform IS NULL');
  where.push(`(${parts.join(' OR ')})`);
}

function tendersRepo(db, now) {
  const FEED_MIN_MARGIN_DEFAULT = 20;
  // Мои площадки — где у компании есть регистрация. Хранится в настройках, а не в профиле: смена списка не меняет
  // версию профиля и не запускает переоценку закупок. Пустой список — площадки не отбираются.
  const myPlatforms = () => {
    try { const v = JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get('my_platforms')?.value || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
  };
  const feedMinMargin = () => {
    const v = db.prepare('SELECT value FROM settings WHERE key = ?').get('feed_min_margin_pct')?.value;
    const n = v == null ? FEED_MIN_MARGIN_DEFAULT : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : FEED_MIN_MARGIN_DEFAULT;
  };
  // Сложность закупки — как в карточке («Главное»): простая — одна позиция и не больше 12 характеристик, средняя — до 5
  // позиций, сложная — больше. Позиции ещё не загружены — NULL (сложность не известна).
  const DIFFICULTY = `(SELECT CASE WHEN COUNT(*) = 0 THEN NULL
      WHEN COUNT(*) <= 1 AND COALESCE(SUM(COALESCE(json_array_length(i.eis_chars_json), json_array_length(i.characteristics_json))), 0) <= 12 THEN 'simple'
      WHEN COUNT(*) <= 5 THEN 'medium' ELSE 'complex' END FROM tender_items i WHERE i.tender_id = t.id)`;
  const TENDER_SELECT = `SELECT t.id, t.law, t.number, t.title, t.price, t.currency, t.region, t.okpd2_json, t.ktru_json,
      t.customer_inn, t.published_at, t.deadline_at, t.deadline_from, t.closed_stage, t.stage, t.eis_url, t.status, t.filter_reason, t.score, t.verdict,
      t.reasons_json, t.concerns_json, t.score_error, t.scored_profile_version, t.score_basis, t.analysis_id, t.first_seen_at,
      a.status AS analysis_status, a.card_json AS analysis_card,
      e.verdict AS econ_verdict, e.profit AS econ_profit, e.margin_pct AS econ_margin, e.computed_at AS econ_at,
      e.opportunity AS econ_opportunity, e.confirmed AS econ_confirmed,
      ${PURCHASE_SUM} AS econ_purchase,
      t.direction,
      t.source,
      t.platform, t.platform_url, t.platform_checked_at,
      ${DIFFICULTY} AS difficulty,
      (SELECT COUNT(*) FROM tender_items i WHERE i.tender_id = t.id) AS items_count,
      (SELECT d.spec_status FROM tender_details d WHERE d.tender_id = t.id) AS spec_status,
      (SELECT json_extract(d.spec_coverage_json, '$.status') FROM tender_details d WHERE d.tender_id = t.id) AS spec_coverage_status,
      json_extract(a.card_json, '$.decision.decision_status') AS analysis_decision_status
    FROM tenders t LEFT JOIN analyses a ON a.id = t.analysis_id LEFT JOIN tender_economics e ON e.tender_id = t.id`;

  // Закупка «живая»: до окончания подачи не меньше «дней до подачи» из профиля (по московским суткам: «2 дня» —
  // окончание послезавтра или позже). Срок известен точно — по нему; известна только нижняя граница из ленты ЕИС
  // (deadline_from: «окончание не раньше этого дня») — по ней. У закупки из ленты ЕИС без того и другого срок
  // неизвестен в принципе (лента его не даёт) — она не показывается: раньше такие закупки считались действующими,
  // и в ленту попадали давно завершённые. У источников с извещением (ГосПлан, площадки) пустой срок — редкость: такие
  // закупки видны, как раньше. Свои закупки (добавленные вручную) видны, пока срок не прошёл или если он не указан.
  // Параметр — текущее время (ISO).
  const LIVE = `EXISTS (SELECT 1 FROM (SELECT ? AS n) q WHERE
    (t.source = 'manual' AND (t.deadline_at IS NULL OR t.deadline_at > q.n))
    OR (t.source IS NOT 'manual' AND t.deadline_at IS NULL AND t.deadline_from IS NULL AND COALESCE(t.source, '') NOT LIKE '%eis-rss%')
    OR (t.source IS NOT 'manual' AND COALESCE(t.deadline_at, t.deadline_from) >= MAX(q.n, strftime('%Y-%m-%dT%H:%M:%fZ', q.n, '+3 hours', 'start of day',
      '+' || COALESCE((SELECT min_days_to_deadline FROM profile WHERE id = 1), 2) || ' days', '-3 hours'))))`;

  const repo = {
    // ---------- профиль ----------
    getProfile() {
      const p = db.prepare('SELECT * FROM profile WHERE id = 1').get();
      return {
        mode: p.mode === 'profile' ? 'profile' : 'resale',
        description: p.description,
        regions: J(p.regions_json, []),
        price_min: p.price_min,
        price_max: p.price_max,
        codes: J(p.codes_json, []),
        keywords: J(p.keywords_json, []),
        // Направления (группы товаров): {id, title, short, note, enabled, codes, keywords}. В режиме перепродажи при
        // хотя бы одном включённом codes и keywords профиля — объединение включённых направлений.
        directions: J(p.directions_json, []),
        stop_words: J(p.stop_words_json, []),
        min_days_to_deadline: p.min_days_to_deadline,
        laws: J(p.laws_json, ['44', '223']),
        economics: { ...ECONOMICS_DEFAULTS, ...J(p.economics_json, {}) },
        score_threshold: p.score_threshold,
        digest_size: p.digest_size,
        // Лента: закупки с посчитанной маржой ниже этого порога скрываются (0 — не отбирать). Хранится в настройках,
        // а не в профиле: смена порога версию профиля не меняет и переоценку закупок не запускает.
        feed_min_margin_pct: feedMinMargin(),
        // площадки, где у компании есть регистрация: закупки других площадок скрыты по умолчанию
        my_platforms: myPlatforms(),
        version: p.version,
        updated_at: p.updated_at,
      };
    },
    /** Сохраняет профиль и увеличивает версию — оценки прошлой версии считаются устаревшими. */
    /** Мои площадки: список коротких имён площадок (как в tenders.platform). */
    setMyPlatforms(list) {
      const clean = [...new Set((list || []).map((x) => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 40);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('my_platforms', JSON.stringify(clean));
      return myPlatforms();
    },
    /** Порог маржи для ленты, % (0 — отбор выключен). */
    setFeedMinMargin(pct) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('feed_min_margin_pct', String(pct));
      return feedMinMargin();
    },
    saveProfile(p) {
      // Направления не пришли — остаются прежними. Включено хотя бы одно (перепродажа) — коды и слова профиля
      // собираются из включённых направлений: по ним идёт загрузка из источников.
      const dirs = Array.isArray(p.directions) ? p.directions : repo.getProfile().directions;
      const mode = p.mode === 'profile' ? 'profile' : 'resale';
      const enabled = directions.enabledOf({ directions: dirs });
      const byDirs = mode === 'resale' && enabled.length > 0;
      const codes = byDirs ? directions.unionCodes(enabled) : p.codes;
      const keywords = byDirs ? directions.unionKeywords(enabled) : p.keywords;
      db.prepare(
        `UPDATE profile SET description = ?, regions_json = ?, price_min = ?, price_max = ?, codes_json = ?,
         keywords_json = ?, stop_words_json = ?, min_days_to_deadline = ?, laws_json = ?, score_threshold = ?,
         digest_size = ?, economics_json = ?, mode = ?, directions_json = ?, version = version + 1, updated_at = ? WHERE id = 1`
      ).run(p.description, JSON.stringify(p.regions), p.price_min ?? null, p.price_max ?? null, JSON.stringify(codes),
        JSON.stringify(keywords), JSON.stringify(p.stop_words), p.min_days_to_deadline, JSON.stringify(p.laws),
        p.score_threshold, p.digest_size, JSON.stringify(p.economics || {}), mode, JSON.stringify(dirs), now());
      return repo.getProfile();
    },

    // ---------- закупки ----------
    /** @returns {{id: number, isNew: boolean}} */
    upsertTender(t) {
      const existing = db.prepare('SELECT id, source FROM tenders WHERE law = ? AND number = ?').get(t.law, t.number);
      const raw = JSON.stringify(t.raw_json ?? null);
      // Закупку, добавленную вручную, источник не перезаписывает: у неё свои файлы и поля, вписанные владельцем.
      if (existing?.source === 'manual') return { id: Number(existing.id), isNew: false };
      if (existing) {
        db.prepare(
          `UPDATE tenders SET title = ?, price = COALESCE(?, price), currency = COALESCE(?, currency), region = COALESCE(?, region),
           okpd2_json = CASE WHEN ? = '[]' THEN okpd2_json ELSE ? END, ktru_json = CASE WHEN ? = '[]' THEN ktru_json ELSE ? END,
           customer_inn = COALESCE(?, customer_inn), published_at = COALESCE(?, published_at), deadline_at = COALESCE(?, deadline_at),
           deadline_from = CASE WHEN ? > COALESCE(deadline_from, '') THEN ? ELSE deadline_from END,
           closed_stage = CASE WHEN ? THEN NULL ELSE closed_stage END,
           stage_checked_at = CASE WHEN ? THEN ? ELSE stage_checked_at END,
           stage = COALESCE(?, stage), eis_url = COALESCE(?, eis_url), raw_json = CASE WHEN ? = 'null' THEN raw_json ELSE ? END,
           source = COALESCE(source, ?) WHERE id = ?`
        ).run(t.title, t.price ?? null, t.currency ?? null, t.region ?? null, JSON.stringify(t.okpd2 || []), JSON.stringify(t.okpd2 || []), JSON.stringify(t.ktru || []), JSON.stringify(t.ktru || []),
          t.customer_inn ?? null, t.published_at ?? null, t.deadline_at ?? null, t.deadline_from ?? '', t.deadline_from ?? null, t.open_confirmed ? 1 : 0, t.open_confirmed ? 1 : 0, now(),
          t.stage ?? null, t.eis_url ?? null, raw, raw, t.source_name ?? null, existing.id);
        return { id: Number(existing.id), isNew: false };
      }
      const r = db.prepare(
        `INSERT INTO tenders (law, number, title, price, currency, region, okpd2_json, ktru_json, customer_inn,
         published_at, deadline_at, deadline_from, stage, eis_url, raw_json, status, first_seen_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`
      ).run(t.law, t.number, t.title, t.price, t.currency, t.region, JSON.stringify(t.okpd2 || []), JSON.stringify(t.ktru || []),
        t.customer_inn, t.published_at, t.deadline_at, t.deadline_from ?? null, t.stage, t.eis_url, raw, now(), t.source_name ?? null);
      return { id: Number(r.lastInsertRowid), isNew: true };
    },
    getTender(id) {
      return tenderRow(db.prepare(`${TENDER_SELECT} WHERE t.id = ?`).get(id));
    },
    // ---------- закупки, добавленные вручную (tenders/manual.js) ----------
    findTender(law, number) {
      return db.prepare('SELECT id, source FROM tenders WHERE law = ? AND number = ?').get(String(law), String(number)) || null;
    },
    /** Закупка из своих документов: вне ЕИС, без оценки нейросетью; в ленте видна сразу. @returns {number} id */
    createManualTender({ number, title, price = null, region = null, customer_inn = null, deadline_at = null, eis_url = null, raw = null }) {
      const r = db.prepare(
        `INSERT INTO tenders (law, number, title, price, currency, region, okpd2_json, ktru_json, customer_inn,
         published_at, deadline_at, stage, eis_url, raw_json, status, first_seen_at, source)
         VALUES ('com', ?, ?, ?, 'RUB', ?, '[]', '[]', ?, ?, ?, NULL, ?, ?, 'new', ?, 'manual')`
      ).run(number, title, price, region, customer_inn, now(), deadline_at, eis_url, JSON.stringify(raw), now());
      return Number(r.lastInsertRowid);
    },
    getTenderRaw(id) {
      const r = db.prepare('SELECT raw_json FROM tenders WHERE id = ?').get(id);
      return r ? J(r.raw_json, null) : null;
    },
    setTenderRaw(id, raw) {
      db.prepare('UPDATE tenders SET raw_json = ? WHERE id = ?').run(JSON.stringify(raw ?? null), id);
    },
    /** Правка полей ручной закупки: меняются только переданные поля (null — очистить). */
    updateManualTender(id, f) {
      const cols = { title: 'title', price: 'price', deadline_at: 'deadline_at', region: 'region', customer_inn: 'customer_inn', url: 'eis_url' };
      const set = Object.keys(cols).filter((k) => f[k] !== undefined && !(k === 'title' && !String(f[k] || '').trim()));
      if (!set.length) return false;
      return db.prepare(`UPDATE tenders SET ${set.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ? AND source = 'manual'`)
        .run(...set.map((k) => (f[k] === '' ? null : f[k])), id).changes > 0;
    },
    /** Удалить закупку целиком: позиции, предложения, расчёт и прочее уходят вместе с ней (ON DELETE CASCADE). */
    deleteTender(id) {
      return db.prepare('DELETE FROM tenders WHERE id = ?').run(id).changes > 0;
    },
    countManualTenders() {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM tenders WHERE source = 'manual'").get().n);
    },
    /**
     * Закупки, которые нужно (пере)проверить под текущую версию профиля.
     * Уже истёкшие перепроверяются только если ещё не проверены — фильтр пометит их «подача закончилась».
     */
    tendersNeedingReview(profileVersion, nowIso = now()) {
      return db.prepare(
        `${TENDER_SELECT} WHERE t.status != 'dismissed' AND COALESCE(t.source, '') != 'manual'
           AND (t.scored_profile_version IS NULL OR t.scored_profile_version != ? OR t.status IN ('new', 'score_failed'))
           AND (${LIVE} OR t.status = 'new')
         ORDER BY t.id`
      ).all(profileVersion, nowIso).map(tenderRow);
    },
    /** Дополнить закупку данными извещения: срок подачи, регион, коды, ИНН заказчика (источник мог их не дать). */
    // ---------- фото товаров из ТЗ ----------
    getTenderPhotos(tenderId) {
      return db.prepare('SELECT * FROM tender_photos WHERE tender_id = ? ORDER BY idx').all(tenderId);
    },
    getTenderPhoto(tenderId, photoId) {
      return db.prepare('SELECT * FROM tender_photos WHERE tender_id = ? AND id = ?').get(tenderId, photoId) || null;
    },
    getTenderPhotosChecked(tenderId) {
      return repo.getSetting(`photos_checked_v3:${tenderId}`) != null;
    },
    saveTenderPhotos(tenderId, rows) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM tender_photos WHERE tender_id = ?').run(tenderId);
        const ins = db.prepare('INSERT INTO tender_photos (tender_id, idx, item_idx, file, mime, size, source_file, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const r of rows) ins.run(tenderId, r.idx, r.item_idx ?? null, r.file, r.mime ?? null, r.size ?? null, r.source_file ?? null, r.context ?? null);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      repo.setSetting(`photos_checked_v3:${tenderId}`, now());
    },
    updateTenderBasics(id, t) {
      const cur = db.prepare('SELECT deadline_at, region, customer_inn, okpd2_json, ktru_json FROM tenders WHERE id = ?').get(id);
      if (!cur) return false;
      const okpd2 = J(cur.okpd2_json, []).length ? null : (t.okpd2?.length ? JSON.stringify(t.okpd2) : null);
      const ktru = J(cur.ktru_json, []).length ? null : (t.ktru?.length ? JSON.stringify(t.ktru) : null);
      return db.prepare(`UPDATE tenders SET deadline_at = COALESCE(deadline_at, ?), region = COALESCE(region, ?),
        customer_inn = COALESCE(customer_inn, ?), okpd2_json = COALESCE(?, okpd2_json), ktru_json = COALESCE(?, ktru_json) WHERE id = ?`)
        .run(t.deadline_at ?? null, t.region ?? null, t.customer_inn ?? null, okpd2, ktru, id).changes > 0;
    },
    /**
     * Закупки из ленты, у которых этап давно не сверялся с ЕИС: срок подачи ещё не прошёл, но заказчик мог закупку
     * отменить. Сначала — с предложениями в корзине, затем самые выгодные и с лучшей оценкой.
     */
    stageCheckCandidates({ limit, olderThanIso, nowIso = now() }) {
      return db.prepare(`${TENDER_SELECT} WHERE t.status = 'scored' AND COALESCE(t.source, '') != 'manual' AND t.law IN ('44', '223')
          AND t.closed_stage IS NULL AND (t.stage_checked_at IS NULL OR t.stage_checked_at < ?) AND ${LIVE}
          ORDER BY EXISTS (SELECT 1 FROM offers o WHERE o.tender_id = t.id AND o.cart_at IS NOT NULL) DESC, e.opportunity IS NULL, e.opportunity DESC, t.score DESC
          LIMIT ?`).all(olderThanIso, nowIso, limit).map(tenderRow);
    },
    /** Этап сверен с ЕИС (в том числе «не найдена»): отметить время, чтобы не спрашивать снова раньше срока. */
    setStageChecked(id, at = now()) {
      db.prepare('UPDATE tenders SET stage_checked_at = ? WHERE id = ?').run(at, id);
    },
    /** В ЕИС приём заявок по закупке закрыт: запомнить этап. Своих (добавленных вручную) не касается. @returns {number|null} id */
    markClosed(law, number, stage) {
      const t = db.prepare('SELECT id, source FROM tenders WHERE law = ? AND number = ?').get(String(law), String(number));
      if (!t || t.source === 'manual' || !stage) return null;
      db.prepare('UPDATE tenders SET closed_stage = ? WHERE id = ?').run(String(stage).slice(0, 200), t.id);
      return Number(t.id);
    },
    setFiltered(id, reason, version) {
      db.prepare(
        // Оценку нейросети не стираем: если закупка вернётся в работу при том же описании профиля, её не придётся
        // оценивать заново (см. restoreScore). В ленте отсеянные закупки и так скрыты.
        `UPDATE tenders SET status = 'filtered', filter_reason = ?, score_error = NULL, scored_profile_version = ? WHERE id = ?`
      ).run(reason, version, id);
    },
    setScore(id, { score, verdict, reasons, concerns }, version, basis = null) {
      db.prepare(
        `UPDATE tenders SET status = 'scored', filter_reason = NULL, score = ?, verdict = ?, reasons_json = ?,
         concerns_json = ?, score_error = NULL, scored_profile_version = ?, score_basis = ? WHERE id = ?`
      ).run(score, verdict, JSON.stringify(reasons), JSON.stringify(concerns), version, basis, id);
    },
    /** Закупка снова прошла фильтры, а оценка сделана при том же описании профиля — возвращаем её без нейросети. */
    restoreScore(id, version) {
      db.prepare("UPDATE tenders SET status = 'scored', filter_reason = NULL, score_error = NULL, scored_profile_version = ? WHERE id = ? AND score IS NOT NULL").run(version, id);
    },
    setScoreFailed(id, error, version) {
      db.prepare(
        `UPDATE tenders SET status = 'score_failed', filter_reason = NULL, score = NULL, verdict = NULL,
         score_error = ?, scored_profile_version = ? WHERE id = ?`
      ).run(String(error).slice(0, 500), version, id);
    },
    // ---------- уведомления о выгодных закупках ----------
    /** Выгодные закупки: прибыль подтверждена ценами поставщиков, срок подачи не прошёл. where — доп. условие по e.* */
    /** Закупки с подтверждёнными ценами в работе — кандидаты на уведомление; вид (или его отсутствие) решает alertKind. */
    alertTenders(where, nowIso = now(), limit = 200) {
      return db.prepare(`${TENDER_SELECT.replace('t.source,', 't.source, e.alerted_at, e.alert_tg_at, e.alert_read_at, e.alert_profit, e.alert_margin, e.alert_kind, e.alert_purchase,')}
        WHERE t.status = 'scored' AND e.confirmed = 1
          AND ${LIVE} AND ${where}
        ORDER BY e.profit DESC, t.deadline_at`).all(nowIso).map(tenderRow).filter((t) => alertKind(t, nowIso)).slice(0, limit);
    },
    /** Новое уведомление (или повышение вида: «товар найден» → «выгодно») — снова непрочитано и не отправлено. */
    markAlerted(id, at = now(), kind = 'profit', purchase = null) {
      db.prepare(`UPDATE tender_economics SET alerted_at = ?, alert_kind = ?, alert_purchase = ?, alert_profit = profit, alert_margin = margin_pct,
        alert_read_at = NULL, alert_tg_at = NULL WHERE tender_id = ?`).run(at, kind, purchase, id);
    },
    markAlertSent(id, at = now()) {
      db.prepare('UPDATE tender_economics SET alert_tg_at = ? WHERE tender_id = ?').run(at, id);
    },
    /** Отметить уведомления прочитанными: ids — конкретные закупки, без ids — все. */
    markAlertsRead(ids = null, at = now()) {
      if (!ids) return db.prepare('UPDATE tender_economics SET alert_read_at = ? WHERE alerted_at IS NOT NULL AND alert_read_at IS NULL').run(at).changes;
      const st = db.prepare('UPDATE tender_economics SET alert_read_at = ? WHERE tender_id = ? AND alerted_at IS NOT NULL AND alert_read_at IS NULL');
      return ids.reduce((n, id) => n + Number(st.run(at, id).changes), 0);
    },
    /** История уведомлений (вкладка «Уведомления»), свежие сверху. still — выгодна ли закупка до сих пор. */
    listAlerts(nowIso = now(), limit = 200) {
      return db.prepare(`${TENDER_SELECT.replace('t.source,', 't.source, e.alerted_at, e.alert_tg_at, e.alert_read_at, e.alert_profit, e.alert_margin, e.alert_kind, e.alert_purchase,')}
        WHERE e.alerted_at IS NOT NULL ORDER BY e.alerted_at DESC LIMIT ?`).all(limit).map(tenderRow)
        // still — уведомление ещё в силе: закупка в работе и её нынешнее состояние не хуже того, о чём сообщали.
        .map((t) => ({ ...t, alert_kind: t.alert_kind || 'profit', still: (KIND_RANK[alertKind(t, nowIso)] || 0) >= KIND_RANK[t.alert_kind || 'profit'] }));
    },
    dismissTender(id) {
      return db.prepare("UPDATE tenders SET status = 'dismissed' WHERE id = ?").run(id).changes > 0;
    },
    setTenderAnalysis(id, analysisId) {
      db.prepare('UPDATE tenders SET analysis_id = ? WHERE id = ?').run(analysisId, id);
    },
    listTenders({ status, minScore, law, q, sort = 'score', limit = 30, offset = 0, showHidden = false, profitableOnly = false, direction, ids, platforms, published, minMargin = 0, priceMin, priceMax, difficulty, manual = false, nowIso = now() } = {}) {
      const where = [];
      const args = [];
      // manual — только закупки, добавленные вручную: все, включая скрытые и с истёкшим сроком (их немного, и они свои)
      if (manual) { where.push("t.source = 'manual'"); showHidden = true; }
      // В ленте — только закупки, на которые ещё можно подать заявку. С истёкшим сроком видны вместе с отсеянными и скрытыми.
      if (!status && !showHidden) { where.push(LIVE); args.push(nowIso); }
      // ids — только эти закупки (отбор по группам товаров считается заранее, см. tenders/product-groups.js)
      if (ids) { where.push('t.id IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(ids)); }
      // direction: id направления; 'none' — закупки вне включённых направлений
      if (direction === 'none') {
        // «Прочее»: без метки или с меткой направления, которое сейчас выключено
        const on = directions.enabledOf(repo.getProfile()).map((d) => d.id);
        where.push(`(t.direction IS NULL${on.length ? ` OR t.direction NOT IN (${on.map(() => '?').join(', ')})` : ''})`);
        args.push(...on);
      } else if (direction) { where.push('t.direction = ?'); args.push(String(direction)); }
      if (status) { where.push('t.status = ?'); args.push(status); }
      else if (!showHidden) where.push("t.status NOT IN ('filtered', 'dismissed')");
      if (minScore != null) { where.push('t.score >= ?'); args.push(minScore); }
      if (law) { where.push('t.law = ?'); args.push(String(law)); }
      // published: где опубликована закупка — 'eis' (ЕИС: 44-ФЗ и 223-ФЗ), 'com' (вне ЕИС: коммерческие)
      wherePublished(published, where, args);
      // platforms: имена площадок; пустая строка в списке — закупки, у которых площадка ещё не определена
      wherePlatforms(platforms, where, args);
      if (q) { where.push('(t.title LIKE ? OR t.number LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
      if (profitableOnly) where.push("e.verdict = 'выгодно'");
      // цена закупки (НМЦК) от и до: закупки без цены в такой отбор не попадают — их цена неизвестна
      if (priceMin != null) { where.push('t.price >= ?'); args.push(priceMin); }
      if (priceMax != null) { where.push('t.price <= ?'); args.push(priceMax); }
      // difficulty: ['simple', 'medium', 'complex', ''] — '' — сложность ещё не известна (позиции не загружены)
      if (difficulty?.length) {
        const named = difficulty.filter(Boolean);
        const parts = [];
        if (named.length) { parts.push(`${DIFFICULTY} IN (${named.map(() => '?').join(', ')})`); args.push(...named); }
        if (difficulty.includes('')) parts.push(`${DIFFICULTY} IS NULL`);
        where.push(`(${parts.join(' OR ')})`);
      }
      const order = {
        profit: 'e.profit IS NULL, e.profit DESC, t.score DESC',
        // Перепродажа: сначала подтверждённая поставщиками прибыль, потом ожидаемая маржа (ранг возможности).
        opportunity: INTEREST_ORDER,
        score: 't.score IS NULL, t.score DESC, t.deadline_at',
        deadline: 't.deadline_at IS NULL, t.deadline_at ASC',
        published: 't.published_at DESC',
        // цена закупки (НМЦК): закупки без цены — в конце
        price_asc: 't.price IS NULL, t.price ASC',
        price_desc: 't.price IS NULL, t.price DESC',
      }[sort] || 't.score IS NULL, t.score DESC';
      // minMargin: закупки с посчитанной маржой ниже порога скрываются; закупки без расчёта остаются — иначе в ленте
      // были бы только уже посчитанные. Сколько скрыто — сообщаем, чтобы отбор было видно и можно было снять.
      let hiddenByMargin = 0;
      if (minMargin > 0) {
        const base = where.length ? `WHERE ${where.join(' AND ')} AND` : 'WHERE';
        hiddenByMargin = Number(db.prepare(`SELECT COUNT(*) AS n FROM tenders t LEFT JOIN tender_economics e ON e.tender_id = t.id ${base} e.margin_pct < ?`).get(...args, minMargin).n);
        where.push('(e.margin_pct IS NULL OR e.margin_pct >= ?)');
        args.push(minMargin);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM tenders t LEFT JOIN tender_economics e ON e.tender_id = t.id ${whereSql}`).get(...args).n;
      const items = db.prepare(`${TENDER_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...args, limit, offset).map(tenderRow);
      return { total: Number(total), items, hidden_by_margin: hiddenByMargin };
    },
    /** Забыть, что ТЗ уже читали: после нового разбора документации требования соберутся заново. */
    clearSpec(tenderId) {
      db.prepare('UPDATE tender_details SET spec_status = NULL, spec_note = NULL, spec_at = NULL WHERE tender_id = ?').run(tenderId);
    },
    // ---------- направления ----------
    // ---------- площадки ----------
    /** Записать площадку закупки (null — узнать не удалось, попробуем позже). */
    setPlatform(id, platform) {
      if (!platform?.name) return;
      db.prepare('UPDATE tenders SET platform = ?, platform_url = ?, platform_checked_at = ? WHERE id = ?').run(platform.name, platform.url ?? null, now(), id);
    },
    /** Закупки, найденные на самой площадке (источник = площадка): проставить её тем, у кого она ещё не записана. */
    fillSourcePlatforms(bySource) {
      let n = 0;
      for (const [source, p] of Object.entries(bySource || {})) {
        n += Number(db.prepare('UPDATE tenders SET platform = ?, platform_url = ?, platform_checked_at = ? WHERE source = ? AND platform IS NULL').run(p.name, p.url ?? null, now(), source).changes);
      }
      return n;
    },
    /** В источнике этой закупки (пока) нет: площадку узнать не удалось — запомнить, когда спрашивали, чтобы не спрашивать каждый раз. */
    markPlatformChecked(id) {
      db.prepare('UPDATE tenders SET platform_checked_at = ? WHERE id = ? AND platform IS NULL').run(now(), id);
    },
    /**
     * Закупки в ленте без площадки: сначала те, у кого её ещё не узнавали (лучшие по оценке и с ближайшим сроком),
     * потом те, по которым источник ответил «не найдено» больше retryHours часов назад — закупка могла появиться.
     */
    platformCandidates({ limit = 30, nowIso = now(), retryHours = 12 } = {}) {
      const retryBefore = new Date(new Date(nowIso).getTime() - retryHours * 3600_000).toISOString();
      return db.prepare(`${TENDER_SELECT} WHERE t.platform IS NULL AND (t.platform_checked_at IS NULL OR t.platform_checked_at < ?)
        AND t.status NOT IN ('filtered', 'dismissed') AND ${LIVE}
        ORDER BY t.platform_checked_at IS NOT NULL, t.score IS NULL, t.score DESC, t.deadline_at LIMIT ?`).all(retryBefore, nowIso, limit).map(tenderRow);
    },
    /**
     * Сколько закупок в ленте на каждой площадке (без отсеянных, скрытых и с истёкшим сроком); direction — как в ленте,
     * published — считать только среди опубликованных там ('eis', 'com').
     */
    platformCounts({ direction, published, nowIso = now() } = {}) {
      const where = ["t.status NOT IN ('filtered', 'dismissed')", LIVE];
      const args = [nowIso];
      if (direction === 'none') {
        const on = directions.enabledOf(repo.getProfile()).map((d) => d.id);
        where.push(`(t.direction IS NULL${on.length ? ` OR t.direction NOT IN (${on.map(() => '?').join(', ')})` : ''})`);
        args.push(...on);
      } else if (direction) { where.push('t.direction = ?'); args.push(String(direction)); }
      wherePublished(published, where, args);
      return db.prepare(`SELECT t.platform AS name, MAX(t.platform_url) AS url, COUNT(*) AS n FROM tenders t WHERE ${where.join(' AND ')} GROUP BY t.platform ORDER BY n DESC`)
        .all(...args).map((r) => ({ name: r.name, url: r.url, count: Number(r.n) }));
    },
    /**
     * Сколько закупок в ленте опубликовано в ЕИС (44-ФЗ и 223-ФЗ) и вне его (коммерческие); direction — как в ленте,
     * platforms — считать только среди идущих на этих площадках.
     */
    publishedCounts({ direction, platforms, nowIso = now() } = {}) {
      const where = ["t.status NOT IN ('filtered', 'dismissed')", LIVE];
      const args = [nowIso];
      if (direction === 'none') {
        const on = directions.enabledOf(repo.getProfile()).map((d) => d.id);
        where.push(`(t.direction IS NULL${on.length ? ` OR t.direction NOT IN (${on.map(() => '?').join(', ')})` : ''})`);
        args.push(...on);
      } else if (direction) { where.push('t.direction = ?'); args.push(String(direction)); }
      wherePlatforms(platforms, where, args);
      const out = { eis: 0, com: 0 };
      for (const r of db.prepare(`SELECT t.law, COUNT(*) AS n FROM tenders t WHERE ${where.join(' AND ')} GROUP BY t.law`).all(...args)) out[r.law === 'com' ? 'com' : 'eis'] += Number(r.n);
      return out;
    },
    setDirection(id, direction) {
      db.prepare('UPDATE tenders SET direction = ? WHERE id = ?').run(direction ?? null, id);
    },
    /** Сколько закупок в ленте по каждому направлению (без отсеянных, скрытых и с истёкшим сроком). Ключ '' — без направления. */
    directionCounts(nowIso = now()) {
      const out = {};
      for (const r of db.prepare(`SELECT t.direction, COUNT(*) AS n FROM tenders t WHERE t.status NOT IN ('filtered', 'dismissed') AND ${LIVE} GROUP BY t.direction`).all(nowIso)) out[r.direction || ''] = Number(r.n);
      return out;
    },
    /** Все закупки в виде, достаточном для разметки по направлениям. */
    tendersForTagging() {
      return db.prepare('SELECT id, title, okpd2_json, ktru_json, direction FROM tenders').all()
        .map((r) => ({ id: r.id, title: r.title, okpd2: J(r.okpd2_json, []), ktru: J(r.ktru_json, []), direction: r.direction }));
    },
    /** Закупки для отбора по группам товаров: наименование, коды закупки и коды её позиций (по одному на позицию). */
    tendersForGroups(includeHidden = false, nowIso = now()) {
      const itemCodes = new Map();
      for (const r of db.prepare('SELECT tender_id, okpd2_code, ktru_code FROM tender_items WHERE okpd2_code IS NOT NULL OR ktru_code IS NOT NULL').iterate()) {
        if (!itemCodes.has(r.tender_id)) itemCodes.set(r.tender_id, []);
        itemCodes.get(r.tender_id).push(String(r.ktru_code || r.okpd2_code));
      }
      return (includeHidden
        ? db.prepare('SELECT id, title, okpd2_json, ktru_json FROM tenders').all()
        : db.prepare(`SELECT t.id, t.title, t.okpd2_json, t.ktru_json FROM tenders t WHERE t.status NOT IN ('filtered', 'dismissed') AND ${LIVE}`).all(nowIso))
        .map((r) => ({ id: r.id, title: r.title, codes: [...J(r.okpd2_json, []), ...J(r.ktru_json, [])].map(String), itemCodes: itemCodes.get(r.id) || [] }));
    },
    tenderIdsWithItems() {
      return db.prepare('SELECT DISTINCT tender_id FROM tender_items').all().map((r) => r.tender_id);
    },
    /** Кандидаты в дайджест: оценённые выше порога, впервые найденные после прошлого дайджеста. */
    digestCandidates({ since, threshold, limit, nowIso = now() }) {
      return db.prepare(
        `${TENDER_SELECT} WHERE t.status = 'scored' AND t.score >= ? AND t.first_seen_at > ?
           AND ${LIVE}
         ORDER BY t.score DESC, t.deadline_at ASC LIMIT ?`
      ).all(threshold, since || '', nowIso, limit).map(tenderRow);
    },

    // ---------- этап 3: позиции, ориентир, выгодность ----------
    getItems(tenderId) {
      return db.prepare('SELECT * FROM tender_items WHERE tender_id = ? ORDER BY idx').all(tenderId)
        .map(({ characteristics_json, spec_json, contract_match_json, eis_chars_json, ...i }) => ({
          ...i, characteristics: J(characteristics_json, []), spec: J(spec_json, null), contract_match: J(contract_match_json, {}), eis_chars: J(eis_chars_json, null),
        }));
    },
    /** Характеристики КТРУ из извещения (с инструкцией заказчика) — дописать к уже сохранённой позиции. */
    setItemEisChars(itemId, list, measure = null) {
      db.prepare('UPDATE tender_items SET eis_chars_json = ?, eis_measure = COALESCE(?, eis_measure) WHERE id = ?').run(list ? JSON.stringify(list) : null, measure, itemId);
    },
    setItemSpec(itemId, spec, characteristics) {
      db.prepare('UPDATE tender_items SET spec_json = ?, characteristics_json = COALESCE(?, characteristics_json) WHERE id = ?')
        .run(spec ? JSON.stringify(spec) : null, characteristics ? JSON.stringify(characteristics) : null, itemId);
    },
    setItemContractMatch(itemId, map) {
      db.prepare('UPDATE tender_items SET contract_match_json = ? WHERE id = ?').run(JSON.stringify(map || {}), itemId);
    },
    /** Отчёт о полноте чтения ТЗ и извлечения позиций (kind: 'spec' | 'items'). */
    setDetailsCoverage(tenderId, kind, coverage) {
      const col = kind === 'items' ? 'items_coverage_json' : 'spec_coverage_json';
      db.prepare(`UPDATE tender_details SET ${col} = ? WHERE tender_id = ?`).run(coverage ? JSON.stringify(coverage) : null, tenderId);
    },
    setSpecStatus(tenderId, status, note = null) {
      db.prepare('UPDATE tender_details SET spec_status = ?, spec_note = ?, spec_at = ? WHERE tender_id = ?').run(status, note, now(), tenderId);
    },
    /** Отметить новую попытку загрузить извещение: текст ошибки (null — загружено) и время попытки. */
    touchDetails(tenderId, error) {
      db.prepare('UPDATE tender_details SET error = ?, fetched_at = ? WHERE tender_id = ?').run(error ?? null, now(), tenderId);
    },
    /** Закупки, у которых извещение не нашлось в источнике и пора спросить снова: живые, самые давние попытки первыми. */
    noticeRetryCandidates({ limit = 15, olderThanIso, nowIso }) {
      return db.prepare(`SELECT t.id FROM tenders t JOIN tender_details d ON d.tender_id = t.id
        WHERE (d.error LIKE '%404%' OR d.error LIKE '%не найден%') AND d.fetched_at < ? AND (t.source IS NULL OR t.source != 'manual')
          AND t.status NOT IN ('filtered', 'dismissed') AND (t.deadline_at IS NULL OR t.deadline_at > ?)
        ORDER BY d.fetched_at LIMIT ?`).all(olderThanIso, nowIso, limit).map((r) => repo.getTender(r.id));
    },
    /** Дополнить условия закупки (например, сведениями о заказчике), не трогая позиции и расчёт. */
    mergeConditions(tenderId, patch) {
      const d = db.prepare('SELECT conditions_json FROM tender_details WHERE tender_id = ?').get(tenderId);
      if (!d) return false;
      db.prepare('UPDATE tender_details SET conditions_json = ? WHERE tender_id = ?').run(JSON.stringify({ ...J(d.conditions_json, {}), ...patch }), tenderId);
      return true;
    },
    getDetails(tenderId) {
      const d = db.prepare('SELECT * FROM tender_details WHERE tender_id = ?').get(tenderId);
      return d ? { ...d, conditions: J(d.conditions_json, {}), conditions_json: undefined,
        spec_coverage: J(d.spec_coverage_json, null), items_coverage: J(d.items_coverage_json, null), spec_coverage_json: undefined, items_coverage_json: undefined } : null;
    },
    /**
     * Сохраняет позиции и условия закупки. Позиция, содержание которой не изменилось (название, коды, характеристики,
     * количество, единица), остаётся той же строкой: сохраняются её id, своя цена, выбранное предложение, найденные
     * предложения и прочитанное ТЗ — в каком бы порядке позиции ни пришли. Изменившаяся позиция — новая строка:
     * старые цены и предложения к ней не переносятся (по номеру строки цена могла бы прилипнуть к другому товару).
     */
    saveItems(tenderId, items, { conditions = {}, source, error = null } = {}) {
      const head = (it) => [it.name, it.ktru_code ?? null, it.okpd2_code ?? null, it.quantity ?? null, it.unit ?? null];
      const key = (it) => JSON.stringify([...head(it), it.characteristics_json ?? JSON.stringify(it.characteristics || [])]);
      const previous = db.prepare('SELECT * FROM tender_items WHERE tender_id = ?').all(tenderId);
      const buckets = new Map();
      const put = (k, row) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(row); };
      for (const row of previous) {
        // В извещении характеристик не было, их дописало чтение ТЗ (setItemSpec) — из извещения эта позиция снова придёт
        // без характеристик. Это та же позиция: иначе «Обновить» стирало бы прочитанное ТЗ, свою цену и предложения.
        const spec = J(row.spec_json, null);
        const fromTz = spec?.required?.length && JSON.stringify(spec.required.map((r) => ({ name: r.name, value: r.value }))) === row.characteristics_json;
        put(fromTz ? JSON.stringify([...head(row), '[]']) : key(row), row);
      }
      db.exec('BEGIN');
      try {
        const retained = new Set();
        const ins = db.prepare(`INSERT INTO tender_items (tender_id, idx, name, ktru_code, okpd2_code, characteristics_json,
          quantity, unit, unit_price, sum, source, eis_chars_json, eis_measure) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const update = db.prepare('UPDATE tender_items SET idx = ?, unit_price = ?, sum = ?, source = ?, eis_chars_json = COALESCE(?, eis_chars_json), eis_measure = COALESCE(?, eis_measure) WHERE id = ? AND tender_id = ?');
        const eis = (it) => (it.eis_chars?.length ? JSON.stringify(it.eis_chars) : null);
        items.forEach((it, idx) => {
          const old = buckets.get(key(it))?.shift();
          if (old) {
            retained.add(old.id);
            update.run(idx, it.unit_price ?? null, it.sum ?? null, it.source, eis(it), it.eis_measure ?? null, old.id, tenderId);
          } else {
            ins.run(tenderId, idx, it.name, it.ktru_code ?? null, it.okpd2_code ?? null,
              JSON.stringify(it.characteristics || []), it.quantity ?? null, it.unit ?? null,
              it.unit_price ?? null, it.sum ?? null, it.source, eis(it), it.eis_measure ?? null);
          }
        });
        for (const old of previous) {
          if (retained.has(old.id)) continue;
          db.prepare('DELETE FROM item_allocations WHERE tender_id = ? AND item_id = ?').run(tenderId, old.id);
          db.prepare('DELETE FROM offers WHERE tender_id = ? AND item_id = ?').run(tenderId, old.id);
          db.prepare('DELETE FROM tender_items WHERE tender_id = ? AND id = ?').run(tenderId, old.id);
        }
        // Расчёт выгодности считался по прежним позициям — сбрасываем результат (его пересчитают карточка, обновление
        // или фоновый расчёт). Ручные настройки калькулятора и история уведомлений остаются.
        db.prepare(`UPDATE tender_economics SET result_json = NULL, verdict = NULL, profit = NULL, margin_pct = NULL,
          computed_at = NULL, opportunity = NULL, confirmed = NULL WHERE tender_id = ?`).run(tenderId);
        db.prepare(`INSERT INTO tender_details (tender_id, conditions_json, items_source, error, fetched_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tender_id) DO UPDATE SET conditions_json = excluded.conditions_json, items_source = excluded.items_source,
          error = excluded.error, fetched_at = excluded.fetched_at`).run(tenderId, JSON.stringify(conditions), source ?? null, error, now());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    setItemManualPrice(tenderId, itemId, price) {
      return db.prepare('UPDATE tender_items SET purchase_price_manual = ? WHERE id = ? AND tender_id = ?').run(price ?? null, itemId, tenderId).changes > 0;
    },
    getBenchmark(code, maxAgeDays) {
      const b = db.prepare('SELECT * FROM benchmarks WHERE code = ?').get(code);
      if (!b) return null;
      if (maxAgeDays != null && Date.now() - new Date(b.fetched_at).getTime() > maxAgeDays * 86400000) return null;
      return J(b.data_json, null);
    },
    saveBenchmark(code, data) {
      db.prepare(`INSERT INTO benchmarks (code, data_json, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET data_json = excluded.data_json, fetched_at = excluded.fetched_at`).run(code, JSON.stringify(data), now());
    },
    getEconomics(tenderId) {
      const e = db.prepare('SELECT * FROM tender_economics WHERE tender_id = ?').get(tenderId);
      return e ? {
        overrides: J(e.overrides_json, {}), result: J(e.result_json, null), verdict: e.verdict,
        profit: e.profit, margin_pct: e.margin_pct, computed_at: e.computed_at,
        opportunity: e.opportunity, confirmed: e.confirmed == null ? null : Boolean(e.confirmed),
      } : null;
    },
    saveEconomics(tenderId, { overrides, result, opportunity = null, confirmed = null }) {
      db.prepare(`INSERT INTO tender_economics (tender_id, overrides_json, result_json, verdict, profit, margin_pct, computed_at, opportunity, confirmed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tender_id) DO UPDATE SET overrides_json = excluded.overrides_json,
        result_json = excluded.result_json, verdict = excluded.verdict, profit = excluded.profit, margin_pct = excluded.margin_pct,
        computed_at = excluded.computed_at, opportunity = excluded.opportunity, confirmed = excluded.confirmed`).run(tenderId,
        JSON.stringify(overrides || {}), JSON.stringify(result), result.verdict, result.result?.profit ?? null, result.result?.margin_pct ?? null,
        now(), opportunity, confirmed == null ? null : confirmed ? 1 : 0);
    },
    /**
     * Этап 6b: кому автоматически читать документацию — перспективные закупки без разбора:
     * ожидаемая маржа не ниже порога или маржа неизвестна при высокой оценке потенциала.
     */
    docsCandidates({ minMargin, minScore = 70, limit, nowIso = now() }) {
      return db.prepare(`${TENDER_SELECT} WHERE t.status = 'scored' AND t.analysis_id IS NULL
          AND (e.margin_pct >= ? OR (e.margin_pct IS NULL AND t.score >= ?))
          AND ${LIVE}
          ORDER BY e.margin_pct IS NULL, e.opportunity DESC, t.score DESC LIMIT ?`).all(minMargin, minScore, nowIso, limit).map(tenderRow);
    },
    /**
     * Закупки, у которых разбор стоит перечитать: сделан прежней версией (в карточке нет решения по правилам) или
     * упал с ошибкой. Какие ошибки временные, решает вызывающий (tenders/reread.js). Сначала — закупки с
     * предложениями в корзине, затем упавшие, затем самые выгодные. inWork — только закупки с корзиной.
     */
    rereadCandidates({ limit, inWork = false, nowIso = now() }) {
      const cart = 'EXISTS (SELECT 1 FROM offers o WHERE o.tender_id = t.id AND o.cart_at IS NOT NULL)';
      return db.prepare(`${TENDER_SELECT} WHERE t.status = 'scored' AND t.analysis_id IS NOT NULL
          AND ((a.status = 'done' AND json_extract(a.card_json, '$.decision') IS NULL) OR a.status = 'error')
          AND ${LIVE} ${inWork ? `AND ${cart}` : ''}
          ORDER BY ${cart} DESC, a.status = 'error' DESC, e.opportunity DESC, t.score DESC LIMIT ?`).all(nowIso, limit).map(tenderRow);
    },
    /** Разбор документации готов, а спецификация ещё не прочитана. */
    specCandidates({ limit = 20, nowIso = now() } = {}) {
      return db.prepare(`${TENDER_SELECT} WHERE t.status = 'scored' AND a.status = 'done'
          AND NOT EXISTS (SELECT 1 FROM tender_details d WHERE d.tender_id = t.id AND d.spec_status IS NOT NULL)
          AND ${LIVE} ORDER BY t.score DESC LIMIT ?`).all(nowIso, limit).map(tenderRow);
    },
    /** Кандидаты на автопоиск поставщиков: ожидаемая маржа не ниже порога, цены ещё не подтверждены, поиска не было. */
    autoSearchCandidates({ minMargin, limit, nowIso = now() }) {
      return db.prepare(`${TENDER_SELECT} WHERE t.status = 'scored' AND e.margin_pct >= ? AND COALESCE(e.confirmed, 0) = 0
          AND NOT EXISTS (SELECT 1 FROM offer_searches s WHERE s.tender_id = t.id)
          AND ${LIVE} ORDER BY e.opportunity DESC, e.margin_pct DESC LIMIT ?`)
        .all(minMargin, nowIso, limit).map(tenderRow);
    },
    /** Закупки без расчёта выгодности: прошли фильтры, оценка соответствия не ниже порога, срок не истёк. */
    tendersWithoutEconomics({ threshold, limit, nowIso = now() }) {
      // e.result_json IS NULL — расчёт был, но сброшен обновлением позиций (saveItems): без этого закупка молча
      // выпадала из «выгодных» и автопоиска, пока кто-нибудь не откроет её карточку.
      return db.prepare(`${TENDER_SELECT} WHERE t.status = 'scored' AND t.score >= ? AND (e.tender_id IS NULL OR e.result_json IS NULL)
          AND ${LIVE} ORDER BY t.score DESC LIMIT ?`).all(threshold, nowIso, limit).map(tenderRow);
    },

    // ---------- этап 4: поиск поставщиков ----------
    /** Остаток и наличие, дочитанные со страницы товара у ранее найденного предложения. */
    setOfferStock(id, { qty, note, availability }) {
      db.prepare('UPDATE offers SET stock_qty = ?, stock_note = ?, availability = COALESCE(?, availability), stock_checked_at = ? WHERE id = ?').run(qty ?? null, note ?? null, availability ?? null, now(), id);
    },
    createOfferSearch(tenderId) {
      return Number(db.prepare("INSERT INTO offer_searches (tender_id, status, started_at) VALUES (?, 'queued', ?)").run(tenderId, now()).lastInsertRowid);
    },
    updateOfferSearch(id, { status, progress, log, apiRequests, pagesFetched, error, finished, funnel }) {
      const cur = db.prepare('SELECT * FROM offer_searches WHERE id = ?').get(id);
      db.prepare(`UPDATE offer_searches SET status = ?, progress_json = ?, log_json = ?, api_requests = ?, pages_fetched = ?, error = ?,
        finished_at = ?, funnel_json = ? WHERE id = ?`).run(status ?? cur.status, progress !== undefined ? JSON.stringify(progress) : cur.progress_json,
        log ? JSON.stringify(log) : cur.log_json, apiRequests ?? cur.api_requests, pagesFetched ?? cur.pages_fetched, error ?? cur.error,
        finished ? now() : cur.finished_at, funnel ? JSON.stringify(funnel) : cur.funnel_json, id);
    },
    getOfferSearch(id) {
      const r = db.prepare('SELECT * FROM offer_searches WHERE id = ?').get(id);
      return r ? { ...r, progress: J(r.progress_json, null), log: J(r.log_json, []), funnel: J(r.funnel_json, null), progress_json: undefined, log_json: undefined, funnel_json: undefined } : null;
    },
    lastOfferSearch(tenderId) {
      const r = db.prepare('SELECT id FROM offer_searches WHERE tender_id = ? ORDER BY id DESC LIMIT 1').get(tenderId);
      return r ? repo.getOfferSearch(r.id) : null;
    },
    /** Удаляет найденные поиском предложения закупки (ручные, отложенные в корзину и выбранные в расчёт остаются). */
    clearSearchOffers(tenderId) {
      db.prepare("DELETE FROM offers WHERE tender_id = ? AND source != 'manual' AND cart_at IS NULL AND id NOT IN (SELECT purchase_offer_id FROM tender_items WHERE purchase_offer_id IS NOT NULL) AND id NOT IN (SELECT offer_id FROM item_allocations)").run(tenderId);
    },
    /** Корзина: at — время добавления, null — убрать. */
    setOfferCart(id, at = now()) {
      db.prepare('UPDATE offers SET cart_at = ? WHERE id = ?').run(at, id);
    },
    /** Всё, что отложено в корзину, — свежие сверху. */
    cartOffers() {
      return db.prepare('SELECT o.*, s.decision AS seller_decision, s.egrul_json AS seller_egrul_json, s.gov_contracts AS seller_gov_contracts, s.rnp_status AS seller_rnp, s.rnp_checked_at AS seller_rnp_at, s.rnp_source AS seller_rnp_source, s.rnp_note AS seller_rnp_note FROM offers o LEFT JOIN sellers s ON s.inn = o.seller_inn WHERE o.cart_at IS NOT NULL ORDER BY o.cart_at DESC, o.id')
        .all().map(offerRow);
    },
    /** Очистить корзину: по одной закупке или целиком. @returns сколько убрано */
    clearCart(tenderId = null) {
      return Number((tenderId == null
        ? db.prepare('UPDATE offers SET cart_at = NULL WHERE cart_at IS NOT NULL').run()
        : db.prepare('UPDATE offers SET cart_at = NULL WHERE cart_at IS NOT NULL AND tender_id = ?').run(tenderId)).changes);
    },
    deleteOffer(id) {
      db.prepare('DELETE FROM item_allocations WHERE offer_id = ?').run(id);
      db.prepare('DELETE FROM offers WHERE id = ?').run(id);
    },
    insertOffer(o) {
      const cols = ['tender_id', 'item_id', 'search_id', 'source', 'title', 'url', 'domain', 'price', 'unit', 'pack_qty', 'unit_price', 'availability',
        'seller_name', 'seller_inn', 'seller_inn_on_site', 'seller_region', 'delivery_days', 'delivery_cost', 'delivery_note', 'delivery_estimated',
        'total_cost', 'in_time', 'match', 'match_notes_json', 'trust', 'trust_reasons_json', 'extracted_by', 'created_at', 'verified', 'contacts_json', 'image_url', 'specs_json', 'price_date', 'match_checks_json', 'condition',
        'stock_qty', 'stock_note', 'stock_checked_at', 'delivery_carrier', 'delivery_basis', 'unit_weight_kg', 'unit_volume_m3', 'cargo_estimated'];
      const row = {
        ...o, match_checks_json: o.match_checks ? JSON.stringify(o.match_checks) : null, contacts_json: o.contacts ? JSON.stringify(o.contacts) : null, specs_json: o.specs?.length ? JSON.stringify(o.specs) : null, match_notes_json: JSON.stringify(o.match_notes || []), trust_reasons_json: JSON.stringify(o.trust_reasons || []),
        seller_inn_on_site: o.seller_inn_on_site ? 1 : 0, delivery_estimated: o.delivery_estimated ? 1 : 0,
        in_time: o.in_time == null ? null : o.in_time ? 1 : 0, created_at: now(), verified: o.verified ? 1 : 0,
        cargo_estimated: o.cargo_estimated == null ? null : o.cargo_estimated ? 1 : 0,
      };
      return Number(db.prepare(`INSERT INTO offers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => row[c] ?? null)).lastInsertRowid);
    },
    updateOfferTrust(id, trust, reasons, verified) {
      db.prepare('UPDATE offers SET trust = ?, trust_reasons_json = ?, verified = COALESCE(?, verified) WHERE id = ?')
        .run(trust, JSON.stringify(reasons), verified == null ? null : verified ? 1 : 0, id);
    },
    getOffers(tenderId) {
      return db.prepare('SELECT o.*, s.decision AS seller_decision, s.egrul_json AS seller_egrul_json, s.gov_contracts AS seller_gov_contracts, s.rnp_status AS seller_rnp, s.rnp_checked_at AS seller_rnp_at, s.rnp_source AS seller_rnp_source, s.rnp_note AS seller_rnp_note FROM offers o LEFT JOIN sellers s ON s.inn = o.seller_inn WHERE o.tender_id = ? ORDER BY o.id')
        .all(tenderId).map(offerRow);
    },
    getOffer(id) {
      return offerRow(db.prepare('SELECT o.*, s.decision AS seller_decision, s.egrul_json AS seller_egrul_json, s.gov_contracts AS seller_gov_contracts, s.rnp_status AS seller_rnp, s.rnp_checked_at AS seller_rnp_at, s.rnp_source AS seller_rnp_source, s.rnp_note AS seller_rnp_note FROM offers o LEFT JOIN sellers s ON s.inn = o.seller_inn WHERE o.id = ?').get(id));
    },
    /**
     * Выбрать предложение как закупочную цену позиции на всё её количество. by: auto | user. offer = null — снять выбор.
     * Это частный случай набора партии (setItemPurchase) — одна строка набора.
     */
    setItemOffer(itemId, offer, by) {
      const item = db.prepare('SELECT tender_id, quantity FROM tender_items WHERE id = ?').get(itemId);
      if (!item) return;
      repo.setItemPurchase(itemId, offer ? {
        by, unit_price: offer.unit_price, delivery: offer.delivery_cost, offer_id: offer.id,
        label: [offer.seller_name, offer.domain].filter(Boolean).join(', ') || offer.title,
        rows: [{ offer_id: offer.id, qty: item.quantity || 1, delivery_cost: offer.delivery_cost ?? null, note: null }],
      } : null);
    },
    /**
     * Записать, чем закрыта позиция: rows — набор партии [{offer_id, qty, delivery_cost, note}], остальное — итог для
     * расчёта выгодности (unit_price — средняя цена за единицу или null, если партия набрана не полностью;
     * delivery — доставка от всех продавцов набора; offer_id — основное предложение; label — подпись). null — снять выбор.
     */
    setItemPurchase(itemId, p) {
      const item = db.prepare('SELECT tender_id FROM tender_items WHERE id = ?').get(itemId);
      if (!item) return;
      db.exec('SAVEPOINT item_purchase');
      try {
        db.prepare('DELETE FROM item_allocations WHERE item_id = ?').run(itemId);
        const ins = db.prepare('INSERT INTO item_allocations (tender_id, item_id, offer_id, qty, delivery_cost, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const r of p?.rows || []) ins.run(item.tender_id, itemId, r.offer_id, r.qty, r.delivery_cost ?? null, r.note ?? null, now());
        db.prepare(`UPDATE tender_items SET purchase_price_offer = ?, purchase_offer_label = ?, purchase_offer_id = ?,
          purchase_offer_delivery = ?, purchase_selected_by = ? WHERE id = ?`).run(
          p ? p.unit_price ?? null : null, p ? p.label ?? null : null, p ? p.offer_id ?? null : null,
          p ? p.delivery ?? null : null, p ? p.by ?? null : null, itemId);
        db.exec('RELEASE item_purchase');
      } catch (err) {
        db.exec('ROLLBACK TO item_purchase; RELEASE item_purchase');
        throw err;
      }
    },
    /** Набор партии по позициям закупки: [{item_id, offer_id, qty, delivery_cost, note}] в порядке добавления. */
    getAllocations(tenderId) {
      return db.prepare('SELECT item_id, offer_id, qty, delivery_cost, note FROM item_allocations WHERE tender_id = ? ORDER BY id').all(tenderId);
    },
    /** То же предложение найдено заново (свежая запись) — набор партии переходит на неё. */
    replaceAllocationOffer(oldId, newId) {
      db.prepare('UPDATE item_allocations SET offer_id = ? WHERE offer_id = ?').run(newId, oldId);
    },
    getSeller(inn) {
      const r = db.prepare('SELECT * FROM sellers WHERE inn = ?').get(inn);
      return r ? { ...r, egrul: J(r.egrul_json, null), egrul_json: undefined, contacts: J(r.contacts_json, null), contacts_json: undefined } : null;
    },
    /** Контакты поставщика из реестра контрактов — копим по ИНН, чтобы показывать во всех закупках. */
    saveSellerContacts(inn, name, contacts) {
      db.prepare(`INSERT INTO sellers (inn, name, contacts_json) VALUES (?, ?, ?)
        ON CONFLICT(inn) DO UPDATE SET contacts_json = excluded.contacts_json, name = COALESCE(sellers.name, excluded.name)`).run(inn, name ?? null, JSON.stringify(contacts));
    },
    setOfferProduct(id, { url = null, price = null, title = null, image_url = null, specs = null } = {}) {
      db.prepare(`UPDATE offers SET product_url = ?, product_price = ?, product_title = ?, product_checked_at = ?,
        image_url = COALESCE(image_url, ?), specs_json = COALESCE(specs_json, ?) WHERE id = ?`)
        .run(url, price, title, now(), image_url, specs?.length ? JSON.stringify(specs) : null, id);
    },
    /** Новая сверка с ТЗ у того же предложения (после дочитывания характеристик). Выбор пользователя не меняется. */
    setOfferMatch(id, { match, notes, checks, specs = null }) {
      db.prepare('UPDATE offers SET match = ?, match_notes_json = ?, match_checks_json = ?, specs_json = COALESCE(?, specs_json) WHERE id = ?')
        .run(match, JSON.stringify(notes || []), checks ? JSON.stringify(checks) : null, specs?.length ? JSON.stringify(specs) : null, id);
    },
    setOfferContacts(id, contacts) {
      db.prepare('UPDATE offers SET contacts_json = ? WHERE id = ?').run(JSON.stringify(contacts), id);
    },
    saveSellerEgrul(inn, name, egrul) {
      db.prepare(`INSERT INTO sellers (inn, name, egrul_json, checked_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(inn) DO UPDATE SET name = COALESCE(excluded.name, sellers.name), egrul_json = excluded.egrul_json, checked_at = excluded.checked_at`)
        .run(inn, name ?? null, JSON.stringify(egrul), now());
    },
    /** Продавец встречен победителем госконтракта — копим репутацию между поисками. */
    noteSellerContract(inn, name) {
      db.prepare(`INSERT INTO sellers (inn, name, gov_contracts) VALUES (?, ?, 1)
        ON CONFLICT(inn) DO UPDATE SET gov_contracts = sellers.gov_contracts + 1, name = COALESCE(sellers.name, excluded.name)`).run(inn, name ?? null);
    },
    /**
     * Для таблицы «Источники по группам»: все позиции закупок (к какой группе — решает вызывающий код) и цены,
     * полученные поиском на сайтах (не госконтракты и не ручные), по сайту и позиции.
     */
    groupSourceRows() {
      return {
        items: db.prepare('SELECT id, name, ktru_code, okpd2_code FROM tender_items').all(),
        offers: db.prepare(`SELECT item_id, tender_id, domain, match, seller_region FROM offers
          WHERE domain IS NOT NULL AND source NOT IN ('contracts', 'manual') AND unit_price IS NOT NULL`).all(),
      };
    },
    /** Предложения любых закупок, в названии которых есть это обозначение (для добора характеристик той же модели). */
    offersByTitleLike(text, limit = 60) {
      return db.prepare(`SELECT id, url, domain, title FROM offers WHERE url IS NOT NULL AND source NOT IN ('contracts', 'manual') AND title LIKE ? ORDER BY id DESC LIMIT ?`)
        .all(`%${String(text).replace(/[%_]/g, '')}%`, limit);
    },
    /** Суточный счётчик платных запросов (ключ — сервис + дата по Москве). */
    apiUsage(service, day) {
      return Number(repo.getSetting(`usage:${service}:${day}`) || 0);
    },
    addApiUsage(service, day, n = 1) {
      repo.setSetting(`usage:${service}:${day}`, repo.apiUsage(service, day) + n);
    },
    /**
     * Отметка по реестру недобросовестных поставщиков: 'clean' | 'listed' | null (не проверено).
     * source: manual — поставил пользователь, auto — автоматическая проверка; note — что нашла проверка.
     * checked — запомнить время проверки, даже если статус не определён (чтобы не проверять каждый раз заново).
     */
    setSellerRnp(inn, status, name, { source = 'manual', note = null, checked = Boolean(status) } = {}) {
      db.prepare(`INSERT INTO sellers (inn, name, rnp_status, rnp_checked_at, rnp_source, rnp_note) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(inn) DO UPDATE SET rnp_status = excluded.rnp_status, rnp_checked_at = excluded.rnp_checked_at,
          rnp_source = excluded.rnp_source, rnp_note = excluded.rnp_note, name = COALESCE(sellers.name, excluded.name)`)
        .run(inn, name ?? null, status, checked ? now() : null, status || checked ? source : null, note ? JSON.stringify(note) : null);
    },
    /**
     * Продавцы, которых пора проверить по реестру: есть в предложениях закупок из ленты, ещё не проверялись или
     * проверялись автоматически давно. Отметки пользователя не перепроверяются. Сначала продавцы выбранных
     * предложений, потом подходящих под ТЗ, потом остальные.
     */
    rnpCandidates({ limit = 10, recheckDays = 14, nowIso = now(), tenderId = null } = {}) {
      const before = new Date(new Date(nowIso).getTime() - recheckDays * 86400000).toISOString();
      return db.prepare(`SELECT o.seller_inn AS inn, MAX(o.seller_name) AS name,
          MAX(CASE WHEN a.offer_id IS NOT NULL THEN 2 WHEN o.match = 'соответствует' THEN 1 ELSE 0 END) AS rank
        FROM offers o JOIN tenders t ON t.id = o.tender_id
        LEFT JOIN item_allocations a ON a.offer_id = o.id
        LEFT JOIN sellers s ON s.inn = o.seller_inn
        WHERE o.source != 'contracts' AND o.seller_inn IS NOT NULL AND t.status NOT IN ('filtered', 'dismissed') AND ${LIVE}
          AND (? IS NULL OR o.tender_id = ?)
          AND (s.rnp_checked_at IS NULL OR (s.rnp_checked_at < ? AND COALESCE(s.rnp_source, 'auto') = 'auto'))
        GROUP BY o.seller_inn ORDER BY rank DESC, MAX(o.id) DESC LIMIT ?`)
        .all(nowIso, tenderId, tenderId, before, limit).filter((r) => /^(\d{10}|\d{12})$/.test(r.inn));
    },
    setSellerDecision(inn, decision, name) {
      db.prepare(`INSERT INTO sellers (inn, name, decision, decided_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(inn) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at, name = COALESCE(sellers.name, excluded.name)`)
        .run(inn, name ?? null, decision, now());
    },

    // ---------- синхронизации ----------
    startSyncRun(source) {
      return Number(db.prepare("INSERT INTO sync_runs (started_at, status, source) VALUES (?, 'running', ?)")
        .run(now(), source).lastInsertRowid);
    },
    finishSyncRun(id, { status, fetched = 0, newCount = 0, filtered = 0, scored = 0, error = null }) {
      db.prepare(
        `UPDATE sync_runs SET finished_at = ?, status = ?, fetched = ?, new_count = ?, filtered = ?, scored = ?, error = ?
         WHERE id = ?`
      ).run(now(), status, fetched, newCount, filtered, scored, error, id);
    },
    updateSyncRun(id, { fetched = 0, newCount = 0 }) {
      db.prepare('UPDATE sync_runs SET fetched = ?, new_count = ? WHERE id = ?').run(fetched, newCount, id);
    },
    lastSyncRun() {
      return db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() || null;
    },
    lastSuccessfulSyncRun() {
      // Пересчёт оценок без загрузки (source = 'rescore') не сдвигает окно синхронизации.
      return db.prepare("SELECT * FROM sync_runs WHERE status = 'done' AND source != 'rescore' ORDER BY id DESC LIMIT 1").get() || null;
    },

    // ---------- настройки ----------
    getSetting(key) {
      return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    },
    setSetting(key, value) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value == null ? null : String(value));
    },
  };
  return repo;
}

module.exports = { openDb, createRepo };
