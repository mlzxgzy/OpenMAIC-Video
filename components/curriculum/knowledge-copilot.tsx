'use client';

/**
 * 第三步右栏的 AI 副驾：**出草稿、逐行签字**，不替作者改任何东西。
 *
 * 骨架是一条硬规则：**左边是决定，右边是建议；右边写的每一样都要人在左边再确认一次。**
 * 所以这个面板没有任何一个按钮能改库——它只有"让 AI 起草"和"丢掉草稿"，行上的采纳
 * 由调用方用**已经存在的**手工路由去写（`/nodes`、`/nodes/[id]`、`/node-objectives`、
 * `/dependencies`）。这不是多此一举：那些路由里有阶段校验、端点归属校验和"整表替换
 * 链接"的那条规则，让草稿走它们，采纳和手工编辑就是**同一件事**，也就没有"AI 那条路
 * 少了一层校验"这种差异要记得。
 *
 * 三个刻意的决定：
 *
 * 1. **模型说的话不叫"建议"，叫草稿；每一行都是一条可点的行，不是一段散文。** 一段
 *    散文没法逐行同意，而"整段一起接受"就是这次要取消的那个按钮。
 * 2. **灰掉的行必须写为什么。** 指向草稿节点的先后关系在那个节点被采纳前按不了，
 *    因为它写不进去——`createCurriculumDependency` 会因为端点不存在而拒。理由由
 *    `lineAvailability` 给，这个组件只负责显示，不自己判断。
 * 3. **失败的起草不吞。** 起草失败就把服务端原话显示出来，并保留那句话，因为"AI 什么
 *    都没说"和"AI 说了一句你没看懂的话"要能被分开。
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  describeKnowledgeLine,
  knowledgeLineBlockedBy,
  knowledgeLineId,
  lineAvailability,
  type KnowledgeDraft,
  type KnowledgeDraftLine,
  type KnowledgeDraftLineStatus,
} from '@/lib/curriculum/knowledge-draft';
import { draftKnowledge } from '@/lib/curriculum/knowledge-client';
import type {
  CurriculumLearningNodeRecord,
  CurriculumObjectiveRecord,
} from '@/lib/curriculum/design-types';
import { knowledgeDraftOf } from '@/lib/curriculum/knowledge-draft';

/** 与 `draft?.lines ?? []` 同一个理由：一个稳定的空引用。 */
const EMPTY_LINES: readonly KnowledgeDraftLine[] = [];

interface KnowledgeCopilotProps {
  taskId: string;
  /** 库里的当前图，右栏画"来源"时用，也是起草请求之前的真相。 */
  nodes: readonly CurriculumLearningNodeRecord[];
  objectives: readonly CurriculumObjectiveRecord[];
  /**
   * 采纳一行：走手工写入路由，写完刷新左栏。新节点返回它的真实 id。
   *
   * `adoptedNodeIds` 传进来而不是让调用方自己存——"哪些草稿节点已经落地了"只有右栏知道
   * （它决定哪一行可按），而写一条边时又必须用它来把 `draft:<n>` 换成真实 id。两份副本
   * 一定会有一份是旧的，而过期的端点 id 写出来的边，界面看不出任何异常。
   */
  onAdopt: (
    line: KnowledgeDraftLine,
    edit: string | undefined,
    adoptedNodeIds: readonly string[],
  ) => Promise<string | null>;
  /** 有任何一行被采纳过：调用方据此提示"确认"按钮该亮了。 */
  onDraftTouched: () => void;
}

/** 一个具体、可执行的起草指令示例，而不是"你想让它做什么？"的开放式提问。 */
const EXAMPLES = [
  '这一目要讲「目录扫描」和「指纹识别」，各自依赖什么？按已确认的学习目标补齐知识点。',
  '把已经列出的知识点按「先学哪个」排出先后关系，并说明理由。',
  '有一个目标到现在还没有任何知识点支撑，请补上。',
];

export function KnowledgeCopilot({
  taskId,
  nodes,
  objectives,
  onAdopt,
  onDraftTouched,
}: KnowledgeCopilotProps) {
  const [draft, setDraft] = useState<KnowledgeDraft | null>(null);
  const [statuses, setStatuses] = useState<Record<string, KnowledgeDraftLineStatus>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [adoptedNodeIds, setAdoptedNodeIds] = useState<string[]>([]);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<'draft' | 'adopt' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const draftIt = useCallback(async () => {
    const text = instruction.trim();
    if (text === '' || busy) return;
    setBusy('draft');
    setError(null);
    setNotice(null);
    try {
      const payload = await draftKnowledge({ taskId, instruction: text });
      setDraft(
        knowledgeDraftOf({
          turn: {
            message: payload.message,
            warnings: payload.warnings ?? [],
            added: payload.added,
            patches: new Map(payload.patches.map((row) => [row.nodeId, row.patch])),
            removed: new Set(payload.removed),
            links: payload.links,
            dependencies: payload.dependencies,
            removedDependencies: payload.removedDependencies,
            unmatchedRefs: payload.unmatchedRefs,
            rejectedRefs: payload.rejectedRefs,
          },
          instruction: text,
          currentLinks: payload.currentLinks,
          nodeNameById: new Map(Object.entries(payload.nodeNameById)),
          objectiveTitleById: new Map(Object.entries(payload.objectiveTitleById)),
        }),
      );
      // 重新起草就是重新开始：旧草稿的行 id 与新草稿的不是一回事，留着旧的采纳记录
      // 会把"这一行按过了"套到另一行上。
      setStatuses({});
      setEdits({});
      setAdoptedNodeIds([]);
      onDraftTouched();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '起草失败');
    } finally {
      setBusy(null);
    }
  }, [busy, instruction, onDraftTouched, taskId]);

  const decide = useCallback((lineId: string, status: KnowledgeDraftLineStatus) => {
    setStatuses((current) => ({ ...current, [lineId]: status }));
    setNotice(null);
  }, []);

  const adopt = useCallback(
    async (line: KnowledgeDraftLine, lineId: string) => {
      setBusy('adopt');
      setError(null);
      setNotice(null);
      try {
        const nodeId = await onAdopt(line, edits[lineId], adoptedNodeIds);
        if (line.kind === 'node') {
          // 边能不能采纳只关心"那个草稿节点落地了没有"，所以这里记的是"有"这件事，
          // 而真实 id 已经被左栏拿去写连线了——右栏自己不需要保存它。
          setAdoptedNodeIds((current) => {
            const next = [...current];
            next[line.draftIndex] = nodeId ?? 'adopted';
            return next;
          });
        }
        decide(lineId, 'adopted');
        setNotice('已采纳这一行，左栏已经改好。');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '采纳失败');
      } finally {
        setBusy(null);
      }
    },
    [adoptedNodeIds, decide, edits, onAdopt],
  );

  // `EMPTY_LINES` 而不是 `?? []`：空数组字面量每次渲染都是新引用，会让下面这个
  // `useMemo` 的依赖在每一帧都变，于是它算出同样的答案而下游以为它变了。
  const lines = draft?.lines ?? EMPTY_LINES;
  const pending = useMemo(
    () =>
      lines.filter((line, index) => statuses[knowledgeLineId(line, index)] === undefined).length,
    [lines, statuses],
  );

  return (
    <div className="flex flex-col gap-3" aria-label="AI 草稿">
      <div className="flex flex-col gap-2">
        <Textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="说一句你要它起草什么，例如：这一目要讲目录扫描，它依赖什么？"
          rows={3}
          aria-label="给 AI 的起草指令"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => void draftIt()}
            disabled={busy !== null || instruction.trim() === ''}
          >
            {busy === 'draft' ? <Loader2 className="animate-spin" /> : <Sparkles />}让 AI 起草
          </Button>
          {draft ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(null);
                setStatuses({});
                setEdits({});
                setAdoptedNodeIds([]);
                setNotice(null);
              }}
              disabled={busy !== null}
            >
              <RotateCcw />
              丢掉这份草稿
            </Button>
          ) : null}
        </div>
        {!draft && instruction.trim() === '' ? (
          <ul className="text-muted-foreground flex flex-col gap-1 text-[11px]">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => setInstruction(example)}
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {error ? (
        <p className="text-destructive flex items-start gap-1 text-[11px]" role="alert">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-[11px]">{notice}</p> : null}

      {draft ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-[11px]">
            按「{draft.instruction}」起草。草稿一行都不写进库；你按哪一行，它才改哪一行。
            {pending > 0 ? `还有 ${pending} 行等你决定。` : '这一份已经逐行处理完。'}
          </p>
          {draft.message ? <p className="text-[11px]">{draft.message}</p> : null}
          {draft.warnings.length > 0 ? (
            <ul className="text-muted-foreground flex flex-col gap-0.5 text-[11px]">
              {draft.warnings.map((warning) => (
                <li key={warning}>⚠ {warning}</li>
              ))}
            </ul>
          ) : null}
          <ul className="flex flex-col gap-1.5">
            {lines.map((line, index) => {
              const lineId = knowledgeLineId(line, index);
              const { availability, reason } = lineAvailability(
                line,
                { statuses, adoptedNodeIds },
                lineId,
              );
              const blockers = knowledgeLineBlockedBy(line, lines, knowledgeLineId);
              return (
                <DraftLine
                  key={lineId}
                  line={line}
                  lineId={lineId}
                  availability={availability}
                  reason={reason}
                  status={statuses[lineId]}
                  edit={edits[lineId]}
                  blockedBy={blockers}
                  busy={busy === 'adopt'}
                  onEdit={(value) => setEdits((current) => ({ ...current, [lineId]: value }))}
                  onAdopt={() => void adopt(line, lineId)}
                  onDrop={() => decide(lineId, 'dropped')}
                  onRestore={() => decide(lineId, 'pending')}
                />
              );
            })}
          </ul>
        </div>
      ) : null}

      {nodes.length === 0 ? (
        <p className="text-muted-foreground text-[11px]">
          现在图上还没有知识点。让 AI 起草可以给你一份草稿。
        </p>
      ) : (
        <p className="text-muted-foreground text-[11px]">
          图上现有 {nodes.length} 个知识点、{objectives.length}{' '}
          个目标；草稿只会动其中明确提到的那几个。
        </p>
      )}
    </div>
  );
}

function DraftLine({
  line,
  lineId,
  availability,
  reason,
  status,
  edit,
  blockedBy,
  busy,
  onEdit,
  onAdopt,
  onDrop,
  onRestore,
}: {
  line: KnowledgeDraftLine;
  lineId: string;
  availability: 'ready' | 'waiting' | 'done';
  reason: string;
  status: KnowledgeDraftLineStatus | undefined;
  edit: string | undefined;
  blockedBy: string[];
  busy: boolean;
  onEdit: (value: string) => void;
  onAdopt: () => void;
  onDrop: () => void;
  onRestore: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const isNote = line.kind === 'drop';

  return (
    <li className="border-border flex flex-col gap-1.5 rounded-lg border p-2" data-line-id={lineId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 flex-1 text-[11px]">
          {isNote ? (
            <span className="text-muted-foreground">{describeKnowledgeLine(line)}</span>
          ) : (
            <span className="block break-words">{describeKnowledgeLine(line)}</span>
          )}
        </span>
        {status === 'adopted' ? (
          <Badge variant="outline" className="gap-1 px-1 py-0 text-[10px]">
            <Check className="size-3" />
            已采纳
          </Badge>
        ) : status === 'dropped' ? (
          <Badge variant="outline" className="gap-1 px-1 py-0 text-[10px]">
            <X className="size-3" />
            已丢弃
          </Badge>
        ) : null}
      </div>

      {line.kind === 'node' ? (
        <>
          {line.summary ? (
            <p className="text-muted-foreground text-[11px]">{line.summary}</p>
          ) : null}
          {editing ? (
            <Input
              value={edit ?? line.name}
              onChange={(event) => onEdit(event.target.value)}
              aria-label="改一改这个知识点的名称"
            />
          ) : null}
          <span className="text-muted-foreground text-[10px]">
            来源：AI 起草；改名称只影响这行的名字，摘要与难度保持它的判断
          </span>
        </>
      ) : null}

      {!isNote && status !== 'adopted' && status !== 'dropped' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            onClick={onAdopt}
            disabled={busy || availability !== 'ready'}
            title={reason || '按这一行写入左栏'}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Check />}
            采纳
          </Button>
          {line.kind === 'node' ? (
            <Button size="xs" variant="outline" onClick={() => setEditing((v) => !v)}>
              改一改
            </Button>
          ) : null}
          <Button size="xs" variant="outline" onClick={onDrop}>
            丢弃
          </Button>
        </div>
      ) : null}

      {status === 'dropped' ? (
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={onRestore}>
            撤销丢弃
          </Button>
        </div>
      ) : null}

      {availability === 'waiting' ? (
        <p className="text-muted-foreground text-[10px]" title={blockedBy.join(',')}>
          ⓘ {reason}
        </p>
      ) : null}
    </li>
  );
}
