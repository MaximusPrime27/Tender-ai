// Правила состава заявки — отдельно от нейросети: версионированные наборы в config/bid-rules/*.json.
// У каждого правила статус: draft (не сверено человеком) | verified | superseded. Подтверждение правила — действие
// человека (кто, когда, по какой редакции), оно хранится в базе и привязано к отпечатку набора: изменился файл
// правил — подтверждения больше не действуют, затронутые заявки помечаются устаревшими.
// Ответ нейросети юридической проверкой не считается: статус verified она поставить не может.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = path.join(__dirname, '..', '..', 'config', 'bid-rules');

/** Все наборы правил из папки; у каждого — отпечаток содержимого. Новейший — последний по имени файла. */
function loadRulePacks(dir = DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const pack = JSON.parse(raw);
    return { ...pack, file: f, hash: crypto.createHash('sha256').update(raw).digest('hex') };
  });
}

/** Действующий набор: новейший. (Выбор редакции по дате извещения появится, когда наборов станет больше одного.) */
const activePack = (packs) => packs[packs.length - 1] || null;

/**
 * Правила сценария с действующим статусом: черновик из файла, если человек не подтвердил его для этого отпечатка набора.
 * @param verifications [{rule_id, pack_hash, status, verified_by, verified_at, note}] из базы
 */
function rulesFor(pack, scenario, verifications = []) {
  if (!pack || !scenario) return [];
  const confirmed = new Map(verifications.filter((v) => v.pack_hash === pack.hash).map((v) => [v.rule_id, v]));
  return pack.rules.filter((r) => r.scenarios.includes(scenario)).map((r) => {
    const v = confirmed.get(r.id);
    const source = pack.sources?.[r.law] || {};
    return {
      ...r,
      status: v?.status || r.status || 'draft',
      verified_by: v?.verified_by || null, verified_at: v?.verified_at || null, review_note: v?.note || null,
      act: source.act || r.law, url: source.url || null, pack_id: pack.id, pack_hash: pack.hash,
    };
  });
}

module.exports = { loadRulePacks, activePack, rulesFor, DIR };
