// REST issue → 内部 payload 的纯映射。
// 去库后机审不再回调 app 的同步接口；原同步相关函数已随 Phase C 移除，
// 此文件仅保留 manualModeration 所需的类型与映射函数。
export interface GitHubIssuePayload {
  id: string
  number: number
  title: string
  body: string | null
  user: {
    login: string
    avatar_url: string
    html_url: string
  }
  created_at: string
  updated_at: string
  html_url: string
}

export function toIssuePayloadFromRestIssue(issue: any): GitHubIssuePayload {
  return {
    id: issue.node_id || String(issue.id || ''),
    number: issue.number,
    title: issue.title || '',
    body: issue.body ?? '',
    user: {
      login: issue.user?.login || 'unknown',
      avatar_url: issue.user?.avatar_url || '',
      html_url: issue.user?.html_url || '',
    },
    created_at: issue.created_at || new Date().toISOString(),
    updated_at: issue.updated_at || new Date().toISOString(),
    html_url: issue.html_url || '',
  }
}
