import { tokenize } from './lexer.js';
import { Parser } from './parser.js';
import { Interpreter } from './interpreter.js';

// ============================================================
// Elevator controller verification
//
// Properties to check:
// 1. Elevator never goes above max floor or below min floor
// 2. Every request is eventually serviced (liveness via bounded steps)
// 3. Door is closed while moving
// 4. Elevator stops at requested floors
// ============================================================

const ELEVATOR_MODEL = `
/* Elevator controller for 4 floors (0-3) */
int floor = 0;          /* current floor */
int door = 0;           /* 0=closed, 1=open */
int moving = 0;         /* 0=stopped, 1=moving */
int direction = 1;      /* 1=up, -1(=big number, use 0)=down. Use 1=up, 0=down */
chan request = [4] of { int };   /* floor request queue */
int served = 0;         /* count of served requests */

active proctype controller() {
  int target;
  do
  :: request ? target ->
    printf("request for floor %d, currently at %d\\n", target, floor);

    /* Move to target floor */
    do
    :: floor < target ->
      assert(door == 0);    /* door must be closed while moving */
      moving = 1;
      floor = floor + 1;
      printf("moving up to %d\\n", floor);
      assert(floor >= 0);   /* bounds check */
      assert(floor <= 3)
    :: floor > target ->
      assert(door == 0);
      moving = 1;
      floor = floor - 1;
      printf("moving down to %d\\n", floor);
      assert(floor >= 0);
      assert(floor <= 3)
    :: floor == target -> break
    od;

    /* Arrived */
    moving = 0;
    door = 1;
    printf("arrived at floor %d, door open\\n", floor);
    assert(floor == target);  /* actually at requested floor */

    /* Close door */
    door = 0;
    printf("door closed\\n");
    served = served + 1

  :: timeout -> break
  od;
  printf("controller done, served %d requests\\n", served)
}

/* Passengers requesting various floors */
active proctype passenger1() {
  request ! 3;
  request ! 0
}

active proctype passenger2() {
  request ! 2;
  request ! 1
}

active proctype passenger3() {
  request ! 3;
  request ! 0
}
`;

console.log("=== Elevator Model - Single Run ===");
{
  const tokens = tokenize(ELEVATOR_MODEL);
  const ast = new Parser(tokens).parse();
  const interp = new Interpreter(ast, (msg, cls) => {
    if (cls === 'log-print') console.log(`  ${msg}`);
    else if (cls === 'log-error') console.log(`  !! ${msg}`);
    else if (cls === 'log-info') console.log(`  [info] ${msg}`);
  }, 'simulate');
  interp.run();

  console.log(`\n  Final state: floor=${interp.globals.floor}, door=${interp.globals.door}, served=${interp.globals.served}`);
}

console.log("\n=== Elevator Model - Verification (500 runs) ===");
{
  let errorRuns = 0;
  let deadlockRuns = 0;
  let totalServed = 0;
  const NUM_RUNS = 500;

  for (let i = 0; i < NUM_RUNS; i++) {
    const tokens = tokenize(ELEVATOR_MODEL);
    const ast = new Parser(tokens).parse();
    const output = [];
    const interp = new Interpreter(ast, (msg) => output.push(msg), 'verify');
    interp.maxSteps = 5000;
    interp.run();

    if (interp.errors.length > 0) errorRuns++;
    if (output.some(m => m.includes('DEADLOCK'))) deadlockRuns++;
    totalServed += interp.globals.served || 0;
  }

  console.log(`  Assertion violations: ${errorRuns}/${NUM_RUNS}`);
  console.log(`  Deadlocks: ${deadlockRuns}/${NUM_RUNS}`);
  console.log(`  Average requests served: ${(totalServed / NUM_RUNS).toFixed(1)}`);

  if (errorRuns === 0) console.log("  PASS: No safety violations (bounds, door-while-moving, arrival correctness)");
  else console.log("  FAIL: Safety violations detected!");

  if (totalServed / NUM_RUNS >= 5.5) console.log("  PASS: Liveness OK (most requests served)");
  else console.log(`  WARN: Low service rate, possible liveness issue`);
}

// ============================================================
// Buggy elevator - door stays open while moving
// ============================================================
const BUGGY_ELEVATOR = `
int floor = 0;
int door = 0;
int moving = 0;
chan request = [4] of { int };
int served = 0;

active proctype controller() {
  int target;
  do
  :: request ? target ->
    /* BUG: open door before moving! */
    door = 1;

    do
    :: floor < target ->
      assert(door == 0);  /* should catch the bug */
      floor = floor + 1
    :: floor > target ->
      assert(door == 0);
      floor = floor - 1
    :: floor == target -> break
    od;

    moving = 0;
    door = 0;
    served = served + 1
  :: timeout -> break
  od
}

active proctype passenger() {
  request ! 2;
  request ! 0
}
`;

console.log("\n=== Buggy Elevator (door open while moving) - Verification ===");
{
  let errorRuns = 0;
  const NUM_RUNS = 200;

  for (let i = 0; i < NUM_RUNS; i++) {
    const tokens = tokenize(BUGGY_ELEVATOR);
    const ast = new Parser(tokens).parse();
    const interp = new Interpreter(ast, () => {}, 'verify');
    interp.maxSteps = 2000;
    interp.run();
    if (interp.errors.length > 0) errorRuns++;
  }

  console.log(`  Bug detected in ${errorRuns}/${NUM_RUNS} runs`);
  if (errorRuns > 0) console.log("  PASS: Caught door-open-while-moving bug");
  else console.log("  FAIL: Should have caught the bug");
}

// ============================================================
// Elevator with floor bounds violation
// ============================================================
const BOUNDS_ELEVATOR = `
int floor = 0;
chan request = [2] of { int };
int door = 0;

active proctype controller() {
  int target;
  do
  :: request ? target ->
    do
    :: floor < target ->
      floor = floor + 1;
      assert(floor <= 3);
      assert(floor >= 0)
    :: floor > target ->
      floor = floor - 1;
      assert(floor <= 3);
      assert(floor >= 0)
    :: floor == target -> break
    od;
    door = 1;
    door = 0
  :: timeout -> break
  od
}

/* Request out of bounds floor - should NOT cause assertion failure
   because the loop simply won't terminate until floor == target,
   but target=5 means floor keeps going up past 3 */
active proctype bad_passenger() {
  request ! 5
}
`;

console.log("\n=== Elevator bounds check (request floor 5 on 0-3 building) ===");
{
  let errorRuns = 0;
  const NUM_RUNS = 100;

  for (let i = 0; i < NUM_RUNS; i++) {
    const tokens = tokenize(BOUNDS_ELEVATOR);
    const ast = new Parser(tokens).parse();
    const interp = new Interpreter(ast, () => {}, 'verify');
    interp.maxSteps = 200;
    interp.run();
    if (interp.errors.length > 0) errorRuns++;
  }

  console.log(`  Bounds violation detected in ${errorRuns}/${NUM_RUNS} runs`);
  if (errorRuns > 0) console.log("  PASS: Caught out-of-bounds floor request");
  else console.log("  FAIL: Should have caught bounds violation");
}
