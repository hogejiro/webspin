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
// Interpreter tests
// ============================================================

test('interpreter: basic rendezvous send/recv', () => {
  const { logs, interp } = simulate(`
    chan ch = [0] of { int };
    active proctype sender() {
      ch ! 42;
      printf("sent 42\\n")
    }
    active proctype receiver() {
      int v;
      ch ? v;
      printf("recv %d\\n", v)
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('recv 42')), 'Should receive 42 via rendezvous');
  assert(!interp.deadlocked, 'Should not deadlock');
});

test('interpreter: rendezvous multiple messages', () => {
  const { logs, interp } = simulate(`
    chan ch = [0] of { int };
    active proctype sender() {
      ch ! 1;
      ch ! 2;
      ch ! 3;
      printf("all sent\\n")
    }
    active proctype receiver() {
      int v;
      ch ? v; printf("got %d\\n", v);
      ch ? v; printf("got %d\\n", v);
      ch ? v; printf("got %d\\n", v);
      printf("all received\\n")
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('got 1')), 'Should get 1');
  assert(msgs.some(m => m.includes('got 2')), 'Should get 2');
  assert(msgs.some(m => m.includes('got 3')), 'Should get 3');
  assert(msgs.some(m => m.includes('all sent')), 'Sender should complete');
  assert(msgs.some(m => m.includes('all received')), 'Receiver should complete');
  assert(!interp.deadlocked, 'Should not deadlock');
});

test('interpreter: rendezvous with multiple values', () => {
  const { logs } = simulate(`
    chan ch = [0] of { int, int };
    active proctype sender() {
      ch ! 10, 20;
      printf("sent pair\\n")
    }
    active proctype receiver() {
      int a;
      int b;
      ch ? a, b;
      printf("recv %d %d\\n", a, b)
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('recv 10 20')), 'Should receive pair 10, 20');
});

test('interpreter: rendezvous blocks without partner', () => {
  const { interp } = simulate(`
    chan ch = [0] of { int };
    active proctype lonely() {
      ch ! 1;
      printf("never\\n")
    }
  `);
  assert(interp.deadlocked, 'Single sender on rendezvous should deadlock');
});

test('interpreter: rendezvous in do loop', () => {
  const { logs, interp } = simulate(`
    chan ch = [0] of { int };
    int count = 0;
    active proctype sender() {
      int i = 0;
      do
      :: i < 3 -> ch ! i; i = i + 1
      :: i >= 3 -> break
      od;
      printf("sender done\\n")
    }
    active proctype receiver() {
      int v;
      do
      :: ch ? v -> count = count + 1; printf("got %d\\n", v)
      :: timeout -> break
      od;
      printf("count=%d\\n", count)
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('count=3')), 'Should receive 3 messages');
  assert(!interp.deadlocked, 'Should not deadlock');
});

test('interpreter: rendezvous len/empty/full', () => {
  const { logs } = simulate(`
    chan ch = [0] of { int };
    active proctype P() {
      printf("len=%d empty=%d full=%d\\n", len(ch), empty(ch), full(ch))
    }
  `);
  const msgs = logs.map(l => l.msg);
  // Rendezvous channel: buffer is always 0, always empty, always full (can't buffer)
  assert(msgs.some(m => m.includes('len=0')), 'len should be 0');
  assert(msgs.some(m => m.includes('empty=1')), 'empty should be 1');
  assert(msgs.some(m => m.includes('full=1')), 'full should be 1 (bufSize=0, buffer.length=0 >= 0)');
});

// ============================================================
// Verifier tests
// ============================================================

test('verifier: rendezvous basic handshake', () => {
  const result = verify(`
    chan ch = [0] of { int };
    int received = 0;
    active proctype sender() { ch ! 42 }
    active proctype receiver() {
      int v;
      ch ? v;
      received = v
    }
    ltl { <> received == 42 }
  `);
  const ltlErrors = result.errors.filter(e => e.type === 'ltl');
  assert(ltlErrors.length === 0, `Expected no LTL errors, got ${ltlErrors.length}: ${JSON.stringify(ltlErrors)}`);
});

test('verifier: rendezvous ordering', () => {
  const result = verify(`
    chan ch = [0] of { int };
    int last = 0;
    active proctype sender() {
      ch ! 1;
      ch ! 2;
      ch ! 3
    }
    active proctype receiver() {
      int v;
      ch ? v; assert(v == 1);
      ch ? v; assert(v == 2);
      ch ? v; assert(v == 3);
      last = v
    }
    ltl { <> last == 3 }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: rendezvous deadlock detection', () => {
  const result = verify(`
    chan ch = [0] of { int };
    active proctype P() { ch ! 1 }
  `);
  const deadlocks = result.errors.filter(e => e.type === 'deadlock');
  assert(deadlocks.length > 0, 'Should detect deadlock with unmatched rendezvous send');
});

test('verifier: rendezvous as guard in if', () => {
  const result = verify(`
    chan ch = [0] of { int };
    int done = 0;
    active proctype sender() {
      if
      :: ch ! 1 -> done = 1
      fi
    }
    active proctype receiver() {
      int v;
      ch ? v
    }
    ltl { <> done == 1 }
  `);
  const ltlErrors = result.errors.filter(e => e.type === 'ltl');
  assert(ltlErrors.length === 0, `Expected no LTL errors, got ${ltlErrors.length}`);
});

test('verifier: rendezvous as guard in do', () => {
  const result = verify(`
    chan ch = [0] of { int };
    int sum = 0;
    active proctype sender() {
      ch ! 10;
      ch ! 20
    }
    active proctype receiver() {
      int v;
      do
      :: ch ? v -> sum = sum + v
      :: timeout -> break
      od;
      assert(sum == 30)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
