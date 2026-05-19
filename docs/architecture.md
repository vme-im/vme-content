# vme 架构决策与实施规格（正式 · 定稿 2026-05-19）

> **状态**：正式文档。本项目架构的权威决策与实施规格；全部关键决策已定（见 §0 决策日志），实施按 §9 路线图推进、遵循「先 review 再 commit」。后续变更以新增决策日志条目记录。
> **范围**：vme-app + vme-content 整体架构。
> **与旧文 `llm-auto-tagging.md`（仍在 vme-app）的关系**：旧文所述设计（single-sync LLM 打标 + Neon 为库 + 路径相关打标）已被本文件**取代**，旧文已加历史横幅、仅作存档，**一切以本文件为准**（删除待用户确认）。旧文地址：<https://github.com/vme-im/vme-app/blob/main/docs/plan/llm-auto-tagging.md>
> **本文件是跨 vme-app / vme-content 的唯一权威规格**，置于 vme-content（耐久真相侧）；vme-app 仅留 URL 指针。

---

## 0. 决策日志

| 日期 | 决策 | 取舍说明 |
|---|---|---|
| 2026-05-19 | **点赞依赖 GitHub**（GitHub 为真相 + 自建缓存投影；岔路选 A） | 抗腐烂/免费优先于扩张；放弃自有点赞库的可扩与匿名能力，换取「点赞也独立于 app/DB」与零存储 |
| 2026-05-19 | **快照产物落 Cloudflare R2**（不入 git、不用 Release asset、非构建期内存） | 复用现有图片上传的 R2 账户/凭据；R2 永久免费额度 + **零 egress** → 此规模长期实际 $0，最契合「免费/不腐烂/长期」；覆盖式写、强缓存头；git 只留小 tag 缓存 |
| 2026-05-19 | **tag 持久化用 git 小缓存文件，不回写 Issue 标签** | 避免 label 泛滥与扩写权；保留 PR 可审标；不污染审核标签命名空间 |
| 2026-05-19 | **读模型一次到位做「无正文索引 + 正文按需」**（用户确认） | 接缝一次铺好、贴合做大野心；明确不走「单文件服务端缓存」过渡 |
| 2026-05-19 | **跨仓塌缩为「单仓 + 冻结归档」**：whitescent/rin0chan 一次性冻结，ingest 此后只看 `vme-im/vme-content` | 实测上游 2023-08 起停更（~2.75 年）、已改名、139 条全在本地；放弃 live 跨仓即消除已漂移的第三方依赖，符合少维护/不腐烂；详见 §6、§9 |
| 2026-05-19 | **上游涓流采摘 = 手动按需，非定时自动** | 实测上游新 issue ~4 条/年且全无标签；定时器为此长期常驻=腐烂面不划算。改为"操作手册"按需跑：零常驻、不会静默失败、人顺手滤垃圾。运行手册待单仓管线就位后撰写 |
| 2026-05-19 | **A3-3 取消：采摘水位线不预建状态文件** | resume point 可在采摘运行手册落地时由 archive-rin0chan.json/快照推导（含最大 issue 号）；预建无人读写的状态文件=过早脚手架+漂移风险，与「不堆死代码/按需按比例」一致 |
| 2026-05-19 | **Phase A 完成并 CI 端到端验证** | 单仓 139 + 冻结归档 139 = 278；磁盘==summary==278（漂移消解）；276 打标（回填 271 缓存命中零额外花费 + 网关实打 5；2 条短文偶发失败、缓存跳过下次自愈）；全量 tagHash/sourceRepo；createData 仅 push 数据不碰 issue。剩 A5（拆旧打标路径）须 Phase B 后做 |
| 2026-05-19 | **更正：create_data 的 AI_API_BASE_URL/LLM_MODEL 取 `vars.` 非 `secrets.`** | 对齐 issue_moderation 成熟写法。此前误取 `secrets.`（空）→ tagger 回退 api.openai.com、用网关 key 打官方端点失败→标签空。`AI_API_KEY`（`secrets.`，机审在用）本就正确、secret 确实存在 |

> **更正（2026-05-19）**：早期讨论曾称产物落点为「S3」。经核对代码（`src/app/api/image-upload/route.ts` 用 `@aws-sdk/client-s3` 指向 `*.r2.cloudflarestorage.com`，`.env.local.example` 仅有 `R2_*` 凭据），实为 **Cloudflare R2**。架构不变，仅正名并升级成本结论：R2 永久免费额度 + 零 egress，此规模长期实际 $0，且不再有 AWS「12 个月免费额度到期转收费」那条腐烂风险。

> **实测数据量（2026-05-19，gh + 本地）**：上游 `whitescent` 已改名 `rin0chan/KFC-Crazy-Thursday`（`pushed_at` 2023-08，停更 ~2.75 年，未归档，326★）：`文案提供` 139 / `梗图` 4 / issue 共 185。自有 `vme-im/vme-content`：`收录` 139 / `梗图` 3 / issue 共 175。本地 `data.json` 244（whitescent 139 + `zkl2333/vme` 105），但 `summary.json` 称 277 且 `data.json` 最新仅到 2025-05 → 现行管线已漂移/部分失效，一次性重生成时一并校正。

---

## 1. 触发

由提问「这个架构有哪些不优雅的地方」展开，逐步澄清出长期架构目标与硬约束。

## 2. 现状架构的不优雅点（已识别）

- **文档数据流与实际不符 + 死代码**：README 称「vme-content 生成快照 → vme-app 同步入 Neon」，实际读路径 100% 走 Neon，而 Neon 由 sync **直接抓 GitHub** 填充；`data/*.json`、`data.json` 无人消费。`vme-app/src/lib/moderation/index.ts` 是 vme-content `moderationLogic.ts` 的近乎逐字拷贝且无任何调用方（死代码）。
- **同一逻辑实现三遍且不一致**：抓 Issue / 判 text·meme / 仓库配置在 vme-content、vme-app sync、sync/route 内联各一套；`detectContentType` 三个不同正则；仓库身份三处不一致（`zkl2333/vme` vs `vme-im/vme-content` vs README）。
- **tag 只活在 Neon 且路径相关**：LLM 打标仅在 `/api/sync` 的 `single` 分支发生；incremental/full（含整个 whitescent 仓）进来的条目无 tag，靠详情页 `ClassifyTrigger` → `/api/classify` 懒补，没人点开就永久无标签。git 快照零 tag。
- **`moderation_status` 恒为 `approved`**：每条查询都过滤一个常量，纯仪式。
- **增量同步用 `sync_logs` 的 `MAX(finished_at)` 当水位线**：拿审计表当游标，空成功推进水位、用同步时刻而非 issue `updatedAt`，有丢数据竞态。
- **点赞实时打 GitHub**：用登录用户 OAuth token 实时写 Issue reaction，耦合 GitHub 可用性/限流（故有庞大 `RateLimitManager`），匿名不能赞，`reactions_count` 在 Neon 与 GitHub 两处真相会漂移，`reactions(first:100)` 截断。

## 3. 目标与硬约束（用户明确表达）

1. app 挂、DB 挂都**不丢数据**；社区共创**独立于 app**；**app 只是优雅的界面**。
2. **不想在 git 存大/会膨胀/高 churn 的文件**。
3. 前端/服务端**不应加载整包大文件**（慢、内存）。
4. **有做大做强的野心**（规模是真实需求，不是当下 277 条的体量）。
5. **少维护、不腐烂、极低费用或免费**；基于 GitHub / Vercel 等，**自动化长期无人值守存在**。

## 4. 收敛的架构原则

**双速架构**——免费/抗腐烂与扩张野心的张力，用「永不为活着付费，只为长更快付费」化解：

- **Tier 0（永久、免费、抗腐烂的默认核心，必须几年无人管还活着）**
  - 真相 = **GitHub Issues**（投稿 / 审核标签 / 点赞 reactions），GitHub 替你维护、随规模免费扩。
  - tag = **git 里的小缓存**（`id → {tagHash, tags}`，无正文，低 churn，可在 PR 审标）；LLM 付费只花一次（按内容 hash），key/模型挂了旧 tag 照用、不阻塞站点。
  - 界面 = **静态构建产物**（零运行时依赖可腐烂，上游全死仍服务最后一次好构建）。
  - 点赞 = **GitHub 为真相**（已定）；Tier 0 的「自建缓存投影」= 计数随快照刷新（as-of-last-snapshot）+ 详情页可实时拉 GitHub。**不在 Tier 0 引入常驻 reaction 服务**——那是 Tier 1+ 仅在规模逼迫时才做。
- **Tier 1+（可选、付费、需维护的扩展投影，增长到了才栓上）**
  - DB / 真搜索引擎 / 规模化 reaction 摄取管线。均在 `DataProvider` 接口之后、可从 Tier 0 重建；腐烂或停付即**回落 Tier 0，零数据丢失**。

**三条不变量**：

1. **真相层固定**（GitHub Issues + git 小 tag 缓存）——唯一「选错才痛」的决定，且它是对的。
2. **`DataProvider` 接口是契约**——页面/API 永不随投影变化而改；每次扩容是「加一个实现」。
3. **投影永远可从真相层重建**——换 DB、加搜索、重新分片皆零迁移风险，可重建性 = 规模 + 抗腐烂双重保险。

## 5. 数据与产物设计（结论）

- **真相**：GitHub Issues，不额外存。
- **tag 缓存**：小 git 文件（**已定，不回写 Issue 标签**），`tagHash = sha256(tagPromptVersion + "\n" + preprocess(title,body))`；上一版快照即缓存，命中则不调 LLM；`tagPromptVersion` bump 即全量重打标。
- **查询读模型**（替代 Neon 的读职责）：**无正文紧凑索引**（id/title/author/createdAt/reactionsCount/contentType/tags，~150B/条）服务端内存排序筛选分页搜索；**正文按需**取（per-item / per-page）。任何环节都不加载整包。
- **summary**：与索引**同一次 createData、同一内存数组原子生成**的预聚合（totalItems/contributors/months/topTags/版本号），统计零扫描，杜绝多文件漂移。
- **产物落点**：**Cloudflare R2（已定）**（代码经 `@aws-sdk/client-s3` 接 R2，与现有梗图上传同账户/凭据，实施时建议独立 bucket/前缀）——覆盖式写、强缓存头；不入 git；git 只留小 tag 缓存。R2 永久免费额度 + 零 egress，此规模长期实际 $0。
- **稳定排序**：数组按 `createdAt ASC, id ASC` 固定后写出，保证（git 中 tag 缓存的）diff 干净。

## 6. 关键流程结论

- **tag 必须在快照层产出**（createData，唯一已合并多仓处），统一覆盖所有来源仓库；删除 `/api/classify` + `ClassifyTrigger` + single-sync 打标 + `lib/moderation` 死副本。
- **跨仓塌缩为「单仓 + 冻结归档」**（2026-05-19 实测据此定）：上游 `whitescent`→已改名 `rin0chan/KFC-Crazy-Thursday` 且 2023-08 后停更；其 139 条 `文案提供` 已全量在本地。决定：**一次性冻结该 139 条为静态归档**（provenance 记当前名 `rin0chan/KFC-Crazy-Thursday`，机审/去重/打标各做一次、永不再抓），**此后 ingest 只看单仓 `vme-im/vme-content`**。`node_id` 仍为键；不再有 live 跨仓合并、跨仓 token/限流、whitescent 绕过审核那条路径。
- **上游涓流靠「手动采摘」补**（2026-05-19 定）：上游 2023 后仍有 ~4 条/年、全无标签的社区投稿。不做定时自动；改为**按需操作手册**——维护者按需执行：读「水位线之后的新 issue」→ 当作一次 vme.im/submit 跑**本仓机审+去重**→ 通过的在 `vme-content` 建 issue（保留原作者署名 + `sourceRef: rin0chan#NNN`）→ resume point 由 archive/快照推导（不预建状态文件，见 §0）。写 issue 用 Actions/本地令牌写**自有仓**、读上游公开 issue 免令牌；上游消失则采摘空转、数据不损（优雅降级）。
- **仓库身份**：单仓塌缩后此项自然消解——唯一 live 源即 `vme-im/vme-content`；冻结归档不参与 live 抓取。仍需修掉现行 `zkl2333/vme` 旧名（重定向兜着、且少抓 105 vs 线上 139）。

## 7. 抗腐烂工程清单（落地时必须执行）

- **public repo → GitHub Actions 免费不限量**：自动化建在公开仓 Actions 上，不建按量计费常驻服务。
- **事件驱动而非定时（设计上消除「60 天禁用」风险）**：ingest 由 issue 提交事件触发（`on: issues`）、无 cron，采摘为手动按需。故不存在「定时 workflow 60 天无活动自动禁用」问题，也无空转——无人投稿即不运行，恰好符合少维护。
- **存储型 PAT 会过期**（已搁置 · 低优先，2026-05-19）：本项目数据量极小、偶发抓取，**免令牌的公开仓读取（60/h）大概率够用**，无需存储型 PAT，过期腐烂自然规避；仅当限流真咬人再考虑 Actions 原生 `GITHUB_TOKEN` 或 GitHub App。注意：此项与 R2（存储）无关，PAT 是读 GitHub Issue 抬限流用。
- **全部钉死**：Node 版本（已用 Volta）、Action 按 commit SHA、锁文件、不用 `latest`。确定性 = 抗腐烂。
- **静态产物无运行时依赖**：天然降级兜底；动态增强（点赞/搜索）做成可独立降级的叠加层，腐烂时内容核心仍站。
- **Vercel Hobby 禁商用**：玩梗项目不商用不变现。

## 8. 已决 vs 待决

**已决**（见 §0）：点赞依赖 GitHub（A）；快照产物落 Cloudflare R2；tag 用 git 小缓存、不回写 Issue 标签。
**共识**：DB-less 为默认；tag 入快照；双速架构；真相层 = Issues + git 小 tag 缓存；`DataProvider` 为扩容接缝；读模型 = 无正文索引 + 正文按需。

**待决**：无。**Phase A 已完成并 CI 端到端验证**（见 §0）；下一步 Phase B（去库），A5（拆旧打标路径）随 Phase B 后做。

## 9. 实施路线图（Phase 2）

**Phase A — 前置清理（低风险、可独立先行、不依赖去库）** — ✅ **已完成并 CI 端到端验证（2026-05-19）**：1 / 1b / 2 / 3 / 5 完成，1c 取消，4（=A5 拆旧打标路径）推迟到 Phase B 后（现删会回归 app 读 Neon）。
1. **ingest 收敛为单仓**：live 源仅 `vme-im/vme-content`；移除多仓配置与 `whitescent`/`zkl2333/vme` 旧名（致命前置：无库后这是唯一数据源）。
1b. **冻结上游归档**：将本地已有的 139 条 whitescent/rin0chan 内容定格为静态归档（provenance 记 `rin0chan/KFC-Crazy-Thursday`），机审/去重/打标各一次后永不再抓。
1c. ~~采摘水位线~~（**取消**，2026-05-19）：不预建状态文件——resume point 在采摘运行手册落地时由 archive-rin0chan.json/快照推导；**手动采摘运行手册**待管线就位后单独撰写（非定时 workflow）。
2. tag 入快照：createData 跑 `analyzeContent`，写 `tags`+`tagHash` 进产物；按 `tagHash` 缓存（上一版产物即缓存）。
3. 一次性回填：导出现有 Neon tags 对齐进首版产物（省 LLM 钱、保已积累/人工修正的标签）。
4. 删除：`/api/classify`、`ClassifyTrigger`、single-sync 的 `analyzeContent` 调用、`lib/moderation` 死副本。
5. **校正快照漂移**：一次性重生成一致快照（修 `data.json` 244 vs `summary` 277、最新停在 2025-05、`zkl2333/vme`→`vme-im/vme-content` 旧名少抓）。

**Phase B — 产物与读模型（去库核心）**
5. createData 产出「无正文索引 + 正文分片 + summary」，同批原子生成、稳定排序，**上传 Cloudflare R2**（覆盖式、强缓存头；复用现有 R2 账户，建议独立 bucket/前缀）。
6. createData 富化 `reactions.totalCount`（`fetchIssues` 现未抓，补 GraphQL；`github-fetcher.ts:69` 有现成写法）。
7. 实现 `SnapshotProvider implements DataProvider`：读 S3 索引建内存 + `Map`，正文按需，summary 直读；`getDataProvider()` 由 `NeonProvider` 切 `SnapshotProvider`，`server-utils.ts` 以上不动。
8. 等价性验证：列表/分页/随机/详情/精选/搜索/统计读路径全部对齐。

**Phase C — 退役与抗腐烂加固**
9. 移除 sync 的 DB 写入、`sync_logs` 水位线、Neon 依赖。
10. 点赞投影（决策 A）：GitHub 为真相不变；计数随产物刷新；详情页保留实时拉 GitHub（已 DB 无关）。
11. 抗腐烂闸：ingest 事件触发（无 cron，免 60 天禁用问题）；读公开仓免令牌、必要时 Actions 原生 `GITHUB_TOKEN`；Node/Action SHA/lockfile 钉死；静态降级兜底验证。
12. 处理 `llm-auto-tagging.md`（标历史/废弃，删除前确认）。

**回退方案**：任一阶段失败，`SnapshotProvider` 与 `NeonProvider` 同接口可即时切回；产物可从 Issues + tag 缓存重建，无数据风险。

## 10. 扩张分阶段路线（骨架）

| 阶段 | 投影实现 | 升级触发信号 |
|---|---|---|
| 现在 ~ 万级 | 无正文索引在内存 + 正文按需（R2） | 索引装不进函数内存 / 冷启动慢 |
| 万 ~ 十万+ | 重新引入查询库（PG+zhparser / 搜索引擎）作投影，从真相层重建 | 排序/聚合/搜索扛不住 |
| 多仓 ingest 上量 | createData 改按仓增量游标（把 sync_logs 那个坑做对）+ 弹性重试 | 全量重抓变慢 / 打爆 GitHub 限额 |
| 内容产品做大 | **搜索/发现独立投影**（现 `simple` tsvector 是假搜索，与条数无关，应尽早投入） | 发现质量成为增长瓶颈 |

## 11. 下一步

1. 用户 review 本文档（决策记录是否忠实、Phase 路线图是否认可）。
2. Review 通过 → 按 Phase A → B → C 推进；落地遵循「先 review 再 commit、按比例投入、不写码先给设想」。
3. 实施中本文件随进展更新决策日志与状态。
