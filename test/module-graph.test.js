/**
 * The browser's module graph must not touch Node.
 *
 * core/ is DOM-free, but "DOM-free" is not the property the browser needs: it
 * needs to be NODE-free, because these modules are imported unmodified by the
 * page (`import '../core/index.js'`) and by the tests, and there is no bundler
 * to shake anything out. One `import { readFileSync } from 'node:fs'` reached
 * from core/index.js is a console that will not boot — and it fails in the
 * browser, at a page nobody is watching, not here.
 *
 * This is written as a graph walk rather than a rule about one file, because
 * that is exactly how it broke: core/index.js re-exported the two server-side
 * modules, which was invisible until a browser tried it. The walk catches the
 * next one wherever it appears.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

/** Every relative module reachable from an entry, as repo paths. */
function graph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop().split(sep).join('/');
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const re of [/\bfrom\s+['"](\.[^'"]+)['"]/g, /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g]) {
      for (const m of src.matchAll(re)) {
        queue.push(normalize(join(dirname(file), m[1])).split(sep).join('/'));
      }
    }
  }
  return seen;
}

const entries = ['core/index.js', 'web/app.js'];

test('the browser module graph reaches no Node built-in', () => {
  for (const entry of entries) {
    const files = graph(entry);
    assert.ok(files.size > 5, `${entry} resolves to a real graph, not one file`);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const nodeImports = [...src.matchAll(/\bfrom\s+['"](node:[^'"]+|fs|path|crypto|http|url)['"]/g)]
        .map((m) => m[1]);
      assert.deepEqual(nodeImports, [],
        `${file} imports ${nodeImports.join(', ')} — reached from ${entry}, which the browser loads`);
    }
  }
});

test('the server-side modules are reachable only from Node', () => {
  // The two modules that ARE Node-side, and the reason the walk above exists.
  for (const file of ['core/guards.js', 'core/drawing-store.js']) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /from 'node:/, `${file} is server-side, as intended`);
  }
  // ...and nothing the browser loads pulls them in.
  for (const entry of entries) {
    const files = graph(entry);
    for (const serverSide of ['core/guards.js', 'core/drawing-store.js']) {
      assert.ok(!files.has(serverSide), `${entry} must not reach ${serverSide}`);
    }
  }
});

test('every page the browser opens resolves its imports inside the repo', () => {
  // Same walk, for the pages: an import that points outside the served roots is
  // a 404 in the browser and a green test here, so resolve them for real.
  for (const page of ['web/index.html', 'web/public.html', 'web/draw.html', 'web/content.html']) {
    const src = readFileSync(page, 'utf8');
    const dir = dirname(page);
    for (const m of src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const file = normalize(join(dir, m[1])).split(sep).join('/');
      assert.ok(existsSync(file), `${page} imports ${m[1]}, which resolves to ${file}`);
    }
    for (const m of src.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
      const file = normalize(join(dir, m[1])).split(sep).join('/');
      assert.ok(existsSync(file), `${page} loads ${m[1]}, which resolves to ${file}`);
    }
  }
});

test('the walk would have caught the regression it was written for', () => {
  // A guard test that cannot fail is a comment. This reconstructs the exact
  // break: core/index.js re-exporting the server-side guards, which is what
  // took the console down after the relay landed. If the rule above ever stops
  // being a rule, this test says so.
  assert.ok(!graph('core/index.js').has('core/guards.js'), 'the real graph is clean today');
  assert.match(readFileSync('core/guards.js', 'utf8'), /from 'node:/,
    'guards.js imports Node built-ins, so re-exporting it from core/index.js '
    + 'would put them in the browser graph � which is the break this catches');
});
