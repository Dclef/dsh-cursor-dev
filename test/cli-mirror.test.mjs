/** 真实 CLI 解析器到真实子会话镜像的离线集成，不把工具名/参数/结果预先伪造成归一化事件。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CliSession } from '../lib/cli-runner.js';
import { CursorMirror } from '../lib/mirror.js';

/** 记录子会话事件，同时校验工具公告、执行与结果使用相同 ID/名称/参数。 */
function childLog() {
    const events = [];
    const calls = new Map();
    return { events, snapshotEvents: () => events, append(type, data, opts) {
        if (type === 'assistant/message') for (const block of data.message.content) {
            if (block.type === 'tool-call') calls.set(block.id, { name: block.name, arguments: block.arguments });
        }
        if (type === 'tool/call') assert.deepEqual(calls.get(data.callId), { name: data.name, arguments: data.arguments });
        if (type === 'tool/result') assert.ok(calls.has(data.message.toolCallId));
        const event = { seq: events.length, type, data, ...opts };
        events.push(event);
        return event;
    } };
}

/** 将真实 stream-json 输入生产解析器，并经生产镜像写入子会话。 */
test('取消的工具卡片不能标记为成功结果', () => {
    const child = childLog();
    const mirror = new CursorMirror(child, 'test-model');
    mirror.begin('取消工具');
    mirror.observe({ kind: 'tool-call', call: { id: 'cancel-1', name: 'shell', input: { command: 'npm test' }, status: 'running' } });
    mirror.observe({ kind: 'tool-update', call: { id: 'cancel-1', status: 'cancelled', output: '父任务已取消' } });
    mirror.finish({ ok: false, stopReason: 'cancelled' });
    const result = child.events.find(event => event.type === 'tool/result').data.message;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /父任务已取消/);
});

async function run(events) {
    const child = childLog();
    const mirror = new CursorMirror(child, 'test-model');
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const handle = { stdout, stderr, terminate() {}, done: new Promise(resolve => setImmediate(() => {
        for (const event of events) stdout.write(`${JSON.stringify(event)}\n`);
        stdout.end();
        resolve({ exitCode: 0, signal: null });
    })) };
    const cli = new CliSession({ cwd: process.cwd(), env: {}, resolved: { command: 'agent' }, spawn: () => handle }, event => mirror.observe(event));
    mirror.begin('执行真实工具');
    try { mirror.finish({ ...await cli.prompt('执行真实工具'), ok: true }); }
    catch (error) { mirror.finish({ ...error.partialTurn, error: error.message, ok: false }); }
    assert.equal(mirror.open, false);
    return child.events;
}

test('真实CLI读文件事件在子会话展示read、文件参数与实际内容，不再只有{}和completed', async () => {
    const events = await run([
        { type: 'tool_call', subtype: 'started', call_id: 'r1', tool_call: { readToolCall: { args: { path: 'sample.ts' } } } },
        { type: 'tool_call', subtype: 'completed', call_id: 'r1', tool_call: { readToolCall: { result: { success: { content: 'export const 已读取 = true' } } } } },
        { type: 'result', subtype: 'success', result: '读取完毕' },
    ]);
    const call = events.find(event => event.type === 'tool/call').data;
    assert.equal(call.name, 'read');
    assert.deepEqual(JSON.parse(call.arguments), { path: 'sample.ts' });
    const result = events.find(event => event.type === 'tool/result').data.message;
    assert.match(result.content[0].text, /export const 已读取 = true/);
    assert.equal(result.isError, false);
    assert.equal(events.at(-1).data.reason.kind, 'completed');
});

test('没有result事件时未完成工具明确失败，子会话也以error收尾', async () => {
    const events = await run([
        { type: 'tool_call', subtype: 'started', call_id: 's1', tool_call: { shellToolCall: { args: { command: 'npm test' } } } },
    ]);
    const result = events.find(event => event.type === 'tool/result').data.message;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /未收到.*完成事件/);
    assert.notEqual(events.at(-1).data.reason.kind, 'completed');
});