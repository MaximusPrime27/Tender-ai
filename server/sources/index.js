// Выбор источника закупок. Новый источник (например, ЕИС getDocsIP) — отдельный файл с тем же интерфейсом:
//   fetchNew({profile, since}) → {tenders: [нормализованные закупки], requests, truncated}
//   getAttachments(tender)     → [{fileName, url, description}]

const config = require('../config');
const { createGosplanSource } = require('./gosplan');
const { createFixtureSource } = require('./fixture');
const { createEisRssSource } = require('./eis-rss');
const { eisGate } = require('./eis-gate');
const { createRoseltorgSource } = require('./roseltorg');
const { createEtpGpbSource } = require('./etpgpb');
const { createFabrikantSource } = require('./fabrikant');
const { createSberAstSource } = require('./sberast');
const { createMultiSource } = require('./multi');

function createSource(name = config.TENDER_SOURCE) {
  switch (name) {
    case 'gosplan':
      return createGosplanSource({
        baseUrl: config.GOSPLAN_BASE_URL,
        apiKey: config.GOSPLAN_API_KEY,
        laws: config.GOSPLAN_LAWS,
        maxPages: config.GOSPLAN_MAX_PAGES,
        delayMs: config.GOSPLAN_REQUEST_DELAY_MS,
      });
    case 'eis-rss':
      return createEisRssSource({ delayMs: config.EIS_REQUEST_DELAY_MS, maxPages: config.EIS_MAX_PAGES, gate: eisGate(config.EIS_REQUEST_DELAY_MS) });
    case 'roseltorg':
      return createRoseltorgSource({ delayMs: config.ROSELTORG_DELAY_MS, maxPages: config.ROSELTORG_MAX_PAGES, eisPages: config.ROSELTORG_EIS_PAGES });
    case 'etpgpb':
      return createEtpGpbSource({ delayMs: config.ETPGPB_DELAY_MS, maxPages: config.ETPGPB_MAX_PAGES });
    case 'fabrikant':
      return createFabrikantSource({ delayMs: config.FABRIKANT_DELAY_MS, maxPages: config.FABRIKANT_MAX_PAGES });
    case 'sberast':
      return createSberAstSource({ delayMs: config.SBERAST_DELAY_MS, maxPages: config.SBERAST_MAX_PAGES });
    case 'fixture':
      return createFixtureSource({ dir: config.FIXTURES_DIR, laws: config.GOSPLAN_LAWS });
    default:
      throw new Error(`Неизвестный источник закупок «${name}». Допустимо: gosplan, eis-rss, roseltorg, etpgpb, fabrikant, sberast, fixture`);
  }
}

/** Все включённые источники как один (TENDER_SOURCES). */
function createSources(names = config.TENDER_SOURCES, opts = {}) {
  return createMultiSource(names.map((n) => createSource(n)), opts);
}

module.exports = { createSources, createSource };
