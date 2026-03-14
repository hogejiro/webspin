import { tokenize } from './lexer.js';
import { Parser } from './parser.js';
import { Interpreter } from './interpreter.js';

function log(msg, cls) { console.log(`[${cls}] ${msg}`); }

function run(name, source) {
  console.log(`\n=== ${name} ===`);
  try {
    const tokens = tokenize(source);
    const ast = new Parser(tokens).parse();
    const interp = new Interpreter(ast, log, 'simulate');
    interp.run();
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
  }
}

// Test 1: Hello World
run('Hello World', `
active proctype hello() {
  printf("Hello, Promela!\\n")
}
active proctype world() {
  printf("World process running\\n")
}
`);

// Test 2: Shared counter
run('Shared Counter', `
int count = 0;
active proctype inc1() {
  int tmp;
  tmp = count;
  tmp = tmp + 1;
  count = tmp;
  printf("inc1: count = %d\\n", count)
}
active proctype inc2() {
  int tmp;
  tmp = count;
  tmp = tmp + 1;
  count = tmp;
  printf("inc2: count = %d\\n", count)
}
`);

// Test 3: Channel
run('Channel', `
chan ch = [2] of { int };
active proctype sender() {
  int i = 0;
  do
  :: i < 5 ->
    ch ! i;
    printf("sent: %d\\n", i);
    i = i + 1
  :: i >= 5 -> break
  od
}
active proctype receiver() {
  int val;
  do
  :: ch ? val ->
    printf("recv: %d\\n", val)
  :: timeout -> break
  od
}
`);

// Test 4: Peterson's mutex
run('Peterson Mutex', `
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
`);

console.log('\n=== All tests completed ===');
