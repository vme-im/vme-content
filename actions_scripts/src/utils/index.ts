import github from '@actions/github'
import { IssueNode } from './fetchIssues'
import { removeSeparator } from './removeSeparator'
import { readSnapshotIssues } from './snapshotReader'

// 从 issue body 中提取图片 URL
export function extractImageUrls(body: string): string[] {
  const regex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g
  const urls: string[] = []
  let match
  while ((match = regex.exec(body)) !== null) {
    urls.push(match[1])
  }
  return urls
}

// 从 issue body 中提取纯文本（移除图片 Markdown）
export function extractText(body: string): string {
  return body.replace(/!\[.*?\]\(https?:\/\/[^\s)]+\)/g, '').trim()
}

// 获取 Octokit 实例
export function getOctokit() {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN not set')
  }
  return github.getOctokit(process.env.GITHUB_TOKEN)
}

// 获取 issue 的标签
export async function getIssueLabels(issueNumber: number): Promise<string[]> {
  const octokit = getOctokit()
  const response = await octokit.rest.issues.listLabelsOnIssue({
    ...github.context.repo,
    issue_number: issueNumber,
  })
  return response.data.map((label) => label.name)
}

// 获取 issue 的 ID
export async function getIssueId(issueNumber: number): Promise<string> {
  const octokit = getOctokit()
  const response = await octokit.rest.issues.get({
    ...github.context.repo,
    issue_number: issueNumber,
  })
  return response.data.node_id
}

// 获取仓库的所有 issues
export async function addCommentToIssue(issueNumber: number, comment: string) {
  const octokit = getOctokit()
  await octokit.rest.issues.createComment({
    ...github.context.repo,
    issue_number: issueNumber,
    body: comment,
  })
}

// 为 issue 添加标签
export async function addLabelsToIssue(issueNumber: number, labels: string[]) {
  const octokit = getOctokit()
  await octokit.rest.issues.addLabels({
    ...github.context.repo,
    issue_number: issueNumber,
    labels: labels,
  })
}

// 为 issue 移除标签
export async function removeLabelFromIssue(issueNumber: number, label: string) {
  const octokit = getOctokit()
  await octokit.rest.issues.removeLabel({
    ...github.context.repo,
    issue_number: issueNumber,
    name: label,
  })
}

// 关闭 issue
export async function closeIssue(issueNumber: number) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN not set')
  }

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN)
  await octokit.rest.issues.update({
    ...github.context.repo,
    issue_number: issueNumber,
    state: 'closed',
  })
}

// 触发工作流
export async function dispatchWorkflow(workflow_id: string, ref: string) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN not set')
  }

  const octokit = github.getOctokit(process.env.GITHUB_TOKEN)
  await octokit.rest.actions.createWorkflowDispatch({
    ...github.context.repo,
    workflow_id,
    ref,
  })
}

// 最短编辑距离
export function minDistance(word1: string, word2: string): number {
  const m = word1.length
  const n = word2.length
  const dp = new Array(m + 1).fill(0).map(() => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    dp[i][0] = i
  }
  for (let j = 1; j <= n; j++) {
    dp[0][j] = j
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (word1[i - 1] === word2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j - 1] + 1,
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
        )
      }
    }
  }
  return dp[m][n]
}

// 判断两个文本是否相似
export function isSimilar(str1: string, str2: string): boolean {
  const distance = minDistance(removeSeparator(str1), removeSeparator(str2))
  const maxLength = Math.max(str1.length, str2.length)
  return distance / maxLength < 0.2
}

// 判断新的文案是否与 snapshot.sql 中的历史 issue 重复（图片 URL 精确匹配 + 文本相似）
// 注：原 `imageHashes`（pHash）路径从未被填充，2026-05-20 随月份 JSON 一起退役。
export async function findSimilarIssue(
  newIssue: string,
  currentIssueId?: string,
): Promise<Pick<IssueNode, 'id' | 'title' | 'url' | 'body'> | null> {
  const issues = await readSnapshotIssues()
  console.log(`从 snapshot.sql 读取到 ${issues.length} 个历史文案`)

  const newIssueImages = extractImageUrls(newIssue)
  const hasNewImage = newIssueImages.length > 0
  const newIssueText = extractText(newIssue)

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i]

    if (currentIssueId && issue.id === currentIssueId) {
      console.log(`跳过当前 issue ID: ${currentIssueId}`)
      continue
    }

    // 1. 图片 URL 精确匹配
    if (hasNewImage) {
      const existingImages = extractImageUrls(issue.body)
      for (const newUrl of newIssueImages) {
        if (existingImages.includes(newUrl)) {
          console.log(`在第 ${i + 1} 个文案中找到相同图片 URL: ${issue.title}`)
          return issue
        }
      }
    }

    // 2. 文本相似性（两者都有文本时）
    const existingText = extractText(issue.body)
    if (newIssueText && existingText && isSimilar(existingText, newIssueText)) {
      console.log(`在第 ${i + 1} 个文案中找到相似文本: ${issue.title}`)
      return issue
    }
  }

  console.log('遍历完所有文案，未找到相似内容')
  return null
}
