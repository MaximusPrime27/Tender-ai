// Деньги в копейках: целые числа, без двоичных дробей. Проценты — точной дробью, округление HALF_UP.
// Пустое значение — это «нет значения» (null), а не ноль: ноль бывает только подтверждённым.

const MAX_KOP = Number.MAX_SAFE_INTEGER; // ≈ 90 трлн ₽ — больше в копейках через Number не передаём

class MoneyError extends Error {}

/** Проверка: целое число копеек в безопасном диапазоне. */
function assertKop(v, what = 'сумма') {
  if (!Number.isSafeInteger(v)) throw new MoneyError(`${what}: должна быть целым числом копеек в допустимом диапазоне`);
  return v;
}

/**
 * Разбор суммы в копейки: 1234.56, «1 234,56», «1234,5 ₽», строка копеек нет. null/'' → null.
 * Отрицательные суммы не принимаются (возвраты и корректировки — отдельные события).
 */
function parseRub(v, what = 'сумма') {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new MoneyError(`${what}: не число`);
    if (v < 0) throw new MoneyError(`${what}: отрицательная сумма не принимается`);
    // число с копейками: округление до копейки через строку, без накопления ошибки 0,1 + 0,2
    const kop = Math.round(Number(v.toFixed(4)) * 100);
    return assertKop(kop, what);
  }
  const s = String(v).replace(/[\s ₽]|руб\.?/gi, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new MoneyError(`${what}: «${String(v).slice(0, 30)}» — не сумма в рублях (пример: 1 234,56)`);
  const [r, k = ''] = s.split('.');
  return assertKop(Number(r) * 100 + Number(k.padEnd(2, '0')), what);
}

/** Процент как точная дробь: 6 → 6/100, 22.5 → 2250/10000. Не больше 4 знаков после запятой. */
function parsePct(v, what = 'процент', { min = 0, max = 100 } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw new MoneyError(`${what}: не число`);
  if (n < min || n > max) throw new MoneyError(`${what}: должен быть от ${min} до ${max}`);
  return Math.round(n * 10000) / 10000;
}

/** a × num / den с округлением половины от нуля (HALF_UP) — через BigInt, без потери копеек. */
function mulDiv(a, num, den) {
  assertKop(a);
  const A = BigInt(a) * BigInt(num);
  const D = BigInt(den);
  const neg = (A < 0n) !== (D < 0n);
  const q = ((A < 0n ? -A : A) * 2n + (D < 0n ? -D : D)) / (2n * (D < 0n ? -D : D));
  return Number(neg ? -q : q);
}

/** Процент от суммы в копейках: kop × pct / 100, HALF_UP. */
const pctOf = (kop, pct) => mulDiv(kop, Math.round(pct * 10000), 1000000);

/** НДС, включённый в сумму: gross × r / (100 + r), HALF_UP. */
const vatIncluded = (gross, rate) => mulDiv(gross, Math.round(rate * 10000), Math.round((100 + rate) * 10000));

const rub = (kop) => (kop == null ? null : kop / 100);
const fmt = (kop) => (kop == null ? '—' : `${(kop / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`);

module.exports = { MoneyError, assertKop, parseRub, parsePct, mulDiv, pctOf, vatIncluded, rub, fmt, MAX_KOP };
