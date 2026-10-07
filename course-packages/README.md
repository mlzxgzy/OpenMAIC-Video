# 课程包（Course Packages）

课程包是《CTF 综合实战》的“目级”配置。一个课程包对应一个 OpenMAIC 课程、一个视频，以及该目的理论题和可选的 Docker 实操。

## 目录结构

```text
course-packages/
  ctf/
    1-1-1.json
    1-1-2.json
    ...
```

当前已落地的目：

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| `1-1-1` | CTF概述与竞赛形式 | 已生成、已配音、已导出 MP4 |
| `1-1-2` | CTF常见赛事与竞赛平台 | 已生成、已配音 |
| `1-1-3` | CTF学习路径与常用工具 | 已生成、已配音 |

编号规则：

```text
1-1-1
章节目
```

- `1`：第一章
- `1`：第一节
- `1`：目1

## 字段说明

| 字段 | 说明 |
|---|---|
| `code` | 目编号，例如 `1-1-1` |
| `chapter` / `section` / `title` | 章、节、目标题；章、节只用于分类 |
| `type` | `theory` / `practical` / `comprehensive` |
| `hours` | 学时，默认 1 |
| `objectives` | 学习目标 |
| `generation` | 生成 OpenMAIC 课程的参数 |
| `slideOutline` | 视频的 slide 页面结构 |
| `theory` | 理论题数量与标签 |
| `lab` | Docker 实操配置；纯理论目为 `null` |

`generation` 会被 `scripts/start-lesson-generation.mjs` 转成
`POST /api/generation-runs` 的请求体：

```json
{
  "sceneTypes": ["slide"],
  "interactive": false,
  "taskEngine": false,
  "outlineReview": "auto"
}
```

这里固定只生成 slide，不生成 code、interactive、PBL 场景。

## 启动生成

推荐正式生成时固定 owner 和课程库 folder，避免 54 个目散落到不同匿名空间：

```bash
node scripts/start-lesson-generation.mjs \
  --package course-packages/ctf/1-1-1.json \
  --base-url http://localhost:3000 \
  --anonymous-id <anonymous_id cookie 的 UUID> \
  --folder "CTF综合实战"
```

参数说明：

- `--anonymous-id`：浏览器 `anonymous_id` cookie 的 UUID v4，也接受 `anon:<uuid>`。不传则服务端每次新建匿名 owner。
- `--folder`：按名称查找或创建课程库文件夹，生成完成后把 stage 挂进去。
- `--folder-id`：直接使用已有 folder id，和 `--folder` 二选一。
- `--no-wait`：只启动、不等待；此时不知道 stageId，不会自动挂 folder。

只看最终请求体，不真正启动：

```bash
node scripts/start-lesson-generation.mjs \
  --package course-packages/ctf/1-1-1.json \
  --dry-run
```

只启动、不等待：

```bash
node scripts/start-lesson-generation.mjs \
  --package course-packages/ctf/1-1-1.json \
  --no-wait
```

## 生成链路

```text
课程包 JSON
  → generation.requirement
  → POST /api/generation-runs
  → OpenMAIC 生成 slide 课程
  → stageId
  → 导出视频
  → 绑定理论题
  → 如有 lab，绑定 Docker 实操
```

## 视频配音

导出有声音的视频必须配置真实 TTS provider。浏览器原生 TTS 会导出静音视频，不能用于正式课程。
