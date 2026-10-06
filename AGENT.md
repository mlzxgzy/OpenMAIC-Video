# AGENT.md — OpenMAIC-Video 二开上下文

> 本文件是**给 AI Agent / 新加入的开发者**看的项目上下文。
> 目标：让接手的人（或模型）在 5 分钟内搞清楚「这是谁、我们在哪、要改哪里、哪些线不能碰」。
> 事实来源：仓库代码与官方文档（`packages/docs/content/docs/`），均带文件路径与行号，可直接跳转核对。

---

## 1. 仓库身份

| 项 | 值 |
| --- | --- |
| 上游项目 | [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) — 清华 MAIC 团队的 AI 互动课堂平台 |
| 本仓库 | `git@github.com:mlzxgzy/OpenMAIC-Video.git`（fork） |
| 当前基线 | `v1.2.0-rc.1`，commit `636fab0d`（"release: OpenMAIC 1.2.0-rc.1 (server-first)"） |
| 许可证 | MIT（可自由商用）。例外：`packages/mathml2omml` 为 LGPL-3.0-or-later |
| 二开方向 | **视频化**：视频导出 / 渲染服务 / 视频生成能力 |
| 代码状态 | 二开已开始：AGENT.md（二开上下文）、CHANGELOG.fork.md（二开变更记录）、首页「场景类型」筛选（L4）、大纲 AI 修改（L4）、课堂讲稿逐句编辑 + 独立重新生成语音面板（L4） |
| 变更记录 | 二开自己的改动写 [`CHANGELOG.fork.md`](./CHANGELOG.fork.md)；上游变更仍看 `CHANGELOG.md` |

### 1.1 与上游的关系（重要）

- 本仓库**没有配置 `upstream` 远端**，只有 `origin`。想跟上游同步必须先自己加：
  ```bash
  git remote add upstream https://github.com/THU-MAIC/OpenMAIC.git
  git fetch upstream
  ```
- 跟上游的差异**原则上只集中在视频相关目录**，便于日后 rebase：
  `lib/video-export/`、`lib/video-export-app/`、`lib/store/video-render.ts`、`app/api/export-video/`、`render-service/`、`components/stage/video-export-dialog.tsx`
  - **已有例外**：首页「场景类型」筛选是课程生成功能（非视频链路），落在 L4
    （`app/page.tsx`、`components/generation/`、`lib/server/generation/` 等）。
    L4 本就是「改生成流水线、场景类型、UI」的既定层，宿主扩展钩子（§6）覆盖不到，
    所以这是有意为之的偏离。同步上游时的冲突热点与后续动作记在
    [`CHANGELOG.fork.md`](./CHANGELOG.fork.md#与上游的差异)。
  - 后续再有非视频方向的功能，照此先在 `CHANGELOG.fork.md` 记录偏离理由再动手。
- **v1.2.0 是破坏性大版本**（"server-first"）。课程生成从浏览器驱动改为服务端常驻进程，模型配置统一到 `openmaic.yml`，**不再支持 Vercel 等 Serverless 部署**，必须 PostgreSQL + 常驻 Node。追上游时不要把 1.1.x 的部署写法照搬过来。

---

## 2. 环境与命令

**前置**：Node `>=22.19`、pnpm `>=10`、PostgreSQL 16（视频导出另需 Docker）。

```bash
pnpm install          # postinstall 会自动 build:packages
pnpm db:up            # Docker 起开发用 PG（127.0.0.1:5432，独立 compose project openmaic-dev-db）
cp .env.example .env.local          # 至少填 OPENAI_API_KEY + DATABASE_URL
cp openmaic.example.yml openmaic.yml  # 服务端模型配置（1.2.0 新增）
pnpm dev              # http://localhost:3000

# 视频导出（可选 profile）
docker compose --profile video-export up --build
```

**验证与检查**

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm test` | vitest，`tests/**/*.test.ts`，约 915 个测试文件 |
| `pnpm test:e2e` | playwright，`e2e/tests`，27 个 spec，仅 chromium，baseURL `localhost:3002` |
| `pnpm build:packages` | **改了 `packages/@openmaic/*` 源码后必须手动跑** |
| `pnpm lint` / `pnpm check` | eslint / prettier |
| `pnpm check:i18n-keys` | 界面文案改动后必跑（支持 12 种语言/区域） |

> ⚠️ `postinstall` 只在装依赖时构建包。改了 `packages/@openmaic/*` 而没跑 `build:packages`，根应用会吃旧的 `dist`，症状是"我改了但没生效"。

`render-service/` 是**独立的 npm 工程**（有自己的 `package-lock.json`，不用 pnpm），测试单独跑 `cd render-service && npm test`。

---

## 3. 二开策略：分五层，能往上层就别往下层

改东西之前先确认你要动的是哪一层。**从轻到重**：

| 层 | 手段 | 适用场景 | 代价 |
| --- | --- | --- | --- |
| L1 配置 | `openmaic.yml` 的 `providers` / `slots` / `lock` / `allowUserKeys` | 换模型、锁模型、禁用户自带 Key | 零代码 |
| L2 宿主钩子 | `lib/server/persistence-hooks/`，在 `instrumentation.ts` 注册 | 接 SSO/自有账号、按课程库过滤、资产落自有存储 | 少量胶水代码 |
| L3 SDK | `packages/@openmaic/{dsl,generation,renderer,storage,editor,importer}` | 自建应用、换存储后端、复用生成流水线 | 中等，**改完必须 `build:packages`** |
| L4 应用代码 | `lib/` `app/` `components/` | 改生成流水线、场景类型、UI | 较大，需跟上游同步 |
| L5 渲染服务 | `render-service/`（独立容器） | 改渲染算法、并发、隔离策略 | 最大，独立版本管理 |

**视频化二开的默认落点是 L4 + L5**：浏览器侧（L4）构建自包含项目，渲染服务（L5）出 MP4。**在 L4/L5 之间传递的是 ZIP 与状态查询，不要试图在两侧共享状态。**

---

## 4. 视频链路现状（视频化二开的主战场）

### 4.1 端到端调用链

```
[UI] components/stage/video-export-dialog.tsx:124
      │  弹窗 open 时探测能力
      ▼
GET /api/export-video/capability ──► app/api/export-video/capability/route.ts:14
      │                                └─► lib/server/render-service.ts:53  (探 GET /health，3s 超时)
      │                                   ★ 服务 URL 绝不返回给客户端
      ▼
[浏览器构建 ZIP]  lib/video-export/emit-hyperframes/index.ts  (产出 index.html + manifest + 字幕)
      │            lib/video-export-app/build-export-zip.ts:6
      ▼
POST /api/export-video/render  (FormData: project=zip blob + fps/quality/format)
      │  lib/store/video-render.ts:269-282
      ▼
app/api/export-video/render/route.ts   ← BFF：不解析 multipart，流式转发上游 (duplex:'half')，上限 300MB
      ▼
render-service/src/main.ts:266  POST /render
      ▼
GET /api/export-video/render/[jobId]  →  轮询 3s 间隔 / 3600 次上限  (lib/media/polled-task.ts)
      │                                ETA 用 EMA(权重 0.3)，只采纳前进样本
      ▼
GET .../[jobId]/download   (仅 succeeded；否则 409)
```

### 4.2 渲染服务内部

**状态机**：`render-service/src/types.ts:15`
```ts
RenderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
```
`isTerminal()` 在 `:176`，协调器 `RenderCoordinator`（`render-coordinator.ts:77`）持有 `running`/`queue`/`activeByIdentity`。

**准入顺序即安全边界**（`main.ts:231-239` 注释明确）：
1. 按 `x-openmaic-client` 头取 identity（`:278`）—— **故意忽略 multipart 里的 userId**，防轮换绕过
2. `coordinator.reserve()`（`:284`）→ 3. 整个解压段在 `extractionGate` 信号量内（`:305`）→ 4. `hardenProject()`（`:342`）→ 5. `coordinator.submit()`

**发布语义**：`result.resources.published === true` 时产物已原子提交，迟到的 cancel 不得改判结果（`render-coordinator.ts:399-450`）。改这里务必读原始注释。

**两级资源隔离**（"resource" = 一次渲染任务的 OS 级隔离资源：cgroup 配额 + 私有 mount namespace）

| 组件 | 层级 | 职责 |
| --- | --- | --- |
| `resource-main.ts` | root 引导 | 校验 Linux+root、fork 后 setuid 降权、以 `RENDER_SERVICE_NO_LISTEN=true` 启动服务 |
| `resource-systemd-runner.mjs` | **外层** | `systemd-run` 拉 scope unit，注入 `CPUQuota/MemoryMax/TasksMax`；**原子发布** `publishStagedArtifact:447`、`finalizePublication:581`、未发布结算 `settleUnpublished:537` |
| `resource-task-runner.mjs` | **内层** | 建 tmpfs + `mount --make-rprivate /`，项目目录**只读 bind**，`setpriv` 起 worker |
| `resource-task-worker.mjs` | 最内 | 真正调 producer，强制 `workers:1, useGpu:false, hdrMode:'force-sdr'` |

**资源档位**（`resource-profile.ts:55-58`）

| 档位 | Chromium 模式 | 内存门槛 | `maxParallelChunks` |
| --- | --- | --- | --- |
| `standard` | `prefer-beginframe` | ≥ 8 GiB | 4 |
| `low-memory` | `screenshot-only` | ≥ 4 GiB | 1 |

两者都强制 `producerWorkers/maxConcurrency/maxConcurrentExtractions = 1`，环境冲突启动即抛错（`:97-102`）。

**容器**（`render-service/Dockerfile`）：Debian bookworm-slim（**不是 Alpine**，puppeteer 需要 glibc）+ `chromium-headless-shell` 151 + `ffmpeg` 5.1.9 + `iptables`，版本钉在 `snapshot.debian.org`。容器**故意以 root 启动**——需 root 装 iptables 规则，再 `setpriv` 降权。

### 4.3 三个必须知道的设计事实

1. **两条导出路径不可能漂移**：本地 CLI 降级（`use-export-video.ts`）与上传渲染（`use-render-video.ts`）**共用 `buildExportZip`**（`build-export-zip.ts:6-12`）。ZIP 在浏览器里构建完成。这是设计红线，改一处必须改两处。

2. **Hyperframes 有两个版本**（故意的）：
   - 根 `package.json` → `hyperframes: 0.7.60`（CLI 路线）
   - `render-service/package.json` → `@hyperframes/producer: ^0.7.107` + 别名 `hyperframes-resource-producer: npm:@hyperframes/producer@0.8.37`（资源隔离路线固定 0.8.37）

3. **确定性优先于一切**：GSAP 随包分发、**绝不走 CDN**（`emit-hyperframes/index.ts:18` + `package-zip.ts:80-83`），资源落在 `assets/<planPath>`。任何"优化成 CDN"的想法都要先问：离线课堂还能播吗？

---

## 5. 红线区（改之前必读）

### 5.1 安全地雷（历史上全是真实 CVE / GHSA）

| 坑 | 位置 | 硬规则 |
| --- | --- | --- |
| **middleware 是 fail-open** | `middleware.ts:48-50` | `ACCESS_CODE` 未设时**直接放行，API 完全可达且无第二道门**（`SECURITY.md:41` 明确说明这是有意设计）。只有 `/api/` 会 401，页面请求放行弹前端窗。**别假设 middleware 会兜住你的新路由。** |
| **owner 校验是能力式的** | `SECURITY.md:44` | 文档读取、活跃课程引用的媒体读取**不校验 owner**——有链接就能读。默认是 30 天匿名 cookie，`anonymous_id` 是**未签名 bearer credential**，同注册域的兄弟子域可植入。**服务真实用户必须自己注册 `OwnerAuthMethod`，并考虑 `anonymousFallback: false`。** |
| **配额/ACL 都按 owner 走** | `instrumentation.ts:41-45` | 默认匿名共享 owner，**清 cookie 即换新 owner**，配额和课程库都是新的。总量限制要在别处做。 |
| **SSRF 防护的三条不可绕过规则** | `lib/server/ssrf-guard.ts:492-520` | ① 云 metadata（`100.100.100.200` 等）即使 `ALLOW_LOCAL_NETWORKS=true` 也**永久拒绝**；② 该模式下 DNS 失败/超时是 **fail-open**（注释直言"不是防 DNS rebinding 的防线"），**必须配合 pinned dispatcher**；③ **通过环境变量配置的 endpoint 不受 guard 约束**（如 `RENDER_SERVICE_URL`、`OLLAMA_BASE_URL`），**只有请求时用户给的 URL 才受约束**。 |
| **新增服务端 fetch 用户 URL 的路由** | `lib/server/pinned-dispatcher.ts`、`fetch-with-redirect-validation.ts` | 必须走 `ssrf-guard` + `pinned-dispatcher`，遵守「**每跳重校验、跨源丢凭据**」范式。否则等于重新打开 GHSA-9m7h / GHSA-g87c / GHSA-23xq。仓库里有**扫描测试**防止回退，改路由时这个测试会挂。 |
| **CSRF 是按路由手动挂的** | `lib/persistence/owner-claim-http.ts:33-57` | `isSameOriginJsonRequest` 目前只用在 3 个路由（`identity/claim`、`identity/legacy-import-binding`、`persistence` 的 owner-merge 分支）。**新增会改状态的路由要自己加。** |
| **CSP 必须双份逐字节一致** | `untrusted-html-csp.ts:15-20` | app 侧场景策略与渲染侧策略有测试断言一致性。**改一处必须同步另一处**，否则 `test/untrusted-html-csp.test.ts` 挂。`UNTRUSTED_RENDER_CSP` 是超集但 `connect-src` 仍为 `'none'`。 |
| **egress lockdown 是 fail-closed** | `docker-entrypoint.sh:40-62` | iptables 规则装不上就**非零退出**。因为 app 能主动连 render，而 Chromium **绝不能反向回连**。改容器网络时别把这个改成"装不上就警告"。 |
| **注入位置按字节计算** | `untrusted-html-csp.ts:122-140` | 只认 HTML ASCII 空白，**不能用 JS 正则 `\s`**（会匹配 NBSP/U+3000 导致 meta 落入 `<body>` 被 Chromium 忽略）。非 UTF-8 文档从不解码重编码。 |

**已知残留风险**（上游自己承认，靠 egress lockdown 兜底）：CSP 没有 `navigate-to`，`location` / `window.open` / `target=_top` 可换顶帧（`render-service/README.md:186-192`）；framed SVG 中的 `<image href>` 仍可加载子资源（`:194-196`）。**引入新的出站路径前，评估这两条是否被你的改动放大了。**

### 5.2 并发与死锁

| 坑 | 位置 | 规则 |
| --- | --- | --- |
| **写操作第一条语句必须取 owner 写锁** | `lib/persistence/owner-bound-document-store.ts:526-530` | 打乱顺序会死锁。owner 写锁共享、claim 排他；超 `OWNER_WRITE_LOCK_WAIT_MS`(30s) / `OWNER_CLAIM_LOCK_WAIT_MS`(5s) 返回 `503 OWNER_BUSY`。**资产回收器不取 identity lock**——回收与 claim 竞争会让其中一方被 PG 中止。 |
| **create 钩子的 `background` source 不是可信调用方** | `persistence-hooks/types.ts:33-36` | 限额策略必须**同样作用于 agent run 写入**。`onCreate` 抛错会**回滚整个课程创建**。 |
| **`library.list` 列出别人的课程 = 交出能力** | `types.ts:91-93` | 上限 `MAX_LIBRARY_STAGE_IDS = 5000`（`lib/persistence/library.ts:25`），超了返回 500。 |
| **钩子只能注册一次且首次使用后封存** | `registry.ts:79-97` | 键名拼错会被 `unknownKey()` **拒绝**（防静默绕过），但注册时机错误会启动失败。 |
| **`writesOutsideRegistryDatabase: true` 是被信任而不校验的** | `byte-store.ts:107-128` | 误标会造成**自死锁**且 PG 检测不到。PG 列内字节层**不能**注册该 flag，也**不能**同时设 `ASSET_S3_BUCKET`（会停服）。 |
| **redirect egress 有两个前提** | hosting.mdx:286-291 | bucket 需 CORS 放行本 origin 并在签名响应暴露 `Content-Type`；签名身份需 `s3:ListBucket`，否则已回收资产返回 `403` 而非 `404`——**客户端只能把"已回收"读成 miss，代码必须靠状态码确认**。 |
| **配额为 0 表示关闭** | `asset-quota.ts:40-49` | 必须是安全的非负整数，否则**启动即失败**。回收两级串行（先释放 entry 再删字节），最坏耗时 2× grace。 |

### 5.3 语义陷阱

- `signsReadUrls` 未声明却设 `ASSET_BYTE_EGRESS=redirect` → **启动时停服**（`hosting.mdx:937-940`）。
- `OwnerAuthMethodResult` 的 `invalid` **必须**用于"凭据存在但无效"，否则会静默降级到下一方法或匿名身份（`identity/types.ts:130-159` 有明确警告）。
- `describeStoredOwner` 的返回**必须稳定**，否则退休 id 的 fence 失效（`types.ts:190-193`）。
- 默认 `chunkWorkers===1` 时会把 `PRODUCER_MIN_PARALLEL_FRAMES` 抬到 `MAX_SAFE_INTEGER` 压掉 producer 的双 worker 下限，**必须在 finally 恢复**（`chunk-executor.ts:827-895`）。
- `chunk` 渲染固定 **2 次尝试、无退避**（`chunk-executor.ts:763`）；重试前先 `verifyChunkOutput` 校验 `planHash`，失败则删产物重渲。
- 取消靠 `fork` + `detached:true` + `process.kill(-pid,'SIGKILL')` 杀整个进程组（`chunk-executor.ts:208-217`）。**别用只杀父进程的方式改这段。**

---

## 6. 宿主扩展钩子（二开接入点，不改上游代码）

实现位于 `lib/server/persistence-hooks/`，宿主唯一 import 的出口是 `index.ts:16-29`，在 `instrumentation.ts` 的 `register()` 中注册。

| 钩子 | 用途 | 定义位置 |
| --- | --- | --- |
| `authorizeCreate` / `onCreate` | 课程创建鉴权 / 副作用 | `types.ts:65-69` |
| `library` (`LibraryProvider`) | 自定义课程库列出逻辑 | `types.ts:95-99` |
| `beforeAssetAllocate` | 资产分配前拦截 | `types.ts:131-134` |
| `configureAssetByteStore` | 把资产字节落到自有存储 | `types.ts:158-180` |
| `configureOwnerAuthentication` | 注册账号认证方法 | `lib/server/identity/registry.ts:200` |

**接自有对象存储只需实现 `AssetByteStore`**（`packages/@openmaic/storage/src/asset/byte-store.ts:54-129`）：

```ts
write(hash, bytes): Promise<void>       // 必须无条件、幂等
read(hash): Promise<Uint8Array | null>   // miss 不是错误
delete(hash): Promise<void>              // 只有离线回收器会调
signReadUrl?(hash, headers): Promise<string | undefined>   // 可选
readonly writesOutsideRegistryDatabase?: true              // 见上文红线
```

参考实现：`src/asset/s3-bytes.ts`、`src/asset/pg-bytes.ts`。

**接新的 DocumentStore / RuntimeStore 后端**：实现 `src/document/types.ts` / `src/runtime/types.ts` 接口 + `pg-migrations.ts`。HTTP 契约规范在 `packages/@openmaic/storage/docs/{runtime,document,kv,asset}-http-contract.md`。

---

## 7. 模型配置（1.2.0 新增，改模型行为不用改代码）

`openmaic.yml` 顶层四个键：`providers` / `slots` / `lock` / `allowUserKeys`。

| 概念 | 定义位置 |
| --- | --- |
| 解析与校验（含 `${VAR}` 插值、`.strict()` 未知键拒绝） | `lib/server/model-config/openmaic-yml.ts:396-457` |
| 无 yml 时的旧配置回落 | `deployment-layer.ts:11-26`（设了 `MODEL_ROUTES` 却无 yml → 直接报错 `:28-35`） |
| 槽位定义森林（7 个 capability 根 + 子 slot） | `lib/config/model-slots.ts:49-77` |
| `lock` → 锁定 | `lib/server/model-config/settings.ts:481, 639-650` |
| `allowUserKeys` | `lib/server/model-config/runtime.ts:55` |
| provider 注册表 | `lib/ai/providers.ts`（87KB，导出 `PROVIDERS` / `TTS_` / `ASR_` / `IMAGE_` / `VIDEO_` / `WEB_SEARCH_` / `PDF_`） |
| preset 层 | `lib/config/provider-presets.ts:47-91` |

**新增一个模型服务商要动**：`lib/ai/providers.ts`（注册表 + models 目录）→ `lib/config/provider-presets.ts`（若非自动生成）→ 对应传输层（`llm-provider-fetch.ts` / `media-provider-fetch.ts` / `audio-provider-fetch.ts`）→ `lib/server/model-config/settings.ts`。

---

## 8. 工作方式约定

**改动流程**（沿用本项目一贯节奏，不要跳步）：
1. **先 code review / 定位根因**，给出文件路径 + 行号证据，再谈改法
2. **最小化改动**——优先 L1/L2，其次 L4；不要顺手重构无关代码
3. **自验证**——改完先跑相关测试（`pnpm test` 可用 `-t` 过滤），再跑构建
4. **构建验证**——动了 `packages/` 必须 `pnpm build:packages`
5. **最后才 commit**，commit message 沿用上游风格：`feat/fix/docs(scope): 简述`（有历史 PR 参照）

**改动前必答三问**：
1. 这个改动会不会**在渲染服务里执行用户可控的 HTML/JS**？会 → 走第 5.1 节的 CSP + egress 规则
2. 这个改动**新增了服务端 fetch 用户 URL 的路径**吗？是 → 走 SSRF 三规则 + pinned dispatcher
3. 这个改动**碰并发/锁/配额**吗？碰 → 读第 5.2 节再动手

**输出风格**：先给结论，再展开；用表格 + 简短摘要；引用具体 `文件:行号`；不确定的地方明说"未查到"，**不要编造行号或 API**。

**改文案**：界面支持 12 种语言/区域，改完跑 `pnpm check:i18n-keys`。
