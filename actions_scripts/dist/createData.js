import { O as Octokit, c as core } from './index-BHzAQa0b.js';
import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import 'os';
import 'http';
import 'https';
import 'net';
import 'tls';
import 'events';
import 'assert';
import 'util';
import 'stream';
import 'buffer';
import 'querystring';
import 'stream/web';
import 'node:stream';
import 'node:util';
import 'node:events';
import 'worker_threads';
import 'perf_hooks';
import 'util/types';
import 'async_hooks';
import 'console';
import 'zlib';
import 'string_decoder';
import 'diagnostics_channel';

async function fetchIssues(owner, name, labels, afterCursor = null) {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const query = `query ($owner: String!, $name: String!, $labels: [String!], $afterCursor: String) {
    repository(owner: $owner, name: $name) {
      issues(labels: $labels, first: 10, after: $afterCursor) {
        edges {
          node {
            id
            title
            url
            body
            createdAt
            updatedAt
            author {
              username: login
              avatarUrl
              url
            }
            reactions(first: 0) {
              totalCount
            }
          }
          cursor
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }`;
    const variables = {
        owner,
        name,
        labels,
        afterCursor,
    };
    const data = await octokit.graphql(query, variables);
    const issues = data.repository.issues.edges.map((edge) => {
        var _a;
        const { reactions, ...rest } = edge.node;
        return { ...rest, reactionsCount: (_a = reactions === null || reactions === void 0 ? void 0 : reactions.totalCount) !== null && _a !== void 0 ? _a : 0 };
    });
    const pageInfo = data.repository.issues.pageInfo;
    if (pageInfo.hasNextPage && pageInfo.endCursor) {
        return issues.concat(await fetchIssues(owner, name, labels, pageInfo.endCursor));
    }
    else {
        return issues;
    }
}

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
// bump 此版本号即让全部文案在下一轮重打标
const TAG_PROMPT_VERSION = 1;
// ===== 标签体系（镜像 vme-app/src/lib/tags/taxonomy.ts，A5 后此处为唯一来源）=====
const TONE_TAGS = [
    '温情', '荒诞', '抽象', '自嘲', '讽刺', '黑色幽默', '暴躁', '尴尬', '甜蜜',
    '崩溃', '治愈', '魔性', '摆烂', '冷幽默', '心酸', '无奈', '怀旧', '卑微',
    '破防', '凡尔赛', '阴阳怪气', '中二',
];
const THEME_TAGS = [
    '职场', '恋爱', '网恋', '单身', '家庭', '朋友', '群聊', '考试', '校园',
    '租房', '加班', '工资', '游戏', '旅行', '相亲', '熬夜', '宠物', '理财',
    '社交', '追星', '八卦', '创业', '大厂', '面试', '古风',
];
const STYLE_TAGS = [
    '对话', '排比', '谐音梗', '夸张', '押韵', '口号', '通知', '吐槽', '清单',
    '模仿', '诗歌', '书信', '翻译腔', '拟人', '字符画', '角色扮演',
];
const FALLBACK_TAG = '其他';
// ===== 预处理 =====
/** 去掉疯四结尾套话、图片链接、多余空白 */
function preprocessContent(title, body) {
    let text = `${title}\n\n${body}`.slice(0, 6000);
    // 去掉 markdown 图片
    text = text.replace(/!\[.*?\]\(.*?\)/g, '');
    // 去掉疯四结尾套话（贪婪匹配到末尾）
    text = text.replace(/[，,。！!？?\s\n]*(今天是?|因为)?(肯德基|KFC)?疯狂星期四[\s\S]*$/i, '');
    // 去掉散落的 V我50 / vivo50 / V50 等变体
    text = text.replace(/[Vv](我|ivo)?\s*\d{1,3}(块|元)?/g, '');
    // 压缩多余空行
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
}
/** 检测是否为纯图片内容（无实质文字） */
function isImageOnly(title, body) {
    const textContent = `${title}\n${body}`
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .trim();
    return textContent.length < 10;
}
// ===== Tool 定义 =====
const SET_TAGS_TOOL = {
    type: 'function',
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
};
// ===== Prompt =====
function buildSystemPrompt() {
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
→ tags: ["谐音梗", "冷幽默"]`;
}
// ===== 后处理 =====
// 硬过滤：这些标签区分度太低或经常误判
const BLOCKED_TAGS = new Set([
    '反转', '故事', '独白', '美食', '外卖', '节日',
    '无厘头', // 已改为"荒诞"
    '科技', // 高频误判
]);
function normalizeTags(tags) {
    const valid = tags
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && t.length <= 6 && !BLOCKED_TAGS.has(t));
    if (valid.length === 0) {
        return [FALLBACK_TAG];
    }
    return [...new Set(valid)].slice(0, 3);
}
// ===== 内容 hash =====
function computeTagHash(title, body) {
    const processed = preprocessContent(title, body);
    return createHash('sha256')
        .update(`${TAG_PROMPT_VERSION}\n${processed}`)
        .digest('hex');
}
// ===== LLM 调用（fetch，重试+超时，失败回退 []）=====
async function requestTags(processed) {
    var _a, _b, _c, _d, _e;
    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) {
        return [];
    }
    const base = (process.env.AI_API_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
    const url = `${base}/v1/chat/completions`;
    const model = process.env.LLM_MODEL || 'gpt-5-nano';
    const maxRetries = 3;
    const initialBackoff = 1000;
    const timeoutMs = 30000;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (attempt > 0) {
            await new Promise((r) => setTimeout(r, initialBackoff * Math.pow(2, attempt - 1)));
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
            });
            clearTimeout(timeout);
            if (!response.ok) {
                if (attempt < maxRetries - 1)
                    continue;
                return [];
            }
            const data = await response.json();
            const toolCall = (_d = (_c = (_b = (_a = data === null || data === void 0 ? void 0 : data.choices) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.message) === null || _c === void 0 ? void 0 : _c.tool_calls) === null || _d === void 0 ? void 0 : _d[0];
            if (!toolCall ||
                toolCall.type !== 'function' ||
                ((_e = toolCall.function) === null || _e === void 0 ? void 0 : _e.name) !== 'set_tags') {
                return [];
            }
            const args = JSON.parse(toolCall.function.arguments);
            const tags = args === null || args === void 0 ? void 0 : args.tags;
            if (!Array.isArray(tags)) {
                return [];
            }
            return normalizeTags(tags);
        }
        catch (error) {
            clearTimeout(timeout);
            if (attempt < maxRetries - 1)
                continue;
            console.warn('tagger: LLM 调用失败，回退空标签：', error);
            return [];
        }
    }
    return [];
}
/**
 * 为单条文案产出标签。
 * @param input  文案 title / body
 * @param prev   上一版同 id 的缓存（tagHash + tags）；hash 一致则跳过 LLM
 */
async function tagContent(input, prev) {
    const title = input.title || '';
    const body = input.body || '';
    const processed = preprocessContent(title, body);
    const tagHash = createHash('sha256')
        .update(`${TAG_PROMPT_VERSION}\n${processed}`)
        .digest('hex');
    // 缓存命中：内容与 prompt 版本均未变，直接复用，不调 LLM
    if (prev && prev.tagHash === tagHash) {
        return { tags: prev.tags, tagHash, hitCache: true };
    }
    // 纯图 / 预处理后过短：稳定回退空标签（仍返回 tagHash，下轮不会重复尝试）
    if (isImageOnly(title, body) || processed.length < 15) {
        return { tags: [], tagHash, hitCache: false };
    }
    const tags = await requestTags(processed);
    return { tags, tagHash, hitCache: false };
}

// 生成 vme 快照 SQL 文本（CREATE + INDEX + INSERT），由 createData 写入 data/snapshot.sql。
// 设计点：
// - 拆 items + item_tags 两表，tag 查询走索引、避免 LIKE 假阳性
// - 全部按主键稳定排序输出，diff 干净（无时间戳/无随机）
// - 由 vme-app 端 SqlSnapshotProvider 用 sql.js 装载
// - 与 vme-app SnapshotProvider.detectType 保持等价（!\[\]\(\) 即 meme）
function escSqlString(s) {
    // SQLite 字符串字面量：单引号转义为两个单引号，反斜杠不需要处理
    return s.replace(/'/g, "''");
}
function detectType(body) {
    return /!\[.*?\]\(.*?\)/.test(body || '') ? 'meme' : 'text';
}
const SCHEMA_LINES = [
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
];
function generateSnapshotSql(items) {
    var _a, _b;
    // 稳定排序：items 按 id ASC
    const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const itemInserts = [];
    const tagRows = [];
    for (const it of sortedItems) {
        const id = it.id;
        const title = it.title || '';
        const body = it.body || '';
        const author = ((_a = it.author) === null || _a === void 0 ? void 0 : _a.username) || 'unknown';
        const createdMs = new Date(it.createdAt).getTime() || 0;
        const reactions = (_b = it.reactionsCount) !== null && _b !== void 0 ? _b : 0;
        const type = detectType(body);
        itemInserts.push(`INSERT INTO items VALUES ('${escSqlString(id)}','${escSqlString(title)}','${escSqlString(body)}','${escSqlString(author)}',${createdMs},${reactions},'${type}');`);
        for (const tag of it.tags || []) {
            if (tag && tag.trim())
                tagRows.push({ itemId: id, tag });
        }
    }
    // 稳定排序 item_tags：(item_id ASC, tag ASC)
    tagRows.sort((a, b) => a.itemId.localeCompare(b.itemId) || a.tag.localeCompare(b.tag));
    const tagInserts = tagRows.map(({ itemId, tag }) => `INSERT INTO item_tags VALUES ('${escSqlString(itemId)}','${escSqlString(tag)}');`);
    return [...SCHEMA_LINES, ...itemInserts, ...tagInserts, 'COMMIT;', ''].join('\n');
}

// 获取当前文件的路径
const __filename = fileURLToPath(import.meta.url);
// 获取当前文件所在的目录
const __dirname = path.dirname(__filename);
// 单一数据源配置：live 只抓自有仓 vme-im/vme-content（A1+A3 收敛单仓）。
// rin0chan/KFC-Crazy-Thursday（原 whitescent）已停更，其 139 条历史冻结于
// data/archive-rin0chan.json，由下方合并、不再 live 抓取（见 docs/architecture.md A3）。
const SOURCE_REPOS = [
    { owner: 'vme-im', repo: 'vme-content', labels: ['收录'] },
];
async function createData() {
    console.log('开始创建数据');
    if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN 必须存在');
    }
    const liveItems = (await Promise.all(SOURCE_REPOS.map(({ owner, repo, labels }) => fetchIssues(owner, repo, labels)))).flat();
    const dataDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log(`创建目录: ${dataDir}`);
    }
    // 整体覆盖前，先从现有按月文件收集 tag 缓存（id -> {tagHash, tags}），避免丢标
    const tagCache = new Map();
    for (const f of fs.readdirSync(dataDir)) {
        if (!/^\d{4}-\d{2}\.json$/.test(f))
            continue;
        const prev = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
        for (const it of prev) {
            if (!it || typeof it.id !== 'string' || !Array.isArray(it.tags) || it.tags.length === 0) {
                continue;
            }
            if (typeof it.tagHash === 'string' && it.tagHash) {
                tagCache.set(it.id, { tagHash: it.tagHash, tags: it.tags });
            }
            else {
                // 回填的 tag 无 tagHash：用规范算法现算，使首跑即缓存命中、不调 LLM、不覆盖已有标签
                tagCache.set(it.id, {
                    tagHash: computeTagHash(it.title || '', it.body || ''),
                    tags: it.tags,
                });
            }
        }
    }
    // 合并冻结归档（rin0chan 139 条，不再 live 抓取）
    const archivePath = path.join(dataDir, 'archive-rin0chan.json');
    const archived = fs.existsSync(archivePath)
        ? JSON.parse(fs.readFileSync(archivePath, 'utf8'))
        : [];
    const data = [
        ...liveItems.map((it) => ({ ...it, sourceRepo: 'vme-im/vme-content' })),
        ...archived.map((it) => ({ reactionsCount: 0, ...it })),
    ];
    console.log(`获取到 ${liveItems.length} 条（live）+ ${archived.length} 条（冻结归档）= ${data.length}`);
    // 打标：命中缓存跳过 LLM；失败/无 key 回退空标签，不阻塞
    let reTagged = 0;
    let cacheHit = 0;
    for (const item of data) {
        const r = await tagContent({ title: item.title || '', body: item.body || '' }, tagCache.get(item.id));
        item.tags = r.tags;
        item.tagHash = r.tagHash;
        if (r.hitCache)
            cacheHit++;
        else
            reTagged++;
    }
    console.log(`打标完成：缓存命中 ${cacheHit}，重算 ${reTagged}`);
    // 按月份分组数据（使用中国时间 UTC+8）
    const dataByMonth = {};
    data.forEach((item) => {
        // 创建中国时区的日期对象
        const utcDate = new Date(item.createdAt);
        const chinaTime = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000); // UTC+8
        const month = `${chinaTime.getFullYear()}-${String(chinaTime.getMonth() + 1).padStart(2, '0')}`;
        if (!dataByMonth[month]) {
            dataByMonth[month] = [];
        }
        dataByMonth[month].push(item);
    });
    // 记录更改的文件
    const changedFiles = [];
    // 统计贡献者信息
    const contributorMap = new Map();
    data.forEach((item) => {
        const { username, avatarUrl, url } = item.author;
        if (contributorMap.has(username)) {
            contributorMap.get(username).count++;
        }
        else {
            contributorMap.set(username, {
                username,
                count: 1,
                avatarUrl,
                url,
            });
        }
    });
    // 转换为数组并按贡献数排序
    const contributors = Array.from(contributorMap.values())
        .sort((a, b) => b.count - a.count);
    // 获取前10名贡献者用于排行榜
    const topContributors = contributors.slice(0, 10);
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
    };
    // 写入汇总信息
    const summaryPath = path.join(dataDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`汇总信息已写入: ${summaryPath}`);
    changedFiles.push(summaryPath);
    // 删除不再属于当前数据集的陈旧按月文件（清除旧管线/旧仓身份残留的僵尸条目，
    // 使磁盘月文件 == summary == data；删除路径并入 changedFiles 以随提交一并落库）
    const currentMonths = new Set(Object.keys(dataByMonth));
    for (const f of fs.readdirSync(dataDir)) {
        if (!/^\d{4}-\d{2}\.json$/.test(f))
            continue;
        if (!currentMonths.has(f.slice(0, 7))) {
            const stale = path.join(dataDir, f);
            fs.unlinkSync(stale);
            console.log(`删除陈旧月份文件: ${stale}`);
            changedFiles.push(stale);
        }
    }
    // 将数据按月份写入对应文件
    for (const [month, items] of Object.entries(dataByMonth)) {
        const filePath = path.join(dataDir, `${month}.json`);
        fs.writeFileSync(filePath, JSON.stringify(items, null, 2));
        console.log(`月份数据已写入: ${filePath}，共 ${items.length} 条`);
        // 直接记录文件的绝对路径
        changedFiles.push(filePath);
    }
    // 生成 SQL 快照（供 vme-app SqlSnapshotProvider 装载，兑现架构 §5「无正文索引 + 正文按需」）
    const snapshotSqlPath = path.join(dataDir, 'snapshot.sql');
    fs.writeFileSync(snapshotSqlPath, generateSnapshotSql(data));
    console.log(`SQL 快照已写入: ${snapshotSqlPath}`);
    changedFiles.push(snapshotSqlPath);
    // 提交到仓库
    execSync('git config --global user.name github-actions[bot]');
    execSync('git config --global user.email github-actions[bot]@users.noreply.github.com');
    // 检查文件变化并提交
    if (changedFiles.length > 0) {
        console.log('文件有变化，开始提交到仓库');
        try {
            // 添加所有更改的文件
            changedFiles.forEach((file) => {
                console.log(`正在添加: ${file}`);
                execSync(`git add "${file}"`);
            });
            execSync('git commit -m "自动更新按月份数据"');
            execSync('git push');
            console.log('数据变化已经提交到仓库');
        }
        catch (error) {
            if (error instanceof Error) {
                console.error('提交过程中发生错误：', error.message);
                throw error;
            }
            else {
                console.log('发生了未知类型的错误');
            }
        }
    }
    else {
        console.log('数据没有变化，跳过提交');
    }
}
createData().catch((err) => core.setFailed(err.message));
