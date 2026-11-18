import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGrepOutput } from '../src/composite-tools.js';
import { FindOutput, clipUtf8, finishFindOutput } from '../src/find-read-output.js';
import { createTestRuntime, call } from './support/runtime.js';

const textOf = event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');

async function scenario(options, args, check) {
  const host = await createTestRuntime({
    ...options,
    script: [[call('hardened-find', 'find_and_read', args)], [{ type: 'text', text: 'Done.' }]]
  });
  try {
    await host.run('Verify bounded search and reads');
    const result = host.events.find(event => event.type === 'tool/result');
    assert.ok(result);
    await check({ host, result, output: textOf(result), reads: host.calls.filter(call => call.name === 'read') });
  } finally {
    await host.dispose();
  }
}

for (const contextLines of [0, 1]) {
  test(`find_and_read hard-caps Unicode output and long indexes with contextLines=${contextLines}`, async () => {
    const files = Object.fromEntries(Array.from({ length: 350 }, (_, i) => [
      `src/${i}-${'长路径'.repeat(25)}.ts`, `needle ${'中😀'.repeat(1500)}`
    ]));
    await scenario({ files, optimizerConfig: { compositeTools: { maxTotalBytes: 512 } } },
      { pattern: 'needle', contextLines }, ({ output, reads }) => {
        assert.ok(Buffer.byteLength(output) <= 512, `Got ${Buffer.byteLength(output)} bytes`);
        assert.doesNotMatch(output, /\uFFFD/);
        assert.match(output, /omitted/);
        assert.match(output, /narrow search or read by line/);
        if (contextLines === 0) assert.equal(reads.length, 0);
      });
  });
}

test('find_and_read bounds the default 24KB including a large overflow index', async () => {
  const files = Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`src/${i}-${'p'.repeat(80)}.ts`, 'needle']));
  await scenario({ files }, { pattern: 'needle', maxFiles: 1, maxWindows: 1 }, ({ output, reads }) => {
    assert.ok(Buffer.byteLength(output) <= 24576);
    assert.match(output, /Additional matches/);
    assert.match(output, /file index\(es\) omitted/);
    assert.equal(reads.length, 1);
  });
});

test('find_and_read retains matched rows when the first slice exceeds the budget', async () => {
  const files = { 'dense.ts': Array.from({ length: 20 }, (_, i) => `needle ${i} ${'x'.repeat(95)}`).join('\n') };
  await scenario({ files, optimizerConfig: { compositeTools: { maxTotalBytes: 512 } } },
    { pattern: 'needle', contextLines: 1 }, ({ output }) => {
      assert.ok(Buffer.byteLength(output) <= 512);
      assert.match(output, /> 1: needle/);
      assert.match(output, /context omitted/);
      const lastShown = [...output.matchAll(/^> (\d+):/gm)].at(-1);
      assert.ok(lastShown);
      assert.ok(output.includes(`L${Number(lastShown[1]) + 1}-20`));
    });
});

test('find_and_read preserves whitespace regexes and deduplicates only exact patterns', async () => {
  await scenario({ files: { 'a.ts': 'needle\n  needle\n ' } },
    { patterns: ['  needle', ' ', '  needle'], contextLines: 0 }, ({ output, host }) => {
      assert.deepEqual(host.calls.filter(call => call.name === 'grep').map(call => call.args.pattern), ['  needle', ' ']);
      assert.match(output, /2:   needle/);
      assert.doesNotMatch(output, /1: needle/);
    });
});

test('find_and_read preserves upstream counts and recovery locator', async () => {
  await scenario({
    files: { 'visible.ts': 'needle' },
    grepHandler: () => 'Found 1 of 100 matches\n\nvisible.ts\nLine 1: needle\n\n(Full grep result stored at: hidden-spill.txt. Use read to continue.)'
  }, { pattern: 'needle' }, ({ output }) => {
    assert.match(output, /Search incomplete/);
    assert.match(output, /1 of 100 matches/);
    assert.match(output, /hidden-spill\.txt/);
    assert.match(output, /> 1: needle/);
  });
});

test('find_and_read reports unavailable spill and partial grep failures within the byte cap', async () => {
  await scenario({
    files: { 'a.ts': 'needle' },
    optimizerConfig: { compositeTools: { maxTotalBytes: 512 } },
    grepHandler: args => {
      if (args.pattern === '[') throw new Error('invalid regex ' + '长'.repeat(5000));
      return 'Found 1 of 100 matches\n\na.ts\nLine 1: needle\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)';
    }
  }, { patterns: ['needle', '['] }, ({ output, result }) => {
    assert.equal(result.data.message.isError, false);
    assert.ok(Buffer.byteLength(output) <= 512);
    assert.match(output, /#1 truncated, #2 failed/);
    assert.match(output, /1 of 100/);
    assert.match(output, /could not be saved/);
  });
});

test('find_and_read caps all-error and zero-match output with oversized input', async () => {
  for (const fail of [false, true]) {
    await scenario({
      optimizerConfig: { compositeTools: { maxTotalBytes: 512 } },
      grepHandler: () => { if (fail) throw new Error('错误'.repeat(10000)); return 'No matches found'; }
    }, { pattern: 'x'.repeat(10000) }, ({ output, result, reads }) => {
      assert.equal(result.data.message.isError, fail);
      assert.ok(Buffer.byteLength(output) <= 512, `${Buffer.byteLength(output)} bytes`);
      assert.equal(reads.length, 0);
      assert.match(output, fail ? /failed/ : /No matches/);
    });
  }
});

test('parseGrepOutput unions independently capped grouped meta and rendered matches', () => {
  assert.deepEqual(parseGrepOutput('a.ts\nLine 1: one\nb.ts\nLine 2: two', {
    shape: 'matches', total: 100, truncated: true,
    files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'one' }] }]
  }), [
    { path: 'a.ts', lineNumber: 1, line: 'one' },
    { path: 'b.ts', lineNumber: 2, line: 'two' }
  ]);
});

test('find_and_read bounds dense chained windows, aggregate read lines, and concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const files = { 'long.ts': Array.from({ length: 2400 }, (_, i) => i % 12 === 0 ? 'needle' : 'padding').join('\n') };
  await scenario({
    files,
    optimizerConfig: { compositeTools: { maxWindowLines: 30, maxReadLines: 75, readConcurrency: 2, maxWindows: 10 } },
    async readHandler(args, _exec, virtualFs) {
      active++;
      maxActive = Math.max(active, maxActive);
      await new Promise(resolve => setTimeout(resolve, 15));
      active--;
      return virtualFs.get(args.file_path).split('\n').slice(args.offset - 1, args.offset - 1 + args.limit)
        .map((line, index) => `${args.offset + index}: ${line}`).join('\n');
    }
  }, { pattern: 'needle', contextLines: 5 }, ({ output, host, reads }) => {
    assert.equal(reads.length, 3);
    assert.ok(reads.every(call => call.args.limit <= 30));
    assert.equal(reads.reduce((sum, call) => sum + call.args.limit, 0), 75);
    assert.equal(maxActive, 2);
    const stats = host.compositeTools.getStats(host.agent.session);
    assert.equal(stats.findLinesRequested, 75);
    assert.equal(stats.findReadBatches, 2);
    assert.match(output, /Additional matches/);
  });
});

test('find_and_read preserves later pattern evidence before spending bytes on context', async () => {
  const padding = 'p'.repeat(650);
  const terms = ['alpha', 'beta', 'gamma'];
  const files = Object.fromEntries(terms.map((term, index) => [
    `${index}.ts`, [padding, padding, `const ${term} = true;`, padding, padding].join('\n')
  ]));
  await scenario({ files, optimizerConfig: { compositeTools: { maxTotalBytes: 4096, readConcurrency: 1 } } },
    { patterns: terms, contextLines: 2 }, ({ output, reads }) => {
      assert.deepEqual([...output.matchAll(/^> 3: const (\w+)/gm)].map(match => match[1]), terms);
      assert.equal(reads.length, 3);
      assert.ok(Buffer.byteLength(output) <= 4096);
      assert.ok(output.includes(`  2: ${padding}`));
      assert.match(output, /context omitted/);
    });
});

test('exact function names prefer definitions over imports and calls within the read limit', async () => {
  const files = {
    'calls.js': ['import { normalizePath, truncateLongLines } from "./helpers.js";', 'normalizePath(truncateLongLines(input));'].join('\n'),
    'helpers.js': ['// Helpers', '', 'export function normalizePath(filePath, cwd = "") {}', '', '', '', 'export function truncateLongLines(text, maxLineChars = 1500) {}', ''].join('\n')
  };
  const args = { patterns: ['normalizePath', 'truncateLongLines'], contextLines: 1, maxFiles: 1, maxWindows: 2 };
  await scenario({ files }, args, ({ output, reads }) => {
    assert.deepEqual(reads.map(({ args }) => [args.file_path, args.offset, args.limit]), [['helpers.js', 2, 7]]);
    assert.match(output, /^> 3: export function normalizePath/m);
    assert.match(output, /^> 7: export function truncateLongLines/m);
    assert.match(output, /calls\.js: L1-2/);
  });
  await scenario({ files }, { ...args, contextLines: 0 }, ({ output, reads }) => {
    assert.equal(reads.length, 0);
    assert.ok(output.indexOf('=== calls.js') < output.indexOf('=== helpers.js'));
  });
});

test('find_and_read stops scheduling further batches after output budget exhaustion', async () => {
  await scenario({
    files: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.ts`, `needle ${'x'.repeat(10000)}`])),
    optimizerConfig: { compositeTools: { maxTotalBytes: 512, readConcurrency: 3, maxFiles: 6 } }
  }, { pattern: 'needle' }, ({ output, reads }) => {
    assert.equal(reads.length, 1);
    assert.ok(Buffer.byteLength(output) <= 512);
    assert.match(output, /omitted/);
  });
});

test('find_and_read indexes matches hidden by native read truncation', async () => {
  await scenario({
    files: { 'native.ts': 'needle\nneedle\nneedle' },
    readHandler: () => '<content>\n1: needle\n\n(Output capped. Showing lines 1-1 of 3. Use offset=2 to continue.)\n</content>'
  }, { pattern: 'needle', contextLines: 1 }, ({ output }) => {
    assert.match(output, /> 1: needle/);
    assert.match(output, /native\.ts: L2-3/);
  });
});

test('find_and_read keeps bounded read errors and actionable locations', async () => {
  await scenario({
    files: { 'denied.ts': 'needle' },
    optimizerConfig: { compositeTools: { maxTotalBytes: 512 } },
    readHandler: () => { throw new Error('Access denied ' + 'x'.repeat(10000)); }
  }, { pattern: 'needle' }, ({ output }) => {
    assert.ok(Buffer.byteLength(output) <= 512);
    assert.match(output, /READ ERROR/);
    assert.match(output, /Access denied/);
    assert.match(output, /denied\.ts: L1/);
  });
});

test('find_and_read cancellation stops scheduling the next read batch', async () => {
  const controller = new AbortController();
  const host = await createTestRuntime({
    files: { 'a.ts': 'needle', 'b.ts': 'needle', 'c.ts': 'needle' },
    optimizerConfig: { compositeTools: { readConcurrency: 1 } },
    readHandler: () => { controller.abort(); return '1: needle'; }
  });
  try {
    const tool = host.ctx.tools.get('find_and_read', host.agent);
    await assert.rejects(tool.execute({ pattern: 'needle' }, {
      agent: host.agent, callId: 'cancel-find', rootCallId: 'cancel-find',
      signal: controller.signal, deferContext() {}
    }), /abort/i);
    assert.equal(host.calls.filter(call => call.name === 'read').length, 1);
  } finally { await host.dispose(); }
});

test('UTF-8 clipping and all finalization paths keep the complete byte contract', () => {
  for (let budget = 512; budget < 900; budget += 17) {
    const output = new FindOutput(budget);
    output.appendClipped('中😀'.repeat(1000));
    const final = finishFindOutput(output, []);
    assert.ok(Buffer.byteLength(final) <= budget);
    assert.doesNotMatch(final, /\uFFFD/);
  }
  for (let bytes = 0; bytes < 40; bytes++) {
    const clipped = clipUtf8('😀中'.repeat(50), bytes);
    assert.ok(Buffer.byteLength(clipped) <= bytes);
    assert.doesNotMatch(clipped, /\uFFFD/);
  }
});
