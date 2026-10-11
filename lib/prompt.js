/**
 * Prompt composition for a Cursor turn.
 *
 * The parent model writes the task; this module adds only the scaffolding a
 * coding subagent needs to work autonomously — the workspace it is bound to, a
 * nudge toward its real tools, and the rule that it must finish rather than ask
 * questions (there is no human on the child's end of the pipe).
 *
 * Deliberately NOT done here: no persona override, no hidden system prompt. The
 * parent's task text is passed through verbatim so the parent stays in control
 * of what the child does.
 */

/**
 * Build the prompt sent to the Cursor child.
 *
 * @param task - the parent-authored task text (verbatim).
 * @param options - workspace and context attachments.
 */
export function buildPrompt(task, options) {
    const parts = [];
    parts.push(`You are working in this workspace: ${options.cwd}`);
    parts.push('');
    parts.push('## Task');
    parts.push(task.trim());

    if (options.acceptance !== undefined && options.acceptance.trim() !== '') {
        parts.push('');
        parts.push('## Acceptance criteria');
        parts.push(options.acceptance.trim());
    }

    if (options.contextFiles !== undefined && options.contextFiles.length > 0) {
        parts.push('');
        parts.push('## Files to read first');
        for (const path of options.contextFiles)
            parts.push(`- ${path}`);
    }

    parts.push('');
    parts.push('## How to work');
    parts.push('- Use your own file-editing and shell tools to make the changes on disk. Do not just describe them.');
    parts.push('- Read the surrounding code before editing so the change matches local conventions.');
    parts.push('- You cannot ask questions: nobody is available to answer. Make the most reasonable choice, do the work, and state any assumption in your final message.');
    parts.push('- When you are done, reply with a concise report: what you changed (file paths), what you verified, and anything left undone.');

    return parts.join('\n');
}

/**
 * One-line label for the child run, used in status output.
 *
 * @param task - parent task text.
 * @param maxLength - truncation length.
 */
export function summarizeTask(task, maxLength = 60) {
    const flat = task.replace(/\s+/g, ' ').trim();
    return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}
