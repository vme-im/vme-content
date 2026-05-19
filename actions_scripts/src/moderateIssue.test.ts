import nock from 'nock'
import { moderateIssue } from './moderateIssue'
import {
  addCommentToIssue,
  addLabelsToIssue,
  closeIssue,
  findSimilarIssue,
  getIssueLabels,
} from './utils'

jest.mock('@actions/core', () => ({
  setFailed: jest.fn(),
}))
jest.mock('@actions/github')
jest.mock('./utils', () => ({
  addCommentToIssue: jest.fn(),
  addLabelsToIssue: jest.fn(),
  closeIssue: jest.fn(),
  findSimilarIssue: jest.fn(),
  dispatchWorkflow: jest.fn(),
  getIssueLabels: jest.fn(),
  getIssueId: jest.fn().mockResolvedValue('test-issue-id'),
}))
jest.mock('@actions/github', () => ({
  context: {
    issue: {
      number: 1,
    },
  },
}))

// 使用类型断言
const mockedFindSimilarIssue = findSimilarIssue as jest.MockedFunction<
  typeof findSimilarIssue
>
const mockedGetIssueLabels = getIssueLabels as jest.MockedFunction<
  typeof getIssueLabels
>

nock.emitter.on('no match', (req) => {
  console.log('No match for request', req)
})

describe('moderateIssue', () => {
  beforeEach(() => {
    process.env.ISSUE_BODY = '这是一个测试的issue内容'
    process.env.AI_API_KEY = 'test-api-key'
    process.env.AI_API_BASE_URL = 'https://aihubmix.com'
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    nock.cleanAll()
    jest.clearAllMocks()
    delete process.env.ISSUE_BODY
    delete process.env.AI_API_KEY
    delete process.env.AI_API_BASE_URL
    ;(console.log as jest.Mock).mockRestore()
    ;(console.error as jest.Mock).mockRestore()
  })

  it('当issue已有审核标签时，应该跳过审核过程', async () => {
    // 模拟issue已有"收录"标签
    mockedGetIssueLabels.mockResolvedValueOnce(['bug', '收录'])

    await moderateIssue()

    // 验证不再进行后续的审核操作
    expect(findSimilarIssue).not.toHaveBeenCalled()
    expect(addLabelsToIssue).not.toHaveBeenCalled()
    expect(addCommentToIssue).not.toHaveBeenCalled()
    expect(closeIssue).not.toHaveBeenCalled()
  })

  it('当issue已有待审标签时，应该跳过审核过程', async () => {
    // 模拟issue已有"待审"标签
    mockedGetIssueLabels.mockResolvedValueOnce(['待审'])

    await moderateIssue()

    // 验证不再进行后续的审核操作
    expect(findSimilarIssue).not.toHaveBeenCalled()
    expect(addLabelsToIssue).not.toHaveBeenCalled()
    expect(addCommentToIssue).not.toHaveBeenCalled()
    expect(closeIssue).not.toHaveBeenCalled()
  })

  it('当重复提交时，应该添加重复标签并关闭 issue', async () => {
    // 模拟issue没有任何审核标签
    mockedGetIssueLabels.mockResolvedValueOnce([])

    const similarIssue = {
      id: 'abc123',
      title: '测试标题',
      body: '这是一个测试的issue内容',
      url: 'https://github.com/owner/repo/issues/2',
      createdAt: '2021-01-01T00:00:00Z',
      updatedAt: '2021-01-01T00:00:00Z',
      reactionsCount: 0,
      author: {
        username: 'test-user',
        avatarUrl: 'https://github.com/test-user.png',
        url: 'https://github.com/test-user',
      },
    }

    mockedFindSimilarIssue.mockResolvedValueOnce(similarIssue)

    await moderateIssue()

    expect(addLabelsToIssue).toHaveBeenCalledWith(1, ['重复'])
    expect(addCommentToIssue).toHaveBeenCalledWith(
      1,
      expect.stringContaining('相似'),
    )
    expect(closeIssue).toHaveBeenCalledWith(1)
  })

  it('当内容被标记时，应该添加违规标签并关闭 issue', async () => {
    // 模拟issue没有任何审核标签
    mockedGetIssueLabels.mockResolvedValueOnce([])

    mockedFindSimilarIssue.mockResolvedValueOnce(null)
    nock('https://aihubmix.com')
      .post('/v1/moderations')
      .reply(200, {
        results: [
          {
            flagged: true,
            categories: {
              hate: false,
              sexual: false,
              violence: true,
              'self-harm': false,
            },
          },
        ],
      })

    await moderateIssue()

    expect(addLabelsToIssue).toHaveBeenCalledWith(1, ['违规'])
    expect(addCommentToIssue).toHaveBeenCalledWith(
      1,
      expect.stringContaining('不予收录'),
    )
    expect(closeIssue).toHaveBeenCalledWith(1)
  })

  it('当内容被标记并且没有准确的分类时，应该添加待审标签', async () => {
    // 模拟issue没有任何审核标签
    mockedGetIssueLabels.mockResolvedValueOnce([])

    mockedFindSimilarIssue.mockResolvedValueOnce(null)
    nock('https://aihubmix.com')
      .post('/v1/moderations')
      .reply(200, {
        results: [
          {
            flagged: true,
            categories: {
              hate: false,
              sexual: false,
              violence: false,
              'self-harm': false,
            },
          },
        ],
      })

    await moderateIssue()

    expect(addLabelsToIssue).toHaveBeenCalledWith(1, ['待审'])
    expect(addCommentToIssue).toHaveBeenCalledWith(
      1,
      expect.stringContaining('审核'),
    )
  })

  it('当内容未被标记时，应该添加收录标签并关闭 issue', async () => {
    // 模拟issue没有任何审核标签
    mockedGetIssueLabels.mockResolvedValueOnce([])

    mockedFindSimilarIssue.mockResolvedValueOnce(null)
    nock('https://aihubmix.com')
      .post('/v1/moderations')
      .reply(200, {
        results: [
          {
            flagged: false,
            categories: {
              hate: false,
              sexual: false,
              violence: false,
              'self-harm': false,
            },
          },
        ],
      })

    await moderateIssue()

    expect(addLabelsToIssue).toHaveBeenCalledWith(1, ['收录'])
    expect(closeIssue).toHaveBeenCalledWith(1)
  })

  it('当接口返回错误时，应该标记为待审', async () => {
    // 模拟issue没有任何审核标签
    mockedGetIssueLabels.mockResolvedValueOnce([])

    mockedFindSimilarIssue.mockResolvedValueOnce(null)
    // 由于有重试机制（3次），需要mock 3次请求
    nock('https://aihubmix.com')
      .post('/v1/moderations')
      .times(3)
      .reply(200, {
        error: {
          message: '接口错误',
        },
      })

    // 现在不再抛错，而是标记为待审
    await moderateIssue()

    expect(addLabelsToIssue).toHaveBeenCalledWith(1, ['待审'])
    expect(addCommentToIssue).toHaveBeenCalledWith(
      1,
      expect.stringContaining('自动审核暂时不可用'),
    )
  })
})
