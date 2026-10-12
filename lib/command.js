/**
 * dsh-cursor-dev — the `/cursor-subagent` human command.
 *
 * The split this command has to keep straight: **Cursor writes the business
 * code, the parent (harness) model reviews it**. So the command does not ask the
 * parent to delegate — asking is exactly how the parent ends up writing the code
 * itself. It dispatches the task to the child directly:
 *
 *   /cursor-subagent 把 oldcat 的存档格式换成 JSON
 *
 *   1. the handler starts the child run right away and settles, so the composer
 *      is free while Cursor works (the panel shows the live session);
 *   2. when the run settles, one ordinary user message is steered into the same
 *      conversation carrying the facts a review needs — what Cursor changed,
 *      which model ran, its own summary;
 *   3. the parent model wakes on that message and reviews the diff instead of
 *      authoring it.
 *
 * Nothing here reaches the model as a *tool* call: the run is the same one
 * `cursor_code` performs (same pool, same journal, same conversation record), so
 * a follow-up `cursor_code` with `continueSession: true` continues the very same
 * Cursor conversation the command started.
 *
 * @module dsh-cursor-dev/command
 */
import { randomUUID } from 'node:crypto';

/** The registered command name, without the leading slash. */
export const COMMAND_NAME = 'cursor-subagent';

/** Shown when the command is run without a task, in both languages. */
export const USAGE = '用法：/cursor-subagent [-m <模型>] <要交给 Cursor 写的任务>  ·  Usage: /cursor-subagent [-m <model>] <task>';

/** How much of the child's own summary the review message carries. */
const SUMMARY_LIMIT = 1200;

/** How many changed files the review message lists. */
const FILE_LIMIT = 20;

/**
 * Split the command line into an optional model override and the task.
 *
 * Only a leading `-m <model>` is special; everything after it is the task, so a
 * task may contain dashes, quotes, or newlines without being reinterpreted.
 *
 * @param rawInput - everything the user typed after the command name.
 * @returns `{ model?, task? }`; both absent when the line was empty.
 */
export function parseCommandInput(rawInput) {
    const text = String(rawInput ?? '').trim();
    if (text === '')
        return {};
    const match = /^-m\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    if (match === null)
        return { task: text };
    const task = (match[2] ?? '').trim();
    if (task === '')
        return { model: match[1] };
    return { model: match[1], task };
}

/** First line of the task, for the settled-command line the UI renders. */
function firstLine(text) {
    const line = String(text ?? '').split('\n', 1)[0].trim();
    return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Clamp a block of text to a budget, saying how much was dropped. */
function clamp(text, limit) {
    const value = String(text ?? '').trim();
    if (value.length <= limit)
        return value;
    return `${value.slice(0, limit)}…（还有 ${value.length - limit} 字，完整内容在面板里）`;
}

/** One `path (modified +12/-3)` line per change, or a plain "no edits". */
function changeLines(result) {
    const changes = Array.isArray(result?.changes) ? result.changes : [];
    if (changes.length === 0)
        return ['（这次没有落盘的文件改动）'];
    const shown = changes.slice(0, FILE_LIMIT).map(change => {
        const counts = typeof change.added === 'number' || typeof change.removed === 'number'
            ? ` +${change.added ?? 0}/-${change.removed ?? 0}`
            : '';
        return `· ${change.path}（${change.operation ?? 'modified'}${counts}）`;
    });
    if (changes.length > FILE_LIMIT)
        shown.push(`· …还有 ${changes.length - FILE_LIMIT} 个文件`);
    return shown;
}

/**
 * The message that hands the finished run to the parent model for review.
 *
 * It states the division of labour outright, because a review message that only
 * reports a result invites the parent to redo the work instead of checking it.
 *
 * @param task - the task the user gave the command.
 * @param result - the `cursor_code` result object.
 * @param options - `toolName`.
 * @returns the user-role message text.
 */
export function reviewBrief(task, result, options = {}) {
    const toolName = options.toolName ?? 'cursor_code';
    const ok = result?.ok === true;
    const seconds = typeof result?.durationMs === 'number' ? `${Math.round(result.durationMs / 1000)}s` : '?';
    const lines = [
        'Cursor 子智能体已经动手写完了，现在轮到你审查它的代码（不要自己重写一遍；要改就再让它改）：',
        '',
        `任务：${firstLine(task)}`,
        `结果：${ok ? '跑完了' : '没跑完'} · 模型 ${result?.model ?? '?'} · 用时 ${seconds} · 步数 ${Array.isArray(result?.steps) ? result.steps.length : 0}`,
        `改动 ${Array.isArray(result?.changes) ? result.changes.length : 0} 个文件：`,
        ...changeLines(result),
    ];
    const summary = clamp(result?.text, SUMMARY_LIMIT);
    if (summary !== '')
        lines.push('', `它自己的说明：${summary}`);
    if (result?.error !== undefined && result.error !== null)
        lines.push('', `错误：${clamp(result.error, 600)}`);
    lines.push(
        '',
        '你该做的：核对 diff 与它改过的文件、跑测试或按验收标准验证；发现问题就用 '
            + `\`${toolName}\` 带 \`continueSession: true\` 让它接着改（同一个 Cursor 会话，它记得自己写过什么）。`,
        '完整 diff、逐步时间线与额度在面板：设置 → Cursor 子智能体。',
    );
    return lines.join('\n');
}

/**
 * The message for a run that threw instead of returning a result.
 *
 * @param task - the task the user gave the command.
 * @param error - whatever the runner threw.
 * @returns the user-role message text.
 */
export function failureBrief(task, error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
        'Cursor 子智能体这次没能跑起来（不是它的代码产出，而是运行本身失败），由你判断怎么收场：',
        '',
        `任务：${firstLine(task)}`,
        `错误：${clamp(message, 600)}`,
        '',
        '可以先用面板确认 CLI 是否可用/已登录，再决定重派一次，还是你自己处理。',
    ].join('\n');
}

/**
 * One identified, immutable user message.
 *
 * `createUserMessage` lives in a first-party package that a profile-installed
 * plugin cannot resolve, and all it does is stamp an id, a role, and a freeze
 * onto the input — so the shape is built here instead.
 *
 * @param content - message content blocks.
 * @returns a frozen user message.
 */
export function userMessage(content) {
    return deepFreeze({ id: randomUUID(), role: 'user', content, source: { kind: 'user' } });
}

/** Freeze a message the way the session log expects to receive it. */
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value))
            deepFreeze(value[key]);
    }
    return value;
}

/**
 * Run the child and hand the outcome to the parent for review.
 *
 * Never throws: a failure has to reach the conversation as a message, or the
 * user is left with a run that vanished. The parent is woken by the steer, so
 * this is what turns "Cursor wrote code" into "the parent reviews code".
 *
 * @param options - `run` ({@link ChildRunner}), `agent`, `task`, `model`, `logger`, `toolName`.
 * @returns the child result, or undefined when the run threw.
 */
export async function runChildForReview(options) {
    const { run, agent, task, logger } = options;
    try {
        const result = await run({
            task,
            model: options.model,
            agent,
            signal: options.signal,
            timeoutSeconds: options.timeoutSeconds,
        });
        agent.steer(userMessage([{ type: 'text', text: reviewBrief(task, result, options) }]));
        logger?.info?.(`dsh-cursor-dev: /${COMMAND_NAME} finished "${firstLine(task)}" ok=${result?.ok === true}`);
        return result;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn?.(`dsh-cursor-dev: /${COMMAND_NAME} run failed: ${message}`);
        try {
            agent.steer(userMessage([{ type: 'text', text: failureBrief(task, error) }]));
        }
        catch (steerError) {
            // The session is gone; the log line above is the only record left.
            logger?.warn?.(`dsh-cursor-dev: could not report the failed run: ${steerError instanceof Error ? steerError.message : String(steerError)}`);
        }
        return undefined;
    }
}

/**
 * Register `/cursor-subagent` against the host command registry.
 *
 * The dependency is injected rather than declared in the plugin's `inject`
 * list: a headless profile has no command surface at all, and the coding tool
 * must not go down with it. A host with no `commands` service simply never runs
 * the mount.
 *
 * @param ctx - Cordis context of the plugin.
 * @param options - `toolName`, `logger`, and `run` (the child runner).
 */
export function registerCursorCommand(ctx, options = {}) {
    const toolName = options.toolName ?? 'cursor_code';
    const runner = options.run;
    const mount = (commandCtx) => {
        const commands = typeof commandCtx.get === 'function' ? commandCtx.get('commands') : undefined;
        // No command surface is a normal host here (a headless profile), not a
        // problem to report: the coding tool is unaffected, so this stays quiet.
        if (commands === undefined || typeof commands.register !== 'function')
            return;
        commandCtx.effect(() => {
            const dispose = commands.register({
                name: COMMAND_NAME,
                description: '直接把活儿交给 Cursor 子智能体写，写完由你审查 · Hand the task straight to the Cursor CLI child agent; the parent reviews',
                input: { hint: '[-m <模型>] <任务>' },
                handler: ({ agent, rawInput }) => {
                    const { model, task } = parseCommandInput(rawInput);
                    if (task === undefined)
                        return { kind: 'error', text: USAGE };
                    if (agent === undefined || typeof agent.steer !== 'function')
                        return { kind: 'error', text: '这个命令要在有会话的地方用 · this command needs a live session' };
                    if (typeof runner !== 'function')
                        return { kind: 'error', text: '这个 host 上没有接上 Cursor 运行器 · no child runner is wired on this host' };
                    // Deliberately not the invocation's own signal: that one is
                    // aborted as soon as this handler settles, which would kill the
                    // run a second later. The child's own timeout bounds it.
                    const controller = new AbortController();
                    void runChildForReview({
                        run: runner,
                        agent,
                        task,
                        model,
                        signal: controller.signal,
                        logger: options.logger,
                        toolName,
                    });
                    options.logger?.info?.(`dsh-cursor-dev: /${COMMAND_NAME} dispatched to the child "${firstLine(task)}"`);
                    return { kind: 'success', text: `已交给 Cursor 子智能体去写，写完把结果交给主模型审查：${firstLine(task)}` };
                },
            });
            return () => {
                dispose?.();
            };
        }, `dsh-cursor-dev: /${COMMAND_NAME} command`);
    };

    if (typeof ctx.inject !== 'function') {
        mount(ctx);
        return;
    }
    ctx.inject(['commands'], mount);
}
