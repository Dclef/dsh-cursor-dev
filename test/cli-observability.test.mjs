/** Cursor CLI 的真实工具详情与异常退出证据回归；全部使用内存流，不启动 Cursor 或网络。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CliSession } from '../lib/cli-runner.js';

/** 模拟宿主进程，明确区分 JSON 结果与实际退出码。 */
function fixture(events, exit = { exitCode: 0, signal: null }) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitted = [];
    const handle = { stdout, stderr, terminate() {}, done: new Promise((resolve, reject) => setImmediate(() => {
        for (const event of events) stdout.write(`${JSON.stringify(event)}\n`);
        stdout.end();
        if (exit instanceof Error) reject(exit);
        else resolve(exit);
    })) };
    const session = new CliSession({ resolved: { command: 'agent' }, cwd: process.cwd(), env: {}, spawn: () => handle }, event => emitted.push(event));
    return { session, emitted };
}

const tool = (subtype, id, name, payload) => ({ type: 'tool_call', subtype, call_id: id, tool_call: { [`${name}ToolCall`]: payload } });
const success = { type: 'result', subtype: 'success' };

test('进程done提前reject也保留正文且不产生未处理拒绝', async () => {
    const { session } = fixture([
        { type: 'assistant', message: { content: [{ type: 'text', text: '部分执行证据' }] } }, success,
    ], new Error('宿主进程异常关闭'));
    await assert.rejects(session.prompt('执行'), error => {
        assert.match(error.message, /宿主进程异常关闭/);
        assert.equal(error.partialTurn.text, '部分执行证据');
        return true;
    });
});

test('进程被信号终止不能被success事件掩盖', async () => {
    const { session } = fixture([success], { exitCode: null, signal: 'SIGTERM' });
    await assert.rejects(session.prompt('执行'), error => {
        assert.equal(error.partialTurn.exitSignal, 'SIGTERM');
        return true;
    });
});

test('父级取消传播到进程、关闭未完成工具并移除监听器', async () => {
    const { getEventListeners } = await import('node:events');
    const abort = new AbortController();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const session = new CliSession({ cwd: process.cwd(), env: {}, resolved: { command: 'agent' }, spawn(spec) {
        spec.signal.addEventListener('abort', () => { stdout.end(); resolveDone({ exitCode: null, signal: 'SIGTERM' }); }, { once: true });
        setImmediate(() => {
            stdout.write(`${JSON.stringify(tool('started', 'c1', 'shell', { args: { command: 'npm test' } }))}\n`);
            setImmediate(() => abort.abort(new Error('父任务取消')));
        });
        return { stdout, stderr, done, terminate() {} };
    } }, () => {});
    await assert.rejects(session.prompt('执行', abort.signal), error => {
        assert.equal(error.partialTurn.stopReason, 'cancelled');
        assert.equal(error.partialTurn.calls[0].status, 'cancelled');
        return true;
    });
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('工具名称、请求参数和读文件结果都进入共享事件，而不是 cursor tool / {}', async () => {
    const { session, emitted } = fixture([
        tool('started', 'read-1', 'read', { args: { path: 'README.md', startLine: 1 } }),
        tool('completed', 'read-1', 'read', { result: { success: { content: '真实读文件内容', totalLines: 1 } } }), success,
    ]);
    const turn = await session.prompt('读取文件');
    const started = emitted.find(event => event.kind === 'tool-call').call;
    assert.equal(started.name, 'read');
    assert.deepEqual(started.input, { path: 'README.md', startLine: 1 });
    const completed = turn.calls[0];
    assert.equal(completed.path, 'README.md', '完成事件缺参时仍保留开始参数');
    assert.deepEqual(completed.input, started.input);
    assert.match(completed.output, /真实读文件内容/);
});

test('缺少最终result时保留部分步骤并关闭未完成工具，绝不冒充成功', async () => {
    const { session, emitted } = fixture([
        tool('started', 'edit-1', 'edit', { args: { path: 'a.js', oldString: 'a', newString: 'b' } }),
        { type: 'assistant', message: { content: [{ type: 'text', text: '已开始修改' }] } },
    ]);
    let failure;
    try { await session.prompt('修改'); } catch (error) { failure = error; }
    assert.match(failure.message, /no result event/);
    assert.equal(failure.partialTurn.text, '已开始修改');
    assert.equal(failure.partialTurn.calls.length, 1);
    assert.equal(failure.partialTurn.calls[0].status, 'failed');
    assert.ok(emitted.some(event => event.kind === 'tool-update' && event.call.status === 'failed'));
    assert.equal(session.turns.at(-1).stopReason, 'error');
});

test('有success JSON但实际进程退出非零仍失败，保留退出码', async () => {
    const { session } = fixture([success], { exitCode: 7, signal: null });
    await assert.rejects(session.prompt('执行'), error => {
        assert.match(error.message, /exit.*7|7.*exit/i);
        assert.equal(error.partialTurn.stopReason, 'error');
        return true;
    });
});

test('结果事件里的最终文本在没有assistant消息时仍可读', async () => {
    const { session } = fixture([{ ...success, result: '已完成最后一个步骤' }]);
    const turn = await session.prompt('执行');
    assert.equal(turn.text, '已完成最后一个步骤');
});

test('工具失败的错误正文保留，完成事件无started仍显示真实参数', async () => {
    const { session } = fixture([
        tool('completed', 'shell-1', 'shell', { args: { command: 'npm test' }, result: { error: { message: '测试失败：3个断言', exitCode: 1 } } }), success,
    ]);
    const turn = await session.prompt('测试');
    assert.equal(turn.calls[0].name, 'shell');
    assert.deepEqual(turn.calls[0].input, { command: 'npm test' });
    assert.equal(turn.calls[0].status, 'failed');
    assert.match(turn.calls[0].output, /3个断言/);
});