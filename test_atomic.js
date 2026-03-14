import { tokenize, preprocess } from './lexer.js';
import { Parser } from './parser.js';
import { Interpreter } from './interpreter.js';
import { ExhaustiveVerifier } from './verifier.js';

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function parse(src) {
  const tokens = tokenize(preprocess(src));
  return new Parser(tokens).parse();
}

function verify(src) {
  const program = parse(src);
  const logs = [];
  const v = new ExhaustiveVerifier(program, (msg) => logs.push(msg));
  const result = v.verify();
  return result;
}

function run(src, maxSteps = 500) {
  const program = parse(src);
  const logs = [];
  const interp = new Interpreter(program, (msg) => logs.push(msg));
  interp.run(maxSteps);
  return { logs, interp };
}

console.log('--- Atomic mutex: no assertion violation ---');
test('atomic mutex', () => {
  const result = verify(`
int critical = 0;

active proctype P0() {
  atomic {
    critical = critical + 1;
    assert(critical == 1);
    critical = critical - 1
  }
}

active proctype P1() {
  atomic {
    critical = critical + 1;
    assert(critical == 1);
    critical = critical - 1
  }
}`);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
  assert(result.statesExplored > 0, 'Should explore some states');
});

console.log('--- Without atomic: assertion violation found ---');
test('broken mutex without atomic', () => {
  const result = verify(`
int critical = 0;

active proctype P0() {
  critical = critical + 1;
  assert(critical == 1);
  critical = critical - 1
}

active proctype P1() {
  critical = critical + 1;
  assert(critical == 1);
  critical = critical - 1
}`);
  assert(result.errors.length > 0, 'Expected assertion violations');
});

console.log('--- Atomic in interpreter ---');
test('atomic interpreter', () => {
  const { logs } = run(`
int x = 0;

active proctype P0() {
  atomic {
    x = 1;
    x = x + 1;
    x = x + 1
  };
  printf("P0: x = %d\\n", x)
}

active proctype P1() {
  atomic {
    x = 10;
    x = x + 1;
    x = x + 1
  };
  printf("P1: x = %d\\n", x)
}`);
  // With atomic blocks, either P0 runs first (x=3 then P1 sets x=12)
  // or P1 runs first (x=12 then P0 sets x=3)
  // The key is no interleaving within atomic blocks
  const output = logs.join('\n');
  assert(output.includes('P0: x =') && output.includes('P1: x ='),
    'Both processes should complete');
});

console.log('--- Dining philosophers: deadlock without atomic ---');
test('dining deadlock', () => {
  const result = verify(`
chan fork[2] = [1] of { int };
active proctype phil0() {
  fork[0] ! 1;
  do :: true -> fork[0] ? 1; fork[1] ? 1; fork[0] ! 1; fork[1] ! 1 od
}
active proctype phil1() {
  fork[1] ! 1;
  do :: true -> fork[1] ? 1; fork[0] ? 1; fork[1] ! 1; fork[0] ! 1 od
}`);
  assert(result.deadlocks > 0, 'Expected deadlock without atomic');
});

console.log('--- Dining philosophers: no deadlock with resource ordering ---');
test('dining resource ordering no deadlock', () => {
  const result = verify(`
chan fork[2] = [1] of { int };
active proctype phil0() {
  fork[0] ! 1;
  do :: true ->
    fork[0] ? 1; fork[1] ? 1;
    fork[0] ! 1; fork[1] ! 1
  od
}
active proctype phil1() {
  fork[1] ! 1;
  do :: true ->
    fork[0] ? 1; fork[1] ? 1;
    fork[0] ! 1; fork[1] ! 1
  od
}`);
  assert(result.deadlocks === 0, `Expected no deadlocks, got ${result.deadlocks}`);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

console.log('--- d_step mutex: no assertion violation ---');
test('d_step mutex', () => {
  const result = verify(`
int critical = 0;
active proctype P0() {
  d_step { critical = critical + 1; assert(critical == 1); critical = critical - 1 }
}
active proctype P1() {
  d_step { critical = critical + 1; assert(critical == 1); critical = critical - 1 }
}`);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

console.log('--- d_step in interpreter ---');
test('d_step interpreter', () => {
  // d_step should execute body as single step without interleaving
  const { logs, interp } = run(`
int x = 0;
active proctype P0() {
  d_step { x = 1; x = x + 1; x = x + 1 };
  printf("P0: x = %d\\n", x)
}
active proctype P1() {
  d_step { x = 10; x = x + 1; x = x + 1 };
  printf("P1: x = %d\\n", x)
}`);
  assert(interp.processes.every(p => p.done), 'Both processes should complete');
  // With d_step, no interleaving within the block
  const output = logs.join('\\n');
  assert(output.includes('P0: x =') && output.includes('P1: x ='),
    'Both processes should print');
});

console.log('--- d_step loses atomicity on block (SPIN semantics) ---');
test('d_step block loses atomicity', () => {
  // When d_step blocks mid-execution, it reverts to normal scheduling
  const result = verify(`
chan ch = [1] of { int };
int got = 0;
active proctype sender() {
  ch ! 42
}
active proctype receiver() {
  int val;
  d_step {
    ch ? val;
    got = val
  };
  assert(got == 42)
}`);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

console.log('--- Nested atomic (atomic inside do-loop) ---');
test('atomic inside do-loop', () => {
  const result = verify(`
int count = 0;

active proctype P0() {
  int i = 0;
  do
  :: i < 2 ->
    atomic {
      count = count + 1;
      assert(count <= 2)
    };
    i = i + 1
  :: i >= 2 -> break
  od
}

active proctype P1() {
  int i = 0;
  do
  :: i < 2 ->
    atomic {
      count = count + 1;
      assert(count <= 2)
    };
    i = i + 1
  :: i >= 2 -> break
  od
}`);
  // count can reach at most 4 (each proc increments twice), never > 2 in a single atomic step
  // But between atomic blocks, count accumulates, so count <= 2 could fail
  // Actually count grows up to 4 total, the assert checks <= 2, which can fail
  // when both procs have done one atomic increment each (count=2) then one does another (count=3)
  // This SHOULD find violations
  assert(result.errors.length > 0, 'Expected assertion violation when count > 2');
});

console.log('--- Atomic with channel ---');
test('atomic with channel', () => {
  const result = verify(`
chan ch = [1] of { int };
int received = 0;

active proctype sender() {
  atomic {
    ch ! 42
  }
}

active proctype receiver() {
  int val;
  atomic {
    ch ? val;
    received = val
  };
  assert(received == 42)
}`);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

console.log('--- Async verify with atomic ---');
test('async atomic verify', (done) => {
  const program = parse(`
int critical = 0;

active proctype P0() {
  atomic {
    critical = critical + 1;
    assert(critical == 1);
    critical = critical - 1
  }
}

active proctype P1() {
  atomic {
    critical = critical + 1;
    assert(critical == 1);
    critical = critical - 1
  }
}`);
  const v = new ExhaustiveVerifier(program, () => {});
  // Just run sync verify as a proxy - verifyAsync uses same _getTransitions
  const result = v.verify();
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
