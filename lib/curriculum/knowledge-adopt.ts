'use client';

/**
 * 采纳一行草稿 = 走**已经存在的手工写入路由**做作者自己会做的那件事。
 *
 * 这个文件存在的理由是"没有第二条路径"。AI 采纳如果走一套自己的写入代码，就多出一样
 * 东西：手工新建节点要过的阶段校验、端点归属校验、链接整表替换规则，AI 那条路要么没有，
 * 要么有但不一样——而"不一样"是那种只有出问题时才被发现的分叉。所以这里一行新的写逻辑
 * 都没有，只有对已有路由的调用组合。
 *
 * 两条容易写错、这里被显式处理的地方：
 *
 * 1. **连线必须合进整份集合。** `setCurriculumNodeObjectives` 是全表替换（先删后插），
 *    所以采纳一个新节点时要带着**当前全部**连线加上它自己的。只发它自己那几条会悄悄
 *    删掉别的节点的支撑关系，而那不会报错——它只会让后面某个目标变成"没东西可讲"。
 * 2. **草稿节点先落库，连线后写，顺序不能反。** 边要按真实 id 写，而 id 只有落库之后
 *    才有；反过来没有任何一条边写得进去。
 *
 * **不经过工作台的 `run`**，是一个被 e2e 逮到的真 bug：`run` 把失败吞进页面的错误条然后
 * 正常返回，于是右栏会一边显示"已采纳这一行，左栏已经改好"、一边什么也没写进去。
 * 采纳必须让失败**抛回右栏**，右栏才有资格决定"这一行算不算已采纳"——采纳记录和存储
 * 必须由同一次结果决定，否则状态和事实会各说各话。
 */

import {
  edgeEndpointsOf,
  mergedLinkSet,
  nodeDraftForAdoption,
  type KnowledgeDraftLine,
} from '@/lib/curriculum/knowledge-draft';
import type {
  CurriculumDesignSnapshot,
  CurriculumNodeObjectiveRecord,
} from '@/lib/curriculum/design-types';

/** 与 `design-workbench` 里的 `requestJson` 同一个约定：失败时抛出服务端原话。 */
async function write(url: string, init: RequestInit): Promise<{ node?: { id: string } }> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    node?: { id: string };
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return payload ?? {};
}

export async function adoptKnowledgeDraftLine(input: {
  line: KnowledgeDraftLine;
  /** 作者在"改一改"里写的名字，未改则为空。 */
  edit: string | undefined;
  base: string;
  snapshot: CurriculumDesignSnapshot;
  /**
   * 已经落地的草稿节点真实 id，下标即 `draftIndex`。
   *
   * 由右栏持有而不是这里重算：它是"哪个草稿已经被作者按过"这件事唯一的记录，重算就得
   * 有一份第二状态，而第二状态会过期——过期的端点 id 写出来的边在界面上看不出任何异常。
   */
  adoptedNodeIds: readonly string[];
  /** 采纳成功后刷新左栏。**不经过 `run`**，理由见文件头。 */
  refresh: () => Promise<void>;
}): Promise<string | null> {
  const { line, base, adoptedNodeIds } = input;

  if (line.kind === 'node') {
    const draft = nodeDraftForAdoption(line, input.edit);
    const node = await write(`${base}/nodes`, {
      method: 'POST',
      body: JSON.stringify(draft),
    });
    const created = node.node?.id ?? null;
    if (line.objectiveRefs.length > 0) {
      if (!created) throw new Error('新知识点没有返回 id，无法写入支撑关系');
      // 整表替换：带上当前全部连线，否则别的节点的支撑会被悄悄删掉。
      await write(`${base}/node-objectives`, {
        method: 'PUT',
        body: JSON.stringify({
          links: mergedLinkSet({
            current: input.snapshot.nodeObjectives ?? [],
            line,
            newNodeId: created,
          }),
        }),
      });
    }
    await input.refresh();
    return created;
  }

  if (line.kind === 'patch') {
    await write(`${base}/nodes/${line.nodeId}`, {
      method: 'PATCH',
      body: JSON.stringify(line.patch),
    });
    await input.refresh();
    return null;
  }

  if (line.kind === 'link') {
    const current = (input.snapshot.nodeObjectives ?? []) as CurriculumNodeObjectiveRecord[];
    await write(`${base}/node-objectives`, {
      method: 'PUT',
      body: JSON.stringify({
        links: [
          ...current
            .filter((row) => !(row.nodeId === line.nodeId && row.objectiveId === line.objectiveId))
            .map((row) => ({
              nodeId: row.nodeId,
              objectiveId: row.objectiveId,
              supportLevel: row.supportLevel,
            })),
          {
            nodeId: line.nodeId,
            objectiveId: line.objectiveId,
            supportLevel: line.supportLevel,
          },
        ],
      }),
    });
    await input.refresh();
    return null;
  }

  if (line.kind !== 'edge') {
    // 说明行没有"采纳"这件事；界面不渲染按钮，这里是把类型收窄而不是处理一种真实情况。
    throw new Error('这一行不需要采纳。');
  }
  if (line.kind !== 'edge') {
    // 说明行没有"采纳"这件事；界面不渲染按钮，这里是把类型收窄而不是处理一种真实情况。
    throw new Error('这一行不需要采纳。');
  }
  const endpoints = edgeEndpointsOf(line, { adoptedNodeIds });
  if (!endpoints) {
    // 与右栏灰掉那一行的判定同源；这里再判一次是因为采纳可以被键盘触发到灰掉的按钮上。
    throw new Error('这条先后关系的两端还没都落地，先采纳它依赖的知识点。');
  }
  await write(`${base}/dependencies`, {
    method: 'POST',
    body: JSON.stringify({
      sourceId: endpoints.sourceId,
      targetId: endpoints.targetId,
      sourceKind: 'node',
      targetKind: 'node',
      edgeType: line.edgeType,
      ...(line.note ? { note: line.note } : {}),
    }),
  });
  await input.refresh();
  return null;
}
