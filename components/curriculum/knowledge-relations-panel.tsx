'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, GitBranch, Loader2, Plus, Save, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { buildCurriculumCoverage } from '@/lib/curriculum/coverage';
import {
  KNOWLEDGE_POINT_RELATION_TYPES,
  type CourseKnowledgePointRecord,
  type CurriculumCourseRecord,
  type KnowledgePointRecord,
  type KnowledgePointRelationRecord,
  type KnowledgePointRelationType,
} from '@/lib/curriculum/types';

interface KnowledgeRelationsPanelProps {
  seriesId: string;
  courses: CurriculumCourseRecord[];
  knowledgePoints: KnowledgePointRecord[];
  knowledgePointRelations: KnowledgePointRelationRecord[];
  courseKnowledgePoints: CourseKnowledgePointRecord[];
  onChanged: () => Promise<void> | void;
}

const RELATION_LABELS: Record<KnowledgePointRelationType, string> = {
  prerequisite: '先修',
  'follow-up': '后继',
  contains: '包含',
  related: '相关',
};

const COVERAGE_LABELS = {
  introduced: '引入',
  practiced: '练习',
  mastered: '掌握',
} as const;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    [key: string]: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return payload as T;
}

export function KnowledgeRelationsPanel({
  seriesId,
  courses,
  knowledgePoints,
  knowledgePointRelations,
  courseKnowledgePoints,
  onChanged,
}: KnowledgeRelationsPanelProps) {
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [relationType, setRelationType] = useState<KnowledgePointRelationType>('prerequisite');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visibleCourses = useMemo(
    () => (seriesId ? courses.filter((course) => course.seriesId === seriesId) : courses),
    [courses, seriesId],
  );
  const visiblePoints = useMemo(
    () =>
      seriesId ? knowledgePoints.filter((point) => point.seriesId === seriesId) : knowledgePoints,
    [knowledgePoints, seriesId],
  );
  const visiblePointIds = useMemo(
    () => new Set(visiblePoints.map((point) => point.id)),
    [visiblePoints],
  );
  const visibleRelations = useMemo(
    () =>
      knowledgePointRelations.filter(
        (relation) =>
          visiblePointIds.has(relation.sourceKnowledgePointId) &&
          visiblePointIds.has(relation.targetKnowledgePointId),
      ),
    [knowledgePointRelations, visiblePointIds],
  );

  const pointById = useMemo(
    () => new Map(visiblePoints.map((point) => [point.id, point])),
    [visiblePoints],
  );

  /**
   * Why the create button is closed, in words.
   *
   * Only the reasons a person can act on are named here — a missing end and the
   * same point at both ends. `busy` is deliberately not one of them: it clears
   * itself the moment the request returns, so a sentence about it would flicker.
   */
  const relationRefusal = useMemo(() => {
    if (!sourceId || !targetId) return null;
    if (sourceId !== targetId) return null;
    const point = pointById.get(sourceId);
    const label = point ? `${point.code ? `${point.code} · ` : ''}${point.name}` : '同一个知识点';
    return `关系的两端现在都是「${label}」。先修、后继、包含、相关都描述两个知识点之间的关系，请把其中一端换成另一个知识点。`;
  }, [pointById, sourceId, targetId]);

  const courseById = useMemo(
    () => new Map(visibleCourses.map((course) => [course.id, course])),
    [visibleCourses],
  );

  const coverage = useMemo(
    () =>
      buildCurriculumCoverage({
        courses: visibleCourses,
        knowledgePoints: visiblePoints,
        courseKnowledgePoints,
        seriesId: null,
      }),
    [courseKnowledgePoints, visibleCourses, visiblePoints],
  );
  const coverageByPoint = useMemo(
    () => new Map(coverage.knowledgePoints.map((item) => [item.knowledgePointId, item])),
    [coverage.knowledgePoints],
  );

  const createRelation = async () => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    setBusy('relation');
    setError(null);
    try {
      await requestJson('/api/curriculum/knowledge-point-relations', {
        method: 'POST',
        body: JSON.stringify({
          sourceKnowledgePointId: sourceId,
          targetKnowledgePointId: targetId,
          relationType,
          note: note.trim() || null,
        }),
      });
      setNote('');
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const deleteRelation = async (relation: KnowledgePointRelationRecord) => {
    setBusy(`relation-${relation.id}`);
    setError(null);
    try {
      await requestJson(`/api/curriculum/knowledge-point-relations/${relation.id}`, {
        method: 'DELETE',
      });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-4" />
          知识点关系与覆盖分析
        </CardTitle>
        <CardDescription>
          维护知识点之间的先修、后继、包含、相关关系，并查看每个知识点被课程覆盖的情况。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <div className="flex flex-col gap-4">
          <div className="grid gap-2 md:grid-cols-2">
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              <option value="">源知识点</option>
              {visiblePoints.map((point) => (
                <option key={point.id} value={point.id}>
                  {point.code ? `${point.code} · ` : ''}
                  {point.name}
                </option>
              ))}
            </select>
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">目标知识点</option>
              {visiblePoints.map((point) => (
                <option key={point.id} value={point.id}>
                  {point.code ? `${point.code} · ` : ''}
                  {point.name}
                </option>
              ))}
            </select>
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={relationType}
              onChange={(event) =>
                setRelationType(event.target.value as KnowledgePointRelationType)
              }
            >
              {KNOWLEDGE_POINT_RELATION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {RELATION_LABELS[type]}
                </option>
              ))}
            </select>
            <Input
              placeholder="备注（可选）"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <Button
            onClick={() => void createRelation()}
            disabled={busy !== null || !sourceId || !targetId || sourceId === targetId}
          >
            {busy === 'relation' ? <Loader2 className="animate-spin" /> : <Plus />}
            新建/更新知识点关系
          </Button>
          {/*
            A disabled button is not an explanation. Picking the same point on
            both sides is an easy mistake — the two selects look alike and both
            list every point — so it is named here rather than left to be
            guessed at. Same reasoning as the phase gates in the design
            workbench, which also state the reason as visible text.
          */}
          {relationRefusal ? (
            <p className="text-muted-foreground text-xs">{relationRefusal}</p>
          ) : null}

          <div className="flex flex-col gap-2">
            {visibleRelations.map((relation) => (
              <div
                key={relation.id}
                className="border-border flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <div>
                  <div className="font-medium">
                    {pointById.get(relation.sourceKnowledgePointId)?.name ?? '未知知识点'}
                    {' → '}
                    {RELATION_LABELS[relation.relationType]}
                    {' → '}
                    {pointById.get(relation.targetKnowledgePointId)?.name ?? '未知知识点'}
                  </div>
                  {relation.note ? (
                    <div className="text-muted-foreground mt-1 text-xs">{relation.note}</div>
                  ) : null}
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => void deleteRelation(relation)}
                  disabled={busy !== null}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {visibleRelations.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                当前系列还没有知识点关系
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">覆盖分析</div>
              <div className="text-muted-foreground text-xs">
                当前系列：{coverage.coveredKnowledgePointCount}/{coverage.totalKnowledgePointCount}{' '}
                个知识点至少被一门课程覆盖
              </div>
            </div>
            {coverage.uncoveredKnowledgePointIds.length > 0 ? (
              <span className="flex items-center gap-1 text-xs text-amber-600">
                <AlertTriangle className="size-3.5" />
                {coverage.uncoveredKnowledgePointIds.length} 个空缺
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <CheckCircle2 className="size-3.5" />
                已全部覆盖
              </span>
            )}
          </div>

          <div className="flex max-h-[520px] flex-col gap-2 overflow-auto pr-1">
            {visiblePoints.map((point) => {
              const item = coverageByPoint.get(point.id);
              const covered = item ? item.coverageCount > 0 : false;
              const highest = item?.highestCoverageLevel;
              return (
                <div
                  key={point.id}
                  className={`rounded-md border px-3 py-2 text-sm ${
                    covered ? 'border-border' : 'border-amber-500/40 bg-amber-500/5'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-medium">
                      {point.code ? `${point.code} · ` : ''}
                      {point.name}
                    </div>
                    <span
                      className={`shrink-0 text-xs ${
                        covered ? 'text-muted-foreground' : 'text-amber-600'
                      }`}
                    >
                      {covered && highest ? COVERAGE_LABELS[highest] : '未覆盖'}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-1 flex flex-wrap gap-1 text-xs">
                    {item && item.courseIds.length > 0 ? (
                      item.courseIds.map((courseId) => (
                        <span key={courseId} className="bg-muted rounded px-1.5 py-0.5">
                          {courseById.get(courseId)?.title ?? courseId}
                        </span>
                      ))
                    ) : (
                      <span>还没有课程绑定这个知识点</span>
                    )}
                  </div>
                </div>
              );
            })}
            {visiblePoints.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                先创建知识点，再看覆盖分析
              </p>
            ) : null}
          </div>

          <Button variant="outline" disabled={busy !== null} onClick={() => void onChanged()}>
            {busy !== null ? <Loader2 className="animate-spin" /> : <Save />}
            刷新覆盖分析
          </Button>
        </div>
      </CardContent>
      {error ? <CardContent className="text-sm text-destructive">{error}</CardContent> : null}
    </Card>
  );
}
