/**
 * 系列知识体系的「候选清单」生成：依据第二步的课程目标，一次给出一批可挑的知识 /
 * 技能点，由用户勾选后走 PATCH。
 *
 * 为什么依据是目标而不是方向：知识体系是**课程目标的支撑**。只按方向写，得到的
 * 是一张泛泛的目录；按目标写，每个点都能回答"它支撑哪条承诺"。这也是第 3 步排在
 * 第 2 步之后的原因——没有目标时这个入口在界面上是灰的，接口也回 409。
 *
 * 和第二步的候选一样：只生成、不落库。解析层只要求每个候选自身成套（名字、类型、
 * 难度），先修用名字引用；采用时再解析成 id，并丢掉指向未勾选候选的引用。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  formatSeriesDirection,
  parseSeriesKnowledgeCandidatesAnswer,
  screenNodeCandidates,
  seriesNodeDifficultyLabel,
  seriesNodeTypeLabel,
  seriesObjectiveTypeLabel,
  SeriesKnowledgeCandidatesInvalidError,
  SERIES_KNOWLEDGE_CANDIDATES_MIN,
  type SeriesDesignDirection,
  type SeriesDesignDoc,
  type SeriesKnowledgeCandidate,
} from '@/lib/curriculum/series-design';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

export interface SeriesKnowledgeDraftInput {
  /** 系列名称与说明，原样进提示词。 */
  seriesName: string;
  seriesDescription: string | null;
  /** 方向：决定从哪一档难度起步、哪些范围不要碰。 */
  direction: SeriesDesignDirection;
  /** 已有设计：目标是生成的依据，已有节点避免重复、也可被先修引用。 */
  existing: SeriesDesignDoc;
  model: StepLanguageModel;
}

export async function draftSeriesKnowledgeCandidates(
  input: SeriesKnowledgeDraftInput,
  ctx: StepContext,
): Promise<SeriesKnowledgeCandidate[]> {
  // 目标为空时不该调用模型：没有可支撑的承诺，生成的只是一张泛泛的目录。
  // 路由层已经用 409 挡过一次；这里再挡一次，避免调用方绕过路由。
  if (input.existing.objectives.length === 0) {
    throw new SeriesKnowledgeCandidatesInvalidError(
      '还没有课程目标：知识体系要支撑它们，先把第 2 步定下来',
    );
  }

  const variables = {
    seriesInfo: [
      `名称：${input.seriesName}`,
      input.seriesDescription ? `说明：${input.seriesDescription}` : '说明：（未填写）',
    ].join('\n'),
    // 空方向不要留成一片空白：模型会以为"没写"和"没这个字段"是一回事。
    directionText: formatSeriesDirection(input.direction),
    objectivesText: objectivesText(input.existing),
    existingNodes: existingNodesText(input.existing),
  };
  const prompts = buildPrompt(PROMPT_IDS.COURSE_SERIES_KNOWLEDGE, variables);
  if (!prompts) throw new Error('找不到系列知识体系提示词模板：course-series-knowledge');

  ctx.log.info(
    `Series knowledge candidates: ${input.seriesName} ` +
      `[objectives=${input.existing.objectives.length} / existing=${input.existing.nodes.length}]`,
  );

  // 提示词里已经要求"不要重复已有节点"，但模型不照做时不能让重复项占满清单：
  // 筛选放在校验里，可用候选太少会触发一次重试。
  const usable = (text: string): SeriesKnowledgeCandidate[] => {
    const parsed = parseSeriesKnowledgeCandidatesAnswer(text);
    const screened = screenNodeCandidates(parsed, input.existing.nodes);
    if (screened.length < SERIES_KNOWLEDGE_CANDIDATES_MIN) {
      throw new SeriesKnowledgeCandidatesInvalidError(
        `筛掉与已有节点重复的条目后只剩 ${screened.length} 个候选（至少 ${SERIES_KNOWLEDGE_CANDIDATES_MIN} 个）`,
      );
    }
    return screened;
  };

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-series-knowledge',
    {
      // 坏 JSON / 候选太少几乎都是模型抖动；重试一次比让用户重新点一次便宜。
      retries: 1,
      validate: (text: string) => {
        try {
          usable(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  try {
    return usable(result.text);
  } catch (error) {
    if (error instanceof SeriesKnowledgeCandidatesInvalidError) {
      throw new SeriesKnowledgeCandidatesInvalidError(`模型回答不可用：${error.message}`);
    }
    throw error;
  }
}

/** 目标清单：标题 + 类型 + 可观察行为 + 证明方式，够模型判断"这个点支撑哪条目标"。 */
function objectivesText(doc: SeriesDesignDoc): string {
  if (doc.objectives.length === 0) return '（还没有课程目标）';
  return doc.objectives
    .map((objective) =>
      [
        `- [${seriesObjectiveTypeLabel(objective.type)}] ${objective.title}`,
        `  能做什么：${objective.expectedBehavior || '（没写可观察行为）'}`,
        objective.evidence ? `  怎么证明：${objective.evidence}` : '',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    )
    .join('\n');
}

/** 已有节点：名字 + 类型 + 难度 + 摘要 + 先修（先修按名字给，模型才能继续引用）。 */
function existingNodesText(doc: SeriesDesignDoc): string {
  if (doc.nodes.length === 0) return '（还没有知识 / 技能点）';
  const names = new Map(doc.nodes.map((node) => [node.id, node.name]));
  return doc.nodes
    .map((node) => {
      const prerequisites = node.prerequisites
        .map((id) => names.get(id) ?? id)
        .filter(Boolean)
        .join('、');
      return `- ${node.name}（${seriesNodeTypeLabel(node.type)}，${seriesNodeDifficultyLabel(
        node.difficulty,
      )}）${node.summary ? `：${node.summary}` : ''}${
        prerequisites ? `；先修：${prerequisites}` : ''
      }`;
    })
    .join('\n');
}
