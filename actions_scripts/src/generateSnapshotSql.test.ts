import { generateSnapshotSql, type SnapshotItem } from './generateSnapshotSql'

function mkItem(over: Partial<SnapshotItem> & { id: string }): SnapshotItem {
  return {
    title: 't',
    body: 'b',
    createdAt: '2026-05-20T00:00:00.000Z',
    author: { username: 'u' },
    tags: [],
    reactionsCount: 0,
    ...over,
  }
}

describe('generateSnapshotSql', () => {
  it('生成包含 schema + 索引 + 事务的 SQL 文本', () => {
    const sql = generateSnapshotSql([])
    expect(sql).toContain('CREATE TABLE items (')
    expect(sql).toContain("CHECK (type IN ('text','meme'))")
    expect(sql).toContain('CREATE INDEX idx_items_author ON items(author);')
    expect(sql).toContain('CREATE TABLE item_tags (')
    expect(sql).toContain('CREATE INDEX idx_item_tags_tag ON item_tags(tag);')
    expect(sql).toContain('BEGIN;')
    expect(sql).toContain('COMMIT;')
  })

  it('为每条 item 生成 INSERT', () => {
    const sql = generateSnapshotSql([
      mkItem({ id: 'a', title: 'hello', author: { username: 'zkl2333' } }),
    ])
    expect(sql).toContain(
      "INSERT INTO items VALUES ('a','hello','b','zkl2333',",
    )
  })

  it('SQL 注入防护：单引号 escape 为两个单引号', () => {
    const sql = generateSnapshotSql([
      mkItem({ id: "x'1", title: "it's", body: "let's", author: { username: "user's" } }),
    ])
    // 全部单引号都被翻倍
    expect(sql).toContain("'x''1'")
    expect(sql).toContain("'it''s'")
    expect(sql).toContain("'let''s'")
    expect(sql).toContain("'user''s'")
    // 没有未转义的单引号导致 SQL 提前关闭
    expect(sql).not.toMatch(/INSERT INTO items VALUES \('x'1/)
  })

  it('createdAt → epoch 毫秒数', () => {
    const sql = generateSnapshotSql([
      mkItem({ id: 'a', createdAt: '2026-05-20T00:00:00.000Z' }),
    ])
    const expected = new Date('2026-05-20T00:00:00.000Z').getTime()
    expect(sql).toContain(`,${expected},`)
  })

  it('detectType：含 markdown 图片为 meme，否则 text', () => {
    const sql = generateSnapshotSql([
      mkItem({ id: 'a', body: 'plain text' }),
      mkItem({ id: 'b', body: '![](https://x.png) caption' }),
    ])
    const lines = sql.split('\n')
    const lineA = lines.find((l) => l.startsWith("INSERT INTO items VALUES ('a',"))
    const lineB = lines.find((l) => l.startsWith("INSERT INTO items VALUES ('b',"))
    expect(lineA).toMatch(/,'text'\);$/)
    expect(lineB).toMatch(/,'meme'\);$/)
  })

  it('item_tags 用单独表，按 (item_id, tag) 稳定排序', () => {
    const sql = generateSnapshotSql([
      mkItem({ id: 'b', tags: ['z', 'a'] }),
      mkItem({ id: 'a', tags: ['c'] }),
    ])
    const tagLines = sql.split('\n').filter((l) => l.startsWith('INSERT INTO item_tags'))
    expect(tagLines).toEqual([
      "INSERT INTO item_tags VALUES ('a','c');",
      "INSERT INTO item_tags VALUES ('b','a');",
      "INSERT INTO item_tags VALUES ('b','z');",
    ])
  })

  it('items 按 id ASC 稳定排序（输入乱序输出有序）', () => {
    const sql = generateSnapshotSql([
      mkItem({ id: 'c' }),
      mkItem({ id: 'a' }),
      mkItem({ id: 'b' }),
    ])
    const ids = (sql.match(/INSERT INTO items VALUES \('([^']+)'/g) || []).map(
      (m) => m.replace(/INSERT INTO items VALUES \('|'.*$/g, ''),
    )
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('确定性：同一输入两次生成的 SQL 完全一致（diff 干净保证）', () => {
    const items = [
      mkItem({ id: 'b', tags: ['x'] }),
      mkItem({ id: 'a', tags: ['y', 'z'] }),
    ]
    expect(generateSnapshotSql(items)).toBe(generateSnapshotSql(items))
  })

  it('过滤空 tag', () => {
    const sql = generateSnapshotSql([mkItem({ id: 'a', tags: ['', '  ', 'real'] })])
    const tagLines = sql.split('\n').filter((l) => l.startsWith('INSERT INTO item_tags'))
    expect(tagLines).toEqual(["INSERT INTO item_tags VALUES ('a','real');"])
  })

  it('author 缺失退化为 unknown', () => {
    const sql = generateSnapshotSql([
      // @ts-expect-error 测试 runtime 兜底，故意传缺失 author
      { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(sql).toContain("'unknown'")
  })

  it('reactionsCount 默认 0', () => {
    const sql = generateSnapshotSql([mkItem({ id: 'a' })])
    expect(sql).toMatch(/INSERT INTO items VALUES \('a','t','b','u',\d+,0,/)
  })
})
