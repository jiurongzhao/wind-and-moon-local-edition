/**
 * bench-order.mjs —— 两个"算法换排序"的小基准：
 *   1) 角色列表"收藏在前"：整体 sort O(n log n) vs 稳定分区 O(n)
 *   2) 取会话最新消息：扫一遍找最大 ts O(n) vs 索引取末尾 O(1)
 *
 * 纯 JS 微基准，不依赖 jsdom。用法: node bench-order.mjs [卡片数] [消息数]
 */
const N = Number(process.argv[2] || 32000);
const M = Number(process.argv[3] || 2000);

const time = (label, iters, fn) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
  console.log('  ' + label.padEnd(34) + ms.toFixed(3).padStart(9) + ' ms/次   （' + iters + ' 次）');
  return ms;
};

console.log('=== 收藏在前：sort vs 稳定分区（' + N.toLocaleString() + ' 张卡）===\n');
const cards = [];
for (let i = 0; i < N; i++) cards.push({ id: i, fav: i % 97 === 0, createdAt: i });

const sortMs = time('filter + sort（旧）', 60, () => {
  return cards.filter(() => true).sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0));
});
const partMs = time('filter + 稳定分区（新）', 60, () => {
  const shown = [], favs = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (c.fav) favs.push(c); else shown.push(c);
  }
  return favs.concat(shown);
});
console.log('\n  提速：' + (sortMs / partMs).toFixed(1) + '×（每敲一个搜索字符都会走这一步）\n');

console.log('=== 取最新消息：扫最大 ts vs 取末尾（' + M.toLocaleString() + ' 条）===\n');
const msgs = [];
for (let i = 0; i < M; i++) msgs.push({ ts: 1700000000000 + ((i * 7919) % M) });
msgs.sort((a, b) => a.ts - b.ts);

const scanMs = time('扫一遍找最大 ts（旧）', 200000, () => {
  let last = msgs[0];
  for (let i = 1; i < msgs.length; i++) if (msgs[i].ts >= last.ts) last = msgs[i];
  return last;
});
const o1Ms = time('取最后一条（新，O(1)）', 200000, () => msgs[msgs.length - 1]);
console.log('\n  提速：' + (scanMs / o1Ms).toFixed(0) + '×');
