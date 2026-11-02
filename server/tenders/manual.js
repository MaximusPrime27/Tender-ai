// Закупка, добавленная вручную: владелец сам скачал документы заказчика с площадки (например, ЕАТ «Берёзка»),
// загрузил их и вписал, что знает. Дальше закупка идёт обычным путём: разбор документации → позиции и ТЗ →
// поставщики → расчёт → итог. К площадке сервис не обращается и ничего на неё не отправляет.

const fs = require('node:fs');
const path = require('node:path');
const { regionFromInn, regionFromText } = require('../offers/logistics');

const MANUAL = 'manual';
const isManual = (t) => t?.source === MANUAL;
// Закупки ЕАТ записываются так же, как их запишет подключение площадки (ветка eat-source): вне ЕИС, номер «EAT-…».
const EAT = { name: 'ЕАТ «Берёзка»', url: 'https://agregatoreat.ru' };
const isEatName = (name) => /еат|берёзк|березк|agregatoreat/i.test(String(name || ''));

const cardField = (card, key) => card?.groups?.flatMap((g) => g.fields).find((f) => f.key === key && f.status === 'found')?.value ?? null;

/** «1 234 567,89 руб.» → 1234567.89; «1,2 млн» → 1200000. Не число — null. */
function parseMoney(text) {
  const m = String(text || '').replace(/ /g, ' ').match(/(\d[\d ]*(?:[.,]\d+)?)\s*(млн|тыс)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/ /g, '').replace(',', '.')) * (/млн/i.test(m[2] || '') ? 1e6 : /тыс/i.test(m[2] || '') ? 1e3 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
/** «15.10.2026 09:00», «15 октября 2026 г. в 9:00» → ISO. Время без пояса считаем московским; без времени — конец дня. */
function parseDate(text) {
  const s = String(text || '');
  let d = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  let rest = '';
  let parts = null;
  if (d) { parts = [Number(d[3]), Number(d[2]), Number(d[1])]; rest = s.slice(d.index + d[0].length); }
  else {
    d = s.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
    const month = d ? MONTHS.findIndex((x) => d[2].toLowerCase().startsWith(x) && (x !== 'ма' || /^ма[йя]/i.test(d[2]))) : -1;
    if (d && month >= 0) { parts = [Number(d[3]), month + 1, Number(d[1])]; rest = s.slice(d.index + d[0].length); }
  }
  if (!parts) return null;
  const [y, mo, day] = parts;
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || y < 2000 || y > 2100) return null;
  const t = rest.slice(0, 24).match(/(\d{1,2})[:.](\d{2})/);
  const [hh, mm] = t && Number(t[1]) < 24 && Number(t[2]) < 60 ? [Number(t[1]), Number(t[2])] : [23, 59];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = new Date(`${y}-${pad(mo)}-${pad(day)}T${pad(hh)}:${pad(mm)}:00+03:00`);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

/** ИНН организации (10 цифр) или предпринимателя (12) из текста. */
const innFrom = (text) => String(text || '').match(/(?<!\d)(\d{10}|\d{12})(?!\d)/)?.[1] ?? null;

const upFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Название заказчика без ИНН/КПП в хвосте: «Школа № 12, ИНН 5031012345» → «Школа № 12». */
const orgName = (text) => String(text || '').replace(/\s+/g, ' ').replace(/[,;(]?\s*(ИНН|КПП|ОГРН)\s*:?\s*\d+\)?/gi, '').replace(/^\s*заказчик\s*:\s*/i, '').replace(/[\s,;.]+$/, '').trim().slice(0, 300);

/** Файлы ручной закупки на диске: [{originalname, path}] — только те, что на месте. */
function storedFiles({ repo, uploadsDir, tender }) {
  const m = repo.getTenderRaw(tender.id)?.manual;
  if (!m?.dir) return [];
  const dir = path.join(uploadsDir, path.basename(m.dir));
  return (m.files || []).map((f) => ({ originalname: f.name, path: path.join(dir, path.basename(f.file)) })).filter((f) => fs.existsSync(f.path));
}

function createManualTenders({ repo, analyses, uploadsDir, clock = () => new Date(), log = console }) {
  const metaOf = (id) => repo.getTenderRaw(id)?.manual || null;
  const saveMeta = (id, patch) => { const raw = repo.getTenderRaw(id) || {}; repo.setTenderRaw(id, { ...raw, manual: { ...(raw.manual || {}), ...patch } }); };
  const dirOf = (meta) => path.join(uploadsDir, path.basename(meta.dir));

  /** Номер закупки в сервисе: ЕАТ — «EAT-<номер>»; номера нет — «MANUAL-<дата>-<n>». */
  function numberFor(platform, raw) {
    const n = String(raw || '').replace(/\s+/g, '').replace(/^№/, '').slice(0, 80);
    if (n) return isEatName(platform) ? `EAT-${n.replace(/^EAT-/i, '')}` : n;
    const day = clock().toISOString().slice(0, 10).replace(/-/g, '');
    const taken = repo.db.prepare("SELECT COUNT(*) AS n FROM tenders WHERE law = 'com' AND number LIKE ?").get(`MANUAL-${day}-%`).n;
    return `MANUAL-${day}-${Number(taken) + 1}`;
  }

  /** Текст, скопированный со страницы закупки, — ещё один файл документации. */
  function writeText(dir, text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const file = `${Date.now()}-tekst-iz-kartochki.txt`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), t, 'utf8');
    return { name: 'Текст из карточки закупки.txt', file };
  }

  const dropDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { log.warn?.(`[manual] не удалён каталог ${dir}: ${err.message}`); } };

  /** Запомнить разбор закупки: при удалении закупки удаляются и все её разборы. */
  const track = (tenderId, analysisId) => saveMeta(tenderId, { analyses: [...new Set([...(metaOf(tenderId)?.analyses || []), analysisId])] });

  function startAnalysis(tender) {
    const analysisId = analyses.startFromTender({ tender });
    repo.setTenderAnalysis(tender.id, analysisId);
    track(tender.id, analysisId);
    return analysisId;
  }

  return {
    isManual,
    track,

    /**
     * Завести закупку из загруженных файлов.
     * @param dir    имя каталога в uploads, куда уже сохранены файлы
     * @param files  [{originalname, path}]
     * @param fields {platform, number, title, price, deadline_at, region, customer_inn, url, text}
     * @returns {{id, analysisId}|{existing: id}}
     */
    create({ dir, files, fields }) {
      const platform = String(fields.platform || '').trim() || EAT.name;
      const number = numberFor(platform, fields.number);
      const dup = repo.findTender('com', number);
      if (dup) { dropDir(path.join(uploadsDir, path.basename(dir))); return { existing: dup.id }; }
      const list = files.map((f) => ({ name: f.originalname, file: path.basename(f.path) }));
      const text = writeText(path.join(uploadsDir, path.basename(dir)), fields.text);
      if (text) list.push(text);
      const given = ['title', 'price', 'deadline_at', 'region', 'customer_inn'].filter((k) => fields[k] != null && fields[k] !== '');
      const title = String(fields.title || '').trim()
        || `Закупка из документов от ${clock().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
      const id = repo.createManualTender({
        number, title: title.slice(0, 500), price: fields.price ?? null, deadline_at: fields.deadline_at ?? null,
        region: fields.region ?? regionFromInn(fields.customer_inn), customer_inn: fields.customer_inn || null, eis_url: fields.url || null,
        raw: { manual: { dir: path.basename(dir), files: list, given, from_docs: [], analyses: [] } },
      });
      repo.setPlatform(id, isEatName(platform) ? EAT : { name: platform.slice(0, 120), url: null });
      const analysisId = startAnalysis(repo.getTender(id));
      return { id, analysisId };
    },

    /** Дозагрузить документы и прочитать всё заново; позиции после этого собираются из документов снова. */
    addFiles(tender, { files = [], text = '' }) {
      const meta = metaOf(tender.id);
      if (!meta?.dir) throw Object.assign(new Error('У этой закупки нет каталога с файлами'), { status: 409 });
      const list = [...(meta.files || []), ...files.map((f) => ({ name: f.originalname, file: path.basename(f.path) }))];
      const t = writeText(dirOf(meta), text);
      if (t) list.push(t);
      saveMeta(tender.id, { files: list, reread: true });
      repo.clearSpec(tender.id);
      return startAnalysis(tender);
    },

    /** Правка полей владельцем: что вписано руками, больше не помечается «из документов». */
    update(tender, fields) {
      const meta = metaOf(tender.id) || {};
      const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
      repo.updateManualTender(tender.id, fields);
      if (fields.platform !== undefined && String(fields.platform).trim()) {
        const p = String(fields.platform).trim();
        repo.db.prepare('UPDATE tenders SET platform = ?, platform_url = ? WHERE id = ?').run(isEatName(p) ? EAT.name : p.slice(0, 120), isEatName(p) ? EAT.url : null, tender.id);
      }
      const touched = new Set(keys);
      saveMeta(tender.id, {
        given: [...new Set([...(meta.given || []), ...keys.filter((k) => fields[k] != null && fields[k] !== '')])],
        from_docs: (meta.from_docs || []).filter((k) => !touched.has(k)),
      });
      if (fields.delivery_place !== undefined || fields.customer_name !== undefined) {
        const cur = repo.getDetails(tender.id)?.conditions?.customer || {};
        repo.mergeConditions(tender.id, { customer: {
          ...cur,
          ...(fields.customer_name !== undefined ? { org: fields.customer_name || undefined } : {}),
          ...(fields.delivery_place !== undefined ? { delivery_place: fields.delivery_place || undefined } : {}),
        } });
      }
      return repo.getTender(tender.id);
    },

    /**
     * Разбор документации готов: поля, которые владелец не заполнил, берём из документов и помечаем «из документов».
     * @returns {string[]} какие поля взяты
     */
    applyAnalysis(tender, analysis) {
      const card = analysis?.card;
      const meta = metaOf(tender.id) || {};
      if (!card) return [];
      const given = new Set(meta.given || []);
      const patch = {};
      const subject = cardField(card, 'subject');
      if (!given.has('title') && subject) patch.title = upFirst(String(subject).replace(/\s+/g, ' ').trim().slice(0, 300));
      const price = parseMoney(cardField(card, 'nmck'));
      if (!given.has('price') && price != null) patch.price = price;
      const deadline = parseDate(cardField(card, 'bid_deadline'));
      if (!given.has('deadline_at') && deadline) patch.deadline_at = deadline;
      const customer = cardField(card, 'customer');
      const inn = innFrom(customer);
      if (!given.has('customer_inn') && inn) patch.customer_inn = inn;
      const place = cardField(card, 'delivery_place');
      const region = regionFromText(place) ?? regionFromInn(inn || tender.customer_inn);
      if (!given.has('region') && region != null) patch.region = region;
      if (Object.keys(patch).length) repo.updateManualTender(tender.id, patch);
      // Заказчик и место поставки — для расчёта доставки, письма заказчику и итоговой страницы.
      const cur = repo.getDetails(tender.id)?.conditions?.customer || {};
      const cust = {
        ...cur,
        ...(!given.has('customer_name') && customer ? { org: orgName(customer) } : {}),
        ...(!given.has('delivery_place') && place ? { delivery_place: String(place).replace(/\s+/g, ' ').trim().slice(0, 500) } : {}),
      };
      repo.mergeConditions(tender.id, { customer: cust });
      const taken = [...Object.keys(patch), ...(cust.org && !given.has('customer_name') && customer ? ['customer_name'] : []), ...(cust.delivery_place && !given.has('delivery_place') && place ? ['delivery_place'] : [])];
      saveMeta(tender.id, { from_docs: [...new Set(taken)] });
      return taken;
    },

    /** Нужно ли после разбора собрать позиции из документов заново (дозагружены файлы). Флаг снимается. */
    takeReread(tenderId) {
      const meta = metaOf(tenderId);
      if (!meta?.reread) return false;
      saveMeta(tenderId, { reread: false });
      return true;
    },

    /** Что показать в карточке: площадка, файлы, какие поля откуда. */
    view(tender) {
      const meta = metaOf(tender.id) || {};
      const customer = repo.getDetails(tender.id)?.conditions?.customer || {};
      const onDisk = new Set(storedFiles({ repo, uploadsDir, tender }).map((f) => path.basename(f.path)));
      return {
        platform: tender.platform || null,
        files: (meta.files || []).map((f) => ({ name: f.name, missing: !onDisk.has(path.basename(f.file)) })),
        given: meta.given || [],
        from_docs: meta.from_docs || [],
        customer_name: customer.org || null,
        delivery_place: customer.delivery_place || null,
      };
    },

    /** Удалить закупку вместе с её файлами и разборами. */
    remove(tender) {
      const meta = metaOf(tender.id) || {};
      const ids = [...new Set([...(meta.analyses || []), tender.analysis_id].filter(Boolean))];
      repo.deleteTender(tender.id);
      for (const a of ids) { repo.deleteAnalysis(a); dropDir(path.join(uploadsDir, path.basename(String(a)))); }
      if (meta.dir) dropDir(dirOf(meta));
      return true;
    },
  };
}

module.exports = { createManualTenders, storedFiles, isManual, parseMoney, parseDate, innFrom, MANUAL, EAT };
