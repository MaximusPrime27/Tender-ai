// Автоматическая проверка продавца по реестру недобросовестных поставщиков (РНП) ЕИС.
//
// Реестр открыт на zakupki.gov.ru, программам читать его разрешено (robots.txt: «Allow: /*dishonest*»), но не чаще
// одного запроса в 60 секунд (Crawl-delay: 60) — поэтому проверка идёт в фоне, через общую очередь запросов к ЕИС.
// Ищем по ИНН и смотрим каждую найденную запись: ИНН должен совпасть точно (поиск находит ИНН и среди учредителей
// других компаний), а запись — действовать («Размещено»). Записи «Исключено» — продавец был в реестре раньше:
// сейчас это не запрет, но знать полезно.
// Страница не похожа на реестр (сайт изменился, включилась проверка «я не робот») — ничего не решаем: ошибка,
// отметка продавца остаётся прежней. Проверку «я не робот» не обходим.

const { createGate } = require('../sources/eis-gate');

const SEARCH_URL = 'https://zakupki.gov.ru/epz/dishonestsupplier/search/results.html';
const UA = 'Mozilla/5.0 (compatible; tender-ai/0.1; supplier search for public procurement)';
const PER_PAGE = 50;

const strip = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/**
 * Разбор страницы поиска в реестре.
 * @returns {{recognized: boolean, empty: boolean, total: number|null, entries: Array<{number, status, active, name, inn, included, planned_exclusion, url}>}}
 */
function parseRnpPage(html) {
  const text = String(html || '');
  const entries = text.split(/<div class="search-registry-entry-block/).slice(1).map((b) => {
    const value = (title) => {
      const m = new RegExp(`registry-entry__body-title">\\s*${title}[^<]*</div>\\s*<div class="registry-entry__body-value">([\\s\\S]*?)</div>`).exec(b);
      return m ? strip(m[1]) : null;
    };
    const date = (title) => (new RegExp(`data-block__title">\\s*${title}\\s*</div>\\s*<div class="data-block__value">\\s*(\\d{2}\\.\\d{2}\\.\\d{4})`).exec(b) || [])[1] || null;
    const status = strip((/registry-entry__header-mid__title[^>]*>([^<]*)/.exec(b) || [])[1] || '');
    const href = (/href="(\/epz\/dishonestsupplier\/view\/info\.html[^"]*)"/.exec(b) || [])[1] || null;
    const number = (/№\s*([0-9A-Za-zА-Яа-яЁё/-]+)/.exec(strip((/registry-entry__header-mid__number">([\s\S]*?)<\/div>/.exec(b) || [])[1] || '')) || [])[1] || null;
    return {
      number, status,
      // действует всё, что не исключено: «Размещено» и любые другие статусы, которые могут появиться
      active: Boolean(status) && !/исключ/i.test(status),
      name: value('Наименование'), inn: (value('ИНН') || '').replace(/\D/g, '') || null,
      included: date('Включено'), planned_exclusion: date('Планируемая дата исключения'),
      url: href ? `https://zakupki.gov.ru${href.replace(/&amp;/g, '&')}` : null,
    };
  });
  const total = /search-results__total[^>]*>\s*(?:более\s+)?(\d[\d\s ]*)\s*запис/i.exec(text);
  return {
    // страница реестра узнаётся по блоку итогов поиска и названию реестра
    recognized: /search-results__total/.test(text) && /недобросовестн/i.test(text),
    empty: /Поиск не дал результатов/i.test(text),
    total: total ? Number(total[1].replace(/\D/g, '')) : null,
    entries,
  };
}

/**
 * @param {{fetchImpl?, gate?, delayMs?, timeoutMs?, maxPages?, clock?}} opts gate — общая очередь запросов к ЕИС
 */
function createRnpChecker({ fetchImpl = fetch, gate = null, delayMs = 60000, timeoutMs = 60000, maxPages = 3, clock = () => new Date() } = {}) {
  const queue = gate || createGate(delayMs);

  /**
   * Проверить продавца по ИНН.
   * @returns {Promise<{status: 'listed'|'clean'|null, records: Array, excluded: number, total: number|null, checked_at: string}>}
   *   status null — записей больше, чем сервис просматривает, и действующей среди просмотренных нет: нужна ручная проверка
   */
  async function check(inn) {
    const id = String(inn || '').trim();
    if (!/^(\d{10}|\d{12})$/.test(id)) throw new Error('ИНН — 10 или 12 цифр');
    const records = [];
    let excluded = 0;
    let total = null;
    let seen = 0;
    for (let page = 1; page <= maxPages; page++) {
      await queue.wait();
      const url = `${SEARCH_URL}?searchString=${id}&strictEqual=true&morphology=on&fz94=on&fz223=on&ppRf615=on&sortBy=UPDATE_DATE&sortDirection=false&recordsPerPage=_${PER_PAGE}&pageNumber=${page}`;
      const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`ЕИС ответил ${res.status} на поиск в реестре`);
      const p = parseRnpPage(await res.text());
      if (!p.recognized) throw new Error('страница реестра не распознана — сайт изменился или просит подтвердить, что вы не робот');
      if (p.empty) break;
      total = p.total ?? total;
      seen += p.entries.length;
      const mine = p.entries.filter((e) => e.inn === id);
      records.push(...mine.filter((e) => e.active));
      excluded += mine.filter((e) => !e.active).length;
      if (records.length || !p.entries.length || total == null || seen >= total) break;
    }
    const incomplete = !records.length && total != null && seen < total;
    return {
      status: records.length ? 'listed' : incomplete ? null : 'clean',
      records: records.slice(0, 5).map(({ number, name, included, planned_exclusion, url }) => ({ number, name, included, planned_exclusion, url })),
      excluded, total, checked_at: clock().toISOString(),
    };
  }

  return { check };
}

module.exports = { createRnpChecker, parseRnpPage, SEARCH_URL };
