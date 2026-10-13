/**
 * 第三步「知识技能图」的草稿：把知识那一步的结果算成**通用引擎**的行。
 *
 * B2 试点里这一套有它自己的 `KnowledgeDraftLine`、`KnowledgeCopilot` 与
 * `adoptKnowledgeDraftLine`——写死了知识技能图的三个概念。加上第二、四、五、六步之后，
 * 同一副"出草稿、逐行签字"的界面就有了五份，而**采纳一行**的语义（多跳、依赖、整表替换
 * 在采纳那一刻重算）是五份里最容易出错、也最不该出错的那部分。所以这里把知识那一步改成
 * **通用引擎的一个使用者**，和其他四步一样。
 *
 * 保留下来的四条知识特有的规则，都写在这一层：
 *
 * 1. **连线不是独立的行，它跟着节点走。** `setCurriculumNodeObjectives` 是整表替换，
 *    所以"只采纳这一条连线"根本不存在这种粒度。只有**给已有节点补连线**才单列成一行。
 *    新节点的连线用 `replaceFromLive`：那是引擎的整表替换能力，而它必须按**采纳那一刻**
 *    的库重算——B2 里那段 `mergedLinkSet` 手工合一次，第二次采纳就会抹掉第一次。
 * 2. **指向草稿节点的边在节点被采纳之前不可采纳。** 边的两端都要是真实 id，所以一条边
 *    依赖两行；而 `needs` 可以有两条，这正是它比单数依赖强的那个地方。
 * 3. **"改一改"只改名字。** 摘要是"这是什么"、难度是"多难"，作者在一个单行输入框里改
 *    不动三处语义，假装能改只会让人改错。名字是唯一必须由人拍板的——后面所有步骤都靠它
 *    寻址这个知识点。
 * 4. **空的摘要与难度整个键都不发。** 这是 B2 的 e2e 逮到的：`readNode` 用 `oneOf` 读
 *    难度，"给了 null"等于"不是合法取值"而 400，"没给"才是不设置。
 */

import { dropNullEnums, nullEnumDroppedWarning, uniqueMessages } from './draft-body';
import {
  assertDraftRouteSafe,
  type StepDraft,
  type StepDraftLine,
  type StepDraftLive,
} from './step-draft';
import type {
  CurriculumLearningNodeRecord,
  CurriculumObjectiveRecord,
  CurriculumSupportLevel,
} from './design-types';
import type {
  KnowledgeNodeDraft,
  KnowledgeNodePatch,
  ResolvedDependency,
} from './design-knowledge';

const BASE = '/api/curriculum/design/tasks';

function taskRoute(taskId: string, ...segments: string[]): string {
  return assertDraftRouteSafe([BASE, taskId, ...segments].join('/'));
}

export interface KnowledgeDraftBoard {
  nodes: readonly CurriculumLearningNodeRecord[];
  objectives: readonly CurriculumObjectiveRecord[];
  nodeObjectives: readonly {
    nodeId: string;
    objectiveId: string;
    supportLevel: CurriculumSupportLevel;
  }[];
}

export interface KnowledgeTurnLike {
  message: string;
  warnings: string[];
  added: KnowledgeNodeDraft[];
  patches: Map<string, Omit<KnowledgeNodePatch, 'ref'>>;
  removed: Set<string>;
  links: {
    nodeId: string;
    objectiveId: string;
    supportLevel: CurriculumSupportLevel;
  }[];
  dependencies: ResolvedDependency[];
  removedDependencies: string[];
  unmatchedRefs: string[];
  rejectedRefs: string[];
}

function short(id: string): string {
  return id.slice(0, 8);
}

/** 改写时哪些键叫什么。只用于"清空这一项没做成"那句话。 */
const PATCH_LABELS: Record<string, string> = {
  name: '名称',
  summary: '摘要',
  difficulty: '难度',
  nodeType: '类型',
};

/** 服务端结果 → 通用引擎的行。 */
export function knowledgeDraftLinesOf(input: {
  turn: KnowledgeTurnLike;
  board: KnowledgeDraftBoard;
  taskId: string;
}): { lines: StepDraftLine[]; live: StepDraftLive; warnings: string[] } {
  const { turn, board } = input;
  const route = (...segments: string[]) => taskRoute(input.taskId, ...segments);
  const nodeNameById = new Map(board.nodes.map((node) => [node.id, node.name]));
  const objectiveTitleById = new Map(
    board.objectives.map((objective) => [objective.id, objective.title]),
  );
  const lines: StepDraftLine[] = [];
  const warnings: string[] = [];

  for (const [nodeId, patch] of turn.patches) {
    const changes: string[] = [];
    if (patch.name !== undefined) {
      changes.push(`名称 ${nodeNameById.get(nodeId) ?? short(nodeId)} → ${patch.name}`);
    }
    // `null` 在这里是模型在说"清空它"。它写不进去（见 `draft-body.ts`），但**意图还是要
    // 照实写出来**——那一行会成功，而这一项不会变，所以这句话必须与下面那条提醒一起读。
    if (patch.summary !== undefined) {
      changes.push(patch.summary === null ? '清空摘要' : `摘要 → ${patch.summary}`);
    }
    if (patch.difficulty !== undefined) {
      changes.push(patch.difficulty === null ? '清空难度' : `难度 → ${patch.difficulty}`);
    }
    if (patch.nodeType !== undefined) changes.push(`类型 → ${patch.nodeType}`);
    const raw: Record<string, unknown> = {};
    if (patch.name !== undefined) raw.name = patch.name;
    if (patch.summary !== undefined) raw.summary = patch.summary;
    if (patch.difficulty !== undefined) raw.difficulty = patch.difficulty;
    if (patch.nodeType !== undefined) raw.nodeType = patch.nodeType;
    // `PATCH /nodes/<id>` 用 `oneOf` 读难度：显式 `null` 报"取值非法"，而不是"清空"。
    const { body, dropped } = dropNullEnums(raw, PATCH_LABELS);
    warnings.push(...nullEnumDroppedWarning(dropped));
    lines.push({
      id: `knowledge:patch-${nodeId}`,
      name: patch.name,
      nameKey: 'name',
      text: `改写知识点「${nodeNameById.get(nodeId) ?? short(nodeId)}」：${changes.join('；')}`,
      write: { method: 'PATCH', route: route('nodes', nodeId), body },
    });
  }

  // `turn.links` 是**这一轮之后的整份集合**：没被提到的节点也被带出来了。把它们全画成行，
  // 作者会看到一屏"AI 建议把已有连线重新挂一遍"，而模型其实什么都没改。
  const beforeLevels = new Map(
    board.nodeObjectives.map((link) => [`${link.nodeId}/${link.objectiveId}`, link.supportLevel]),
  );
  for (const link of turn.links) {
    if (beforeLevels.get(`${link.nodeId}/${link.objectiveId}`) === link.supportLevel) continue;
    lines.push({
      id: `knowledge:link-${link.nodeId}-${link.objectiveId}`,
      text:
        `把「${nodeNameById.get(link.nodeId) ?? short(link.nodeId)}」也挂到目标` +
        `「${objectiveTitleById.get(link.objectiveId) ?? short(link.objectiveId)}」上`,
      write: {
        method: 'PUT',
        route: route('node-objectives'),
        // 给已有节点补连线同样要带上**全部**连线，否则别的节点的支撑被悄悄删掉。
        body: {
          links: replaceOneLink(board.nodeObjectives, link),
        },
      },
    });
  }

  turn.added.forEach((draft, draftIndex) => {
    const refs = draft.objectiveRefs.filter(
      (link): link is typeof link & { objectiveRef: string } => link.objectiveRef !== null,
    );
    const lineId = `knowledge:node-${draftIndex}`;
    const body: Record<string, unknown> = { name: draft.name, nodeType: draft.nodeType };
    // 空的摘要与难度整个键都不发——见文件头第 4 条。
    if (draft.summary !== null) body.summary = draft.summary;
    if (draft.difficulty !== null) body.difficulty = draft.difficulty;
    lines.push({
      id: lineId,
      name: draft.name,
      nameKey: 'name',
      text:
        refs.length === 0
          ? `新建知识点「${draft.name}」，但没挂任何目标`
          : `新建知识点「${draft.name}」，支撑 ${refs
              .map((link) => objectiveTitleById.get(link.objectiveRef) ?? short(link.objectiveRef))
              .join('、')}`,
      detail: draft.summary ?? undefined,
      create: {
        route: route('nodes'),
        body,
        idKey: 'node',
        // 新节点的连线跟着这个节点走，而且必须按**采纳那一刻**的库重算——见文件头第 1 条。
        // 所以用 `replaceFromLive` 而不是 `then`：`then` 的 body 在起草时就定死，而那一刻还
        // 不知道作者会先按哪几行，于是先按的那条新知识点贡献的连线会被后按的这一行抹掉。
        // `thenAfter` 排在新建之后发，`#id` 由执行器替换成刚建出来的真实 id。
        ...(refs.length === 0
          ? {}
          : {
              mergeInto: {
                method: 'PUT' as const,
                route: route('node-objectives'),
                // 并进去的那几条。`#id` 由采纳执行器在**第一跳之后**替换成真实 id。
                rows: refs.map((link) => ({
                  nodeId: FRESH,
                  objectiveId: link.objectiveRef,
                  // 与 `mergeNodeLinks` / `setCurriculumNodeObjectives` 同一个缺省值。
                  supportLevel: link.supportLevel ?? 'primary',
                })),
                source: 'nodeObjectives' as const,
                key: ['nodeId', 'objectiveId'],
                // `parseNodeObjectiveSet` 读的是 `links`，写错就是采纳时 400。
                bodyKey: 'links',
              },
            }),
      },
    });
  });

  for (const edge of turn.dependencies) {
    const key = (endpoint: ResolvedDependency['source']) =>
      endpoint.kind === 'node' ? `node:${endpoint.id}` : `draft:${endpoint.index}`;
    const label = (endpoint: ResolvedDependency['source']) =>
      endpoint.kind === 'node'
        ? (nodeNameById.get(endpoint.id) ?? short(endpoint.id))
        : `新知识点「${turn.added[endpoint.index]?.name ?? short(`draft${endpoint.index}`)}」`;
    const needs = [edge.source, edge.target]
      .filter((endpoint) => endpoint.kind !== 'node')
      .map((endpoint) => ({
        lineId: `knowledge:node-${(endpoint as { index: number }).index}`,
        key: endpoint === edge.source ? 'sourceId' : 'targetId',
        label: label(endpoint),
      }));
    lines.push({
      id: `knowledge:edge-${key(edge.source)}->${key(edge.target)}`,
      text: `先后关系：${label(edge.source)} → ${label(edge.target)}`,
      write: {
        method: 'POST',
        route: route('dependencies'),
        body: {
          // 已经在库里的端点直接写真实 id；指向草稿节点的端点由 `needs` 在采纳那一刻填——
          // 它必须先占位，因为草稿节点落库之前没有 id 可填。
          sourceId: endpointIdOf(edge.source),
          targetId: endpointIdOf(edge.target),
          sourceKind: 'node',
          targetKind: 'node',
          edgeType: edge.edgeType,
          ...(edge.note ? { note: edge.note } : {}),
        },
      },
      ...(needs.length > 0 ? { needs } : {}),
    });
  }

  for (const text of [
    ...(turn.removed.size > 0 ? [`删除 ${turn.removed.size} 个已有知识点`] : []),
    ...turn.removedDependencies.map((id) => `撤回一条先后关系（${short(id)}）`),
    ...turn.unmatchedRefs.map((ref) => `没找到「${ref}」，这一条没写进去`),
    ...turn.rejectedRefs.map((ref) => `没照做：${ref}`),
  ]) {
    lines.push({ id: `knowledge:note-${lines.length}`, text, note: text });
  }

  return { lines, live: { nodeObjectives: board.nodeObjectives, unitCoverage: [] }, warnings };
}

/** 刚建出来的那个知识点的 id。 */
const FRESH = '#id';

/** 端点的真实 id；指向草稿节点的端点用占位，等那一行被采纳后由 `needs` 替换。 */
function endpointIdOf(endpoint: ResolvedDependency['source']): string {
  return endpoint.kind === 'node' ? endpoint.id : FRESH;
}

/** 整表替换：换掉这一条，其余原样。 */
function replaceOneLink(
  current: readonly { nodeId: string; objectiveId: string; supportLevel: string }[],
  link: { nodeId: string; objectiveId: string; supportLevel: string },
) {
  return [
    ...current
      .filter((row) => !(row.nodeId === link.nodeId && row.objectiveId === link.objectiveId))
      .map((row) => ({ ...row })),
    { ...link },
  ];
}

/** 回包那一份"现在库里是什么样"的图。 */
export function knowledgeDraftOf(input: {
  turn: KnowledgeTurnLike;
  board: KnowledgeDraftBoard;
  taskId: string;
  instruction: string;
}): StepDraft {
  const { lines, warnings } = knowledgeDraftLinesOf(input);
  return {
    lines,
    message: input.turn.message,
    // 模型自己说的话在前，引擎这一层"哪一项没写成"在后：前者是建议的来源，后者是对它的
    // 限定，顺序反过来作者会先读到限定而不知道它在限定什么。
    warnings: uniqueMessages([...input.turn.warnings, ...warnings]),
    instruction: input.instruction,
  };
}
