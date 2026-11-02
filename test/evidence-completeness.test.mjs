/** 文件证据完整性与无started工具时间线回归，全部离线。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, compareFingerprints } from '../lib/changes.js';
import { RunJournal } from '../lib/journal.js';
import { renderCursorReport } from '../lib/tool.js';

const scan = (files, truncated) => ({ files: new Map(files), truncated });

test('扫描上限导致后快照缺文件时不能误报删除', () => {
    assert.deepEqual(compareFingerprints(scan([['user.txt', '1']], false), scan([], true)).removed, []);
});

test('前快照不完整时不能把未扫描到的用户文件误报成本轮新增', () => {
    assert.deepEqual(compareFingerprints(scan([], true), scan([['user.txt', '1']], false)).added, []);
});

test('部分扫描仍报告两个快照都看见的真实修改', () => {
    assert.deepEqual(compareFingerprints(scan([['known.txt', '1']], true), scan([['known.txt', '2']], true)).modified, ['known.txt']);
});

test('无法读取的工作区不能冒充完整空扫描', async t => {
    const root = await mkdtemp(join(tmpdir(), 'cursor-incomplete-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    assert.equal((await fingerprint(join(root, 'missing'))).truncated, true);
});

test('只有completed事件的工具仍进入父报告时间线', () => {
    const journal = new RunJournal({});
    journal.append('run', { kind: 'tool-update', call: { id: 'c1', name: 'shell', status: 'failed', path: 'script.js' }, diffCount: 0 });
    const steps = journal.timeline('run', 40);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'shell');
    assert.equal(steps[0].status, 'failed');
});

test('已观察到部分变更时仍明确提示扫描不完整', () => {
    const report = renderCursorReport({ ok: false, sessionKey: 'run', error: 'interrupted', changeStatus: 'partial', changes: [{ path: 'a.js', operation: 'modified' }] });
    assert.match(report[0].text, /PARTIAL/);
});