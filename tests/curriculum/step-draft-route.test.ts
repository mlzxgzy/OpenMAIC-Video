/**
 * 起草路由骨架的契约：**结构上无法写库**，以及它给四个步骤共享的那部分行为。
 *
 * 这一层是 B2 试点的"源码里没有 `ctx.write`"那条断言的**升级版**。那条断言要求每个步骤
 * 路由各自自觉，而一个复制四遍的约定就是四次机会；骨架把它变成一条类型不变量，于是
 * 这里测的是那条不变量的两端：骨架自己的上下文里没有 `write`，以及基于它的每个步骤路由
 * 都没有碰写库的函数。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');

describe('起草骨架：不落库是类型不变量，不是自觉', () => {
  it('步骤拿到的上下文里没有 write', () => {
    // 这条断言读的是**类型声明**而不是实现：骨架删掉 `write` 字段就会让它变红，而任何
    // 步骤路由因此都拿不到写库函数。
    const source = read('lib/server/curriculum/step-draft-route.ts');
    const context = /export interface StepDraftRouteContext \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    expect(context).toBeTruthy();
    expect(context).not.toMatch(/\bwrite\b/);
  });

  it('骨架自己不碰任何写库函数', () => {
    const source = read('lib/server/curriculum/step-draft-route.ts');
    expect(source).not.toMatch(/ctx\.write\s*\(/);
    expect(source).not.toMatch(
      /createCurriculum|updateCurriculum|deleteCurriculum|setCurriculum|confirmCurriculum|advanceCurriculum/,
    );
  });

  it('每个基于骨架的步骤路由都不碰写库函数', () => {
    // 用 glob 而不是硬编码名单：新增一个 `draft/route.ts` 会自动被这条断言扫到，所以
    // "忘了走骨架、自己写一遍 handler"这个失败会立刻出现在这里，而不是下一次审核里。
    const root = fileURLToPath(new URL('../../app/api/curriculum/design/tasks', import.meta.url));
    const draftRoutes = findDraftRoutes(root);
    expect(draftRoutes.length).toBeGreaterThan(0);
    for (const route of draftRoutes) {
      const source = readFileSync(route, 'utf8');
      const label = route.slice(route.indexOf('tasks/'));
      expect(source, `${label} 不该自己碰写库函数`).not.toMatch(/ctx\.write\s*\(/);
      expect(source, `${label} 不该直接调 store 的写入函数`).not.toMatch(
        /createCurriculum|updateCurriculum|deleteCurriculum|setCurriculum|confirmCurriculum|advanceCurriculum/,
      );
    }
  });
});

describe('起草骨架：四个步骤真正共享的那部分', () => {
  it('跨源请求被拒，而且不花钱：模型在同源校验之后才解析', async () => {
    // 顺序是这条断言的全部意义——先花钱再校验，等于把别人的请求变成自己的模型账单。
    // 断言的是**调用点**而不是函数定义，所以用 `lastIndexOf`。
    const source = read('lib/server/curriculum/step-draft-route.ts');
    const sameOrigin = source.indexOf('isSameOriginJsonRequest(req)');
    const resolve = source.lastIndexOf('resolveStepModel(ctx.ownerId, config.modelStage');
    expect(sameOrigin).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(sameOrigin);
  });

  it('阶段门槛在读库与花钱之前', async () => {
    // 起草是"让模型说"，但它仍然花钱，而且草稿会被采纳——采纳是真的写入。所以它必须和
    // 写入受同一道阶段门，而不是等采纳时才被拒。
    const source = read('lib/server/curriculum/step-draft-route.ts');
    const phase = source.indexOf('phaseRank(task.designPhase)');
    const readBefore = source.lastIndexOf('config.readBefore(');
    const model = source.lastIndexOf('resolveStepModel(ctx.ownerId, config.modelStage');
    expect(phase).toBeGreaterThan(-1);
    expect(readBefore).toBeGreaterThan(phase);
    expect(model).toBeGreaterThan(phase);
  });

  it('历史截断到最后一条用户消息——其后的助手回答就是这一轮草稿本身', async () => {
    const source = read('lib/server/curriculum/step-draft-route.ts');
    expect(source).toMatch(/lastUserTurns/);
  });

  it('回包是 { ...extra, draft }：右栏不自己读库', async () => {
    const source = read('lib/server/curriculum/step-draft-route.ts');
    expect(source).toMatch(/ownerJson\(\{ \.\.\.\(extra \?\? \{\}\), draft \}/);
  });
});

/**
 * 递归找出所有 `draft/route.ts`。
 *
 * 手写而不引 glob：这个仓库的测试不引它，而一条只为了列文件的断言不值得多一个依赖。
 */
function findDraftRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findDraftRoutes(path));
    } else if (entry.name === 'route.ts' && path.endsWith('/draft/route.ts')) {
      out.push(path);
    }
  }
  return out.sort();
}
