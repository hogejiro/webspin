import { tokenize, preprocess } from './lexer.js';
import { Parser } from './parser.js';
import { ExhaustiveVerifier } from './verifier.js';

function compile(source) {
  return new Parser(tokenize(preprocess(source))).parse();
}

// 1. Assertion violation trace
console.log("=== Broken mutex - assertion violation trace ===");
{
  const ast = compile(`
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
`);
  const logs = [];
  const v = new ExhaustiveVerifier(ast, (msg, cls) => {
    logs.push(msg);
    console.log(`  [${cls}] ${msg}`);
  });
  const result = v.verify();
  console.log();

  // Check trace is present and non-empty
  const firstErr = result.errors.find(e => e.type === 'assertion');
  if (!firstErr) { console.log("FAIL: no assertion error"); process.exit(1); }
  if (firstErr.trace.length === 0) { console.log("FAIL: empty trace"); process.exit(1); }
  console.log(`  Trace has ${firstErr.trace.length} steps`);
  console.log(`  First step: pid=${firstErr.trace[0].pid} proc=${firstErr.trace[0].procName} insn=${firstErr.trace[0].insn}`);
  console.log("  PASS\n");
}

// 2. Deadlock trace
console.log("=== Dining philosophers - deadlock trace ===");
{
  const ast = compile(`
chan fork0 = [1] of { int };
chan fork1 = [1] of { int };
active proctype init_forks() {
  fork0 ! 1;
  fork1 ! 1
}
active proctype phil0() {
  fork0 ? 1;
  fork1 ? 1;
  printf("eating\\n");
  fork0 ! 1;
  fork1 ! 1
}
active proctype phil1() {
  fork1 ? 1;
  fork0 ? 1;
  printf("eating\\n");
  fork1 ! 1;
  fork0 ! 1
}
`);
  const logs = [];
  const v = new ExhaustiveVerifier(ast, (msg, cls) => {
    logs.push(msg);
    console.log(`  [${cls}] ${msg}`);
  });
  const result = v.verify();
  console.log();

  const dl = result.errors.find(e => e.type === 'deadlock');
  if (!dl) { console.log("FAIL: no deadlock"); process.exit(1); }
  if (dl.trace.length === 0) { console.log("FAIL: empty deadlock trace"); process.exit(1); }
  console.log(`  Trace has ${dl.trace.length} steps`);
  console.log("  PASS\n");
}

console.log("=== All trace tests passed ===");
