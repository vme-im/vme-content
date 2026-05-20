<div align="center">

# 🍗 vme-content

**疯狂星期四文案库 · 数据与自动化中枢**

「疯四」文案的投稿审核、查重打标与 SQL 快照都在这里发生。

[![Site](https://img.shields.io/badge/在线访问-vme.im-C41200?style=flat-square)](https://vme.im)
[![Submit](https://img.shields.io/badge/我要投稿-vme.im/submit-FFC72C?style=flat-square&labelColor=000)](https://vme.im/submit)
[![Actions](https://img.shields.io/badge/GitHub_Actions-自动化审核-2088FF?style=flat-square&logo=githubactions&logoColor=fff)](.github/workflows)

[投稿入口](https://vme.im/submit) · [Web 应用 vme-app](https://github.com/vme-im/vme-app) · [架构规格](./docs/architecture.md)

</div>

---

## 这是什么

**vme-content** 是疯狂星期四文案库的「数据与流水线」仓库：文案鬼才通过 GitHub Issues 投稿，自动化脚本负责**机审 + 查重 + 打标**，最终产出单文件 `data/snapshot.sql`（SQLite dump，git diff 可审），供 [vme-app](https://github.com/vme-im/vme-app) 经 `raw.githubusercontent` 直接装载。

> 本仓库**只管数据与脚本**；网站、API 在 [vme-app](https://github.com/vme-im/vme-app)。架构权威规格见 [`docs/architecture.md`](./docs/architecture.md)（跨 vme-app / vme-content 的唯一真相）。

## 📦 数据流水线

```
投稿 (GitHub Issues, vme-im/vme-content)
      │
      ▼  机审 + 莱文斯坦查重 (actions_scripts/moderationLogic.ts)
打上「收录」标签
      │
      ▼  createData (workflow_dispatch / 手动触发)
fetchIssues → 合并冻结归档 → tag 缓存命中 / LLM 打标 → generateSnapshotSql
      │
      ▼
data/snapshot.sql  ← 单文件产物，git 提交
      │
      ▼  raw.githubusercontent
vme-app SqlSnapshotProvider (sql.js + 5min TTL)
```

## 📂 目录结构

| 路径 | 说明 |
| :-- | :-- |
| `data/snapshot.sql` | 唯一读模型产物：SQLite dump（items + item_tags 两表 + 4 索引，稳定排序，diff 干净） |
| `data/archive-rin0chan.json` | 冻结归档（rin0chan/KFC-Crazy-Thursday 139 条，2023-08 后停更，一次性收录、不再 live 抓取） |
| `actions_scripts/` | TypeScript 自动化脚本（tsx 直跑、jest 测试） |
| `.github/workflows/` | 数据生成与审核的 GitHub Actions |
| `docs/architecture.md` | **架构权威规格**（决策日志 / 双速架构 / 抗腐烂工程清单） |

### actions_scripts 关键脚本

| 脚本 | 职责 |
| :-- | :-- |
| `createData.ts` | 抓 issues + 合并归档 + 打标 + 生成 `data/snapshot.sql` |
| `generateSnapshotSql.ts` | 把内存 items 数组渲染成稳定排序的 SQL dump |
| `tagger.ts` | LLM 打标（OpenAI 兼容协议），按 tagHash 缓存命中跳过 LLM |
| `moderateIssue.ts` / `moderationLogic.ts` | 投稿自动审核（OpenAI Moderation API）+ 查重（基于 snapshot.sql） |
| `manualModeration.ts` | 人工复审入口 |
| `utils/snapshotReader.ts` | 装载 `snapshot.sql`（sql.js），暴露给查重 + tag 缓存读取 |
| `syncClient.ts` | issue REST payload → 内部映射类型（manualModeration 用） |

### 自动化工作流

| Workflow | 触发与作用 |
| :-- | :-- |
| `create_data.yml` | `workflow_dispatch` 手动触发，生成 / 刷新 `data/snapshot.sql` |
| `issue_moderation.yml` | `on: issues (labeled)`，投稿打上「文案」/「梗图」时自动审核 |
| `manual_moderation.yml` | 手动触发的人工复审 |

## 🧪 本地开发

```bash
cd actions_scripts
npm install
npm test                          # Jest 单元测试（53 个用例）
npx tsx src/createData.ts         # 跑流水线（需 GITHUB_TOKEN）
```

> Node 24（已用 Volta 锁版本）。`createData` 跑完会就地修改 `../data/snapshot.sql`。

## 🤝 贡献说明

- ✍️ **投稿文案**：请前往 [vme.im/submit](https://vme.im/submit)，**不要**直接改 `data/`（snapshot.sql 由脚本生成）
- 🛠️ **改脚本/审核逻辑**：欢迎 PR；改动审核相关逻辑务必补充并跑通 `actions_scripts` 的测试
- 🎭 **文化约定**：沿用项目「疯四」术语（文案 / 投稿 / 文案鬼才 / V50 英雄榜）

## 🔗 相关仓库

- **[vme-content](https://github.com/vme-im/vme-content)** —— 文案数据与自动化脚本（本仓库）
- **[vme-app](https://github.com/vme-im/vme-app)** —— Web 应用

<div align="center">

**疯狂星期四，V 我 50。** 🍗

</div>
