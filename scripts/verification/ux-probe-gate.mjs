/**
 * Probe: does the knowledge-relation form explain itself when the two ends are
 * the same point? The points are seeded over the API (the question is about the
 * form's behaviour, not about creating points); the page is then loaded fresh.
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:3000';
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();

const api = async (method, path, body) => {
  const response = await context.request.fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    data: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
};

await page.goto(`${BASE}/curriculum`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
for (const [name, code] of [['SQL 注入原理', 'KP-01'], ['联合查询注入', 'KP-02']]) {
  const result = await api('POST', '/api/curriculum/knowledge-points', { name, code, type: 'knowledge' });
  console.log(`seed ${code} -> ${result.status}`);
}

await page.goto(`${BASE}/curriculum?tab=knowledge`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const visible = (locator) => locator.filter({ visible: true });
const selectWith = (text) =>
  visible(page.locator('select').filter({ has: page.locator('option', { hasText: text }) })).first();

const source = selectWith('源知识点');
const target = selectWith('目标知识点');
const submit = visible(page.getByRole('button', { name: '新建/更新知识点关系', exact: true })).first();

console.log('source options:', await source.locator('option').allTextContents());

console.log(`\n[A] 什么都没选          submit disabled=${await submit.isDisabled()}`);

await source.selectOption({ index: 1 });
await target.selectOption({ index: 1 });
await page.waitForTimeout(400);
console.log(`[B] 两端同一个知识点      submit disabled=${await submit.isDisabled()}`);
const sentence = (await page.locator('body').innerText()).match(/关系的两端现在都是[^\n]{0,120}/);
console.log(`    页面上的解释句：${sentence ? sentence[0] : '（找不到）'}`);
const formText = await page
  .locator('div')
  .filter({ hasText: '源知识点' })
  .last()
  .innerText()
  .catch(() => '');
console.log('    表单附近文字：', JSON.stringify(formText.replace(/\s+/g, ' ').slice(0, 160)));

await target.selectOption({ index: 2 });
await page.waitForTimeout(400);
console.log(`[C] 两端不同            submit disabled=${await submit.isDisabled()}`);

const firstValue = await source.locator('option').nth(1).getAttribute('value');
// The API names the ends the way the column does, not the way the form's two
// dropdowns do — sending `sourceId` fails validation before the self-loop rule
// is reached, which would make this case prove nothing.
const same = await api('POST', '/api/curriculum/knowledge-point-relations', {
  sourceKnowledgePointId: firstValue,
  targetKnowledgePointId: firstValue,
  relationType: 'prerequisite',
});
console.log(`\n[D] 绕过界面直接 POST 自环 -> ${same.status} ${JSON.stringify(same.body).slice(0, 200)}`);

await browser.close();
