import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

let releaseModule;
try { releaseModule = await import('../scripts/build-release.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
async function build(options) {
  assert.equal(typeof releaseModule?.buildRelease, 'function', 'buildRelease is exported');
  return releaseModule.buildRelease(options);
}

const modules = ['server', 'provider', 'feedback', 'coach-server', 'coach-session', 'doubao-coach', 'doubao-protocol', 'knowledge', 'knowledge-store', 'knowledge-evaluation', 'knowledge-review', 'material', 'mvp-server'];
const publicFiles = ['app.mjs', 'audio.mjs', 'capture-worklet.mjs', 'connection.mjs', 'index.html', 'styles.css', 'coach-app.mjs', 'coach-connection.mjs', 'coach.html', 'coach.css', 'turn-detector.mjs', 'mvp-app.mjs', 'mvp-session.mjs', 'mvp-store.mjs', 'mvp-part2.mjs', 'mvp.html', 'mvp.css'];
const templates = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'config.example.json', 'package.json', '.gitignore', '.nvmrc', '.github/workflows/ci.yml', 'docs/knowledge.md'];
async function put(root, name, content = '// synthetic public file\n') {
  const target = join(root, name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'afterword-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of modules) await put(root, `qwen-probe/${name}.mjs`);
  for (const name of publicFiles) await put(root, `qwen-probe/public/${name}`);
  for (const name of ['build-knowledge-graph', 'evaluate-knowledge', 'review-knowledge']) await put(root, `qwen-probe/scripts/${name}.mjs`);
  let builderSource = '';
  try { builderSource = await readFile(new URL('../scripts/build-release.mjs', import.meta.url)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await put(root, 'qwen-probe/scripts/build-release.mjs', builderSource);
  await put(root, 'qwen-probe/tests/example.test.mjs', "import test from 'node:test'; test('synthetic', () => {});\n");
  await put(root, 'qwen-probe/package.json', '{"name":"synthetic-app","type":"module","dependencies":{}}\n');
  await put(root, 'qwen-probe/package-lock.json', '{"name":"synthetic-app","lockfileVersion":3,"packages":{"":{"name":"synthetic-app","dependencies":{}}}}\n');
  for (const name of templates) await put(root, `open-source/${name}`, name === 'package.json' ? '{"name":"synthetic-release","private":true}\n' : name === 'config.example.json' ? '{"apiKey":""}\n' : `Public template ${name}\n`);
  await put(root, 'docs/knowledge/source-register.json', '{"sources":[]}\n');
  await put(root, 'docs/knowledge/expression-cards.jsonl', '{"id":"synthetic-card"}\n');
  await put(root, 'docs/knowledge/knowledge-graph.json', '{"nodes":[],"edges":[]}\n');
  await put(root, 'docs/validation/coach-quality-cases.jsonl', '{"id":"synthetic-case"}\n');
  return root;
}
async function filesUnder(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else files.push(relative(root, path).split('\\').join('/'));
  }
  return files.sort();
}

test('release is an explicit, reproducible package with a relative SHA256 manifest', async t => {
  const root = await fixture(t);
  for (const name of ['qwen-probe/README.md', 'qwen-probe/local-secret.mjs', 'qwen-probe/public/private.mjs', 'qwen-probe/scripts/upload.mjs', 'qwen-probe/node_modules/private.mjs', 'docs/knowledge/research/raw-social.jsonl', 'docs/validation/private-progress.md', '.env', 'open-source/notes-private.md']) await put(root, name, 'private input excluded\n');
  const first = join(root, 'release', 'one'), second = join(root, 'release', 'two');
  const summary = await build({ projectRoot: root, outputDirectory: first });
  await build({ projectRoot: root, outputDirectory: second });
  const names = await filesUnder(first), manifest = JSON.parse(await readFile(join(first, 'RELEASE-MANIFEST.json')));
  assert.equal(summary.fileCount, names.length - 1);
  assert.equal(summary.manifest, 'RELEASE-MANIFEST.json');
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.files.map(file => file.path), names.filter(name => name !== 'RELEASE-MANIFEST.json'));
  assert.ok(names.includes('docs/knowledge/README.md'));
  assert.ok(names.includes('open-source/README.md'));
  assert.ok(names.includes('qwen-probe/tests/example.test.mjs'));
  assert.equal(await readFile(join(first, 'README.md'), 'utf8'), 'Public template README.md\n');
  assert.equal(names.some(name => /(?:private|research|node_modules|\.env|upload|qwen-probe\/README)/u.test(name)), false);
  assert.equal(JSON.stringify(manifest).includes(root), false);
  assert.equal(manifest.files.some(file => file.path.startsWith('/') || file.path.includes('..')), false);
  for (const file of manifest.files) {
    const bytes = await readFile(join(first, file.path));
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(file.bytes, bytes.length);
  }
  assert.deepEqual(await filesUnder(second), names);
  for (const name of names) assert.deepEqual(await readFile(join(first, name)), await readFile(join(second, name)));
});

test('includes the backup module when present and defaults to release/afterword', async t => {
  const root = await fixture(t);
  await put(root, 'qwen-probe/public/mvp-backup.mjs');
  await build({ projectRoot: root });
  assert.ok((await filesUnder(join(root, 'release', 'afterword'))).includes('qwen-probe/public/mvp-backup.mjs'));
});

test('projects public source metadata without changing source input or losing source IDs', async t => {
  const root = await fixture(t);
  const sources = Array.from({ length: 46 }, (_, index) => ({
    id: `public-${index}`, title: `Reference ${index}`, url: `https://example.org/${index}`, publisher: 'Example',
    tier: 'official', read_status: 'read', rights: 'reference_only', approved_for_runtime: true,
    checked_at: '2026-10-01', actual_read: true, scope: 'grammar', rights_note: 'Link only',
    engagement: { likes: 123 }, verbatim_quote: 'excluded source quotation', verification_evidence: 'private evidence', aliases: ['private-alias']
  }));
  const input = JSON.stringify({ version: 'synthetic-v1', checked_at: '2026-10-01', policy: { mode: 'reference' }, sources, private_notes: 'excluded' });
  await put(root, 'docs/knowledge/source-register.json', input);
  await build({ projectRoot: root });
  const output = JSON.parse(await readFile(join(root, 'release', 'afterword', 'docs', 'knowledge', 'source-register.json')));
  assert.deepEqual(output.sources.map(source => source.id), sources.map(source => source.id));
  assert.deepEqual(Object.keys(output).sort(), ['checked_at', 'policy', 'sources', 'version']);
  assert.deepEqual(Object.keys(output.sources[0]).sort(), ['actual_read', 'approved_for_runtime', 'checked_at', 'id', 'publisher', 'read_status', 'rights', 'rights_note', 'scope', 'tier', 'title', 'url']);
  assert.equal(output.sources[0].approved_for_runtime, true);
  assert.equal(JSON.stringify(output).includes('excluded'), false);
  assert.equal(await readFile(join(root, 'docs', 'knowledge', 'source-register.json'), 'utf8'), input);
});

test('a packaged copy can build again from its shipped public templates', async t => {
  const root = await fixture(t), output = join(root, 'release', 'first');
  await build({ projectRoot: root, outputDirectory: output });
  const script = join(output, 'qwen-probe', 'scripts', 'build-release.mjs');
  const child = spawnSync(process.execPath, [script], { cwd: output, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const rebuilt = join(output, 'release', 'afterword');
  assert.deepEqual(await readFile(join(output, 'RELEASE-MANIFEST.json')), await readFile(join(rebuilt, 'RELEASE-MANIFEST.json')));
});

test('never overwrites or removes files in a nonempty output directory', async t => {
  const root = await fixture(t), output = join(root, 'release', 'occupied');
  await put(output, 'README.md', 'user-owned\n');
  await assert.rejects(build({ projectRoot: root, outputDirectory: output }), { code: 'RELEASE_OUTPUT_NOT_EMPTY' });
  assert.equal(await readFile(join(output, 'README.md'), 'utf8'), 'user-owned\n');
  assert.deepEqual(await filesUnder(output), ['README.md']);
});

test('bounds output to release descendants and rejects traversal before writing', async t => {
  const root = await fixture(t);
  for (const outputDirectory of [root, join(root, 'qwen-probe'), join(root, 'release'), join(root, 'release', '..', 'unsafe'), '../outside']) {
    await assert.rejects(build({ projectRoot: root, outputDirectory }), { code: 'RELEASE_OUTPUT_UNSAFE' });
  }
});

test('rejects symlink sources without copying their targets', async t => {
  const root = await fixture(t);
  await rm(join(root, 'qwen-probe', 'server.mjs'));
  await put(root, 'outside-secret.txt', 'sensitive source\n');
  await symlink(join(root, 'outside-secret.txt'), join(root, 'qwen-probe', 'server.mjs'));
  await assert.rejects(build({ projectRoot: root }), { code: 'RELEASE_SYMLINK' });
  await assert.rejects(readFile(join(root, 'release', 'afterword', 'qwen-probe', 'server.mjs')), { code: 'ENOENT' });
});

test('rejects symlink parent directories in sources and output', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'other-output'));
  await symlink(join(root, 'other-output'), join(root, 'release'));
  await assert.rejects(build({ projectRoot: root }), { code: 'RELEASE_SYMLINK' });
  await rm(join(root, 'release'));
  await rm(join(root, 'docs', 'knowledge'), { recursive: true });
  await symlink(join(root, 'open-source'), join(root, 'docs', 'knowledge'));
  await assert.rejects(build({ projectRoot: root }), { code: 'RELEASE_SYMLINK' });
});

test('reports suspected credentials as counts and relative paths without values', async t => {
  const root = await fixture(t);
  const credential = ['sk', '7mBz9Qk2pL8xYv4nR6cT0aD3fG5hJ1sW'].join('-');
  await put(root, 'qwen-probe/server.mjs', `const apiKey = '${credential}';\n`);
  await assert.rejects(build({ projectRoot: root }), error => {
    assert.equal(error.code, 'RELEASE_PRIVATE_DATA');
    assert.equal(error.count, 1);
    assert.deepEqual(error.paths, ['qwen-probe/server.mjs']);
    assert.equal(JSON.stringify(error).includes(credential), false);
    assert.equal(error.message.includes(credential), false);
    assert.equal(error.message.includes(root), false);
    return true;
  });
  await assert.rejects(readFile(join(root, 'release', 'afterword', 'RELEASE-MANIFEST.json')), { code: 'ENOENT' });
});

test('allows clearly labelled offline fake credentials and blocks private test filenames', async t => {
  const root = await fixture(t);
  await put(root, 'qwen-probe/tests/example.test.mjs', "const apiKey='OFFLINE_API_KEY'; const fake='sk-test-placeholder-for-offline-only';\n");
  await build({ projectRoot: root, outputDirectory: join(root, 'release', 'safe') });
  await put(root, 'qwen-probe/tests/recordings.test.mjs', '// must not ship personal recordings\n');
  await assert.rejects(build({ projectRoot: root }), error => error.code === 'RELEASE_PRIVATE_DATA' && error.paths.includes('qwen-probe/tests/recordings.test.mjs'));
});

test('missing required public inputs fail before creating output', async t => {
  const root = await fixture(t);
  await rm(join(root, 'open-source', 'LICENSE'));
  await assert.rejects(build({ projectRoot: root }), { code: 'RELEASE_SOURCE_MISSING' });
  await assert.rejects(readFile(join(root, 'release', 'afterword', 'RELEASE-MANIFEST.json')), { code: 'ENOENT' });
});

test('fails if a runtime import points to an absent or unapproved module', async t => {
  const root = await fixture(t);
  await put(root, 'qwen-probe/public/mvp-app.mjs', "import './mvp-backup.mjs';\n");
  await assert.rejects(build({ projectRoot: root }), { code: 'RELEASE_DEPENDENCY_MISSING', paths: ['qwen-probe/public/mvp-backup.mjs'] });
  await put(root, 'qwen-probe/public/mvp-backup.mjs');
  await build({ projectRoot: root, outputDirectory: 'release/complete' });
  await put(root, 'qwen-probe/server.mjs', "import {\n  privateThing\n} from './private-not-approved.mjs';\n");
  await put(root, 'qwen-probe/private-not-approved.mjs');
  await assert.rejects(build({ projectRoot: root }), { code: 'RELEASE_DEPENDENCY_MISSING' });
});

test('CLI accepts only one bounded --output argument and emits no private paths', async t => {
  const root = await fixture(t), script = join(root, 'qwen-probe', 'scripts', 'build-release.mjs');
  const child = spawnSync(process.execPath, [script, '--output', 'release/cli'], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).manifest, 'RELEASE-MANIFEST.json');
  assert.equal(child.stdout.includes(root), false);
  for (const args of [['--output'], ['--output', 'release/one', '--output', 'release/two'], ['--unknown'], ['--output', '../outside'], ['--output', 'release/../release/traversal']]) {
    const invalid = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal((invalid.stdout + invalid.stderr).includes(root), false);
  }
});
