import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNTIME = ['server', 'provider', 'feedback', 'coach-server', 'coach-session', 'doubao-coach', 'doubao-protocol', 'knowledge', 'knowledge-store', 'knowledge-evaluation', 'knowledge-review', 'material', 'mvp-server'];
const PUBLIC = ['app.mjs', 'audio.mjs', 'capture-worklet.mjs', 'connection.mjs', 'index.html', 'styles.css', 'coach-app.mjs', 'coach-connection.mjs', 'coach.html', 'coach.css', 'turn-detector.mjs', 'mvp-app.mjs', 'mvp-session.mjs', 'mvp-store.mjs', 'mvp-part2.mjs', 'mvp.html', 'mvp.css'];
const SCRIPTS = ['build-knowledge-graph', 'evaluate-knowledge', 'review-knowledge', 'build-release'];
const TEMPLATES = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'config.example.json', 'package.json', '.gitignore', '.nvmrc', '.github/workflows/ci.yml', 'docs/knowledge.md'];
const DATA = ['docs/knowledge/source-register.json', 'docs/knowledge/expression-cards.jsonl', 'docs/knowledge/knowledge-graph.json', 'docs/validation/coach-quality-cases.jsonl'];
const SOURCE_FIELDS = ['id', 'title', 'url', 'publisher', 'tier', 'read_status', 'rights', 'approved_for_runtime', 'checked_at', 'actual_read', 'scope', 'rights_note'];
const PRIVATE_NAME = /(?:^|\/)(?:\.env(?:\..*)?|node_modules|\.git|recordings?|backups?|research|private(?:[-_.].*)?|.*(?:secret|credential|private[-_]?progress|raw[-_]?social|admin[-_]?links).*|config\.json)(?:\/|$)|(?:^|\/)(?:recordings?|backups?|research|private|secrets?)\.test\.mjs$/iu;
const ERROR_CODES = new Set(['RELEASE_OUTPUT_UNSAFE', 'RELEASE_OUTPUT_NOT_EMPTY', 'RELEASE_SYMLINK', 'RELEASE_SOURCE_MISSING', 'RELEASE_SOURCE_INVALID', 'RELEASE_DEPENDENCY_MISSING', 'RELEASE_PRIVATE_DATA', 'RELEASE_ARGUMENTS_INVALID', 'RELEASE_BUILD_FAILED']);
const slash = value => value.split(sep).join('/');
function fail(code, paths = []) {
  const sorted = [...new Set(paths)].sort();
  const error = new Error(`${code}${sorted.length ? ` (${sorted.length}): ${sorted.join(', ')}` : ''}`);
  error.code = code;
  if (sorted.length) { error.count = sorted.length; error.paths = sorted; }
  throw error;
}
function inside(root, path) {
  const value = relative(root, path);
  return value && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
async function inspectPath(root, target, { optional = false } = {}) {
  if (target !== root && !inside(root, target)) fail('RELEASE_SOURCE_INVALID');
  const parts = target === root ? [] : relative(root, target).split(sep);
  let cursor = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) cursor = join(cursor, parts[index]);
    let info;
    try { info = await lstat(cursor); }
    catch (error) {
      if (error.code === 'ENOENT' && optional) return undefined;
      if (error.code === 'ENOENT') fail('RELEASE_SOURCE_MISSING', [slash(relative(root, target))]);
      throw error;
    }
    if (info.isSymbolicLink()) fail('RELEASE_SYMLINK', cursor === root ? [] : [slash(relative(root, cursor))]);
    if (index < parts.length - 1 && !info.isDirectory()) fail('RELEASE_SOURCE_INVALID', [slash(relative(root, cursor))]);
    if (index === parts.length - 1) return info;
  }
}
function clearlyFake(value) {
  return /^(?:sk-)?(?:test|fake|dummy|example|placeholder|offline)(?:[-_]|$)/iu.test(value)
    || /^(?:your[-_]|<|\$\{)/iu.test(value)
    || /^(?:OFFLINE|TEST|FAKE|DUMMY|EXAMPLE|PLACEHOLDER|SYNTHETIC)[A-Z0-9_-]*$/u.test(value);
}
function suspectedCredential(content) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u.test(content)) return true;
  const tokens = content.match(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/gu) ?? [];
  if (tokens.some(value => !clearlyFake(value))) return true;
  const literal = /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)["']?\s*[:=]\s*["']([^"'\s]{16,})["']/giu;
  for (const match of content.matchAll(literal)) {
    const value = match[1];
    if (clearlyFake(value)) continue;
    // Literal UUIDs and long mixed credentials are disallowed; short test markers are harmless.
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)
      || /^[A-Za-z0-9_+/=-]{24,}$/u.test(value) && /[a-z]/u.test(value) && /[A-Z]/u.test(value) && /[0-9]/u.test(value)) return true;
  }
  return /(?:\/Users\/|\/home\/)[^\s"'`<>]+|[A-Z]:\\Users\\[^\s"'`<>]+/u.test(content);
}
async function readSource(root, name, optional = false) {
  const path = resolve(root, name), info = await inspectPath(root, path, { optional });
  if (!info) return undefined;
  if (!info.isFile()) fail('RELEASE_SOURCE_INVALID', [name]);
  // O_NOFOLLOW also protects the final component against replacement between lstat and open.
  let descriptor;
  try {
    descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await descriptor.stat()).isFile()) fail('RELEASE_SOURCE_INVALID', [name]);
    return await descriptor.readFile();
  } catch (error) {
    if (error.code === 'ELOOP') fail('RELEASE_SYMLINK', [name]);
    throw error;
  } finally { await descriptor?.close(); }
}
function projectRegister(bytes) {
  const path = 'docs/knowledge/source-register.json';
  let register;
  try { register = JSON.parse(bytes.toString('utf8')); } catch { fail('RELEASE_SOURCE_INVALID', [path]); }
  if (!register || !Array.isArray(register.sources) || register.sources.some(source => !source || typeof source !== 'object' || Array.isArray(source))) fail('RELEASE_SOURCE_INVALID', [path]);
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  const projected = { ...pick(register, ['version', 'checked_at', 'policy']), sources: register.sources.map(source => pick(source, SOURCE_FIELDS)) };
  return Buffer.from(`${JSON.stringify(projected, null, 2)}\n`);
}
function validateDependencies(files) {
  const paths = new Set(files.map(file => file.path)), missing = [];
  for (const { path, bytes } of files) {
    if (!path.startsWith('qwen-probe/') || path.startsWith('qwen-probe/tests/')) continue;
    const content = bytes.toString('utf8');
    const dependencies = [];
    if (path.endsWith('.mjs')) {
      // Runtime files use literal ESM imports; computed test-fixture imports are deliberately excluded.
      const imports = /(?:\b(?:import|export)\s+(?:[\w$*{},\s]+\s+from\s*)?|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
      dependencies.push(...Array.from(content.matchAll(imports), match => match[1]));
    } else if (path.endsWith('.html')) {
      dependencies.push(...Array.from(content.matchAll(/\b(?:src|href)=["'](\.\.?\/[^"']+|[^:/"'#]+\.(?:mjs|css))["']/gu), match => match[1]));
    }
    for (const dependency of dependencies) {
      const target = slash(join(dirname(path), dependency));
      if (!paths.has(target)) missing.push(target.startsWith('../') ? path : target);
    }
  }
  if (missing.length) fail('RELEASE_DEPENDENCY_MISSING', missing);
}
async function validateOutput(root, output) {
  const releaseRoot = resolve(root, 'release');
  if (!inside(releaseRoot, output)) fail('RELEASE_OUTPUT_UNSAFE');
  const existing = await inspectPath(root, output, { optional: true });
  if (existing && (!existing.isDirectory() || (await readdir(output)).length)) fail('RELEASE_OUTPUT_NOT_EMPTY');
}

/** Build only reviewed public inputs. Nonempty destinations are never changed. */
export async function buildRelease({ projectRoot = DEFAULT_ROOT, outputDirectory } = {}) {
  try {
    if (typeof projectRoot !== 'string' || !projectRoot || outputDirectory !== undefined && (typeof outputDirectory !== 'string' || !outputDirectory || outputDirectory.split(/[\\/]/u).includes('..'))) fail('RELEASE_OUTPUT_UNSAFE');
    const root = resolve(projectRoot);
    const output = outputDirectory === undefined ? resolve(root, 'release/afterword') : resolve(root, outputDirectory);
    await validateOutput(root, output);
    const mapping = [
      ...RUNTIME.map(name => [`qwen-probe/${name}.mjs`, `qwen-probe/${name}.mjs`]),
      ...PUBLIC.map(name => [`qwen-probe/public/${name}`, `qwen-probe/public/${name}`]),
      ...SCRIPTS.map(name => [`qwen-probe/scripts/${name}.mjs`, `qwen-probe/scripts/${name}.mjs`]),
      ...['package.json', 'package-lock.json'].map(name => [`qwen-probe/${name}`, `qwen-probe/${name}`]),
      ...DATA.map(name => [name, name]),
      ...TEMPLATES.flatMap(name => [[`open-source/${name}`, name === 'docs/knowledge.md' ? 'docs/knowledge/README.md' : name], [`open-source/${name}`, `open-source/${name}`]])
    ];
    for (const name of ['qwen-probe/public/mvp-backup.mjs', 'qwen-probe/mvp-backup.mjs']) {
      if (await inspectPath(root, resolve(root, name), { optional: true })) mapping.push([name, name]);
    }
    const testsDirectory = resolve(root, 'qwen-probe/tests');
    const testsInfo = await inspectPath(root, testsDirectory);
    if (!testsInfo.isDirectory()) fail('RELEASE_SOURCE_INVALID', ['qwen-probe/tests']);
    for (const entry of await readdir(testsDirectory, { withFileTypes: true })) {
      if (entry.name.endsWith('.test.mjs')) mapping.push([`qwen-probe/tests/${entry.name}`, `qwen-probe/tests/${entry.name}`]);
    }
    mapping.sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    const files = [], privatePaths = [], sourceCache = new Map();
    for (const [source, path] of mapping) {
      if (!sourceCache.has(source)) {
        const bytes = await readSource(root, source);
        sourceCache.set(source, source === 'docs/knowledge/source-register.json' ? projectRegister(bytes) : bytes);
      }
      const bytes = sourceCache.get(source);
      if (PRIVATE_NAME.test(path) || suspectedCredential(bytes.toString('utf8'))) privatePaths.push(path);
      files.push({ path, bytes });
    }
    if (privatePaths.length) fail('RELEASE_PRIVATE_DATA', privatePaths);
    validateDependencies(files);
    // Finish all checks before touching the destination; wx prevents overwriting any new file.
    await validateOutput(root, output);
    await mkdir(output, { recursive: true });
    for (const file of files) {
      const destination = resolve(output, file.path);
      if (!inside(output, destination)) fail('RELEASE_OUTPUT_UNSAFE');
      await mkdir(dirname(destination), { recursive: true });
      await inspectPath(root, dirname(destination));
      await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o644 });
    }
    const manifest = { schemaVersion: 1, files: files.map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
    await writeFile(join(output, 'RELEASE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    return { schemaVersion: 1, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), manifest: 'RELEASE-MANIFEST.json' };
  } catch (error) {
    if (ERROR_CODES.has(error.code)) throw error;
    fail('RELEASE_BUILD_FAILED');
  }
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--'))) fail('RELEASE_ARGUMENTS_INVALID');
    console.log(JSON.stringify(await buildRelease({ outputDirectory: args[1] })));
  } catch (error) {
    console.error(JSON.stringify({ code: ERROR_CODES.has(error.code) ? error.code : 'RELEASE_BUILD_FAILED', ...(error.paths ? { count: error.count, paths: error.paths } : {}) }));
    process.exitCode = 1;
  }
}
