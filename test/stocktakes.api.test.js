'use strict';

// 端到端：工作室盘点（同一张盘点单核点铅条原材与玻璃原片）
// 预览保存各项当时的系统库存/已确认预留/差异/盘后可用，但不改库存；
// 确认在同一事务内重核基准，任一项不符或实盘低于当前预留则整单不生效；
// 全部通过才一次性更新库存并记下原值/实盘值/确认时间；重复确认返回同一记录不再调整；
// 独立计划、裁片订单与整套单的确认/取消继续按盘点后库存计算；原有库存调整入口继续可用。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39232';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `stocktake-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId, pubId;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

const matStock = async (id) => (await api('GET', `/api/materials/${id}`)).data.material;
const sheetStock = async (id) => (await api('GET', `/api/glass-sheets/${id}`)).data.sheet;

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/stocktakes'); break; } catch { await sleep(50); }
  }
  const d = await api('POST', '/api/designs', { name: '盘点测试窗', width: 100, height: 100 });
  designId = d.data.design.id;
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#00ff00', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  const p = await api('POST', `/api/designs/${designId}/publish`);
  pubId = p.data.publication.id;

  // 铅条：6000mm，库存 10 根；玻璃：红 5 张、绿 2 张
  const m = await api('POST', '/api/materials', { name: '6m料', length: 6000, stock: 10 });
  globalThis.MID = m.data.material.id;
  const r = await api('POST', '/api/glass-sheets', { color: '#FF0000', width: 600, height: 400, stock: 5 });
  globalThis.RID = r.data.sheet.id;
  const g = await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 600, height: 400, stock: 2 });
  globalThis.GID = g.data.sheet.id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('预览：同一张单选铅条+玻璃，保存基准/差异/盘后可用，但不改库存', async () => {
  const beforeM = await matStock(globalThis.MID);
  const beforeR = await sheetStock(globalThis.RID);
  const pv = await api('POST', '/api/stocktakes/preview', {
    name: '月末盘点',
    items: [
      { kind: 'lead', id: globalThis.MID, counted: 8 },
      { kind: 'glass', id: globalThis.RID, counted: 6 },
    ],
  });
  assert.strictEqual(pv.status, 201, JSON.stringify(pv.data));
  const st = pv.data.stocktake;
  assert.strictEqual(st.status, 'draft');
  assert.strictEqual(st.name, '月末盘点');
  assert.strictEqual(st.itemCount, 2);
  assert.strictEqual(st.leadCount, 1);
  assert.strictEqual(st.glassCount, 1);
  const lead = st.items.find((i) => i.kind === 'lead');
  const glass = st.items.find((i) => i.kind === 'glass');
  assert.deepStrictEqual(
    [lead.prevStock, lead.prevReserved, lead.counted, lead.diff, lead.availableAfter],
    [10, 0, 8, -2, 8],
  );
  assert.deepStrictEqual(
    [glass.prevStock, glass.prevReserved, glass.counted, glass.diff, glass.availableAfter],
    [5, 0, 6, 1, 6],
  );
  // 预览不改库存
  assert.strictEqual((await matStock(globalThis.MID)).stock, beforeM.stock);
  assert.strictEqual((await sheetStock(globalThis.RID)).stock, beforeR.stock);
  globalThis.ST1 = st.id;
});

test('确认：同事务一次性更新两类库存，记下原值/实盘值/确认时间', async () => {
  const r = await api('POST', `/api/stocktakes/${globalThis.ST1}/confirm`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.idempotent, false);
  const st = r.data.stocktake;
  assert.strictEqual(st.status, 'confirmed');
  assert.ok(st.confirmedAt, '记下确认时间');
  const lead = st.items.find((i) => i.kind === 'lead');
  assert.strictEqual(lead.prevStock, 10, '记下原值');
  assert.strictEqual(lead.counted, 8, '记下实盘值');
  assert.strictEqual((await matStock(globalThis.MID)).stock, 8);
  assert.strictEqual((await sheetStock(globalThis.RID)).stock, 6);
});

test('已确认盘点重复提交返回同一记录，不再调整库存', async () => {
  const again = await api('POST', `/api/stocktakes/${globalThis.ST1}/confirm`);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.data.idempotent, true);
  assert.strictEqual(again.data.stocktake.id, globalThis.ST1);
  assert.strictEqual(again.data.stocktake.status, 'confirmed');
  // 确认后用原有调整入口改库存，再重复提交盘点确认：不得再次调整
  const patch = await api('PATCH', `/api/materials/${globalThis.MID}`, { stock: 20 });
  assert.strictEqual(patch.status, 200, '原有库存调整入口继续可用');
  const third = await api('POST', `/api/stocktakes/${globalThis.ST1}/confirm`);
  assert.strictEqual(third.status, 200);
  assert.strictEqual(third.data.idempotent, true);
  assert.strictEqual((await matStock(globalThis.MID)).stock, 20, '重复确认不再调整库存');
});

test('非法录入：空单/重复规格/负实盘/非整数/未知种类 一律拒绝且不建单', async () => {
  const count = async () => (await api('GET', '/api/stocktakes')).data.stocktakes.length;
  const before = await count();
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', { items: [] })).status, 400);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {})).status, 400);
  const dup = await api('POST', '/api/stocktakes/preview', {
    items: [
      { kind: 'lead', id: globalThis.MID, counted: 1 },
      { kind: 'lead', id: globalThis.MID, counted: 2 },
    ],
  });
  assert.strictEqual(dup.status, 400);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ kind: 'glass', id: globalThis.RID, counted: -1 }],
  })).status, 400);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ kind: 'glass', id: globalThis.RID, counted: 1.5 }],
  })).status, 400);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ kind: 'copper', id: 1, counted: 1 }],
  })).status, 400);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ kind: 'lead', id: 99999, counted: 1 }],
  })).status, 404);
  assert.strictEqual((await api('POST', '/api/stocktakes/preview', {
    items: [{ kind: 'glass', id: 99999, counted: 1 }],
  })).status, 404);
  assert.strictEqual(await count(), before, '均未产生盘点单');
});

test('基准不符（系统库存已变）：返回该项及原因，整单不生效', async () => {
  const pv = await api('POST', '/api/stocktakes/preview', {
    items: [
      { kind: 'lead', id: globalThis.MID, counted: 15 },
      { kind: 'glass', id: globalThis.RID, counted: 9 },
    ],
  });
  assert.strictEqual(pv.status, 201);
  const stId = pv.data.stocktake.id;
  // 预览后库存被其他入口改动（铅条 20→18）
  await api('PATCH', `/api/materials/${globalThis.MID}`, { stock: 18 });
  const cf = await api('POST', `/api/stocktakes/${stId}/confirm`);
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.code, 'baseline_mismatch');
  assert.strictEqual(cf.data.failures.length, 1);
  const f = cf.data.failures[0];
  assert.strictEqual(f.kind, 'lead');
  assert.strictEqual(f.refId, globalThis.MID);
  assert.strictEqual(f.reason, 'stock_changed');
  assert.strictEqual(f.prevStock, 20);
  assert.strictEqual(f.currentStock, 18);
  // 整单不生效：铅条保持 18，玻璃也未被改成 9
  assert.strictEqual((await matStock(globalThis.MID)).stock, 18);
  assert.strictEqual((await sheetStock(globalThis.RID)).stock, 6);
  const st = (await api('GET', `/api/stocktakes/${stId}`)).data.stocktake;
  assert.strictEqual(st.status, 'draft', '盘点单仍是草稿');
});

test('基准不符（预留已变）与实盘低于当前预留：均整单不生效', async () => {
  // 先确认一张独立计划，铅条预留 1 根（18 库存 → 预留 1）
  const plan = await api('POST', '/api/plans', {
    publicationId: pubId, materialId: globalThis.MID, copies: 1, kerf: 0.5,
  });
  const pid = plan.data.plan.id;
  assert.ok((await api('POST', `/api/plans/${pid}/confirm`)).data.ok);
  assert.strictEqual((await matStock(globalThis.MID)).reserved, 1);

  // 情形一：预览时无预留的基准，确认前出现新预留 → reserved_changed
  const pvG = await api('POST', '/api/stocktakes/preview', {
    items: [{ kind: 'glass', id: globalThis.GID, counted: 2 }],
  });
  const order = await api('POST', '/api/cut-orders', { publicationId: pubId, copies: 1, gap: 0 });
  const oid = order.data.order.id;
  assert.ok((await api('POST', `/api/cut-orders/${oid}/confirm`)).data.ok);
  const cfG = await api('POST', `/api/stocktakes/${pvG.data.stocktake.id}/confirm`);
  assert.strictEqual(cfG.status, 409);
  assert.strictEqual(cfG.data.failures[0].reason, 'reserved_changed');
  assert.strictEqual(cfG.data.failures[0].currentReserved, 1);
  assert.strictEqual((await sheetStock(globalThis.GID)).stock, 2, '玻璃库存未被盘点改动');

  // 情形二：预览基准含预留 1，实盘数低于该预留 → below_reserved
  const pvLow = await api('POST', '/api/stocktakes/preview', {
    items: [{ kind: 'lead', id: globalThis.MID, counted: 0 }],
  });
  assert.strictEqual(pvLow.status, 201, '预览只保存基准，允许录出低于预留的实盘（标警示）');
  const lowItem = pvLow.data.stocktake.items[0];
  assert.strictEqual(lowItem.prevReserved, 1);
  assert.strictEqual(lowItem.availableAfter, -1);
  assert.strictEqual(lowItem.belowReserved, true);
  const cfLow = await api('POST', `/api/stocktakes/${pvLow.data.stocktake.id}/confirm`);
  assert.strictEqual(cfLow.status, 409);
  assert.strictEqual(cfLow.data.failures[0].reason, 'below_reserved');
  assert.strictEqual(cfLow.data.failures[0].currentReserved, 1);
  assert.strictEqual((await matStock(globalThis.MID)).stock, 18, '铅条库存未被盘点改动');
});

test('整套单预留计入盘点基准；盘点后库存参与整套单确认', async () => {
  // 当前：铅条 18 库存/1 预留；红 6/1（上一步裁片订单红+绿各 1）；绿 2/1
  const combo = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId: globalThis.MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'stk-combo-1',
  });
  assert.strictEqual(combo.status, 201, JSON.stringify(combo.data));
  // 盘点预览应同时看到独立单与整套单预留：铅条 1+1=2，红 1+1=2，绿 1+1=2
  const pv = await api('POST', '/api/stocktakes/preview', {
    items: [
      { kind: 'lead', id: globalThis.MID, counted: 16 },
      { kind: 'glass', id: globalThis.RID, counted: 4 },
      { kind: 'glass', id: globalThis.GID, counted: 2 },
    ],
  });
  const items = pv.data.stocktake.items;
  assert.strictEqual(items.find((i) => i.kind === 'lead').prevReserved, 2);
  assert.strictEqual(items.find((i) => i.refId === globalThis.RID).prevReserved, 2);
  assert.strictEqual(items.find((i) => i.refId === globalThis.GID).prevReserved, 2);
  const cf = await api('POST', `/api/stocktakes/${pv.data.stocktake.id}/confirm`);
  assert.strictEqual(cf.status, 200, JSON.stringify(cf.data));
  // 盘点后：铅条可用 16-2=14，红可用 4-2=2，绿可用 2-2=0
  // 再下整套单（需铅条 1 + 红 1 + 绿 1）→ 绿不足，409 且两类都不留预留
  const short = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId: globalThis.MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'stk-combo-2',
  });
  assert.strictEqual(short.status, 409);
  assert.strictEqual(short.data.code, 'shortage');
  assert.strictEqual((await matStock(globalThis.MID)).reserved, 2, '失败整套单不留铅条预留');
  // 取消旧整套单释放绿 1 张后，新整套单即可按盘点后库存确认
  assert.ok((await api('POST', `/api/combo-orders/${combo.data.combo.id}/cancel`)).data.ok);
  const ok2 = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId: globalThis.MID,
    copies: 1, kerf: 0.5, gap: 0, requestId: 'stk-combo-3',
  });
  assert.strictEqual(ok2.status, 201, '确认/取消继续按盘点后库存计算');
});

test('盘点把库存调低后，独立计划按新库存计算缺口', async () => {
  // 把铅条盘到 2 根（当前预留 2：独立计划 1 + 整套三 1）→ 可用 0
  const pv = await api('POST', '/api/stocktakes/preview', {
    items: [{ kind: 'lead', id: globalThis.MID, counted: 2 }],
  });
  const cf = await api('POST', `/api/stocktakes/${pv.data.stocktake.id}/confirm`);
  assert.strictEqual(cf.status, 200);
  assert.strictEqual((await matStock(globalThis.MID)).available, 0);
  // 新计划需 1 根 → 可用 0，确认 409 缺口 1
  const plan = await api('POST', '/api/plans', {
    publicationId: pubId, materialId: globalThis.MID, copies: 1, kerf: 0.5,
  });
  const pid = plan.data.plan.id;
  assert.strictEqual(plan.data.plan.requiredBars, 1);
  const cfr = await api('POST', `/api/plans/${pid}/confirm`);
  assert.strictEqual(cfr.status, 409);
  assert.strictEqual(cfr.data.shortage, 1);
  // 原有调整入口把库存调回后即可确认
  await api('PATCH', `/api/materials/${globalThis.MID}`, { stock: 10 });
  assert.ok((await api('POST', `/api/plans/${pid}/confirm`)).data.ok);
});

test('记录可在网页查阅：列表/详情接口与页面入口', async () => {
  const list = await api('GET', '/api/stocktakes');
  assert.strictEqual(list.status, 200);
  assert.ok(list.data.stocktakes.length >= 5);
  const confirmed = list.data.stocktakes.find((s) => s.id === globalThis.ST1);
  assert.strictEqual(confirmed.status, 'confirmed');
  assert.ok(confirmed.confirmedAt);
  const one = await api('GET', `/api/stocktakes/${globalThis.ST1}`);
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.data.stocktake.items.length, 2);
  assert.strictEqual((await api('GET', '/api/stocktakes/99999')).status, 404);
  assert.strictEqual((await api('POST', '/api/stocktakes/99999/confirm')).status, 404);
  const root = await fetch(BASE + '/');
  assert.strictEqual(root.status, 200);
  const html = await root.text();
  assert.ok(html.includes('盘点'));
});
