import { fetchIssues } from "./utils/fetchIssues";
import { tagContent } from './tagger'
import { generateSnapshotSql } from './generateSnapshotSql'
import { readTagCache } from './utils/snapshotReader'
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

  // tag 缓存：从上一版 snapshot.sql 读 id → {tagHash, tags}，命中跳 LLM
  // 月份 JSON / summary.json 已退役（架构 §5），snapshot.sql 是唯一真相
  const tagCache = await readTagCache(path.join(dataDir, 'snapshot.sql'))
  console.log(`tag 缓存装载：${tagCache.size} 条`)

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

  // 唯一产物：data/snapshot.sql（架构 §5；月份 JSON / summary.json / data.json 已退役）
  const changedFiles: string[] = []
  const snapshotSqlPath = path.join(dataDir, 'snapshot.sql')
  fs.writeFileSync(snapshotSqlPath, generateSnapshotSql(data))
  console.log(`SQL 快照已写入: ${snapshotSqlPath}，共 ${data.length} 条`)
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

      execSync('git commit -m "自动更新 snapshot.sql"')
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
