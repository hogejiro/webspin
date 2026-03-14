import { tokenize } from './lexer.js';
import { Parser } from './parser.js';
import { Interpreter, Verifier } from './interpreter.js';

let passed = 0, failed = 0;

function log(msg, cls) {
  if (cls === 'log-error') console.log(`  !! ${msg}`);
  else if (cls === 'log-print') console.log(`  ${msg}`);
  // else skip info/warn for cleaner output
}

function quietLog() {} // suppress output for verify runs

function run(name, source, expectFn) {
  console.log(`\n--- ${name} ---`);
  try {
    const tokens = tokenize(source);
    const ast = new Parser(tokens).parse();
    const interp = new Interpreter(ast, log, 'simulate');
    interp.run();
    if (expectFn) {
      const result = expectFn(interp);
      if (result === true) { console.log(`  PASS`); passed++; }
      else { console.log(`  FAIL: ${result}`); failed++; }
    } else {
      console.log(`  (no assertion)`); passed++;
    }
  } catch (e) {
    console.log(`  FAIL (exception): ${e.message}`);
    failed++;
  }
}

function verify(name, source, expectErrors) {
  console.log(`\n--- [verify] ${name} ---`);
  try {
    const tokens = tokenize(source);
    const ast = new Parser(tokens).parse();

    let errorCount = 0;
    const NUM_RUNS = 200;
    for (let i = 0; i < NUM_RUNS; i++) {
      const interp = new Interpreter(ast, quietLog, 'verify');
      interp.maxSteps = 5000;
      interp.run();
      if (interp.errors.length > 0) errorCount++;
    }

    console.log(`  ${errorCount}/${NUM_RUNS} runs had errors`);
    if (expectErrors && errorCount === 0) {
      console.log(`  FAIL: expected errors but found none`);
      failed++;
    } else if (!expectErrors && errorCount > 0) {
      console.log(`  FAIL: expected no errors but found ${errorCount}`);
      failed++;
    } else {
      console.log(`  PASS`);
      passed++;
    }
  } catch (e) {
    console.log(`  FAIL (exception): ${e.message}`);
    failed++;
  }
}

// ============================================================
// 1. Peterson's Mutex - should NEVER violate mutual exclusion
// ============================================================
verify("Peterson's mutex is correct", `
bool flag[2] = false;
int turn = 0;
int critical = 0;

active proctype P0() {
  flag[0] = true;
  turn = 1;
  (flag[1] == false || turn == 0);
  critical = critical + 1;
  assert(critical == 1);
  critical = critical - 1;
  flag[0] = false
}

active proctype P1() {
  flag[1] = true;
  turn = 0;
  (flag[0] == false || turn == 1);
  critical = critical + 1;
  assert(critical == 1);
  critical = critical - 1;
  flag[1] = false
}
`, false);

// ============================================================
// 2. Broken mutex - NO protection, SHOULD find violation
// ============================================================
verify("Broken mutex (no lock) finds race", `
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
}
`, true);

// ============================================================
// 3. Producer-Consumer with bounded buffer
// ============================================================
run("Producer-Consumer bounded buffer", `
chan buf = [3] of { int };
int consumed = 0;

active proctype producer() {
  int i = 0;
  do
  :: i < 6 ->
    buf ! i;
    printf("produced %d\\n", i);
    i = i + 1
  :: i >= 6 -> break
  od
}

active proctype consumer() {
  int val;
  do
  :: buf ? val ->
    printf("consumed %d\\n", val);
    consumed = consumed + 1
  :: timeout -> break
  od;
  printf("total consumed: %d\\n", consumed)
}
`, (interp) => {
  const consumed = interp.globals['consumed'];
  if (consumed === 6) return true;
  return `expected consumed=6, got ${consumed}`;
});

// ============================================================
// 4. Token ring - N processes pass a token in a ring
// ============================================================
run("Token ring (3 processes)", `
chan ring0 = [1] of { int };
chan ring1 = [1] of { int };
chan ring2 = [1] of { int };
int rounds = 0;

active proctype node0() {
  ring0 ! 1;
  do
  :: ring0 ? 1 ->
    rounds = rounds + 1;
    printf("node0 got token, round %d\\n", rounds);
    if
    :: rounds >= 3 -> break
    :: rounds < 3 -> ring1 ! 1
    fi
  od
}

active proctype node1() {
  int tok;
  do
  :: ring1 ? tok ->
    printf("node1 forwarding\\n");
    ring2 ! tok
  :: timeout -> break
  od
}

active proctype node2() {
  int tok;
  do
  :: ring2 ? tok ->
    printf("node2 forwarding\\n");
    ring0 ! tok
  :: timeout -> break
  od
}
`, (interp) => {
  const rounds = interp.globals['rounds'];
  if (rounds === 3) return true;
  return `expected rounds=3, got ${rounds}`;
});

// ============================================================
// 5. Alternating bit protocol (simplified)
// ============================================================
run("Alternating bit protocol", `
chan toR = [1] of { int, int };
chan toS = [1] of { int };
int delivered = 0;

active proctype sender() {
  int seq = 0;
  int msg = 10;
  int ack;
  do
  :: msg < 13 ->
    toR ! msg, seq;
    printf("sent msg=%d seq=%d\\n", msg, seq);
    toS ? ack;
    if
    :: ack == seq ->
      printf("ack ok for seq=%d\\n", seq);
      seq = 1 - seq;
      msg = msg + 1
    :: ack != seq ->
      printf("ack mismatch, resend\\n")
    fi
  :: msg >= 13 -> break
  od
}

active proctype receiver() {
  int expect_seq = 0;
  int msg;
  int seq;
  do
  :: toR ? msg, seq ->
    printf("recv msg=%d seq=%d\\n", msg, seq);
    if
    :: seq == expect_seq ->
      delivered = delivered + 1;
      expect_seq = 1 - expect_seq
    :: seq != expect_seq -> skip
    fi;
    toS ! seq
  :: timeout -> break
  od
}
`, (interp) => {
  const d = interp.globals['delivered'];
  if (d === 3) return true;
  return `expected delivered=3, got ${d}`;
});

// ============================================================
// 6. Dining philosophers - should deadlock
// ============================================================
{
  console.log("\n--- Dining philosophers deadlock detection ---");
  const source = `
chan fork0 = [1] of { int };
chan fork1 = [1] of { int };

active proctype init_forks() {
  fork0 ! 1;
  fork1 ! 1
}

active proctype phil0() {
  fork0 ? 1;
  fork1 ? 1;
  printf("phil0 eating\\n");
  fork0 ! 1;
  fork1 ! 1
}

active proctype phil1() {
  fork1 ? 1;
  fork0 ? 1;
  printf("phil1 eating\\n");
  fork1 ! 1;
  fork0 ! 1
}
`;
  let deadlockCount = 0;
  const NUM = 100;
  for (let i = 0; i < NUM; i++) {
    const tokens = tokenize(source);
    const ast = new Parser(tokens).parse();
    const output = [];
    const interp = new Interpreter(ast, (msg) => output.push(msg), 'simulate');
    interp.maxSteps = 500;
    interp.run();
    if (output.some(m => m.includes('DEADLOCK'))) deadlockCount++;
  }
  console.log(`  Deadlock detected in ${deadlockCount}/${NUM} runs`);
  if (deadlockCount > 0) { console.log("  PASS (deadlock possible)"); passed++; }
  else { console.log("  FAIL (expected some deadlocks)"); failed++; }
}

// ============================================================
// 7. Increment counter N times with lock - verify correctness
// ============================================================
verify("Lock-protected counter is correct", `
chan lock = [1] of { int };
int count = 0;

active proctype init_lock() {
  lock ! 1
}

active proctype worker1() {
  int i = 0;
  do
  :: i < 3 ->
    lock ? 1;
    count = count + 1;
    lock ! 1;
    i = i + 1
  :: i >= 3 -> break
  od
}

active proctype worker2() {
  int i = 0;
  do
  :: i < 3 ->
    lock ? 1;
    count = count + 1;
    lock ! 1;
    i = i + 1
  :: i >= 3 -> break
  od;
  (count == 6);
  assert(count == 6)
}
`, false);

// ============================================================
// 8. Unprotected counter - SHOULD find bug
// ============================================================
verify("Unprotected counter has race", `
int count = 0;

active proctype worker1() {
  int i = 0;
  do
  :: i < 3 ->
    int tmp;
    tmp = count;
    tmp = tmp + 1;
    count = tmp;
    i = i + 1
  :: i >= 3 -> break
  od
}

active proctype worker2() {
  int i = 0;
  do
  :: i < 3 ->
    int tmp;
    tmp = count;
    tmp = tmp + 1;
    count = tmp;
    i = i + 1
  :: i >= 3 -> break
  od;
  assert(count == 6)
}
`, true);

// ============================================================
// Summary
// ============================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
