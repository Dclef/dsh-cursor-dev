/** 异常/取消后的真实文件证据回归；使用临时目录和内存会话，不调用 Cursor 或网络。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cursorCodeTool, renderCursorReport } from '../lib/tool.js';
import { RunJournal } from '../lib/journal.js';

/** 最小宿主池：只伪造进程执行，文件指纹和工具结果均使用生产实现。 */
function harness(prompt, options = {}) {
    const journal = new RunJournal({});
    const records = [];
    const turns = [];
    const session = {
        sessionId: 'cursor-partial', reportedModel: 'test-model', modes: { currentModeId: 'agent' },
        prompt: () => prompt(journal), dispose() {},
    };
    const pool = {
        persistedFor: () => undefined,
        pickKey: () => ({ key: 'parent::evidence#1', generation: 1 }),
        run: async (_options, callback) => {
            if (options.beforeLeaseError) throw new Error('进程未能启动');
            return callback({ session, reused: false });
        },
        recordTurn: (_key, turn) => turns.push(turn),
    };
    const tool = cursorCodeTool({ pool, journal, index: { get: async () => undefined, set: async (...record) => records.push(record) }, maxScanFiles: options.maxScanFiles ?? 100 });
    return { tool, records, turns };
}

/** 创建只属于本测试的临时目录，保留可验证的用户已有文件。 */
async function workspace(t) {
    const root = await mkdtemp(join(tmpdir(), 'cursor-evidence-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'user.txt'), '用户原有未提交内容');
    return root;
}

test('CLI失败仍报告真实修改/新文件、partial步骤和可续会话，绝不返回files changed NONE', async t => {
    const root = await workspace(t);
    const { tool, records, turns } = harness(async journal => {
        journal.append('parent::evidence#1', { kind: 'tool-call', call: { id: 'c1', name: 'edit', kind: 'edit', status: 'running', path: 'new.txt' } });
        await writeFile(join(root, 'user.txt'), '用户原有未提交内容加上本轮更改');
        await writeFile(join(root, 'new.txt'), 'CLI已经写下的内容');
        const partialTurn = { text: '已修改，但测试尚未执行', reasoning: '部分推理', calls: [], diffs: [], stopReason: 'error', durationMs: 12, exitCode: 9, stderrTail: 'terminal missing' };
        throw Object.assign(new Error('the CLI produced no result event'), { partialTurn });
    });
    const value = await tool.execute({ task: '修改文件', workspaceRoot: root, report: 'detailed' }, { agent: { id: 'parent' }, signal: new AbortController().signal });
    assert.equal(value.ok, false);
    assert.deepEqual(value.changes.map(change => [change.path, change.operation]).sort(), [['new.txt', 'created'], ['user.txt', 'modified']]);
    assert.equal(value.preview.length, 2);
    assert.equal(value.changeStatus, 'complete');
    assert.equal(value.exitCode, 9);
    assert.equal(value.text, '已修改，但测试尚未执行');
    assert.equal(value.reasoning, '部分推理');
    assert.equal(value.steps.length, 1);
    assert.equal(records.length, 1, '失败会话仍持久化，后续continue不能丢会话');
    assert.equal(records[0][1].cursorSessionId, 'cursor-partial');
    assert.equal(turns.length, 1);
    assert.match(renderCursorReport(value)[0].text, /files changed \(2\)/);
    assert.doesNotMatch(renderCursorReport(value)[0].text, /files changed: NONE/);
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'CLI已经写下的内容');
});

test('开始扫描前启动失败只能报告变更未知，不能断言没有修改', async t => {
    const root = await workspace(t);
    const { tool } = harness(() => assert.fail('不应执行'), { beforeLeaseError: true });
    const value = await tool.execute({ task: '执行', workspaceRoot: root }, { agent: { id: 'parent' } });
    assert.equal(value.changeStatus, 'unavailable');
    assert.match(renderCursorReport(value)[0].text, /UNKNOWN|unavailable|未确认/);
    assert.doesNotMatch(renderCursorReport(value)[0].text, /files changed: NONE/);
});

test('取消后仍保留已落盘内容，并明确标记cancelled而非成功', async t => {
    const root = await workspace(t);
    const abort = new AbortController();
    const { tool } = harness(async () => {
        await writeFile(join(root, 'partial.txt'), '取消前已写入');
        abort.abort();
        throw Object.assign(new Error('cancelled'), { partialTurn: { text: '尚未完成', diffs: [], stopReason: 'cancelled' } });
    });
    const value = await tool.execute({ task: '修改', workspaceRoot: root }, { agent: { id: 'parent' }, signal: abort.signal });
    assert.equal(value.ok, false);
    assert.equal(value.stopReason, 'cancelled');
    assert.ok(value.changes.some(change => change.path === 'partial.txt'));
    assert.equal(value.changeStatus, 'complete');
});