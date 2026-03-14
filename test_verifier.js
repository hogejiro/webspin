import { tokenize } from './lexer.js';
import { Parser } from './parser.js';
import { ExhaustiveVerifier } from './verifier.js';

let passed = 0, failed = 0;

function quietLog() {}

function verifyExhaustive(name, source, expectErrors, expectDeadlocks) {
  console.log(`\n--- ${name} ---`);
  try {
    const tokens = tokenize(source);
    const ast = new Parser(tokens).parse();
    const logs = [];
    const v = new ExhaustiveVerifier(ast, (msg, cls) => logs.push({ msg, cls }));
    const result = v.verify();

    console.log(`  States: ${result.statesExplored} (${result.uniqueStates} unique)`);
    console.log(`  Errors: ${result.errors.length}, Deadlocks: ${result.deadlocks}`);

    let ok = true;
    if (expectErrors && result.errors.filter(e => e.type === 'assertion').length === 0) {
      console.log(`  FAIL: expected assertion errors but found none`);
      ok = false;
    }
    if (!expectErrors && result.errors.filter(e => e.type === 'assertion').length > 0) {
      console.log(`  FAIL: expected no assertion errors but found some`);
      ok = false;
    }
    if (expectDeadlocks && result.deadlocks === 0) {
      console.log(`  FAIL: expected deadlocks but found none`);
      ok = false;
    }
    if (expectDeadlocks === false && result.deadlocks > 0) {
      console.log(`  FAIL: expected no deadlocks but found ${result.deadlocks}`);
      ok = false;
    }

    if (ok) { console.log('  PASS'); passed++; }
    else { failed++; }
    return result;
  } catch (e) {
    console.log(`  FAIL (exception): ${e.message}`);
    console.log(e.stack);
    failed++;
    return null;
  }
}

// ============================================================
// 1. Hello world - trivial, no errors
// ============================================================
verifyExhaustive("Hello world (no errors)", `
active proctype hello() {
  printf("Hello!\\n")
}
active proctype world() {
  printf("World!\\n")
}
`, false, false);

// ============================================================
// 2. Peterson's mutex - MUST pass exhaustively
// ============================================================
verifyExhaustive("Peterson's mutex (exhaustive)", `
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
`, false, false);

// ============================================================
// 3. Broken mutex - MUST find assertion violation
// ============================================================
verifyExhaustive("Broken mutex (must find race)", `
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
`, true, false);

// ============================================================
// 4. Dining philosophers - MUST find deadlock
// ============================================================
verifyExhaustive("Dining philosophers (must deadlock)", `
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
`, false, true);

// ============================================================
// 5. Producer-consumer with timeout - no deadlock
// ============================================================
verifyExhaustive("Producer-consumer (no errors)", `
chan buf = [2] of { int };
int consumed = 0;

active proctype producer() {
  int i = 0;
  do
  :: i < 3 ->
    buf ! i;
    i = i + 1
  :: i >= 3 -> break
  od
}

active proctype consumer() {
  int val;
  do
  :: buf ? val ->
    consumed = consumed + 1
  :: timeout -> break
  od
}
`, false, false);

// ============================================================
// 6. Elevator controller - no deadlock (the bug we fixed!)
// ============================================================
verifyExhaustive("Elevator controller (no deadlock)", `
int floor = 0;
int door = 0;
int moving = 0;
chan request = [4] of { int };
int served = 0;

active proctype controller() {
  int target;
  do
  :: request ? target ->
    do
    :: floor < target ->
      assert(door == 0);
      moving = 1;
      floor = floor + 1
    :: floor > target ->
      assert(door == 0);
      moving = 1;
      floor = floor - 1
    :: floor == target -> break
    od;
    moving = 0;
    door = 1;
    door = 0;
    served = served + 1
  :: timeout -> break
  od
}

active proctype passengers() {
  request ! 3;
  request ! 1;
  request ! 0;
  request ! 2
}
`, false, false);

// ============================================================
// 7. Channel communication - simple
// ============================================================
verifyExhaustive("Channel send/recv (simple)", `
chan ch = [1] of { int };

active proctype sender() {
  ch ! 42
}

active proctype receiver() {
  int val;
  ch ? val;
  assert(val == 42)
}
`, false, false);

// ============================================================
// 8. Unprotected counter - MUST find bug
// ============================================================
verifyExhaustive("Unprotected counter (must find race)", `
int count = 0;

active proctype worker1() {
  int tmp;
  tmp = count;
  tmp = tmp + 1;
  count = tmp
}

active proctype worker2() {
  int tmp;
  tmp = count;
  tmp = tmp + 1;
  count = tmp;
  assert(count == 2)
}
`, true, false);

// ============================================================
// Summary
// ============================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
