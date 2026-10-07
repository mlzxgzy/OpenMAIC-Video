'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  GraduationCap,
  Loader2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { buildProgramCoverage } from '@/lib/curriculum/program';
import {
  CURRICULUM_PROGRAM_COURSE_CATEGORIES,
  CURRICULUM_PROGRAM_STATUSES,
  type CurriculumGraduationIndicatorRecord,
  type CurriculumProgramCourseCategory,
  type CurriculumProgramCourseRecord,
  type CurriculumProgramRecord,
  type CurriculumProgramStatus,
  type CurriculumProgramVersionRecord,
  type CurriculumSnapshot,
} from '@/lib/curriculum/types';

interface ProgramPlanPanelProps {
  snapshot: CurriculumSnapshot;
  onChanged: () => Promise<void> | void;
}

const CATEGORY_LABELS: Record<CurriculumProgramCourseCategory, string> = {
  required: '必修',
  elective: '选修',
  practice: '实践',
  general: '通识',
};

const STATUS_LABELS: Record<CurriculumProgramStatus, string> = {
  draft: '草稿',
  active: '启用',
  archived: '归档',
};

const INDICATOR_STATUS_LABELS = {
  missing: '空缺',
  weak: '偏弱',
  covered: '已达标',
} as const;

function statusClass(status: 'missing' | 'weak' | 'covered'): string {
  if (status === 'covered') return 'text-emerald-700';
  if (status === 'weak') return 'text-amber-700';
  return 'text-destructive';
}

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

export function ProgramPlanPanel({ snapshot, onChanged }: ProgramPlanPanelProps) {
  const [programId, setProgramId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [programForm, setProgramForm] = useState({ name: '', code: '', description: '' });
  const [versionForm, setVersionForm] = useState({
    name: '',
    version: '',
    gradeYear: '',
    targetCredits: '',
    status: 'draft' as CurriculumProgramStatus,
  });
  const [indicatorForm, setIndicatorForm] = useState({
    code: '',
    title: '',
    targetWeight: '3',
    sortOrder: '0',
  });
  const [courseForm, setCourseForm] = useState({
    courseId: '',
    title: '',
    semester: '',
    category: 'required' as CurriculumProgramCourseCategory,
    credits: '',
    hours: '',
    sortOrder: '0',
  });
  const [selectedProgramCourseId, setSelectedProgramCourseId] = useState('');
  const [supportDraft, setSupportDraft] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const programs = snapshot.programs;
  const versions = useMemo(
    () => snapshot.programVersions.filter((version) => version.programId === programId),
    [programId, snapshot.programVersions],
  );
  const indicators = useMemo(
    () =>
      snapshot.graduationIndicators
        .filter((indicator) => indicator.programVersionId === versionId)
        .sort(
          (left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code),
        ),
    [snapshot.graduationIndicators, versionId],
  );
  const programCourses = useMemo(
    () =>
      snapshot.programCourses
        .filter((course) => course.programVersionId === versionId)
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder || left.title.localeCompare(right.title),
        ),
    [snapshot.programCourses, versionId],
  );
  const selectedProgramCourse = useMemo(
    () => programCourses.find((course) => course.id === selectedProgramCourseId) ?? null,
    [programCourses, selectedProgramCourseId],
  );

  useEffect(() => {
    if (!programId && programs[0]) setProgramId(programs[0].id);
  }, [programId, programs]);

  useEffect(() => {
    if (!programId) return;
    setVersionId((current) =>
      versions.some((version) => version.id === current) ? current : (versions[0]?.id ?? ''),
    );
  }, [programId, versions]);

  useEffect(() => {
    setSelectedProgramCourseId((current) =>
      programCourses.some((course) => course.id === current)
        ? current
        : (programCourses[0]?.id ?? ''),
    );
  }, [programCourses]);

  useEffect(() => {
    if (!selectedProgramCourseId) {
      setSupportDraft({});
      return;
    }
    const current = snapshot.courseIndicatorSupports.filter(
      (support) => support.programCourseId === selectedProgramCourseId,
    );
    setSupportDraft(
      Object.fromEntries(current.map((support) => [support.indicatorId, support.weight])),
    );
  }, [selectedProgramCourseId, snapshot.courseIndicatorSupports]);

  const coverage = useMemo(
    () =>
      versionId
        ? buildProgramCoverage({
            programVersionId: versionId,
            programs: snapshot.programs,
            programVersions: snapshot.programVersions,
            graduationIndicators: snapshot.graduationIndicators,
            programCourses: snapshot.programCourses,
            courseIndicatorSupports: snapshot.courseIndicatorSupports,
            courses: snapshot.courses,
            knowledgePoints: snapshot.knowledgePoints,
            courseKnowledgePoints: snapshot.courseKnowledgePoints,
          })
        : null,
    [snapshot, versionId],
  );

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const createProgram = () =>
    run('program', async () => {
      if (!programForm.name.trim()) return;
      await requestJson('/api/curriculum/programs', {
        method: 'POST',
        body: JSON.stringify({
          name: programForm.name.trim(),
          code: programForm.code.trim() || null,
          description: programForm.description.trim() || null,
        }),
      });
      setProgramForm({ name: '', code: '', description: '' });
      setNotice('培养方案已创建/复用。');
    });

  const createVersion = () =>
    run('version', async () => {
      if (!programId || !versionForm.name.trim()) return;
      await requestJson('/api/curriculum/program-versions', {
        method: 'POST',
        body: JSON.stringify({
          programId,
          name: versionForm.name.trim(),
          version: versionForm.version.trim() || null,
          gradeYear: versionForm.gradeYear.trim() || null,
          status: versionForm.status,
          targetCredits:
            versionForm.targetCredits.trim() === '' ? null : Number(versionForm.targetCredits),
        }),
      });
      setVersionForm({ name: '', version: '', gradeYear: '', targetCredits: '', status: 'draft' });
      setNotice('培养方案版本已创建。');
    });

  const createIndicator = () =>
    run('indicator', async () => {
      if (!versionId || !indicatorForm.code.trim() || !indicatorForm.title.trim()) return;
      await requestJson('/api/curriculum/indicators', {
        method: 'POST',
        body: JSON.stringify({
          programVersionId: versionId,
          code: indicatorForm.code.trim(),
          title: indicatorForm.title.trim(),
          targetWeight: Number(indicatorForm.targetWeight) || 3,
          sortOrder: Number(indicatorForm.sortOrder) || 0,
        }),
      });
      setIndicatorForm({ code: '', title: '', targetWeight: '3', sortOrder: '0' });
      setNotice('指标点已创建。');
    });

  const addProgramCourse = () =>
    run('program-course', async () => {
      if (!versionId) return;
      const selectedCourse = snapshot.courses.find((course) => course.id === courseForm.courseId);
      const title = courseForm.title.trim() || selectedCourse?.title || '';
      if (!title) return;
      await requestJson('/api/curriculum/program-courses', {
        method: 'POST',
        body: JSON.stringify({
          programVersionId: versionId,
          courseId: courseForm.courseId || null,
          title,
          semester: courseForm.semester.trim() || null,
          category: courseForm.category,
          credits: courseForm.credits.trim() === '' ? null : Number(courseForm.credits),
          hours: courseForm.hours.trim() === '' ? null : Number(courseForm.hours),
          sortOrder: Number(courseForm.sortOrder) || 0,
        }),
      });
      setCourseForm({
        courseId: '',
        title: '',
        semester: '',
        category: 'required',
        credits: '',
        hours: '',
        sortOrder: '0',
      });
      setNotice('计划课程已加入培养方案。');
    });

  const remove = (kind: string, url: string, confirmText: string) =>
    run(`delete-${kind}`, async () => {
      if (!window.confirm(confirmText)) return;
      await requestJson(url, { method: 'DELETE' });
      setNotice('已删除。');
    });

  const saveSupports = () =>
    run('supports', async () => {
      if (!selectedProgramCourseId) return;
      const supports = Object.entries(supportDraft)
        .filter(([, weight]) => weight > 0)
        .map(([indicatorId, weight]) => ({ indicatorId, weight }));
      await requestJson(`/api/curriculum/program-courses/${selectedProgramCourseId}/supports`, {
        method: 'PUT',
        body: JSON.stringify({ supports }),
      });
      setNotice('指标点支撑矩阵已保存。');
    });

  const selectedCourse = snapshot.courses.find((course) => course.id === courseForm.courseId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GraduationCap className="size-4" />
          培养方案与指标点矩阵
        </CardTitle>
        <CardDescription>
          管理专业培养方案版本、毕业要求指标点和课程支撑矩阵；覆盖率、空缺和知识点冗余由服务端同一份快照计算。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="border-border flex flex-col gap-3 rounded-lg border p-3">
            <div className="text-sm font-medium">1. 培养方案</div>
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={programId}
              onChange={(event) => setProgramId(event.target.value)}
            >
              <option value="">选择培养方案</option>
              {programs.map((program: CurriculumProgramRecord) => (
                <option key={program.id} value={program.id}>
                  {program.code ? `${program.code} · ` : ''}
                  {program.name}
                </option>
              ))}
            </select>
            <Input
              placeholder="培养方案名称 *"
              value={programForm.name}
              onChange={(event) => setProgramForm({ ...programForm, name: event.target.value })}
            />
            <Input
              placeholder="编号/专业代码"
              value={programForm.code}
              onChange={(event) => setProgramForm({ ...programForm, code: event.target.value })}
            />
            <Textarea
              className="min-h-16"
              placeholder="说明"
              value={programForm.description}
              onChange={(event) =>
                setProgramForm({ ...programForm, description: event.target.value })
              }
            />
            <Button
              onClick={() => void createProgram()}
              disabled={busy !== null || !programForm.name.trim()}
            >
              {busy === 'program' ? <Loader2 className="animate-spin" /> : <Plus />}
              新建/复用培养方案
            </Button>
          </div>

          <div className="border-border flex flex-col gap-3 rounded-lg border p-3">
            <div className="text-sm font-medium">2. 培养方案版本</div>
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={versionId}
              onChange={(event) => setVersionId(event.target.value)}
              disabled={!programId}
            >
              <option value="">选择版本</option>
              {versions.map((version: CurriculumProgramVersionRecord) => (
                <option key={version.id} value={version.id}>
                  {version.name}
                  {version.version ? ` · ${version.version}` : ''}
                  {version.gradeYear ? ` · ${version.gradeYear}` : ''}
                </option>
              ))}
            </select>
            <Input
              placeholder="版本名称，例如 2026版 *"
              value={versionForm.name}
              onChange={(event) => setVersionForm({ ...versionForm, name: event.target.value })}
              disabled={!programId}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="版本号"
                value={versionForm.version}
                onChange={(event) =>
                  setVersionForm({ ...versionForm, version: event.target.value })
                }
              />
              <Input
                placeholder="年级"
                value={versionForm.gradeYear}
                onChange={(event) =>
                  setVersionForm({ ...versionForm, gradeYear: event.target.value })
                }
              />
              <Input
                type="number"
                placeholder="目标学分"
                value={versionForm.targetCredits}
                onChange={(event) =>
                  setVersionForm({ ...versionForm, targetCredits: event.target.value })
                }
              />
              <select
                className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                value={versionForm.status}
                onChange={(event) =>
                  setVersionForm({
                    ...versionForm,
                    status: event.target.value as CurriculumProgramStatus,
                  })
                }
              >
                {CURRICULUM_PROGRAM_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <Button
              onClick={() => void createVersion()}
              disabled={busy !== null || !programId || !versionForm.name.trim()}
            >
              {busy === 'version' ? <Loader2 className="animate-spin" /> : <Plus />}
              新建方案版本
            </Button>
          </div>

          <div className="border-border flex flex-col gap-3 rounded-lg border p-3">
            <div className="text-sm font-medium">3. 指标点</div>
            <Input
              placeholder="指标点编号，例如 1.1 *"
              value={indicatorForm.code}
              onChange={(event) => setIndicatorForm({ ...indicatorForm, code: event.target.value })}
              disabled={!versionId}
            />
            <Input
              placeholder="指标点描述 *"
              value={indicatorForm.title}
              onChange={(event) =>
                setIndicatorForm({ ...indicatorForm, title: event.target.value })
              }
              disabled={!versionId}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                min={1}
                max={10}
                placeholder="目标支撑权重"
                value={indicatorForm.targetWeight}
                onChange={(event) =>
                  setIndicatorForm({ ...indicatorForm, targetWeight: event.target.value })
                }
              />
              <Input
                type="number"
                placeholder="排序"
                value={indicatorForm.sortOrder}
                onChange={(event) =>
                  setIndicatorForm({ ...indicatorForm, sortOrder: event.target.value })
                }
              />
            </div>
            <Button
              onClick={() => void createIndicator()}
              disabled={
                busy !== null ||
                !versionId ||
                !indicatorForm.code.trim() ||
                !indicatorForm.title.trim()
              }
            >
              {busy === 'indicator' ? <Loader2 className="animate-spin" /> : <Plus />}
              新建指标点
            </Button>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium">4. 计划课程与学期</div>
            <div className="grid gap-2 md:grid-cols-2">
              <select
                className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                value={courseForm.courseId}
                onChange={(event) =>
                  setCourseForm({
                    ...courseForm,
                    courseId: event.target.value,
                    title:
                      snapshot.courses.find((course) => course.id === event.target.value)?.title ??
                      '',
                  })
                }
                disabled={!versionId}
              >
                <option value="">仅建计划占位（暂不关联课程）</option>
                {snapshot.courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.code ? `${course.code} · ` : ''}
                    {course.title}
                  </option>
                ))}
              </select>
              <Input
                placeholder={selectedCourse ? '标题默认同课程，可覆盖' : '计划课程标题 *'}
                value={courseForm.title}
                onChange={(event) => setCourseForm({ ...courseForm, title: event.target.value })}
                disabled={!versionId}
              />
              <Input
                placeholder="学期，例如 2026春"
                value={courseForm.semester}
                onChange={(event) => setCourseForm({ ...courseForm, semester: event.target.value })}
              />
              <select
                className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                value={courseForm.category}
                onChange={(event) =>
                  setCourseForm({
                    ...courseForm,
                    category: event.target.value as CurriculumProgramCourseCategory,
                  })
                }
              >
                {CURRICULUM_PROGRAM_COURSE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {CATEGORY_LABELS[category]}
                  </option>
                ))}
              </select>
              <Input
                type="number"
                placeholder="学分"
                value={courseForm.credits}
                onChange={(event) => setCourseForm({ ...courseForm, credits: event.target.value })}
              />
              <Input
                type="number"
                placeholder="学时"
                value={courseForm.hours}
                onChange={(event) => setCourseForm({ ...courseForm, hours: event.target.value })}
              />
              <Input
                type="number"
                placeholder="排序"
                value={courseForm.sortOrder}
                onChange={(event) =>
                  setCourseForm({ ...courseForm, sortOrder: event.target.value })
                }
              />
            </div>
            <Button
              onClick={() => void addProgramCourse()}
              disabled={
                busy !== null || !versionId || (!courseForm.title.trim() && !selectedCourse)
              }
            >
              {busy === 'program-course' ? <Loader2 className="animate-spin" /> : <Plus />}
              加入计划课程
            </Button>

            <div className="flex max-h-[360px] flex-col gap-2 overflow-auto pr-1">
              {programCourses.map((programCourse: CurriculumProgramCourseRecord) => (
                <div
                  key={programCourse.id}
                  className="border-border flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <button
                    type="button"
                    className="text-left"
                    onClick={() => setSelectedProgramCourseId(programCourse.id)}
                  >
                    <div className="font-medium">
                      {programCourse.courseId ? '🔗 ' : '○ '}
                      {programCourse.title}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {[programCourse.semester, CATEGORY_LABELS[programCourse.category]]
                        .filter(Boolean)
                        .join(' · ')}
                      {programCourse.credits !== null ? ` · ${programCourse.credits} 学分` : ''}
                      {!programCourse.courseId ? ' · 未关联课程' : ''}
                    </div>
                  </button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() =>
                      void remove(
                        programCourse.id,
                        `/api/curriculum/program-courses/${programCourse.id}`,
                        `从培养方案移除“${programCourse.title}”？`,
                      )
                    }
                    disabled={busy !== null}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              {programCourses.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">尚无计划课程</p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium">5. 指标点支撑矩阵</div>
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={selectedProgramCourseId}
              onChange={(event) => setSelectedProgramCourseId(event.target.value)}
            >
              <option value="">选择计划课程</option>
              {programCourses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.title}
                </option>
              ))}
            </select>
            {selectedProgramCourse && indicators.length > 0 ? (
              <div className="flex max-h-[300px] flex-col gap-2 overflow-auto pr-1">
                {indicators.map((indicator: CurriculumGraduationIndicatorRecord) => {
                  const weight = supportDraft[indicator.id] ?? 0;
                  return (
                    <label
                      key={indicator.id}
                      className="border-border flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={weight > 0}
                          onChange={(event) =>
                            setSupportDraft((current) => {
                              const next = { ...current };
                              if (event.target.checked)
                                next[indicator.id] = next[indicator.id] || 1;
                              else delete next[indicator.id];
                              return next;
                            })
                          }
                        />
                        <span>
                          {indicator.code} · {indicator.title}
                        </span>
                      </span>
                      {weight > 0 ? (
                        <select
                          className="border-input h-8 rounded-md border bg-transparent px-2 text-xs"
                          value={weight}
                          onChange={(event) =>
                            setSupportDraft((current) => ({
                              ...current,
                              [indicator.id]: Number(event.target.value),
                            }))
                          }
                        >
                          {[1, 2, 3, 4, 5].map((value) => (
                            <option key={value} value={value}>
                              权重 {value}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground py-6 text-center text-sm">
                {indicators.length === 0 ? '先创建指标点' : '选择一门计划课程'}
              </p>
            )}
            <Button
              onClick={() => void saveSupports()}
              disabled={busy !== null || !selectedProgramCourseId || indicators.length === 0}
            >
              {busy === 'supports' ? <Loader2 className="animate-spin" /> : <Save />}
              保存支撑矩阵
            </Button>

            {indicators.length > 0 ? (
              <div className="flex flex-col gap-2">
                {indicators.map((indicator) => (
                  <div
                    key={indicator.id}
                    className="border-border flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
                  >
                    <span>
                      {indicator.code} · {indicator.title} · 目标 {indicator.targetWeight}
                    </span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() =>
                        void remove(
                          indicator.id,
                          `/api/curriculum/indicators/${indicator.id}`,
                          `删除指标点“${indicator.code}”？`,
                        )
                      }
                      disabled={busy !== null}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {coverage ? (
          <div className="border-border rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  覆盖分析：{coverage.programName} / {coverage.versionName}
                </div>
                <div className="text-muted-foreground text-xs">
                  计划课程 {coverage.summary.linkedCourseCount}/
                  {coverage.summary.plannedCourseCount} 已关联 · 学分{' '}
                  {coverage.summary.assignedCredits}
                  {coverage.summary.targetCredits !== null
                    ? `/${coverage.summary.targetCredits}`
                    : ''}
                  {coverage.summary.creditCoverageRate !== null
                    ? ` (${Math.round(coverage.summary.creditCoverageRate * 100)}%)`
                    : ''}
                </div>
              </div>
              <div className="flex gap-2 text-xs">
                {coverage.summary.missingIndicatorCount > 0 ? (
                  <span className="flex items-center gap-1 text-destructive">
                    <AlertTriangle className="size-3.5" />
                    {coverage.summary.missingIndicatorCount} 个指标空缺
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-emerald-700">
                    <CheckCircle2 className="size-3.5" />
                    指标无空缺
                  </span>
                )}
                {coverage.summary.uncoveredKnowledgePointCount > 0 ? (
                  <span className="text-amber-700">
                    {coverage.summary.uncoveredKnowledgePointCount} 个知识点空缺
                  </span>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {coverage.indicators.map((indicator) => (
                <div
                  key={indicator.indicatorId}
                  className="border-border rounded-md border p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {indicator.code} · {indicator.title}
                    </span>
                    <span className={statusClass(indicator.status)}>
                      {INDICATOR_STATUS_LABELS[indicator.status]}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-1">
                    支撑权重 {indicator.supportWeight}/{indicator.targetWeight}
                    {indicator.gapWeight > 0 ? ` · 缺 ${indicator.gapWeight}` : ''}
                  </div>
                  <div className="text-muted-foreground mt-1">
                    {indicator.supports.length > 0
                      ? indicator.supports
                          .map((support) => `${support.courseTitle}(${support.weight})`)
                          .join('、')
                      : '暂无课程支撑'}
                  </div>
                </div>
              ))}
              {coverage.indicators.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-sm">尚无指标点</p>
              ) : null}
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="border-border rounded-md border p-3 text-xs">
                <div className="font-medium text-amber-700">空缺</div>
                <div className="text-muted-foreground mt-1">
                  计划课程未关联：{coverage.summary.unlinkedCourseCount} 门
                </div>
                <div className="text-muted-foreground mt-1">
                  未覆盖知识点：
                  {coverage.uncoveredKnowledgePoints.length > 0
                    ? coverage.uncoveredKnowledgePoints.map((point) => point.name).join('、')
                    : '无'}
                </div>
              </div>
              <div className="border-border rounded-md border p-3 text-xs">
                <div className="font-medium text-amber-700">冗余/待复核</div>
                <div className="text-muted-foreground mt-1">
                  开课超过 3 次的知识点：
                  {coverage.redundantKnowledgePoints.length > 0
                    ? coverage.redundantKnowledgePoints
                        .map((point) => `${point.name}(${point.coverageCount})`)
                        .join('、')
                    : '无'}
                </div>
                <div className="text-muted-foreground mt-1">
                  重复关联课程：{coverage.summary.duplicateCourseIds.length} 门
                </div>
                <div className="text-muted-foreground mt-1">
                  无指标支撑课程：{coverage.summary.coursesWithoutIndicatorIds.length} 门
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground py-4 text-center text-sm">
            选择或新建一个培养方案版本后查看覆盖分析
          </p>
        )}
      </CardContent>
    </Card>
  );
}
