/**
 * 大纲解析器：把作者手里那份文本变成「章 → 节 → 目」。
 *
 * 这里的失败模式是**静默丢内容**：解析器少认一行，导入仍然成功，只是少了一个目，
 * 而用户要到很久以后发现某一目不存在。所以每个拒绝条件都单独钉一条，而不是只
 * 测"正常文本能解析出来"。
 */
import { describe, expect, it } from 'vitest';

import { parseOutlineText } from '@/lib/curriculum/outline-import';

const SAMPLE = `# CTF 基础与工具环境
## CTF 入门与赛制
- 1-1-1 | CTF概述与竞赛形式 | 理论 | 1 | CTF起源、flag格式
- 1-1-2 | 竞赛平台与提交实操 | 实操 | 1 | 平台注册、题目下载
## Linux 与网络基础
- Linux 基础与权限 | 理论 | 1`;

describe('parseOutlineText', () => {
  it('解析章节目，并保留编号、类型、学时、内容要点', () => {
    const result = parseOutlineText(SAMPLE);
    expect(result.issues).toEqual([]);
    expect(result.stats).toEqual({ chapters: 1, sections: 2, items: 3 });
    const chapter = result.chapters[0]!;
    expect(chapter.code).toBe('1');
    expect(chapter.title).toBe('CTF 基础与工具环境');
    const [first, second] = chapter.sections;
    expect(first!.code).toBe('1-1');
    expect(first!.items[0]).toMatchObject({
      code: '1-1-1',
      title: 'CTF概述与竞赛形式',
      kind: 'theory',
      hours: 1,
      note: 'CTF起源、flag格式',
    });
    // 第二节的目没写编号/学时/要点：编号自动续，其余保持 null 而不是猜。
    expect(second!.items[0]).toMatchObject({
      code: '1-2-1',
      title: 'Linux 基础与权限',
      kind: 'theory',
      hours: 1,
      note: null,
    });
  });

  it('章节编号按出现顺序自动生成', () => {
    const result = parseOutlineText('# 一\n## 一节\n# 二\n## 二节');
    expect(result.issues).toEqual([]);
    expect(result.chapters.map((chapter) => chapter.code)).toEqual(['1', '2']);
    expect(result.chapters[1]!.sections[0]!.code).toBe('2-1');
  });

  it('全角竖线与英文类型都认', () => {
    const result = parseOutlineText('# 章\n## 节\n- 标题｜practice｜2｜要点');
    expect(result.issues).toEqual([]);
    expect(result.chapters[0]!.sections[0]!.items[0]).toMatchObject({
      title: '标题',
      kind: 'practice',
      hours: 2,
      note: '要点',
    });
  });

  it('注释、空行与表格分隔线被跳过', () => {
    const result = parseOutlineText(
      ['// 注释', '<!-- 也算注释 -->', '---', '', '# 章', '## 节', '- 目'].join('\n'),
    );
    expect(result.issues).toEqual([]);
    expect(result.stats.items).toBe(1);
  });

  it('目前面没有节时报错并给出正确行号', () => {
    const result = parseOutlineText('# 章\n- 孤立的目');
    expect(result.chapters).toHaveLength(1);
    expect(result.issues).toEqual([{ line: 2, message: '目前面还没有节：先用 `## 节名` 写一行' }]);
  });

  it('节前面没有章时报错', () => {
    const result = parseOutlineText('## 节');
    expect(result.issues[0]).toMatchObject({ line: 1 });
    expect(result.issues[0]!.message).toContain('节前面还没有章');
  });

  it('编号重复被拒绝，并指出第一次出现在第几行', () => {
    const result = parseOutlineText(['# 章', '## 节', '- 1-1-1 | 甲', '- 1-1-1 | 乙'].join('\n'));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('重复');
    expect(result.issues[0]!.message).toContain('第 3 行');
    // 第二行没有被塞进树里：编号重复的目只保留第一条。
    expect(result.chapters[0]!.sections[0]!.items).toHaveLength(1);
  });

  it('认不出的类型被拒绝，而不是静默当成 null', () => {
    const result = parseOutlineText('# 章\n## 节\n- 标题 | 讲演 | 1');
    expect(result.issues[0]!.message).toContain('类型「讲演」认不出');
  });

  it('负数学时被拒绝', () => {
    const result = parseOutlineText('# 章\n## 节\n- 标题 | 理论 | -1');
    expect(result.issues[0]!.message).toContain('学时');
  });

  it('认不出的行会让预览报错，而不是被丢掉', () => {
    const result = parseOutlineText('# 章\n## 节\n随便一行');
    expect(result.issues[0]!.message).toContain('认不出这一行');
  });

  it('只写章和节也能解析（骨架先行）', () => {
    const result = parseOutlineText('# 章\n## 节一\n## 节二');
    expect(result.issues).toEqual([]);
    expect(result.stats).toEqual({ chapters: 1, sections: 2, items: 0 });
  });

  it('重复的编号在章/节/目之间共享同一个唯一空间', () => {
    // 章 `1` 与目 `1` 不能同时存在：系列的编号是用户核对的依据，混用会读不出层级。
    const result = parseOutlineText(['# 章', '## 节', '- 1 | 目'].join('\n'));
    expect(result.issues[0]!.message).toContain('重复');
  });
});
