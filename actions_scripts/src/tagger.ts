// 疯四文案打标模块（纯函数 + 内容 hash 缓存）
//
// 设计要点：
// - 与本仓既有风格一致，用原生 fetch 调 OpenAI 兼容接口，不引入 openai SDK（少依赖=抗腐烂）。
// - tagHash = sha256(TAG_PROMPT_VERSION + "\n" + 预处理后的正文)；命中上一版缓存即跳过 LLM，
//   付费只花一次；bump TAG_PROMPT_VERSION 即全量重打标。
// - 失败/无 key/纯图/过短一律回退空标签，绝不抛出——打标永不阻塞数据管线。
//
// 注：此处的 TONE/THEME/STYLE 标签体系与提示词，是从 vme-app 的
// src/lib/sync/content-analyzer.ts + src/lib/tags/taxonomy.ts 移植而来。
// 这是 Phase A 的过渡性重复：A5 会移除 vme-app 侧的打标路径，届时本文件为唯一来源。

import { createHash } from 'node:crypto'

// bump 此版本号即让全部文案在下一轮重打标
export const TAG_PROMPT_VERSION = 1

// ===== 标签体系（镜像 vme-app/src/lib/tags/taxonomy.ts，A5 后此处为唯一来源）=====

const TONE_TAGS = [
  '温情', '荒诞', '抽象', '自嘲', '讽刺', '黑色幽默', '暴躁', '尴尬', '甜蜜',
  '崩溃', '治愈', '魔性', '摆烂', '冷幽默', '心酸', '无奈', '怀旧', '卑微',
  '破防', '凡尔赛', '阴阳怪气', '中二',
]

const THEME_TAGS = [
  '职场', '恋爱', '网恋', '单身', '家庭', '朋友', '群聊', '考试', '校园',
  '租房', '加班', '工资', '游戏', '旅行', '相亲', '熬夜', '宠物', '理财',
  '社交', '追星', '八卦', '创业', '大厂', '面试', '古风',
]

const STYLE_TAGS = [
  '对话', '排比', '谐音梗', '夸张', '押韵', '口号', '通知', '吐槽', '清单',
  '模仿', '诗歌', '书信', '翻译腔', '拟人', '字符画', '角色扮演',
]

const FALLBACK_TAG = '其他'

// ===== 预处理 =====

/** 去掉疯四结尾套话、图片链接、多余空白 */
export function preprocessContent(title: string, body: string): string {
  let text = `${title}\n\n${body}`.slice(0, 6000)
  // 去掉 markdown 图片
  text = text.replace(/!\[.*?\]\(.*?\)/g, '')
  // 去掉疯四结尾套话（贪婪匹配到末尾）
  text = text.replace(/[，,。！!？?\s\n]*(今天是?|因为)?(肯德基|KFC)?疯狂星期四[\s\S]*$/i, '')
  // 去掉散落的 V我50 / vivo50 / V50 等变体
  text = text.replace(/[Vv](我|ivo)?\s*\d{1,3}(块|元)?/g, '')
  // 压缩多余空行
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return text
}

/** 检测是否为纯图片内容（无实质文字） */
export function isImageOnly(title: string, body: string): boolean {
  const textContent = `${title}\n${body}`
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .trim()
  return textContent.length < 10
}

// ===== Tool 定义 =====

const SET_TAGS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'set_tags',
    description: '为疯四文案打标签',
    parameters: {
      type: 'object',
      properties: {
        core: {
          type: 'string',
          description: '一句话概括：去掉KFC结尾后，这篇文案讲了什么？',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '2-3个最精准的标签',
        },
      },
      required: ['core', 'tags'],
    },
  },
}

// ===== Prompt =====

function buildSystemPrompt(): string {
  return `你是疯四文案标签员。给文案打 2-3 个标签。

## 规则
- 文案的KFC/V50结尾已被删除，你看到的是纯正文
- 标签要描述正文的核心创意，不要描述文体格式
- 优先从参考列表选，也可自创2-4字短词
- 每个标签必须具体、有区分度

## 参考标签
情绪：${TONE_TAGS.join('、')}
题材：${THEME_TAGS.join('、')}
手法：${STYLE_TAGS.join('、')}

## 禁止使用的标签
- "反转" — 所有疯四都有反转，标了等于没标
- "故事" — 太笼统，要说清什么类型的故事
- "独白" — 大部分文案都是第一人称，标了没意义
- "美食""外卖""节日" — 已从标签体系移除
- "无厘头" — 已改为"荒诞"，请使用新标签

## 示例

文案：少林寺的方丈位置空出来了，有兴趣的可以转我50，我帮你写推荐信
→ core: 恶搞少林寺方丈招聘
→ tags: ["八卦", "讽刺"]

文案：我是盗号的，看了这个人聊天记录发现他过得非常艰苦
→ core: 假装盗号者同情号主
→ tags: ["社交", "黑色幽默"]

文案：假如你是李华，你的英国笔友Peter向你询问周四的安排，请写一封回信
→ core: 模仿高考英语作文题
→ tags: ["考试", "书信"]

文案：全员核酸检测通知，明日本群进行全员核酸检测，地点：肯德基大门口
→ core: 模仿疫情核酸通知格式
→ tags: ["通知", "讽刺"]

文案：和你分手20年了，你还是那个能影响我情绪的人，整整爱了你二十八年
→ core: 伤感情书风格的感情回忆
→ tags: ["恋爱", "心酸"]

文案：KFC和vivo合作推出了一款手机，叫肯德基疯狂星期四vivo50
→ core: vivo50谐音梗
→ tags: ["谐音梗", "冷幽默"]`
}

// ===== 后处理 =====

// 硬过滤：这些标签区分度太低或经常误判
const BLOCKED_TAGS = new Set([
  '反转', '故事', '独白', '美食', '外卖', '节日',
  '无厘头', // 已改为"荒诞"
  '科技', // 高频误判
])

export function normalizeTags(tags: string[]): string[] {
  const valid = tags
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 6 && !BLOCKED_TAGS.has(t))

  if (valid.length === 0) {
    return [FALLBACK_TAG]
  }
  return [...new Set(valid)].slice(0, 3)
}

// ===== 内容 hash =====

export function computeTagHash(title: string, body: string): string {
  const processed = preprocessContent(title, body)
  return createHash('sha256')
    .update(`${TAG_PROMPT_VERSION}\n${processed}`)
    .digest('hex')
}

// ===== LLM 调用（fetch，重试+超时，失败回退 []）=====

async function requestTags(processed: string): Promise<string[]> {
  const apiKey = process.env.AI_API_KEY
  if (!apiKey) {
    return []
  }

  const base = (process.env.AI_API_BASE_URL || 'https://api.openai.com').replace(/\/$/, '')
  const url = `${base}/v1/chat/completions`
  const model = process.env.LLM_MODEL || 'gpt-5-nano'

  const maxRetries = 3
  const initialBackoff = 1000
  const timeoutMs = 30000

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, initialBackoff * Math.pow(2, attempt - 1)))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'APP-Code': 'USYC0298',
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: `打标签：\n\n${processed}` },
          ],
          tools: [SET_TAGS_TOOL],
          tool_choice: { type: 'function', function: { name: 'set_tags' } },
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (!response.ok) {
        if (attempt < maxRetries - 1) continue
        return []
      }

      const data: any = await response.json()
      const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0]

      if (
        !toolCall ||
        toolCall.type !== 'function' ||
        toolCall.function?.name !== 'set_tags'
      ) {
        return []
      }

      const args = JSON.parse(toolCall.function.arguments)
      const tags = args?.tags
      if (!Array.isArray(tags)) {
        return []
      }
      return normalizeTags(tags)
    } catch (error) {
      clearTimeout(timeout)
      if (attempt < maxRetries - 1) continue
      console.warn('tagger: LLM 调用失败，回退空标签：', error)
      return []
    }
  }

  return []
}

// ===== 主函数 =====

export interface TagCacheEntry {
  tagHash: string
  tags: string[]
}

export interface TagResult {
  tags: string[]
  tagHash: string
  hitCache: boolean
}

/**
 * 为单条文案产出标签。
 * @param input  文案 title / body
 * @param prev   上一版同 id 的缓存（tagHash + tags）；hash 一致则跳过 LLM
 */
export async function tagContent(
  input: { title: string; body: string },
  prev?: TagCacheEntry,
): Promise<TagResult> {
  const title = input.title || ''
  const body = input.body || ''
  const processed = preprocessContent(title, body)
  const tagHash = createHash('sha256')
    .update(`${TAG_PROMPT_VERSION}\n${processed}`)
    .digest('hex')

  // 缓存命中：内容与 prompt 版本均未变，直接复用，不调 LLM
  if (prev && prev.tagHash === tagHash) {
    return { tags: prev.tags, tagHash, hitCache: true }
  }

  // 纯图 / 预处理后过短：稳定回退空标签（仍返回 tagHash，下轮不会重复尝试）
  if (isImageOnly(title, body) || processed.length < 15) {
    return { tags: [], tagHash, hitCache: false }
  }

  const tags = await requestTags(processed)
  return { tags, tagHash, hitCache: false }
}
