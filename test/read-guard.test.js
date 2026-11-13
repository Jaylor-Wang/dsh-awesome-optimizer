import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCodeOutline, formatCodeOutline } from '../src/index.js';
import { createTestRuntime, call } from './support/runtime.js';

test('extractCodeOutline parses JS/TS and Python declarations with line numbers while ignoring comments', () => {
  const tsCode = [
    '/* export function fakeComment() {} */',
    '// export class FakeLineComment {}',
    'export interface PolicyRule {',
    '  id: string;',
    '}',
    'export class PolicyEngine {',
    '  async evaluate(exec: any) {',
    '    if (exec) return true;',
    '    return false;',
    '  }',
    '}',
    'export const buildHint = (msg: string) => msg.trim();'
  ].join('\n');

  const tsEntries = extractCodeOutline(tsCode, { filePath: 'policy.ts' });
  assert.deepEqual(tsEntries.map(e => `${e.line}:${e.text}`), [
    '3:export interface PolicyRule',
    '6:export class PolicyEngine',
    '7:async evaluate(exec: any)',
    '12:export const buildHint = (msg: string)'
  ]);

  const pyCode = [
    '# def ignored(): pass',
    'class WorkerDaemon:',
    '    def run_task(self, payload):',
    '        return payload',
    'async def boot_pool():',
    '    pass'
  ].join('\n');

  const pyEntries = extractCodeOutline(pyCode, { filePath: 'worker.py' });
  assert.deepEqual(pyEntries.map(e => `${e.line}:${e.text}`), [
    '2:class WorkerDaemon',
    '3:def run_task(self, payload)',
    '5:async def boot_pool()'
  ]);

  const formatted = formatCodeOutline(tsCode, { filePath: 'policy.ts', startLine: 5, endLine: 12 });
  assert.match(formatted, /^L6: export class PolicyEngine\nL7:   async evaluate\(exec: any\)\nL12: export const buildHint/);
});

test('readGuard truncates oversized single lines and injects tail outline on truncated blind read while preserving <content> wrapper', async () => {
  const headLines = Array.from({ length: 10 }, (_, i) => `export const head${i} = ${i};`);
  const tailLines = [
    'export function processPayment(orderId: string) {',
    '  return orderId;',
    '}',
    'export class AuditTrail {',
    '  record(entry: string) {',
    '    return entry;',
    '  }',
    '}'
  ];
  const fullContent = [...headLines, ...tailLines].join('\n');
  const hugeLine = 'Z'.repeat(600);

  const host = await createTestRuntime({
    optimizerConfig: {
      readGuard: {
        enabled: true,
        maxLineChars: 120,
        injectTailOutline: true,
        maxOutlineEntries: 10
      }
    },
    files: {
      'src/orders.ts': fullContent,
      'dist/bundle.js': hugeLine
    },
    configureTools(ctx, owner) {
      const fsService = ctx.get('fs');
      fsService.readText = async target => owner.virtualFs.get(target.displayPath);
    },
    readHandler(args, _exec, virtualFs) {
      const content = virtualFs.get(args.file_path);
      if (args.file_path === 'dist/bundle.js') {
        return `<path>${args.file_path}</path>\n<type>file</type>\n<content>\n1: ${content}\n\n(End of file - total 1 lines)\n</content>`;
      }
      const lines = content.split('\n');
      if (args.offset === undefined && args.limit === undefined) {
        // Simulate official DSH truncation after line 10
        const slice = lines.slice(0, 10).map((l, idx) => `${idx + 1}: ${l}`).join('\n');
        return `<path>${args.file_path}</path>\n<type>file</type>\n<content>\n${slice}\n\n(Showing lines 1-10 of ${lines.length}. Use offset=11 to continue.)\n</content>`;
      }
      const start = Math.max(0, (args.offset ?? 1) - 1);
      const count = args.limit ?? lines.length;
      const slice = lines.slice(start, start + count).map((l, idx) => `${start + idx + 1}: ${l}`).join('\n');
      return `<path>${args.file_path}</path>\n<type>file</type>\n<content>\n${slice}\n\n(Showing lines ${start + 1}-${Math.min(lines.length, start + count)} of ${lines.length}. Use offset=${start + count + 1} to continue.)\n</content>`;
    },
    script: [
      // 1. Blind read -> truncated -> gets tail outline of lines 11-18
      [call('r-blind', 'read', { file_path: 'src/orders.ts' })],
      // 2. Targeted offset read -> should NOT inject redundant tail outline
      [call('r-targeted', 'read', { file_path: 'src/orders.ts', offset: 11, limit: 4 })],
      // 3. Minified bundle -> truncated to maxLineChars=120 inside <content>
      [call('r-bundle', 'read', { file_path: 'dist/bundle.js' })],
      [{ type: 'text', text: 'Read guard verified.' }]
    ]
  });

  try {
    await host.run('Test readGuard');
    const results = host.events.filter(e => e.type === 'tool/result');
    assert.equal(results.length, 3);

    const blindText = results[0].data.message.content.map(b => b.text).join('\n');
    assert.match(blindText, /\[optimizer-read-guard\] Remaining file outline \(lines 11-18\):/);
    assert.match(blindText, /L11: export function processPayment\(orderId: string\)/);
    assert.match(blindText, /L14: export class AuditTrail/);
    assert.match(blindText, /<\/content>$/);

    const targetedText = results[1].data.message.content.map(b => b.text).join('\n');
    assert.doesNotMatch(targetedText, /Remaining file outline/);

    const bundleText = results[2].data.message.content.map(b => b.text).join('\n');
    assert.match(bundleText, /\[line truncated: \+483 chars\]/);
    assert.match(bundleText, /^<path>dist\/bundle\.js<\/path>[\s\S]*<\/content>$/);
    assert.doesNotMatch(bundleText, new RegExp('Z'.repeat(200)));

    const stats = host.readGuard.getStats(host.agent.session);
    assert.equal(stats.inspected, 3);
    assert.equal(stats.linesTruncated, 1);
    assert.equal(stats.outlinesInjected, 1);
  } finally {
    await host.dispose();
  }
});
