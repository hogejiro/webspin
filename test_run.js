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

test('parser: proctype with parameters', () => {
  const ast = parse(`
    proctype worker(int id) { skip }
  `);
  assert(ast.proctypes.length === 1);
  assert(ast.proctypes[0].params.length === 1);
  assert(ast.proctypes[0].params[0].name === 'id');
  assert(ast.proctypes[0].params[0].varType === 'int');
});

test('parser: proctype with multiple parameters', () => {
  const ast = parse(`
    proctype worker(int id, byte val) { skip }
  `);
  assert(ast.proctypes[0].params.length === 2);
  assert(ast.proctypes[0].params[1].name === 'val');
});

test('parser: run expression', () => {
  const ast = parse(`
    proctype worker() { skip }
    init { run worker() }
  `);
  assert(ast.init !== null);
  assert(ast.init[0].type === 'ExprStmt');
  assert(ast.init[0].expr.type === 'Run');
  assert(ast.init[0].expr.name === 'worker');
});

test('parser: run with arguments', () => {
  const ast = parse(`
    proctype worker(int id) { skip }
    init { run worker(42) }
  `);
  assert(ast.init[0].expr.args.length === 1);
  assert(ast.init[0].expr.args[0].type === 'Literal');
  assert(ast.init[0].expr.args[0].value === 42);
});

test('parser: run as assignment RHS', () => {
  const ast = parse(`
    proctype worker() { skip }
    init { int pid; pid = run worker() }
  `);
  const assign = ast.init[1];
  assert(assign.type === 'Assign');
  assert(assign.value.type === 'Run');
});

// === Interpreter tests ===

test('interpreter: run spawns process', () => {
  const { interp, logs } = simulate(`
    proctype worker() {
      printf("hello\\n")
    }
    init {
      run worker()
    }
  `);
  assert(interp.processes.length === 2, `Expected 2 processes, got ${interp.processes.length}`);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('hello')), 'Worker should print hello');
  assert(msgs.some(m => m.includes('Started worker')), 'Should log process start');
});

test('interpreter: run returns pid', () => {
  const { logs } = simulate(`
    proctype worker() { skip }
    init {
      int pid;
      pid = run worker();
      printf("pid = %d\\n", pid)
    }
  `);
  const msgs = logs.map(l => l.msg);
  const pidMsg = msgs.find(m => m.includes('pid ='));
  assert(pidMsg, 'Should print pid');
  // pid should be > 0 (init is pid 0)
  assert(pidMsg.includes('pid = 1'), `Expected pid = 1, got: ${pidMsg}`);
});

test('interpreter: run with arguments', () => {
  const { logs } = simulate(`
    proctype worker(int id) {
      printf("id = %d\\n", id)
    }
    init {
      run worker(42)
    }
  `);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('id = 42')), 'Worker should receive argument');
});

test('interpreter: multiple run calls', () => {
  const { interp, logs } = simulate(`
    proctype worker(int id) {
      printf("worker %d\\n", id)
    }
    init {
      run worker(1);
      run worker(2);
      run worker(3)
    }
  `);
  assert(interp.processes.length === 4, `Expected 4 processes (init + 3 workers), got ${interp.processes.length}`);
  const msgs = logs.map(l => l.msg);
  assert(msgs.some(m => m.includes('worker 1')));
  assert(msgs.some(m => m.includes('worker 2')));
  assert(msgs.some(m => m.includes('worker 3')));
});

// === Verifier tests ===

test('verifier: run creates process in state space', () => {
  const result = verify(`
    proctype worker() {
      skip
    }
    init {
      run worker()
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
  assert(result.statesExplored > 0, 'Should explore states');
});

test('verifier: run with assertion in spawned process', () => {
  const result = verify(`
    int x = 0;
    proctype worker() {
      x = x + 1;
      assert(x >= 1)
    }
    init {
      run worker();
      run worker()
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: run with data race detected', () => {
  const result = verify(`
    int critical = 0;
    proctype worker() {
      critical = critical + 1;
      assert(critical == 1);
      critical = critical - 1
    }
    init {
      run worker();
      run worker()
    }
  `);
  assert(result.errors.length > 0, 'Expected assertion violation from data race');
});

test('verifier: run with arguments', () => {
  const result = verify(`
    int sum = 0;
    proctype adder(int val) {
      sum = sum + val
    }
    init {
      run adder(10);
      run adder(20)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: run with channel communication', () => {
  const result = verify(`
    chan ch = [2] of { int };
    int received = 0;

    proctype producer(int val) {
      ch ! val
    }

    proctype consumer() {
      int v;
      ch ? v;
      received = received + 1
    }

    init {
      run producer(42);
      run consumer()
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

test('verifier: active proctype still works with run', () => {
  const result = verify(`
    int x = 0;
    proctype helper() {
      x = x + 1
    }
    active proctype main_proc() {
      run helper();
      (x == 1)
    }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
