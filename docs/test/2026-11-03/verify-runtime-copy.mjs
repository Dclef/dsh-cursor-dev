/** Run offline regressions against the exact installed plugin, not a different checkout. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const target = resolve(process.argv[2] ?? '.');
const source = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'dsh-cursor-dev', 'target must be the intended plugin installation');
const tests = [
    'cli-observability.test.mjs', 'cli-mirror.test.mjs', 'transport-wiring.test.mjs',
    'panel-model.test.mjs', 'settings.test.mjs', 'panel-script.test.mjs',
];
const scratch = await mkdtemp(join(tmpdir(), 'cursor-installed-regression-'));
try {
    const paths = [];
    for (const name of tests) {
        const text = await readFile(join(source, 'test', name), 'utf8');
        const rewritten = text.replace(/from (['"])\.\.\/lib\/([^'"]+)\1/g,
            (_match, _quote, module) => `from ${JSON.stringify(pathToFileURL(join(target, 'lib', module)).href)}`);
        const path = join(scratch, name);
        await writeFile(path, rewritten);
        paths.push(path);
    }
    console.log(`Installed-copy regressions: ${target} (manifest ${manifest.version})`);
    const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...paths], {
        stdio: 'inherit', env: { ...process.env, DSH_CURSOR_LIVE_TESTS: '0' }, windowsHide: true,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}
finally {
    await rm(scratch, { recursive: true, force: true });
}
