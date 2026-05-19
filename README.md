<div align="center">

# 🍗 vme-content

**疯狂星期四文案库 · 数据与自动化中枢**

「疯四」文案的投稿审核、查重打标与归档快照都在这里发生。

[![Site](https://img.shields.io/badge/在线访问-vme.im-C41200?style=flat-square)](https://vme.im)
[![Submit](https://img.shields.io/badge/我要投稿-vme.im/submit-FFC72C?style=flat-square&labelColor=000)](https://vme.im/submit)
[![Actions](https://img.shields.io/badge/GitHub_Actions-自动化审核-2088FF?style=flat-square&logo=githubactions&logoColor=fff)](.github/workflows)

[投稿入口](https://vme.im/submit) · [Web 应用 vme-app](https://github.com/vme-im/vme-app)

</div>

---

## 这是什么

**vme-content** 是疯狂星期四文案库的「数据与流水线」仓库：文案鬼才通过 GitHub Issues 投稿，自动化脚本负责**机审 + 查重 + 归档**，最终产出按月切分的 JSON 快照，供 [vme-app](https://github.com/vme-im/vme-app) 同步展示。

> 本仓库**只管数据与脚本**；网站、API 与同步服务在 [vme-app](https://github.com/vme-im/vme-app)。

## 📦 数据流水线

```
投稿 (GitHub Issues)
      │
      ▼
机器审核 + 莱文斯坦距离查重   ← actions_scripts/ + GitHub Actions
      │
      ▼
按月 JSON 快照 (data/) + 汇总 (data.json)
      │
      ▼
vme-app 同步 API 入 Neon → 网站展示
```

## 📂 目录结构

| 路径 | 说明 |
| :-- | :-- |
| `data/` | 按月份切分的文案快照（`YYYY-MM.json`） |
| `data.json` | 全量汇总数据 |
| `actions_scripts/` | TypeScript 自动化脚本（含 Jest 测试） |
| `.github/workflows/` | 数据生成与审核的 GitHub Actions |

### actions_scripts 关键脚本

| 脚本 | 职责 |
| :-- | :-- |
| `createData.ts` | 拉取 Issues、生成数据快照 |
| `moderateIssue.ts` / `moderationLogic.ts` | 投稿自动审核与查重逻辑 |
| `manualModeration.ts` | 人工复审入口 |
| `syncClient.ts` | 与 vme-app 同步 API 对接 |

### 自动化工作流

| Workflow | 触发与作用 |
| :-- | :-- |
| `create_data.yml` | 生成 / 刷新文案数据快照 |
| `issue_moderation.yml` | Issue 投稿自动审核 |
| `manual_moderation.yml` | 手动触发的人工复审 |

## 🧪 本地开发

```bash
cd actions_scripts
npm install
npm test       # Jest 单元测试
npm run build  # 测试通过后打包（rollup）
```

## 🤝 贡献说明

- ✍️ **投稿文案**：请前往 [vme.im/submit](https://vme.im/submit)，**不要**直接改 `data/`（快照由脚本生成）
- 🛠️ **改脚本/审核逻辑**：欢迎 PR；改动审核相关逻辑务必补充并跑通 `actions_scripts` 的测试
- 🎭 **文化约定**：沿用项目「疯四」术语（文案 / 投稿 / 文案鬼才 / V50 英雄榜）

## 🔗 相关仓库

- **[vme-content](https://github.com/vme-im/vme-content)** —— 文案数据与自动化脚本（本仓库）
- **[vme-app](https://github.com/vme-im/vme-app)** —— Web 应用与同步服务

<div align="center">

**疯狂星期四，V 我 50。** 🍗

</div>
