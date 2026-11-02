const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// Под `node --test` локальный .env не читается: тесты не должны ходить в настоящие API с вашими ключами.
if (!process.env.NODE_TEST_CONTEXT) require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  ROOT,
  PORT: num(env.PORT, 8850),
  // На сервере за Caddy — 127.0.0.1, чтобы сервис был доступен только через него (с паролем). Пусто — все адреса.
  HOST: env.HOST || '',
  DATA_DIR: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(ROOT, 'data'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  LLM_PROVIDER: (env.LLM_PROVIDER || 'mock').toLowerCase(),
  // Кто читает документацию закупок: rules — читатель по правилам без нейросети (по умолчанию с 29.10.2026: оплаченный
  // пакет нейросети кончился, а правила на позициях точнее); hybrid — правила, недостающие поля дочитывает нейросеть;
  // llm — нейросеть, при отказе по оплате — правила.
  ANALYSIS_READER: ['rules', 'hybrid', 'llm'].includes(String(env.ANALYSIS_READER || '').toLowerCase()) ? String(env.ANALYSIS_READER).toLowerCase() : 'rules',
  LLM_MAX_CHARS_PER_CHUNK: num(env.LLM_MAX_CHARS_PER_CHUNK, 24000),
  LLM_TIMEOUT_MS: num(env.LLM_TIMEOUT_MS, 180000),
  // Бюджеты одного прохода — сколько фрагментов документации отправляется нейросети за раз. Это не отбор:
  // что не поместилось, остаётся в отчёте о полноте как «не отправлено» и дочитывается следующим проходом.
  ANALYSIS_MAX_CHUNKS: num(env.ANALYSIS_MAX_CHUNKS, 80),
  SPEC_MAX_CHUNKS: num(env.SPEC_MAX_CHUNKS, 20),
  ITEMS_MAX_CHUNKS: num(env.ITEMS_MAX_CHUNKS, 20),
  MAX_UPLOAD_MB: num(env.MAX_UPLOAD_MB, 100),
  // Папка с дополнительными корневыми сертификатами (НУЦ Минцифры) — для ЕИС и GigaChat
  EXTRA_CA_DIR: env.EXTRA_CA_DIR ? path.resolve(env.EXTRA_CA_DIR) : path.join(ROOT, 'certs'),

  // Поиск тендеров
  TENDER_SOURCE: (env.TENDER_SOURCE || 'gosplan').toLowerCase(),
  // Несколько источников сразу: gosplan (API), eis-rss (официальная лента ЕИС, бесплатно), fixture (без сети)
  TENDER_SOURCES: (env.TENDER_SOURCES || env.TENDER_SOURCE || 'gosplan').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
  // robots.txt ЕИС требует паузу 60 секунд между запросами робота
  EIS_REQUEST_DELAY_MS: num(env.EIS_REQUEST_DELAY_MS, 60000),
  EIS_MAX_PAGES: num(env.EIS_MAX_PAGES, 3),
  // Росэлторг, коммерческие закупки (источник roseltorg): пауза между запросами и страниц по 10 закупок на слово
  ROSELTORG_DELAY_MS: num(env.ROSELTORG_DELAY_MS, 5000),
  ROSELTORG_MAX_PAGES: num(env.ROSELTORG_MAX_PAGES, 2),
  // госзакупки 44/223-ФЗ на Росэлторге: страниц по 10 закупок на слово (0 — не брать)
  ROSELTORG_EIS_PAGES: num(env.ROSELTORG_EIS_PAGES, 1),
  // ЭТП ГПБ (коммерческие закупки, sources/etpgpb.js): пауза между страницами и сколько процедур открыть за обновление
  ETPGPB_DELAY_MS: num(env.ETPGPB_DELAY_MS, 3000),
  ETPGPB_MAX_PAGES: num(env.ETPGPB_MAX_PAGES, 40),
  // Фабрикант (коммерческие процедуры, sources/fabrikant.js)
  FABRIKANT_DELAY_MS: num(env.FABRIKANT_DELAY_MS, 5000),
  FABRIKANT_MAX_PAGES: num(env.FABRIKANT_MAX_PAGES, 20),
  // Сбербанк-АСТ (закупки вне ЕИС, sources/sberast.js): пауза между запросами реестра и сколько страниц по 100 закупок
  SBERAST_DELAY_MS: num(env.SBERAST_DELAY_MS, 3000),
  SBERAST_MAX_PAGES: num(env.SBERAST_MAX_PAGES, 10),
  GOSPLAN_BASE_URL: (env.GOSPLAN_BASE_URL || 'https://v2test.gosplan.info').replace(/\/+$/, ''),
  GOSPLAN_API_KEY: env.GOSPLAN_API_KEY || '',
  GOSPLAN_LAWS: (env.GOSPLAN_LAWS || '44,223').split(',').map((s) => s.trim()).filter(Boolean),
  GOSPLAN_MAX_PAGES: num(env.GOSPLAN_MAX_PAGES, 10),
  GOSPLAN_REQUEST_DELAY_MS: num(env.GOSPLAN_REQUEST_DELAY_MS, 400),
  SYNC_INTERVAL_MIN: num(env.SYNC_INTERVAL_MIN, 60),
  SYNC_FIRST_DAYS: num(env.SYNC_FIRST_DAYS, 3),
  SCORE_BATCH_SIZE: num(env.SCORE_BATCH_SIZE, 10),
  // Выгодность (этап 3)
  BENCHMARK_MAX_CONTRACTS: num(env.BENCHMARK_MAX_CONTRACTS, 15),
  BENCHMARK_DECLINE_SAMPLES: num(env.BENCHMARK_DECLINE_SAMPLES, 5),
  BENCHMARK_CACHE_DAYS: num(env.BENCHMARK_CACHE_DAYS, 7),
  ECONOMICS_MAX_PER_SYNC: num(env.ECONOMICS_MAX_PER_SYNC, 30),
  // Поиск поставщиков (этап 4)
  OFFER_SOURCES: env.OFFER_SOURCES || 'contracts,photo,yandex,b2b,stores,manual',
  // Один ключ сервисного аккаунта может работать и для поиска, и для YandexGPT — тогда достаточно YANDEX_API_KEY.
  YANDEX_SEARCH_API_KEY: env.YANDEX_SEARCH_API_KEY || env.YANDEX_API_KEY || '',
  YANDEX_FOLDER_ID: env.YANDEX_FOLDER_ID || '',
  DADATA_API_KEY: env.DADATA_API_KEY || '',
  SEARCH_MAX_QUERIES_PER_ITEM: num(env.SEARCH_MAX_QUERIES_PER_ITEM, 5),
  // Не больше стольких B2B-сайтов на позицию (config/stores.json → b2b): каждый — платный запрос «site:…»
  SEARCH_B2B_SITES_PER_ITEM: num(env.SEARCH_B2B_SITES_PER_ITEM, 3),
  // Сколько товаров из прошлых госконтрактов (с производителем или моделью) искать в магазинах на позицию — каждый платный запрос
  SEARCH_CONTRACT_PRODUCT_QUERIES: num(env.SEARCH_CONTRACT_PRODUCT_QUERIES, 2),
  // Позиция без модели (товар описан характеристиками): сколько конкретных товаров подобрать под ТЗ и искать по названию
  SEARCH_MODEL_CANDIDATES: num(env.SEARCH_MODEL_CANDIDATES, 4),
  // Со страницы каталога: сколько похожих товаров открыть с одной страницы и всего на позицию
  SEARCH_LISTING_PICKS: num(env.SEARCH_LISTING_PICKS, 3),
  SEARCH_LISTING_MAX: num(env.SEARCH_LISTING_MAX, 6),
  // Собственный каталог страниц оптовых поставщиков (config/stores.json → suppliers): SUPPLIER_INDEX=0 выключает.
  SUPPLIER_INDEX: env.SUPPLIER_INDEX !== '0',
  SUPPLIER_INDEX_MAX_AGE_DAYS: num(env.SUPPLIER_INDEX_MAX_AGE_DAYS, 7),
  // Модели из реестра для компьютерной техники (config/registry-makers.json): REGISTRY_MODELS=0 выключает.
  // Сайты производителей перечитываются раз в REGISTRY_MAX_AGE_DAYS дней.
  REGISTRY_MODELS: env.REGISTRY_MODELS !== '0',
  // Официальные сайты производителей из базы знаний в своём каталоге страниц: не больше стольких страниц с сайта
  OFFICIAL_INDEX_MAX_PAGES: num(env.OFFICIAL_INDEX_MAX_PAGES, 20000),
  REGISTRY_MAX_AGE_DAYS: num(env.REGISTRY_MAX_AGE_DAYS, 14),
  // Своя база товаров (offers/product-base.js): PRODUCT_BASE=0 выключает. Подбор по ТЗ — сначала из неё:
  // нейросетью сверяются PRODUCT_BASE_LLM_TOP лучших товаров позиции, остальные — только по таблице (бесплатно).
  PRODUCT_BASE: env.PRODUCT_BASE !== '0',
  // итоговый пакет в автоматическом режиме: декларация, цена, спорные страна и знак — без ручного подтверждения
  PACKAGE_AUTO: env.PACKAGE_AUTO !== '0',
  PRODUCT_BASE_LLM_TOP: num(env.PRODUCT_BASE_LLM_TOP, 6),
  // Ночной агент базы товаров (offers/product-agent.js): AGENT_ENABLED=0 выключает. Запуск в AGENT_HOUR часов
  // (часовой пояс DIGEST_TZ); за ночь — не больше страниц, файлов PDF и задач, чем в лимитах; не дольше AGENT_MAX_MINUTES.
  // Платного поиска и нейросети агент не использует.
  AGENT_ENABLED: env.AGENT_ENABLED !== '0',
  // Агент заявок (tenders/bid-agent.js): утром сам готовит заявки по своим настройкам; BID_AGENT_ENABLED=0 выключает
  BID_AGENT_ENABLED: env.BID_AGENT_ENABLED !== '0',
  AGENT_HOUR: num(env.AGENT_HOUR, 3),
  AGENT_PAGES_PER_NIGHT: num(env.AGENT_PAGES_PER_NIGHT, 150),
  AGENT_PDF_PER_NIGHT: num(env.AGENT_PDF_PER_NIGHT, 20),
  AGENT_TASKS_PER_NIGHT: num(env.AGENT_TASKS_PER_NIGHT, 60),
  AGENT_RETRY_DAYS: num(env.AGENT_RETRY_DAYS, 14),
  AGENT_FEED_DAYS: num(env.AGENT_FEED_DAYS, 3),
  AGENT_MAX_MINUTES: num(env.AGENT_MAX_MINUTES, 120),
  // Каталог Мерлиона (merlion.com) для ночного агента: карточки с характеристиками; MERLION=0 выключает. Пауза между
  // запросами MERLION_DELAY_MS; за ночь — не больше MERLION_LISTS_PER_NIGHT разделов и MERLION_CARDS_PER_NIGHT карточек.
  // Агенты (ночной агент базы товаров и агент заявок) — в отдельной службе (server/worker.js): AGENT_WORKER=1. Тогда
  // сервис их по расписанию не запускает, а кнопки «Запустить» оставляют заявку, которую забирает рабочий процесс.
  AGENT_WORKER: env.AGENT_WORKER === '1',
  // Агент поиска поставщиков (в рабочем процессе): ниши SCOUT_NICHES (через запятую, по умолчанию мебель), свой суточный
  // лимит платных запросов к Яндексу SCOUT_DAILY_REQUESTS; SCOUT=0 выключает.
  SCOUT: env.SCOUT !== '0',
  // Сколько заявок подано (tenders/bid-counts.js, реестр Сбербанк-АСТ, только 44-ФЗ): BID_COUNTS=0 выключает;
  // BID_COUNT_STALE_MIN — через сколько минут переспрашивать площадку по одной закупке.
  BID_COUNTS: env.BID_COUNTS !== '0',
  BID_COUNT_STALE_MIN: num(env.BID_COUNT_STALE_MIN, 180),
  SCOUT_NICHES: (env.SCOUT_NICHES || 'g-furniture').split(',').map((s) => s.trim()).filter(Boolean),
  SCOUT_DAILY_REQUESTS: num(env.SCOUT_DAILY_REQUESTS, 60),
  MERLION: env.MERLION !== '0',
  MERLION_DELAY_MS: num(env.MERLION_DELAY_MS, 1500),
  MERLION_LISTS_PER_NIGHT: num(env.MERLION_LISTS_PER_NIGHT, 15),
  MERLION_CARDS_PER_NIGHT: num(env.MERLION_CARDS_PER_NIGHT, 300),
  // сбор карточек мебели со страниц официальных сайтов фабрик (в ТЗ на мебель модели обычно нет): страниц за ночь, 0 — не собирать
  AGENT_HARVEST_PAGES: num(env.AGENT_HARVEST_PAGES, 40),
  // Сколько страниц оптовых поставщиков открыть по моделям из ТЗ и сколько — «дожимая» цену на подошедший товар
  SEARCH_WHOLESALE_PAGES: num(env.SEARCH_WHOLESALE_PAGES, 8),
  SEARCH_SWEEP_PAGES: num(env.SEARCH_SWEEP_PAGES, 6),
  // Сколько пар «позиция — компания с открытыми ценами» поиск проверяет сам в конце (страница товара на сайте компании,
  // у которой ничего не нашлось). Остальные проверяются при открытии карточки закупки. 0 — не проверять в поиске.
  SEARCH_CANDIDATE_LOOKUPS: num(env.SEARCH_CANDIDATE_LOOKUPS, 12),
  // Второй заход подбора моделей, если первые не подошли: сколько страниц открыть (0 — не делать)
  SEARCH_REFINE_PAGES: num(env.SEARCH_REFINE_PAGES, 8),
  // Добор на сайте (offers/same-site.js): сколько соседних страниц товара открыть на сайтах, где товар подошёл не во всём
  SEARCH_SAME_SITE_PAGES: num(env.SEARCH_SAME_SITE_PAGES, 6),
  // Сначала свой каталог поставщиков: нашлось столько страниц — платный поиск по позиции не запускается (0 — искать всегда)
  SEARCH_FREE_ENOUGH: num(env.SEARCH_FREE_ENOUGH, 4),
  // поиск по словам названия в своём каталоге (товары без модели); SEARCH_FREE_BY_WORDS=0 — выключить
  SEARCH_FREE_BY_WORDS: env.SEARCH_FREE_BY_WORDS !== '0',
  // Сверка с ТЗ: «соответствует» — только когда подтверждены все требования (не настраивается);
  // «частично» — подтверждена хотя бы эта доля, меньше — «не хватает данных»
  MATCH_PART_SHARE: num(env.MATCH_PART_SHARE, 0.3),
  // Сколько ждать чтения ТЗ из документации перед поиском по кнопке
  SEARCH_TZ_WAIT_MS: num(env.SEARCH_TZ_WAIT_MS, 8 * 60000),
  // Не больше стольких страниц с одного сайта на позицию — чтобы охватить больше продавцов. Три, а не две (решение
  // владельца 09.10.2026): у поставщика с десятком моделей проверяется на одну больше; поиск от этого дольше.
  SEARCH_MAX_PAGES_PER_DOMAIN: num(env.SEARCH_MAX_PAGES_PER_DOMAIN, 3),
  // «Простой» запрос на позицию — наименование и модель или главные характеристики, как ищет человек (+1 платный
  // запрос на позицию, если лимит не израсходован точными запросами). SEARCH_PLAIN_QUERY=0 выключает.
  SEARCH_PLAIN_QUERY: env.SEARCH_PLAIN_QUERY !== '0',
  // Суточный лимит платных запросов к Яндекс Search API на весь сервис
  // управляющий агентами: час дневного отчёта в Telegram (по Москве)
  MANAGER_REPORT_HOUR: num(env.MANAGER_REPORT_HOUR, 20),
  SEARCH_DAILY_MAX_API_REQUESTS: num(env.SEARCH_DAILY_MAX_API_REQUESTS, 200),
  SEARCH_RESULTS_PER_QUERY: num(env.SEARCH_RESULTS_PER_QUERY, 10),
  SEARCH_MAX_API_REQUESTS: num(env.SEARCH_MAX_API_REQUESTS, 20),
  // Многопозиционной закупке запросов больше: не меньше SEARCH_API_PER_ITEM на позицию, но не выше SEARCH_MAX_API_REQUESTS_CAP
  // за поиск (у закупки на 13 картриджей из 20 запросов доставалось по одному — большинство позиций оставались без товара)
  SEARCH_API_PER_ITEM: num(env.SEARCH_API_PER_ITEM, 4),
  SEARCH_MAX_API_REQUESTS_CAP: num(env.SEARCH_MAX_API_REQUESTS_CAP, 80),
  SEARCH_MAX_PAGES: num(env.SEARCH_MAX_PAGES, 90),
  // на закупку из многих позиций лимит страниц растёт: не меньше стольких страниц на позицию
  SEARCH_MIN_PAGES_PER_ITEM: num(env.SEARCH_MIN_PAGES_PER_ITEM, 24),
  // 24, а не 12: по разбору 09.10.2026 (docs/supplier-search-losses.md) из-за лимита не открывался каждый шестой
  // адрес из выдачи, уже прошедший отбор. Страницы открываются бесплатно, плата — время: около 5 секунд на страницу.
  SEARCH_MAX_PAGES_PER_ITEM: num(env.SEARCH_MAX_PAGES_PER_ITEM, 24),
  // Добор характеристик (Этап 1): вкладка «Характеристики» и PDF-паспорт со страницы товара, когда на ней не всё.
  // Платного поиска нет — открываются ссылки с самой страницы. Лимиты: документов на предложение и на весь поиск.
  SEARCH_DOC_ENRICH: env.SEARCH_DOC_ENRICH !== '0',
  SEARCH_DOCS_PER_OFFER: num(env.SEARCH_DOCS_PER_OFFER, 2),
  SEARCH_DOCS_PER_SEARCH: num(env.SEARCH_DOCS_PER_SEARCH, 12),
  // Адресный поиск недостающих характеристик по модели (платный, Яндекс): свой суточный лимит — 50 запросов ≈ 25 ₽ в день,
  // не из SEARCH_DAILY_MAX_API_REQUESTS. Только у лидеров позиции (MAKER_SEARCH_TOP самых дешёвых, не отклонённых),
  // не больше MAKER_SEARCH_PER_ITEM запросов на позицию; найденное по модели запоминается на MAKER_CACHE_DAYS дней.
  MAKER_SEARCH_DAILY: num(env.MAKER_SEARCH_DAILY, 50),
  MAKER_SEARCH_PER_ITEM: num(env.MAKER_SEARCH_PER_ITEM, 3),
  // 0 — при поиске поставщиков платный поиск по модели не запускается сам, только кнопкой «Найти по модели» (23.10.2026:
  // за два дня 12 запросов дали 4 подтверждения — бесплатные пути полезнее)
  MAKER_SEARCH_TOP: num(env.MAKER_SEARCH_TOP, 0),
  MAKER_CACHE_DAYS: num(env.MAKER_CACHE_DAYS, 30),
  // Бесплатный добор по модели (досье, другие продавцы этой модели, каталог поставщиков) — у стольких самых дешёвых
  // предложений позиции и не больше стольких открытых страниц на весь поиск.
  MAKER_FREE_TOP: num(env.MAKER_FREE_TOP, 5),
  // Маркетплейсы (Ozon, WB, Яндекс Маркет, Мегамаркет) после поиска поставщиков — для стольких позиций без подходящего
  // товара с ценой: 1 платный запрос к поиску Яндекса на позицию (≈0,5 ₽), результат хранится 3 дня. 0 — выключить.
  MARKETPLACE_AUTO_ITEMS: num(env.MARKETPLACE_AUTO_ITEMS, 5),
  MAKER_FREE_PAGES_PER_SEARCH: num(env.MAKER_FREE_PAGES_PER_SEARCH, 20),
  // Страницы крупнее этого не читаем. Поднимать осторожно: при пробе 6 МБ стали читаться страницы printer-plotter.ru
  // (4,2 МБ), и ценой товара оказалась цена сопутствующей бумаги из разметки — 640 ₽ за МФУ.
  FETCH_MAX_BYTES: num(env.FETCH_MAX_BYTES, 3 * 1024 * 1024),
  FETCH_MIN_INTERVAL_MS: num(env.FETCH_MIN_INTERVAL_MS, 2000),
  SELLER_TRUST_THRESHOLD: num(env.SELLER_TRUST_THRESHOLD, 60),
  SELLER_CHECK_CACHE_DAYS: num(env.SELLER_CHECK_CACHE_DAYS, 30),
  OFFER_DOMAIN_BLOCKLIST: env.OFFER_DOMAIN_BLOCKLIST
    // Тендерные сайты, отзовики, соцсети, маркетплейсы и доски объявлений: цены нестабильные, продавцы анонимные.
    ?? ['zakupki.gov.ru', 'rostender.info', 'tenderguru.ru', 'otzovik.com', 'irecommend.ru', 'youtube.com', 'vk.com', 'ok.ru', 'wikipedia.org',
      'pikabu.ru', 'dzen.ru', 't.me', 'ozon.ru', 'wildberries.ru', 'wb.ru', 'market.yandex.ru', 'megamarket.ru', 'aliexpress.ru', 'aliexpress.com',
      'avito.ru', 'youla.ru', 'drom.ru', 'auto.ru', 'kupiprodai.ru', 'irr.ru', 'farpost.ru'].join(','),
  STORES_CONFIG: env.STORES_CONFIG ? path.resolve(env.STORES_CONFIG) : path.join(ROOT, 'config', 'stores.json'),
  // Доставка транспортной компанией: тарифная сетка перевозчиков и вес/объём по умолчанию (оценка, не тариф перевозчика)
  LOGISTICS_CONFIG: env.LOGISTICS_CONFIG ? path.resolve(env.LOGISTICS_CONFIG) : path.join(ROOT, 'config', 'logistics.json'),
  // Реестр недобросовестных поставщиков ЕИС. RNP_SEARCH_URL — ссылка на поиск по ИНН для человека ({inn} — ИНН).
  // RNP_AUTO — сервис проверяет продавцов сам, в фоне (robots.txt ЕИС это разрешает, не чаще запроса в минуту);
  // под тестами выключено. RNP_CHECK_PER_SYNC — скольких продавцов проверять за одно обновление ленты и после
  // каждого поиска; RNP_RECHECK_DAYS — через сколько дней перепроверять.
  RNP_AUTO: env.RNP_AUTO != null && env.RNP_AUTO !== '' ? env.RNP_AUTO !== '0' : !env.NODE_TEST_CONTEXT,
  RNP_CHECK_PER_SYNC: num(env.RNP_CHECK_PER_SYNC, 10),
  RNP_RECHECK_DAYS: num(env.RNP_RECHECK_DAYS, 14),
  RNP_SEARCH_URL: env.RNP_SEARCH_URL || 'https://zakupki.gov.ru/epz/dishonestsupplier/search/results.html?searchString={inn}',
  // Профильные компании, у которых цену нужно запросить (кандидаты, не предложения)
  SUPPLIER_CANDIDATES_CONFIG: env.SUPPLIER_CANDIDATES_CONFIG ? path.resolve(env.SUPPLIER_CANDIDATES_CONFIG) : path.join(ROOT, 'config', 'profile-suppliers.json'),
  // Перепродажа (этап 5)
  RESALE_EXCLUSIONS: env.RESALE_EXCLUSIONS ? path.resolve(env.RESALE_EXCLUSIONS) : path.join(ROOT, 'config', 'resale-exclusions.json'),
  // Для скольких лучших по потенциалу закупок считать ожидаемую маржу после каждой синхронизации
  RESALE_ECONOMICS_PER_SYNC: num(env.RESALE_ECONOMICS_PER_SYNC, 30),
  // Автопоиск поставщиков (платный Яндекс): для скольких лучших закупок за синхронизацию, от какой ожидаемой маржи и
  // сколько запросов в сутки ему можно потратить — остаток суточного лимита (SEARCH_DAILY_MAX_API_REQUESTS) — на ручные кнопки
  RESALE_AUTO_SEARCH_PER_SYNC: num(env.RESALE_AUTO_SEARCH_PER_SYNC, 2),
  RESALE_AUTO_SEARCH_MIN_MARGIN_PCT: num(env.RESALE_AUTO_SEARCH_MIN_MARGIN_PCT, 25),
  RESALE_AUTO_SEARCH_DAILY_REQUESTS: num(env.RESALE_AUTO_SEARCH_DAILY_REQUESTS, 100),
  // Минимальная ожидаемая маржа, %, чтобы сам читать ТЗ закупки
  RESALE_MIN_MARGIN_PCT: num(env.RESALE_MIN_MARGIN_PCT, 15),
  // Этап 6b: для скольких перспективных закупок за синхронизацию и за сутки сам скачивать и читать ТЗ
  // (разбор документации — модель Max: ~30–80 тыс. токенов на закупку, бесплатный пакет — 25 млн в год)
  RESALE_DOCS_PER_SYNC: num(env.RESALE_DOCS_PER_SYNC, 10),
  // У скольких закупок за одно обновление узнавать площадку (она есть только в подробностях закупки); 0 — не узнавать в фоне
  PLATFORM_FETCH_PER_SYNC: num(env.PLATFORM_FETCH_PER_SYNC, 30),
  // У скольких закупок из ленты за проход сверять этап с ЕИС по номеру (отменённые уходят из ленты) и как часто
  // сверять одну и ту же; 0 — не сверять. Запрос к ЕИС — раз в минуту, очередь общая с загрузкой ленты.
  STAGE_CHECK_PER_SYNC: num(env.STAGE_CHECK_PER_SYNC, 10),
  STAGE_CHECK_HOURS: num(env.STAGE_CHECK_HOURS, 24),
  // Извещение «не найдено» в ГосПлане (закупка из ленты ЕИС свежее его данных): сколько закупок за проход спрашивать
  // снова и не чаще, чем раз в сколько минут одну и ту же; 0 — не спрашивать в фоне (при открытии закупки — всё равно).
  NOTICE_RETRY_PER_SYNC: num(env.NOTICE_RETRY_PER_SYNC, 15),
  NOTICE_RETRY_MINUTES: num(env.NOTICE_RETRY_MINUTES, 60),
  RESALE_DOCS_PER_DAY: num(env.RESALE_DOCS_PER_DAY, 20),
  // Перечитывание документации без кнопки: разбор сделан прежней версией сервиса или упал по временной причине.
  // Когда человек открывает карточку такой закупки, сервис читает документы заново — не больше стольких в сутки
  // (0 — не перечитывать самому). Повтор по одной закупке — не чаще чем раз в REREAD_RETRY_HOURS часов.
  REREAD_ON_OPEN_PER_DAY: num(env.REREAD_ON_OPEN_PER_DAY, 15),
  REREAD_RETRY_HOURS: num(env.REREAD_RETRY_HOURS, 6),
  // Крупные узлы поставок: откуда оценивать доставку, пока поставщик не найден (коды регионов)
  RESALE_HUBS: (env.RESALE_HUBS || '77:Москва,78:Санкт-Петербург,66:Екатеринбург,54:Новосибирск,23:Краснодар')
    .split(',').map((s) => s.split(':')).filter((p) => p[0]).map(([code, name]) => ({ region: Number(code), name: (name || code).trim() })),
  FIXTURES_DIR: env.FIXTURES_DIR ? path.resolve(env.FIXTURES_DIR) : path.join(ROOT, 'samples', 'tenders'),

  // Распознавание текста на сканах и картинках (нужны программы tesseract и pdftoppm — deploy/install-tools.sh)
  OCR_ENABLED: env.OCR_ENABLED !== '0',
  OCR_LANGS: env.OCR_LANGS || 'rus+eng',
  // Сколько страниц-сканов распознаём за один проход (страница — несколько секунд). Это не «первые N страниц»:
  // остальное остаётся в отчёте как непрочитанное и дочитывается кнопкой «Повторить непрочитанные части».
  OCR_MAX_PAGES: num(env.OCR_MAX_PAGES, 200),
  OCR_DPI: num(env.OCR_DPI, 200),

  // Telegram
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_ALLOWED_CHAT_IDS: (env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  DIGEST_TIME: env.DIGEST_TIME || '08:30',
  DIGEST_TZ: env.DIGEST_TZ || 'Europe/Moscow',
  PUBLIC_BASE_URL: (env.PUBLIC_BASE_URL || `http://localhost:${num(env.PORT, 8850)}`).replace(/\/+$/, ''),
};
