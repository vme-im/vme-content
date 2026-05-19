import { c as core } from './index-BHzAQa0b.js';
import { g as github, m as moderateContent, t as triggerDataUpdate } from './moderationLogic-BnDm03sX.js';
import 'os';
import 'fs';
import 'path';
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
import 'url';
import 'zlib';
import 'string_decoder';
import 'diagnostics_channel';
import 'sharp';

async function moderateIssue(issueNumber, issueBody) {
    // 如果没有传入参数，则使用环境变量（向后兼容）
    const targetIssueNumber = issueNumber || github.context.issue.number;
    const targetIssueBody = issueBody || process.env.ISSUE_BODY;
    if (!targetIssueBody) {
        throw new Error('ISSUE_BODY 不存在');
    }
    const result = await moderateContent(targetIssueNumber, targetIssueBody, false);
    // 如果审核通过（非跳过），触发数据更新
    if (result.type === 'approved') {
        await triggerDataUpdate();
    }
    console.log(`审核完成，结果: ${result.type}`, result.message || '');
}
moderateIssue().catch((err) => core.setFailed(err.message));

export { moderateIssue };
