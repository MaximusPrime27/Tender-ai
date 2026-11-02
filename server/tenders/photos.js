// Фото товаров из ТЗ закупки: достаём из скачанной документации, сохраняем и привязываем к позициям.
// Нужны для ручного поиска (сохранить фото → Яндекс Картинки) и для автоматического поиска по картинке.

const fs = require('node:fs');
const path = require('node:path');
const { extractPhotos } = require('../extract/images');
const { nameStems, normLook } = require('../offers/spec');

/**
 * К какой позиции относится фото: чьё наименование (или модель) встречается ближе всего перед картинкой в тексте ТЗ.
 * Одна позиция в закупке — фото относится к ней. Не нашлось — null (фото закупки в целом).
 */
function itemForPhoto(photo, items) {
  if (items.length === 1) return items[0];
  const ctx = normLook(photo.context || '');
  let best = null;
  for (const i of items) {
    const model = i.spec?.identity?.model || i.characteristics?.find((c) => /модел|артикул/i.test(c.name))?.value;
    const keys = [model && normLook(model), ...nameStems(i.name).map(normLook)].filter(Boolean);
    const pos = Math.max(-1, ...keys.map((k) => ctx.lastIndexOf(k)));
    if (pos >= 0 && (!best || pos > best.pos)) best = { item: i, pos };
  }
  return best?.item || null;
}

function createPhotoService({ repo, dataDir, log = console }) {
  const baseDir = path.join(dataDir, 'photos');

  /** Достать фото из документации закупки (один раз). @returns список фото закупки */
  function ensurePhotos(tender) {
    if (repo.getTenderPhotosChecked(tender.id)) return repo.getTenderPhotos(tender.id);
    const a = tender.analysis_id ? repo.getAnalysis(tender.analysis_id) : null;
    if (!a || a.status !== 'done') return [];
    const found = extractPhotos(path.join(dataDir, 'uploads', a.id)).slice(0, 12);
    const items = repo.getItems(tender.id);
    const dir = path.join(baseDir, String(tender.id));
    fs.mkdirSync(dir, { recursive: true });
    const rows = found.map((p, n) => {
      const file = `${n + 1}.${p.ext}`;
      fs.writeFileSync(path.join(dir, file), p.buffer);
      const item = itemForPhoto(p, items);
      return { idx: n, item_idx: item?.idx ?? null, file, mime: p.mime, size: p.size, source_file: p.file, context: p.context.slice(-200) };
    });
    repo.saveTenderPhotos(tender.id, rows);
    if (rows.length) log.log?.(`[photos] закупка ${tender.number}: фото из ТЗ — ${rows.length}`);
    return repo.getTenderPhotos(tender.id);
  }

  /** Путь к файлу фото (для отдачи в браузер и для поиска по картинке). */
  function photoPath(tenderId, photo) {
    return path.join(baseDir, String(tenderId), photo.file);
  }

  /** Фото для позиции: привязанное к ней, иначе единственное фото закупки с одной позицией. */
  function photoForItem(tender, item) {
    const photos = ensurePhotos(tender);
    return photos.find((p) => p.item_idx === item.idx) || null;
  }

  return { ensurePhotos, photoPath, photoForItem };
}

module.exports = { createPhotoService, itemForPhoto };
