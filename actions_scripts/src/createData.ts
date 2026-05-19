import { fetchIssues } from "./utils/fetchIssues";
import core from "@actions/core";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from 'url'

// 获取当前文件的路径
const __filename = fileURLToPath(import.meta.url)
// 获取当前文件所在的目录
const __dirname = path.dirname(__filename)

// 单一数据源配置（A1：集中并规范化仓库身份，替代散落的硬编码旧名）
// 注：rin0chan/KFC-Crazy-Thursday（原 whitescent）已停更；A3 冻结其历史为静态归档后将从此处移除
const SOURCE_REPOS: { owner: string; repo: string; labels: string[] }[] = [
  { owner: 'vme-im', repo: 'vme-content', labels: ['收录'] },
  { owner: 'rin0chan', repo: 'KFC-Crazy-Thursday', labels: ['文案提供'] },
]

async function createData() {
  console.log('开始创建数据')

  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN 必须存在')
  }

  const data = (
    await Promise.all(
      SOURCE_REPOS.map(({ owner, repo, labels }) => fetchIssues(owner, repo, labels)),
    )
  ).flat()

  console.log(`获取到 ${data.length} 条数据`)

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

  // 确保data目录存在
  const dataDir = path.join(__dirname, '..', '..', 'data')
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
    console.log(`创建目录: ${dataDir}`)
  }

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

  // 将数据按月份写入对应文件
  for (const [month, items] of Object.entries(dataByMonth)) {
    const filePath = path.join(dataDir, `${month}.json`)
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2))
    console.log(`月份数据已写入: ${filePath}，共 ${items.length} 条`)

    // 直接记录文件的绝对路径
    changedFiles.push(filePath)
  }

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
