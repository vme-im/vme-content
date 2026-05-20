// 生成 vme 快照 SQL 文本（CREATE + INDEX + INSERT），由 createData 写入 data/snapshot.sql。
// 设计点：
// - 拆 items + item_tags 两表，tag 查询走索引、避免 LIKE 假阳性
// - 全部按主键稳定排序输出，diff 干净（无时间戳/无随机）
// - 由 vme-app 端 SqlSnapshotProvider 用 sql.js 装载
// - 与 vme-app SnapshotProvider.detectType 保持等价（!\[\]\(\) 即 meme）

export interface SnapshotItem {
  id: string
  title?: string
  body?: string
  createdAt: string
  author: { username: string }
  tags?: string[]
  reactionsCount?: number
}

function escSqlString(s: string): string {
  // SQLite 字符串字面量：单引号转义为两个单引号，反斜杠不需要处理
  return s.replace(/'/g, "''")
}

function detectType(body: string): 'text' | 'meme' {
  return /!\[.*?\]\(.*?\)/.test(body || '') ? 'meme' : 'text'
}

const SCHEMA_LINES: string[] = [
  '-- vme snapshot, by vme-content/actions_scripts/createData; loaded by vme-app SqlSnapshotProvider',
  '-- diff 干净依赖稳定排序：items by id ASC, item_tags by (item_id, tag) ASC',
  '',
  'CREATE TABLE items (',
  '  id TEXT PRIMARY KEY,',
  '  title TEXT NOT NULL,',
  '  body TEXT NOT NULL,',
  '  author TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL,',
  '  reactions INTEGER NOT NULL,',
  "  type TEXT NOT NULL CHECK (type IN ('text','meme'))",
  ');',
  'CREATE INDEX idx_items_author ON items(author);',
  'CREATE INDEX idx_items_type ON items(type);',
  'CREATE INDEX idx_items_created ON items(created_at);',
  'CREATE INDEX idx_items_reactions ON items(reactions);',
  '',
  'CREATE TABLE item_tags (',
  '  item_id TEXT NOT NULL,',
  '  tag TEXT NOT NULL,',
  '  PRIMARY KEY (item_id, tag)',
  ');',
  'CREATE INDEX idx_item_tags_tag ON item_tags(tag);',
  '',
  'BEGIN;',
]

export function generateSnapshotSql(items: SnapshotItem[]): string {
  // 稳定排序：items 按 id ASC
  const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id))

  const itemInserts: string[] = []
  const tagRows: { itemId: string; tag: string }[] = []

  for (const it of sortedItems) {
    const id = it.id
    const title = it.title || ''
    const body = it.body || ''
    const author = it.author?.username || 'unknown'
    const createdMs = new Date(it.createdAt).getTime() || 0
    const reactions = it.reactionsCount ?? 0
    const type = detectType(body)

    itemInserts.push(
      `INSERT INTO items VALUES ('${escSqlString(id)}','${escSqlString(title)}','${escSqlString(body)}','${escSqlString(author)}',${createdMs},${reactions},'${type}');`,
    )

    for (const tag of it.tags || []) {
      if (tag && tag.trim()) tagRows.push({ itemId: id, tag })
    }
  }

  // 稳定排序 item_tags：(item_id ASC, tag ASC)
  tagRows.sort(
    (a, b) => a.itemId.localeCompare(b.itemId) || a.tag.localeCompare(b.tag),
  )
  const tagInserts = tagRows.map(
    ({ itemId, tag }) =>
      `INSERT INTO item_tags VALUES ('${escSqlString(itemId)}','${escSqlString(tag)}');`,
  )

  return [...SCHEMA_LINES, ...itemInserts, ...tagInserts, 'COMMIT;', ''].join(
    '\n',
  )
}
