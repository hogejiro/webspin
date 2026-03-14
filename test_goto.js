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

function verify(src) {
  const program = parse(src);
  const logs = [];
  const v = new ExhaustiveVerifier(program, (msg) => logs.push(msg));
  const result = v.verify();
  return { ...result, logs };
}

function simulate(src) {
  const program = parse(src);
  const logs = [];
  const interp = new Interpreter(program, (msg, cls) => logs.push({ msg, cls }));
  interp.run();
  return { logs, interp };
}

// === Parser tests ===

test('parser: label and goto', () => {
  const ast = parse(`
    active proctype P() {
      start: skip;
      goto start
    }
  `);
  const body = ast.proctypes[0].body;
  assert(body[0].type === 'Label');
  assert(body[0].name === 'start');
  assert(body[0].stmt.type === 'Skip');
  assert(body[1].type === 'Goto');
  assert(body[1].label === 'start');
});

test('parser: multiple labels', () => {
  const ast = parse(`
    active proctype P() {
      a: skip;
      b: skip;
      goto a
    }
  `);
  const body = ast.proctypes[0].body;
  assert(body[0].type === 'Label' && body[0].name === 'a');
  assert(body[1].type === 'Label' && body[1].name === 'b');
});

test('parser: colon token does not break guard', () => {
  // :: should still work as GUARD
  const ast = parse(`
    active proctype P() {
      do
      :: true -> skip; break
      od
    }
  `);
  assert(ast.proctypes[0].body[0].type === 'Do');
});

// === Interpreter tests ===

test('interpreter: simple goto loop', () => {
  const { logs, interp } = simulate(`
    int i = 0;
    active proctype P() {
      loop: i = i + 1;
      if
      :: i < 3 -> goto loop
      :: i >= 3 -> skip
      fi;
      printf("done i=%d\\n", i)
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('done i=3')), 'Should finish with i=3');
  assert(interp.processes[0].done, 'Process should terminate');
});

test('interpreter: goto forward', () => {
  const { logs } = simulate(`
    active proctype P() {
      goto end;
      printf("should not print\\n");
      end: printf("reached end\\n")
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(!msgs.some(m => m.includes('should not print')), 'Should skip middle');
  assert(msgs.some(m => m.includes('reached end')), 'Should reach end label');
});

test('interpreter: goto backward (loop)', () => {
  const { logs } = simulate(`
    int count = 0;
    active proctype P() {
      start: count = count + 1;
      if
      :: count < 5 -> goto start
      :: count >= 5 -> goto done
      fi;
      done: printf("count=%d\\n", count)
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('count=5')), 'Should count to 5');
});

test('interpreter: label with assignment', () => {
  const { logs } = simulate(`
    int x = 0;
    active proctype P() {
      mylabel: x = 42;
      printf("x=%d\\n", x)
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('x=42')), 'Label should not affect assignment');
});

// === Verifier tests ===

test('verifier: goto loop terminates', () => {
  const result = verify(`
    int count = 0;
    active proctype P() {
      start: count = count + 1;
      if
      :: count < 5 -> goto start
      :: count >= 5 -> goto done
      fi;
      done: assert(count == 5)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: goto forward skips code', () => {
  const result = verify(`
    int x = 0;
    active proctype P() {
      goto skip_assign;
      x = 99;
      skip_assign: assert(x == 0)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: goto with multiple processes', () => {
  const result = verify(`
    int x = 0;
    active proctype P0() {
      loop: x = x + 1;
      if
      :: x < 3 -> goto loop
      :: x >= 3 -> skip
      fi
    }
    active proctype P1() {
      loop: x = x + 1;
      if
      :: x < 3 -> goto loop
      :: x >= 3 -> skip
      fi
    }
  `);
  // Both processes increment x with goto loops - should terminate
  assert(result.deadlocks === 0, `Expected no deadlocks, got ${result.deadlocks}`);
});

test('verifier: goto in branch body', () => {
  const result = verify(`
    int x = 0;
    active proctype P() {
      if
      :: true -> goto done
      fi;
      x = 99;
      done: assert(x == 0)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: goto with assertion in labeled stmt', () => {
  const result = verify(`
    int x = 0;
    active proctype P() {
      x = 5;
      goto check;
      x = 0;
      check: assert(x == 5)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
