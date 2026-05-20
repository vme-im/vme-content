import { fetchIssues } from "./utils/fetchIssues";
import { tagContent, computeTagHash } from './tagger'
import { generateSnapshotSql } from './generateSnapshotSql'
import core from "@actions/core";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from 'url'

// 获取当前文件的路径
const __filename = fileURLToPath(import.meta.url)
// 获取当前文件所在的目录
const __dirname = path.dirname(__filename)

// 单一数据源配置：live 只抓自有仓 vme-im/vme-content（A1+A3 收敛单仓）。
// rin0chan/KFC-Crazy-Thursday（原 whitescent）已停更，其 139 条历史冻结于
// data/archive-rin0chan.json，由下方合并、不再 live 抓取（见 docs/architecture.md A3）。
const SOURCE_REPOS: { owner: string; repo: string; labels: string[] }[] = [
  { owner: 'vme-im', repo: 'vme-content', labels: ['收录'] },
]

async function createData() {
  console.log('开始创建数据')

  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN 必须存在')
  }

  const liveItems = (
    await Promise.all(
      SOURCE_REPOS.map(({ owner, repo, labels }) => fetchIssues(owner, repo, labels)),
    )
  ).flat()

  const dataDir = path.join(__dirname, '..', '..', 'data')
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
    console.log(`创建目录: ${dataDir}`)
  }

  // 整体覆盖前，先从现有按月文件收集 tag 缓存（id -> {tagHash, tags}），避免丢标
  const tagCache = new Map<string, { tagHash: string; tags: string[] }>()
  for (const f of fs.readdirSync(dataDir)) {
    if (!/^\d{4}-\d{2}\.json$/.test(f)) continue
    const prev = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'))
    for (const it of prev) {
      if (!it || typeof it.id !== 'string' || !Array.isArray(it.tags) || it.tags.length === 0) {
        continue
      }
      if (typeof it.tagHash === 'string' && it.tagHash) {
        tagCache.set(it.id, { tagHash: it.tagHash, tags: it.tags })
      } else {
        // 回填的 tag 无 tagHash：用规范算法现算，使首跑即缓存命中、不调 LLM、不覆盖已有标签
        tagCache.set(it.id, {
          tagHash: computeTagHash(it.title || '', it.body || ''),
          tags: it.tags,
        })
      }
    }
  }

  // 合并冻结归档（rin0chan 139 条，不再 live 抓取）
  const archivePath = path.join(dataDir, 'archive-rin0chan.json')
  const archived: any[] = fs.existsSync(archivePath)
    ? JSON.parse(fs.readFileSync(archivePath, 'utf8'))
    : []

  const data: any[] = [
    ...liveItems.map((it) => ({ ...it, sourceRepo: 'vme-im/vme-content' })),
    ...archived.map((it: any) => ({ reactionsCount: 0, ...it })),
  ]

  console.log(
    `获取到 ${liveItems.length} 条（live）+ ${archived.length} 条（冻结归档）= ${data.length}`,
  )

  // 打标：命中缓存跳过 LLM；失败/无 key 回退空标签，不阻塞
  let reTagged = 0
  let cacheHit = 0
  for (const item of data) {
    const r = await tagContent(
      { title: item.title || '', body: item.body || '' },
      tagCache.get(item.id),
    )
    item.tags = r.tags
    item.tagHash = r.tagHash
    if (r.hitCache) cacheHit++
    else reTagged++
  }
  console.log(`打标完成：缓存命中 ${cacheHit}，重算 ${reTagged}`)

  // 按月份分组数据（使用中国时间 UTC+8）
  const dataByMonth: Record<string, any[]> = {}
  data.forEach((item) => {
    // 创建中国时区的日期对象
    const utcDate = new Date(item.createdAt)
    const chinaTime = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000) // UTC+8
    const month = `${chinaTime.getFullYear()}-${String(chinaTime.getMonth() + 1).padStart(2, '0')}`

    if (!dataByMonth[month]) {
      dataByMonth[month] = []
    }
    dataByMonth[month].push(item)
  })

  // 记录更改的文件
  const changedFiles: string[] = []

  // 统计贡献者信息
  const contributorMap = new Map<string, {
    username: string
    count: number
    avatarUrl: string
    url: string
  }>()

  data.forEach((item) => {
    const { username, avatarUrl, url } = item.author
    if (contributorMap.has(username)) {
      contributorMap.get(username)!.count++
    } else {
      contributorMap.set(username, {
        username,
        count: 1,
        avatarUrl,
        url,
      })
    }
  })

  // 转换为数组并按贡献数排序
  const contributors = Array.from(contributorMap.values())
    .sort((a, b) => b.count - a.count)

  // 获取前10名贡献者用于排行榜
  const topContributors = contributors.slice(0, 10)

  // 生成汇总信息
  const summary = {
    totalItems: data.length,
    totalContributors: contributors.length,
    months: Object.entries(dataByMonth)
      .map(([month, items]) => ({
        month,
        count: items.length,
      }))
      .sort((a, b) => b.month.localeCompare(a.month)), // 按月份降序排序
    contributors,
    topContributors,
    updatedAt: new Date().toISOString(),
  }

  // 写入汇总信息
  const summaryPath = path.join(dataDir, 'summary.json')
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  console.log(`汇总信息已写入: ${summaryPath}`)
  changedFiles.push(summaryPath)

  // 删除不再属于当前数据集的陈旧按月文件（清除旧管线/旧仓身份残留的僵尸条目，
  // 使磁盘月文件 == summary == data；删除路径并入 changedFiles 以随提交一并落库）
  const currentMonths = new Set(Object.keys(dataByMonth))
  for (const f of fs.readdirSync(dataDir)) {
    if (!/^\d{4}-\d{2}\.json$/.test(f)) continue
    if (!currentMonths.has(f.slice(0, 7))) {
      const stale = path.join(dataDir, f)
      fs.unlinkSync(stale)
      console.log(`删除陈旧月份文件: ${stale}`)
      changedFiles.push(stale)
    }
  }

  // 将数据按月份写入对应文件
  for (const [month, items] of Object.entries(dataByMonth)) {
    const filePath = path.join(dataDir, `${month}.json`)
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2))
    console.log(`月份数据已写入: ${filePath}，共 ${items.length} 条`)

    // 直接记录文件的绝对路径
    changedFiles.push(filePath)
  }

  // 生成 SQL 快照（供 vme-app SqlSnapshotProvider 装载，兑现架构 §5「无正文索引 + 正文按需」）
  const snapshotSqlPath = path.join(dataDir, 'snapshot.sql')
  fs.writeFileSync(snapshotSqlPath, generateSnapshotSql(data))
  console.log(`SQL 快照已写入: ${snapshotSqlPath}`)
  changedFiles.push(snapshotSqlPath)

  // 提交到仓库
  execSync('git config --global user.name github-actions[bot]')
  execSync(
    'git config --global user.email github-actions[bot]@users.noreply.github.com',
  )

  // 检查文件变化并提交
  if (changedFiles.length > 0) {
    console.log('文件有变化，开始提交到仓库')
    try {
      // 添加所有更改的文件
      changedFiles.forEach((file) => {
        console.log(`正在添加: ${file}`)
        execSync(`git add "${file}"`)
      })

      execSync('git commit -m "自动更新按月份数据"')
      execSync('git push')
      console.log('数据变化已经提交到仓库')
    } catch (error) {
      if (error instanceof Error) {
        console.error('提交过程中发生错误：', error.message)
        throw error
      } else {
        console.log('发生了未知类型的错误')
      }
    }
  } else {
    console.log('数据没有变化，跳过提交')
  }
}

createData().catch((err) => core.setFailed(err.message));
