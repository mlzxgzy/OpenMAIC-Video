/**
 * 一次性对账：把目工作台那次 run 产出的 stage 写回条目。
 *
 * 背景（走查发现）：设计条目的生成走 `units/[unitId]/generate`，run 的 input 带
 * `curriculumUnitId`，但 generation hook 只把 stage 写回 `curriculum_course` /
 * `curriculum_generation_job` / batch item——**没有任何路径写 `curriculum_unit.stage_id`**。
 * 于是目工作台刷新后条目仍显示未出片（overview 的 producedCount 也数不到它），
 * 「打开课堂 / 导出 MP4」消失。面板靠 `unit.stageId ?? run.stageId` 撑着，页面一关
 * 链路就断。本脚本按 run input 里的 curriculumUnitId 把 stage 补写回去，
 * 作为走查后的数据修复；真正的修法是把这条写回补进 generation hook（见走查报告）。
 *
 * 运行：node scripts/verification/ux-produce-reconcile.mjs --run=<runId>
 */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = ''] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

// DATABASE_URL 与服务端同一来源（.env.local）
const env = readFileSync('.env.local', 'utf8');
const url = (env.match(/^DATABASE_URL=(.*)$/m) ?? [])[1]?.trim().replace(/^["']|["']$/g, '');
if (!url) {
  console.error('DATABASE_URL 未找到');
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

const runId = args.get('run');
if (!runId) {
  console.error('用法: --run=<runId>');
  process.exit(1);
}

const { rows } = await client.query(
  `SELECT input->>'curriculumUnitId' AS unit_id, stage_id, state FROM generation_runs WHERE id = $1`,
  [runId],
);
const run = rows[0];
if (!run) {
  console.error(`run ${runId} 不存在`);
  process.exit(1);
}
console.log(`run state=${run.state} stage=${run.stage_id} unit=${run.unit_id}`);
if (!run.stage_id || !run.unit_id) {
  console.error('run 没有 stage 或 unit id，无需对账');
  process.exit(1);
}

const updated = await client.query(
  `UPDATE curriculum_unit SET stage_id = $3, updated_at = now()
    WHERE owner_id = (SELECT owner_id FROM generation_runs WHERE id = $1)
      AND id = $2
   RETURNING id, task_id`,
  [runId, run.unit_id, run.stage_id],
);
if (updated.rows[0]) {
  console.log(
    `已写回: unit=${updated.rows[0].id} task=${updated.rows[0].task_id} stage=${run.stage_id}`,
  );
} else {
  console.log('没有匹配的条目（可能已写过）');
}
await client.end();
