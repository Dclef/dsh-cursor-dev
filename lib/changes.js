/**
 * Independent change evidence for a Cursor run.
 *
 * The ACP stream already reports diffs for edits Cursor performs through its own
 * edit tools. This module adds a *second, independent* source of truth: a cheap
 * filesystem fingerprint taken before and after the turn. That catches anything
 * the stream omits — shell commands that write files, moves, deletes — so the
 * parent model can verify the child's work instead of trusting its summary.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Directories never worth fingerprinting in a source workspace. */
const SKIP_DIRS = new Set([
    '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
    '.mypy_cache', '.pytest_cache', '.ruff_cache', 'dist', 'build',
    '.next', '.nuxt', '.turbo', '.cache', '.idea', '.vscode',
    'game', 'cache', 'saves', 'log',
]);

/**
 * Normalize a path for cross-platform comparison.
 * @param path - absolute or relative path.
 */
export function normalizePath(path) {
    return path.split(sep).join('/');
}

/**
 * Whether a directory name is excluded from fingerprinting.
 * @param name - directory basename.
 */
function isSkippedDir(name) {
    return SKIP_DIRS.has(name) || name.startsWith('.');
}

/**
 * Fingerprint a workspace tree: path -> mtime+size.
 *
 * Bounded on purpose: a huge tree costs a few hundred ms and the cap keeps a
 * pathological workspace from stalling a tool call.
 *
 * @param root - absolute workspace directory.
 * @param maxFiles - stop after this many files.
 */
export async function fingerprint(root, maxFiles = 20_000) {
    const files = new Map();
    let truncated = false;

    /** @param dir - directory to walk. */
    async function walk(dir) {
        if (truncated)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (files.size >= maxFiles) {
                truncated = true;
                return;
            }
            if (entry.isDirectory()) {
                if (isSkippedDir(entry.name))
                    continue;
                await walk(join(dir, entry.name));
                continue;
            }
            if (!entry.isFile())
                continue;
            const full = join(dir, entry.name);
            try {
                const info = await stat(full);
                files.set(normalizePath(relative(root, full)), `${info.mtimeMs}|${info.size}`);
            }
            catch {
                // Racing deletes are not interesting to the diff.
            }
        }
    }

    await walk(root);
    return { files, truncated };
}

/**
 * Compare two fingerprints.
 *
 * @param before - fingerprint captured before the turn.
 * @param after - fingerprint captured after the turn.
 * @returns added / modified / removed relative paths.
 */
export function compareFingerprints(before, after) {
    const added = [];
    const modified = [];
    const removed = [];

    for (const [path, stamp] of after.files) {
        const previous = before.files.get(path);
        if (previous === undefined)
            added.push(path);
        else if (previous !== stamp)
            modified.push(path);
    }
    for (const path of before.files.keys()) {
        if (!after.files.has(path))
            removed.push(path);
    }
    added.sort();
    modified.sort();
    removed.sort();
    return { added, modified, removed };
}

/**
 * Count added/removed lines in a unified-ish diff pair.
 *
 * @param oldText - previous content (`null` when the file is new).
 * @param newText - new content.
 */
export function diffStats(oldText, newText) {
    const before = oldText === null ? [] : oldText.split('\n');
    const after = newText.split('\n');
    let added = 0;
    let removed = 0;
    if (oldText === null) {
        added = after.length;
        return { added, removed, isNew: true };
    }
    // Line-set comparison: exact enough for a summary, cheap on large files.
    const beforeSet = new Map();
    for (const line of before)
        beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
    for (const line of after) {
        const count = beforeSet.get(line);
        if (count === undefined || count === 0)
            added += 1;
        else
            beforeSet.set(line, count - 1);
    }
    for (const count of beforeSet.values())
        removed += count;
    return { added, removed, isNew: before.length === 0 };
}

/**
 * Merge ACP-reported diffs with the filesystem comparison into one change set.
 *
 * ACP diffs win when both describe the same path: they carry real text.
 *
 * @param diffs - `FileDiff[]` observed on the ACP stream.
 * @param comparison - result of {@link compareFingerprints}.
 * @param root - workspace root, used to relativize absolute ACP paths.
 */
export function mergeChanges(diffs, comparison, root) {
    const byPath = new Map();
    const prefix = normalizePath(root.endsWith(sep) ? root : `${root}${sep}`);

    for (const diff of diffs) {
        const normalized = normalizePath(diff.path);
        const key = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
        const stats = diffStats(diff.oldText, diff.newText);
        byPath.set(key, {
            path: key,
            absolutePath: diff.path,
            operation: stats.isNew ? 'created' : 'modified',
            added: stats.added,
            removed: stats.removed,
            source: 'acp',
            diff,
        });
    }

    for (const path of comparison.added) {
        if (!byPath.has(path)) {
            byPath.set(path, { path, operation: 'created', added: 0, removed: 0, source: 'fs' });
        }
    }
    for (const path of comparison.modified) {
        if (!byPath.has(path)) {
            byPath.set(path, { path, operation: 'modified', added: 0, removed: 0, source: 'fs' });
        }
    }
    for (const path of comparison.removed) {
        byPath.set(path, { path, operation: 'deleted', added: 0, removed: 0, source: 'fs' });
    }

    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}
