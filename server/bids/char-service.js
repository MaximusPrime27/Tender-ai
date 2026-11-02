// Характеристики для заявки по закупке: таблицы по позициям, правки пользователя (значения, товарный знак, страна),
// проверка перед итогом и файл для площадки. Расчёт таблиц — server/bids/characteristics.js.
//
// Характеристики КТРУ с инструкцией заказчика берутся из извещения (позиции, загруженные раньше этой доработки,
// их не хранят — тогда извещение запрашивается один раз, позиции не заменяются: выбранные товары и цены остаются).

const C = require('./characteristics');
const { itemsFrom44Notification } = require('../tenders/items');
const { kindOf, modelFromTitle, compact } = require('../offers/product-base');

const RETRY_MS = 60 * 60 * 1000; // не удалось взять извещение — повторить не раньше чем через час

function createCharService({ repo, source = null, log = console, clock = () => new Date() }) {
  const key = (itemId) => `bidchars:${itemId}`;
  const savedOf = (itemId) => { try { return JSON.parse(repo.getSetting(key(itemId)) || '{}'); } catch { return {}; } };

  /** Дописать к позициям характеристики КТРУ из извещения, если их нет. Возвращает пояснение или null. */
  async function ensureEis(tender) {
    const items = repo.getItems(tender.id);
    if (!items.length || items.every((i) => Array.isArray(i.eis_chars))) return null;
    if (String(tender.law) !== '44' || !source?.getDetailsDoc) return 'характеристики КТРУ есть только в извещениях 44-ФЗ';
    const mark = `eischars_at:${tender.id}`;
    const last = Number(repo.getSetting(mark) || 0);
    if (Date.now() - last < RETRY_MS) return 'извещение недавно не ответило — повторим позже';
    repo.setSetting(mark, String(Date.now()));
    let doc = null;
    try { doc = await Promise.race([source.getDetailsDoc(tender), new Promise((_, rej) => setTimeout(() => rej(new Error('нет ответа 40 с')), 40000))]); }
    catch (err) { log.warn?.(`[заявка] извещение ${tender.number}: ${err.message}`); return `не удалось взять извещение: ${err.message}`; }
    const parsed = itemsFrom44Notification(doc);
    if (!parsed.length) return 'в извещении нет позиций';
    // та же позиция — тот же номер строки и наименование, иначе — то же наименование и код
    const used = new Set();
    for (const it of items) {
      const p = parsed.find((x, i) => !used.has(i) && i === it.idx && x.name === it.name)
        ?? parsed.find((x, i) => !used.has(i) && x.name === it.name && (x.ktru_code || x.okpd2_code) === (it.ktru_code || it.okpd2_code));
      if (!p) continue;
      used.add(parsed.indexOf(p));
      repo.setItemEisChars(it.id, p.eis_chars || [], p.eis_measure ?? null);
    }
    return null;
  }

  /** Выбранный товар позиции: одно предложение на всё количество (набор из нескольких продавцов — это разные товары). */
  function chosenOffer(tender, item) {
    const alloc = (repo.getAllocations ? repo.getAllocations(tender.id) : []).filter((a) => a.item_id === item.id);
    const ids = [...new Set(alloc.map((a) => a.offer_id))];
    const id = ids.length === 1 ? ids[0] : !ids.length ? item.purchase_offer_id : null;
    const o = id ? repo.getOffer(id) : null;
    if (!o) return null;
    const title = o.product_title || o.title || null;
    // На странице магазина часто нет половины характеристик («скорость печати», «ёмкость лотка»), а в своей базе у той же
    // модели они есть (собраны с других страниц и паспортов): дописываем их после значений со страницы продавца —
    // иначе в заявку уходит граница из ТЗ («30 стр/мин») вместо настоящего значения товара («40»).
    const base = baseSpecs(title, item.name).filter((b) => !(o.specs || []).some((s) => String(s.name).toLowerCase() === String(b.name).toLowerCase()));
    return { title, seller: o.seller_name || o.domain || null, url: o.product_url || o.url || null,
      specs: [...(o.specs || []), ...base], rows: o.match_checks?.rows || [] };
  }

  /**
   * Характеристики того же товара из своей базы: вид — по названию товара, иначе по позиции ТЗ; модель — любое
   * обозначение из названия с буквами и цифрами («MA4000x», «110C143AX0», «B27F1»), в ключе карточки целиком.
   */
  function baseSpecs(title, itemName = '') {
    if (!title || !repo.db) return [];
    try {
      const kind = kindOf(title) || kindOf(itemName);
      if (!kind) return [];
      const tokens = [...new Set([modelFromTitle(title, kind), ...(String(title).match(/[A-Za-zА-Яа-яЁё]*\d[A-Za-zА-Яа-яЁё0-9.\-/]*/g) || [])]
        .filter(Boolean).map((t) => compact(t)).filter((t) => t.length >= 4 && /[a-zа-я]/.test(t) && /\d/.test(t)))];
      const seen = new Set();
      const rows = [];
      for (const t of tokens) {
        for (const r of repo.db.prepare('SELECT id, specs_json FROM products WHERE niche = ? AND key LIKE ? LIMIT 3').all(kind.niche, `%:%${t}%`)) {
          if (!seen.has(r.id) && rows.length < 3) { seen.add(r.id); rows.push(r); }
        }
      }
      return rows.flatMap((r) => JSON.parse(r.specs_json || '[]'))
        .filter((x) => x?.name && x.value != null && String(x.value).length <= 120)
        .map((x) => ({ name: x.name, value: x.value, from_label: 'карточка товара в своей базе', src: x.src || null }));
    } catch { return []; }
  }

  /** Заказчик запретил «искусственное приведение значений» (текст документации разбора). */
  function forbidPass(tender) {
    if (!tender.analysis_id || !repo.getFilesFull) return false;
    const texts = repo.getFilesFull(tender.analysis_id).flatMap((f) => (f.pages || []).map((p) => p.text || ''));
    return C.forbidsArtificial(texts);
  }

  async function view(tenderId) {
    const tender = repo.getTender(tenderId);
    if (!tender) return null;
    const note = await ensureEis(tender);
    const forbid = forbidPass(tender);
    const items = repo.getItems(tender.id);
    const tables = items.filter((i) => i.eis_chars?.length || i.spec?.required?.length)
      .map((i) => C.itemTable(i, { offer: chosenOffer(tender, i), saved: savedOf(i.id), forbidPass: forbid }));
    return {
      tender: { id: tender.id, number: tender.number, title: tender.title, law: tender.law },
      forbid_pass: forbid, eis_note: note, tables, problems: C.problems(tables, { forbidPass: forbid }),
      without_chars: items.filter((i) => !i.eis_chars?.length && !i.spec?.required?.length).map((i) => ({ item_id: i.id, idx: i.idx, name: i.name })),
    };
  }

  /**
   * Сохранить правки: значения характеристик позиции, товарный знак, страну. all — та же страна (или знак) во все
   * позиции, где поле пустое; заполненное не меняется. Пустая строка — убрать своё значение.
   */
  function save(tenderId, { item_id = null, values = null, trademark, country, all = false } = {}) {
    const items = repo.getItems(tenderId);
    const targets = all ? items : items.filter((i) => i.id === Number(item_id));
    if (!targets.length) throw Object.assign(new Error('Позиция не найдена'), { status: 404 });
    const tender = repo.getTender(tenderId);
    for (const it of targets) {
      const s = savedOf(it.id);
      if (values && !all) {
        s.values = { ...(s.values || {}) };
        for (const [name, v] of Object.entries(values)) { const t = String(v ?? '').trim().slice(0, 500); if (t) s.values[name] = t; else delete s.values[name]; }
      }
      // «во все пустые»: пустым считается и поле без своего значения, у которого нет значения со страницы товара
      const current = all ? C.itemTable(it, { offer: chosenOffer(tender, it), saved: s }) : null;
      if (trademark !== undefined && (!all || !current.trademark)) { const t = String(trademark ?? '').trim().slice(0, 200); if (t) s.trademark = t; else delete s.trademark; }
      if (country !== undefined && (!all || !current.country)) { const t = String(country ?? '').trim().slice(0, 120); if (t) s.country = t; else delete s.country; }
      s.updated_at = clock().toISOString();
      repo.setSetting(key(it.id), JSON.stringify(s));
    }
    return view(tenderId);
  }

  async function exportFile(tenderId, kind) {
    const v = await view(tenderId);
    if (!v) return null;
    return kind === 'csv' ? C.exportCsv(v.tables) : C.exportText(v.tender, v.tables);
  }

  return { view, save, exportFile };
}

module.exports = { createCharService };
