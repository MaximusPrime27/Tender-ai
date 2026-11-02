// Очередь запросов к сайту ЕИС (zakupki.gov.ru): не чаще одного запроса в delayMs.
//
// В robots.txt ЕИС для программ задана пауза 60 секунд (Crawl-delay: 60). На сайт ходят и лента поиска закупок,
// и проверка продавцов по реестру недобросовестных поставщиков — пауза у них должна быть общая, иначе вдвоём
// они превысили бы разрешённую частоту. Все, кто берёт очередь с одной и той же паузой, получают одну очередь.

function createGate(delayMs = 60000) {
  let last = 0;
  let chain = Promise.resolve();
  return {
    delayMs,
    /** Дождаться своей очереди: после предыдущего запроса должно пройти не меньше delayMs. */
    wait() {
      const turn = chain.then(async () => {
        const left = last + delayMs - Date.now();
        // таймер не держит процесс: фоновая проверка не должна мешать сервису остановиться
        if (left > 0) await new Promise((r) => { const t = setTimeout(r, left); t.unref?.(); });
        last = Date.now();
      });
      chain = turn.catch(() => {});
      return turn;
    },
  };
}

const shared = new Map();
/** Общая на процесс очередь для заданной паузы. */
function eisGate(delayMs = 60000) {
  if (!shared.has(delayMs)) shared.set(delayMs, createGate(delayMs));
  return shared.get(delayMs);
}

module.exports = { createGate, eisGate };
