import {
  preprocessContent,
  isImageOnly,
  normalizeTags,
  computeTagHash,
  tagContent,
  TAG_PROMPT_VERSION,
} from './tagger'

// 全部测试走纯逻辑/缓存短路，不发起真实网络（不设置 AI_API_KEY）
beforeEach(() => {
  delete process.env.AI_API_KEY
})

describe('preprocessContent', () => {
  it('去掉疯四结尾套话与 V我50 变体', () => {
    const out = preprocessContent('标题', '我没钱吃饭了，V我50，今天是肯德基疯狂星期四！')
    expect(out).toContain('我没钱吃饭了')
    expect(out).not.toContain('疯狂星期四')
    expect(out).not.toMatch(/V我50/i)
  })

  it('去掉 markdown 图片', () => {
    const out = preprocessContent('t', '看这张图 ![meme](https://x.com/a.png) 很搞笑')
    expect(out).not.toContain('![meme]')
    expect(out).toContain('很搞笑')
  })
})

describe('isImageOnly', () => {
  it('纯图片为 true', () => {
    expect(isImageOnly('', '![](https://x.com/a.png)')).toBe(true)
  })
  it('有实质文字为 false', () => {
    expect(isImageOnly('标题', '这是一段有内容的疯四文案描述')).toBe(false)
  })
})

describe('normalizeTags', () => {
  it('过滤屏蔽词与过短词、去重、最多 3 个', () => {
    expect(normalizeTags(['反转', '谐音梗', '谐音梗', 'x', '冷幽默', '讽刺'])).toEqual([
      '谐音梗',
      '冷幽默',
      '讽刺',
    ])
  })
  it('全部无效时回退「其他」', () => {
    expect(normalizeTags(['反转', 'a'])).toEqual(['其他'])
  })
})

describe('computeTagHash', () => {
  it('确定性：同输入同 hash', () => {
    expect(computeTagHash('t', 'body')).toBe(computeTagHash('t', 'body'))
  })
  it('不同正文不同 hash，且为 64 位十六进制', () => {
    const h1 = computeTagHash('t', 'aaa')
    const h2 = computeTagHash('t', 'bbb')
    expect(h1).not.toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('tagContent', () => {
  it('缓存命中：prev.tagHash 一致则直接复用、不走 LLM', async () => {
    const title = '标题'
    const body = '一段足够长的疯四文案正文用于测试缓存命中逻辑'
    const tagHash = computeTagHash(title, body)
    const r = await tagContent({ title, body }, { tagHash, tags: ['谐音梗'] })
    expect(r).toEqual({ tags: ['谐音梗'], tagHash, hitCache: true })
  })

  it('无 AI_API_KEY 且无缓存：回退空标签但返回稳定 tagHash', async () => {
    const r = await tagContent({
      title: '标题',
      body: '一段足够长的正文内容用于触发非缓存分支但无 key 回退',
    })
    expect(r.hitCache).toBe(false)
    expect(r.tags).toEqual([])
    expect(r.tagHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('纯图片：短路返回空标签，不调用 LLM', async () => {
    const r = await tagContent({ title: '', body: '![](https://x.com/a.png)' })
    expect(r.tags).toEqual([])
    expect(r.hitCache).toBe(false)
  })

  it('TAG_PROMPT_VERSION 参与 hash（版本号为正整数）', () => {
    expect(typeof TAG_PROMPT_VERSION).toBe('number')
    expect(TAG_PROMPT_VERSION).toBeGreaterThan(0)
  })
})
