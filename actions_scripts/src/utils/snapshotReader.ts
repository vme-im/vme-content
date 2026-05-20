// 装载 data/snapshot.sql（sql.js）并暴露 actions_scripts 侧需要的查询：
// - 历史 issue 列表（用于 moderationLogic 的相似度查重）
// - id → tagHash/tags 缓存映射（用于 createData 打标命中缓存）
//
// 设计选择：与 vme-app 的 SqlSnapshotProvider 同栈（sql.js + wasm），
// 不引入 better-sqlite3 原生模块；snapshot.sql 是机审/打标缓存的唯一真相来源，
// 月份 JSON 与 summary.json 退役（架构 §5）。
//
// 路径定位：约定 `process.cwd() === actions_scripts/`（npx tsx 与 jest 跑法一致），
// 避免使用 import.meta.url（ts-jest commonjs 模式不识别）。
import fs from 'fs'
import path from 'path'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'

export interface SnapshotIssue {
  id: string
  title: string
  body: string
  tagHash: string
  tags: string[]
}

let sqlJsInstance: SqlJsStatic | null = null

async function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsInstance) return sqlJsInstance
  const wasmPath = path.join(
    process.cwd(),
    'node_modules',
    'sql.js',
    'dist',
    'sql-wasm.wasm',
  )
  const buf = fs.readFileSync(wasmPath)
  const wasmBinary = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer
  sqlJsInstance = await initSqlJs({ wasmBinary })
  return sqlJsInstance
}

function defaultSnapshotPath(): string {
  return path.join(process.cwd(), '..', 'data', 'snapshot.sql')
}

async function openSnapshot(snapshotPath: string): Promise<Database | null> {
  if (!fs.existsSync(snapshotPath)) return null
  const sqlText = fs.readFileSync(snapshotPath, 'utf8')
  const SQL = await getSqlJs()
  const db = new SQL.Database()
  db.exec(sqlText)
  return db
}

/**
 * 读取 snapshot.sql 中所有历史 issue（id/title/body/url）；用于查重。
 * 文件不存在或解析失败时返回空数组，机审降级为「无历史」继续跑。
 */
export async function readSnapshotIssues(
  snapshotPath: string = defaultSnapshotPath(),
): Promise<{ id: string; title: string; body: string; url: string }[]> {
  try {
    const db = await openSnapshot(snapshotPath)
    if (!db) return []
    const stmt = db.prepare('SELECT id, title, body, url FROM items')
    const out: { id: string; title: string; body: string; url: string }[] = []
    while (stmt.step()) {
      out.push(
        stmt.getAsObject() as unknown as {
          id: string
          title: string
          body: string
          url: string
        },
      )
    }
    stmt.free()
    db.close()
    return out
  } catch (err) {
    console.error('读取 snapshot.sql 失败，降级为空历史:', err)
    return []
  }
}

/**
 * 读取 snapshot.sql 中所有非空 tag 缓存（id → { tagHash, tags }）。
 * 用于 createData 打标阶段命中缓存、跳过 LLM。
 */
export async function readTagCache(
  snapshotPath: string = defaultSnapshotPath(),
): Promise<Map<string, { tagHash: string; tags: string[] }>> {
  const cache = new Map<string, { tagHash: string; tags: string[] }>()
  try {
    const db = await openSnapshot(snapshotPath)
    if (!db) return cache

    const itemStmt = db.prepare("SELECT id, tag_hash FROM items WHERE tag_hash != ''")
    const idTagHash: { id: string; tag_hash: string }[] = []
    while (itemStmt.step()) {
      idTagHash.push(
        itemStmt.getAsObject() as unknown as { id: string; tag_hash: string },
      )
    }
    itemStmt.free()

    const tagStmt = db.prepare('SELECT item_id, tag FROM item_tags')
    const tagsByItem = new Map<string, string[]>()
    while (tagStmt.step()) {
      const row = tagStmt.getAsObject() as unknown as { item_id: string; tag: string }
      if (!tagsByItem.has(row.item_id)) tagsByItem.set(row.item_id, [])
      tagsByItem.get(row.item_id)!.push(row.tag)
    }
    tagStmt.free()
    db.close()

    for (const { id, tag_hash } of idTagHash) {
      cache.set(id, { tagHash: tag_hash, tags: tagsByItem.get(id) || [] })
    }
    return cache
  } catch (err) {
    console.error('读取 snapshot.sql tag 缓存失败，降级为空缓存:', err)
    return cache
  }
}
