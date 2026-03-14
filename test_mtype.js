import { tokenize, preprocess } from './lexer.js';
import { Parser } from './parser.js';
import { Interpreter } from './interpreter.js';
import { ExhaustiveVerifier } from './verifier.js';

let passed = 0, failed = 0;

function log(msg, cls) {
  if (cls === 'log-print') console.log(`  ${msg}`);
  else if (cls === 'log-error') console.log(`  !! ${msg}`);
}

function quietLog() {}

function test(name, fn) {
  console.log(`\n--- ${name} ---`);
  try {
    const result = fn();
    if (result === true) { console.log('  PASS'); passed++; }
    else { console.log(`  FAIL: ${result}`); failed++; }
  } catch (e) {
    console.log(`  FAIL (exception): ${e.message}`);
    console.log(e.stack);
    failed++;
  }
}

// ============================================================
// 1. #define basic substitution
// ============================================================
test("#define substitution", () => {
  const source = `
#define MAX 5
int x = MAX;
active proctype P() {
  assert(x == 5)
}
`;
  const tokens = tokenize(preprocess(source));
  const ast = new Parser(tokens).parse();
  const interp = new Interpreter(ast, quietLog, 'simulate');
  interp.run();
  if (interp.globals.x !== 5) return `x = ${interp.globals.x}, expected 5`;
  if (interp.errors.length > 0) return `unexpected errors: ${interp.errors}`;
  return true;
});

// ============================================================
// 2. #define not replaced inside strings
// ============================================================
test("#define skips strings", () => {
  const source = `
#define FOO 42
active proctype P() {
  int x = FOO;
  printf("FOO is %d\\n", x)
}
`;
  const processed = preprocess(source);
  // "FOO is %d\n" should NOT be replaced
  if (!processed.includes('"FOO is %d')) return `string was modified: ${processed}`;
  const tokens = tokenize(processed);
  const ast = new Parser(tokens).parse();
  const interp = new Interpreter(ast, quietLog, 'simulate');
  interp.run();
  return true;
});

// ============================================================
// 3. mtype basic
// ============================================================
test("mtype declaration and use", () => {
  const source = `
mtype = { req, ack, nak };

active proctype P() {
  int x = req;
  int y = ack;
  int z = nak;
  assert(x == 1);
  assert(y == 2);
  assert(z == 3)
}
`;
  const tokens = tokenize(preprocess(source));
  const ast = new Parser(tokens).parse();
  const interp = new Interpreter(ast, quietLog, 'simulate');
  interp.run();
  if (interp.errors.length > 0) return `assertion errors: ${interp.errors}`;
  return true;
});

// ============================================================
// 4. mtype with channels
// ============================================================
test("mtype with channel send/recv", () => {
  const source = `
mtype = { ping, pong };
chan ch = [1] of { mtype };

active proctype sender() {
  ch ! ping;
  printf("sent ping\\n")
}

active proctype receiver() {
  mtype msg;
  ch ? msg;
  assert(msg == ping);
  printf("got ping!\\n")
}
`;
  const tokens = tokenize(preprocess(source));
  const ast = new Parser(tokens).parse();
  const interp = new Interpreter(ast, log, 'simulate');
  interp.run();
  if (interp.errors.length > 0) return `assertion errors: ${interp.errors}`;
  return true;
});

// ============================================================
// 5. Client-server protocol (from examples.js)
// ============================================================
test("Client-server protocol (exhaustive verify)", () => {
  const source = `
#define NREQ 3
mtype = { request, response, error };
chan toServer = [2] of { mtype, int };
chan toClient = [2] of { mtype, int };
int served = 0;

active proctype client() {
  int i = 0;
  mtype reply;
  int data;
  do
  :: i < NREQ ->
    toServer ! request, i;
    toClient ? reply, data;
    i = i + 1
  :: i >= NREQ -> break
  od
}

active proctype server() {
  mtype msg;
  int data;
  do
  :: toServer ? msg, data ->
    if
    :: msg == request ->
      toClient ! response, data * 10;
      served = served + 1
    :: else ->
      toClient ! error, 0
    fi
  :: timeout -> break
  od;
  assert(served == NREQ)
}
`;
  const tokens = tokenize(preprocess(source));
  const ast = new Parser(tokens).parse();
  const v = new ExhaustiveVerifier(ast, quietLog);
  const result = v.verify();
  console.log(`  States: ${result.statesExplored} (${result.uniqueStates} unique)`);
  if (result.errors.length > 0) return `errors found: ${result.errors.length}`;
  return true;
});

// ============================================================
// 6. #define with mtype combined
// ============================================================
test("#define + mtype combined", () => {
  const source = `
#define N 2
mtype = { start, done };
int count = 0;

active proctype worker1() {
  int i = 0;
  do
  :: i < N ->
    count = count + 1;
    i = i + 1
  :: i >= N -> break
  od
}

active proctype worker2() {
  int i = 0;
  do
  :: i < N ->
    count = count + 1;
    i = i + 1
  :: i >= N -> break
  od
}
`;
  const tokens = tokenize(preprocess(source));
  const ast = new Parser(tokens).parse();
  const interp = new Interpreter(ast, quietLog, 'simulate');
  interp.run();
  // count may be 2, 3, or 4 depending on interleaving
  if (interp.globals.count < 2 || interp.globals.count > 4)
    return `unexpected count: ${interp.globals.count}`;
  return true;
});

// ============================================================
// Summary
// ============================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
