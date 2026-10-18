/**
 * 七步的标签表，钉在阶段机上。
 *
 * `ui-labels.ts` 现在把"第几步"拆成两个字段（`STEP_NUMBER` 数字、`STEP_NAME` 名字），
 * 由界面自己排版——步骤条要一个大圆圈里的 `3`，卡片角标要 `第 3 步`，二者必须来自同一个
 * 数字。拆字段买到的是排版自由，代价是**可能对不上**：序号手写错一格、名字少写一个阶段、
 * 两个阶段写成同一个名字，类型全绿，界面上只是某一步看起来有点怪。
 *
 * 所以这里把三件事重新算一遍：
 *
 * 1. 序号必须是 `CURRICULUM_DESIGN_PHASES` 的 1..7（不重不漏），否则步骤条上的
 *    "第 N 步 / 共 7 步"和 `next-item.ts` 里"卡在第 N 步"的理由会互相矛盾。
 * 2. 每一张标签表都必须恰好覆盖七个阶段——缺一个键是 `Record` 类型会挡住的，但
 *    多一个键（阶段改名后留下的残骸）不会。
 * 3. `STEP_LABEL` 必须真的是 `STEP_NAME` 前面加序号，而不是抄下来的第二份文案。
 * 4. 源码里不许再出现"旧阶段名 + 阶段"（`依赖图阶段`、`大纲阶段`…）或把阶段字面量插进
 *    中文引号（`「${phase}」`）——这是那场事故的**形状**，不是某一句文案。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRICULUM_DESIGN_PHASE_ORDER } from '@/lib/curriculum/design-editing';
import { CURRICULUM_DESIGN_PHASES } from '@/lib/curriculum/design-types';
import {
  PHASE_DOT_STATE,
  PHASE_STATE_LABEL,
  STEP_DONE_LABEL,
  STEP_LABEL,
  STEP_NAME,
  STEP_NUMBER,
} from '@/lib/curriculum/ui-labels';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];

describe('七步标签', () => {
  it('阶段顺序与阶段机一致', () => {
    expect(CURRICULUM_DESIGN_PHASE_ORDER).toEqual([...CURRICULUM_DESIGN_PHASES]);
  });

  it('序号是 1..7，且与阶段顺序一致', () => {
    expect(CURRICULUM_DESIGN_PHASE_ORDER.map((phase) => STEP_NUMBER[phase])).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('每一张表都恰好覆盖七个阶段，没有残骸', () => {
    const phases = [...CURRICULUM_DESIGN_PHASES].sort();
    for (const table of [STEP_NUMBER, STEP_NAME, STEP_LABEL, STEP_DONE_LABEL, PHASE_STATE_LABEL]) {
      expect(Object.keys(table).sort()).toEqual(phases);
    }
  });

  it('名字各不相同，而且不是空的', () => {
    const names = CURRICULUM_DESIGN_PHASE_ORDER.map((phase) => STEP_NAME[phase]);
    expect(names.every((name) => name.trim().length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('STEP_LABEL 是"序号 + 名字"拼出来的，不是第二份文案', () => {
    for (const phase of CURRICULUM_DESIGN_PHASES) {
      expect(STEP_LABEL[phase]).toBe(`${CIRCLED[STEP_NUMBER[phase] - 1]} ${STEP_NAME[phase]}`);
    }
  });

  it('三种点位状态都有用户语言', () => {
    expect(Object.values(PHASE_DOT_STATE).every((label) => label.trim().length > 0)).toBe(true);
  });
});

/**
 * 事故的形状，写成规则。
 *
 * 截图里那一步有四个名字：卡片写「知识技能与依赖」、空态写「依赖图阶段」、正文写「学习
 * 成果阶段」、红字写「`outcomes` 阶段」。四个都不是打字错误——它们是四份各自维护的文案，
 * 所以只要还有第二份，就一定有第四个名字。这条用例不检查"某一句改好没有"，检查的是
 * **还有没有第二份**：
 *
 * - `进入X阶段`：步骤引用必须走 {@link stepRef}，序号和名字一起出现，否则用户对不上步骤条。
 * - `旧名词 + 阶段`：`依赖图`、`大纲`这些词是内部/历史叫法，加个"阶段"就冒充成了步骤名。
 * - `「${…phase…}」`：把阶段字面量插进中文引号，直接把 `outcomes` 摆在用户面前。
 *
 * 注释行不算：注释里写"离开 task 阶段"是在解释阶段机，用户看不到。扫描面是三个会渲染
 * 文案的目录（`components/`、`app/`、`lib/`），跳过 `.next` 与测试目录。
 */
describe('步骤引用的唯一写法', () => {
  const ROOTS = ['components', 'app', 'lib'];
  const RULES: { pattern: RegExp; why: string }[] = [
    { pattern: /进入[^」\n]{0,8}阶段/, why: '改用 stepRef()：序号与名字必须一起出现' },
    {
      pattern: /(学习成果|依赖图|知识技能图|教学设计|评价设计|审核与导出|大纲)阶段/,
      why: '旧阶段名不是步骤名，用 STEP_WORK_NAME',
    },
    { pattern: /「\$\{[^}]*[Pp]hase[^}]*\}」/, why: '阶段字面量不许摆在中文引号里' },
  ];

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
    return out;
  }

  const isComment = (line: string) => /^\s*(\*|\/\/|\/\*|\{\/\*)/.test(line);

  it('源码里没有第二份步骤名（旧阶段名 / 阶段字面量）', () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (isComment(line)) return;
          for (const { pattern, why } of RULES) {
            if (pattern.test(line)) violations.push(`${file}:${index + 1} ${why} — ${line.trim()}`);
          }
        });
      }
    }
    // 例外只有一个：标签表自己拼 stepRef 的那一行。
    const real = violations.filter((v) => !v.startsWith('lib/curriculum/ui-labels.ts:'));
    expect(real).toEqual([]);
  });

  it('步骤引用真的走的是 stepRef，而不是又抄了一遍名字', () => {
    // 确认按钮、提示语、门禁理由、服务端 409 —— 这五类地方每一处都在拼步骤名。
    const callers = [
      'components/curriculum/design-knowledge-signoff.tsx',
      'components/curriculum/design-outcomes-signoff.tsx',
      'components/curriculum/design-outline-signoff.tsx',
      'components/curriculum/design-teaching-signoff.tsx',
      'components/curriculum/design-assessment-signoff.tsx',
      'components/curriculum/design-direction-card.tsx',
      'lib/server/curriculum/step-draft-route.ts',
      'lib/server/curriculum/design-store.ts',
    ];
    for (const file of callers) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} 应当用 stepRef/stepLockMessage 拼步骤引用`).toMatch(
        /step(Ref|LockMessage)\(/,
      );
    }
  });
});
