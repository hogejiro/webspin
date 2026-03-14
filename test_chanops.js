import { tokenize, preprocess } from './lexer.js';
import { Parser } from './parser.js';
import { Interpreter } from './interpreter.js';
import { ExhaustiveVerifier } from './verifier.js';

let passed = 0, failed = 0;

function test(name, fn) {
  console.log(`--- ${name} ---`);
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

function simulate(src) {
  const program = parse(src);
  const logs = [];
  const interp = new Interpreter(program, (msg, cls) => logs.push({ msg, cls }));
  interp.run();
  return { logs, interp };
}

function verify(src) {
  const program = parse(src);
  const logs = [];
  const v = new ExhaustiveVerifier(program, (msg) => logs.push(msg));
  const result = v.verify();
  return { ...result, logs };
}

// ============================================================
// Parser tests
// ============================================================

test('parser: len(ch)', () => {
  const ast = parse(`
    chan ch = [3] of { int };
    active proctype P() {
      int n;
      n = len(ch)
    }
  `);
  const body = ast.proctypes[0].body;
  const assign = body[1];
  assert(assign.type === 'Assign');
  assert(assign.value.type === 'ChanOp');
  assert(assign.value.op === 'len');
  assert(assign.value.arg.type === 'Var');
  assert(assign.value.arg.name === 'ch');
});

test('parser: empty(ch)', () => {
  const ast = parse(`
    chan ch = [2] of { int };
    active proctype P() {
      (empty(ch))
    }
  `);
  const body = ast.proctypes[0].body;
  assert(body[0].type === 'ExprStmt');
  assert(body[0].expr.type === 'ChanOp');
  assert(body[0].expr.op === 'empty');
});

test('parser: full(ch)', () => {
  const ast = parse(`
    chan ch = [1] of { int };
    active proctype P() { assert(full(ch) == 0) }
  `);
  const body = ast.proctypes[0].body;
  assert(body[0].type === 'Assert');
  assert(body[0].expr.left.type === 'ChanOp');
  assert(body[0].expr.left.op === 'full');
});

test('parser: nfull and nempty', () => {
  const ast = parse(`
    chan ch = [2] of { int };
    active proctype P() {
      assert(nfull(ch));
      assert(nempty(ch) == 0)
    }
  `);
  const body = ast.proctypes[0].body;
  assert(body[0].expr.type === 'ChanOp' && body[0].expr.op === 'nfull');
  assert(body[1].expr.left.type === 'ChanOp' && body[1].expr.left.op === 'nempty');
});

test('parser: len with channel array', () => {
  const ast = parse(`
    chan ch[2] = [3] of { int };
    active proctype P() { int n; n = len(ch[0]) }
  `);
  const assign = ast.proctypes[0].body[1];
  assert(assign.value.type === 'ChanOp');
  assert(assign.value.arg.type === 'Index');
});

// ============================================================
// Interpreter tests
// ============================================================

test('interpreter: len returns buffer length', () => {
  const { logs } = simulate(`
    chan ch = [5] of { int };
    active proctype P() {
      printf("len0=%d\\n", len(ch));
      ch ! 10;
      printf("len1=%d\\n", len(ch));
      ch ! 20;
      ch ! 30;
      printf("len3=%d\\n", len(ch))
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('len0=0')), 'Initial len should be 0');
  assert(msgs.some(m => m.includes('len1=1')), 'After 1 send, len should be 1');
  assert(msgs.some(m => m.includes('len3=3')), 'After 3 sends, len should be 3');
});

test('interpreter: empty/nempty', () => {
  const { logs } = simulate(`
    chan ch = [3] of { int };
    active proctype P() {
      printf("empty=%d nempty=%d\\n", empty(ch), nempty(ch));
      ch ! 1;
      printf("empty=%d nempty=%d\\n", empty(ch), nempty(ch))
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('empty=1 nempty=0')), 'Empty channel: empty=1, nempty=0');
  assert(msgs.some(m => m.includes('empty=0 nempty=1')), 'Non-empty channel: empty=0, nempty=1');
});

test('interpreter: full/nfull', () => {
  const { logs } = simulate(`
    chan ch = [2] of { int };
    active proctype P() {
      printf("full=%d nfull=%d\\n", full(ch), nfull(ch));
      ch ! 1;
      ch ! 2;
      printf("full=%d nfull=%d\\n", full(ch), nfull(ch))
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('full=0 nfull=1')), 'Not-full channel: full=0, nfull=1');
  assert(msgs.some(m => m.includes('full=1 nfull=0')), 'Full channel: full=1, nfull=0');
});

test('interpreter: empty(ch) as guard blocks until empty', () => {
  const { logs } = simulate(`
    chan ch = [2] of { int };
    active proctype producer() {
      ch ! 1;
      ch ! 2
    }
    active proctype consumer() {
      int v;
      ch ? v;
      ch ? v;
      (empty(ch));
      printf("channel is empty\\n")
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('channel is empty')), 'Should print when channel is empty');
});

test('interpreter: len with channel array', () => {
  const { logs } = simulate(`
    chan ch[2] = [3] of { int };
    active proctype P() {
      ch[0] ! 10;
      ch[0] ! 20;
      ch[1] ! 30;
      printf("len0=%d len1=%d\\n", len(ch[0]), len(ch[1]))
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('len0=2 len1=1')), 'Channel array lengths should be independent');
});

// ============================================================
// Verifier tests
// ============================================================

test('verifier: len in assertion', () => {
  const result = verify(`
    chan ch = [3] of { int };
    active proctype P() {
      ch ! 1;
      ch ! 2;
      assert(len(ch) == 2)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: empty in guard', () => {
  const result = verify(`
    chan ch = [2] of { int };
    int done = 0;
    active proctype sender() { ch ! 1 }
    active proctype waiter() {
      int v;
      ch ? v;
      (empty(ch));
      done = 1
    }
    ltl { <> done == 1 }
  `);
  const ltlErrors = result.errors.filter(e => e.type === 'ltl');
  assert(ltlErrors.length === 0, `Expected no LTL errors, got ${ltlErrors.length}`);
});

test('verifier: full prevents send', () => {
  const result = verify(`
    chan ch = [1] of { int };
    active proctype P() {
      ch ! 1;
      assert(full(ch) == 1);
      int v;
      ch ? v;
      assert(full(ch) == 0)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: nfull/nempty in guards', () => {
  const result = verify(`
    chan ch = [2] of { int };
    int count = 0;
    active proctype P() {
      do
      :: nfull(ch) -> ch ! count; count = count + 1
      :: full(ch) -> break
      od;
      assert(count == 2)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: len with LTL property', () => {
  const result = verify(`
    chan buf = [3] of { int };
    active proctype P() {
      buf ! 1;
      buf ! 2;
      buf ! 3
    }
    ltl { <> len(buf) == 3 }
  `);
  const ltlErrors = result.errors.filter(e => e.type === 'ltl');
  assert(ltlErrors.length === 0, `Expected no LTL errors, got ${ltlErrors.length}`);
});

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
