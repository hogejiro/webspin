import { tokenize, preprocess } from './lexer.js';
import { Parser } from './parser.js';
import { ExhaustiveVerifier } from './verifier.js';
import { LTLParser, toNNF, ltlToBuchi, ltlKey, ltlToString } from './ltl.js';

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

function parseLTL(src) {
  const tokens = tokenize(src);
  return new LTLParser(tokens).parse();
}

// ============================================================
// Parser tests
// ============================================================

test('parser: simple proposition', () => {
  const f = parseLTL('x == 0');
  assert(f.type === 'LTLProp', `expected LTLProp, got ${f.type}`);
  assert(f.expr.type === 'BinOp' && f.expr.op === '==');
});

test('parser: variable as proposition', () => {
  const f = parseLTL('flag');
  assert(f.type === 'LTLProp');
  assert(f.expr.type === 'Var' && f.expr.name === 'flag');
});

test('parser: G (globally)', () => {
  const f = parseLTL('G x == 0');
  assert(f.type === 'LTLGlobally');
  assert(f.child.type === 'LTLProp');
});

test('parser: [] syntax for G', () => {
  const f = parseLTL('[] x == 0');
  assert(f.type === 'LTLGlobally');
});

test('parser: F (finally)', () => {
  const f = parseLTL('F done');
  assert(f.type === 'LTLFinally');
  assert(f.child.type === 'LTLProp');
});

test('parser: <> syntax for F', () => {
  const f = parseLTL('<> done');
  assert(f.type === 'LTLFinally');
});

test('parser: X (next)', () => {
  const f = parseLTL('X ready');
  assert(f.type === 'LTLNext');
  assert(f.child.type === 'LTLProp');
});

test('parser: ! (negation)', () => {
  const f = parseLTL('! flag');
  assert(f.type === 'LTLNot');
  assert(f.child.type === 'LTLProp');
});

test('parser: && (and)', () => {
  const f = parseLTL('a && b');
  assert(f.type === 'LTLAnd');
  assert(f.left.type === 'LTLProp');
  assert(f.right.type === 'LTLProp');
});

test('parser: || (or)', () => {
  const f = parseLTL('a || b');
  assert(f.type === 'LTLOr');
});

test('parser: -> (implies)', () => {
  const f = parseLTL('a -> b');
  assert(f.type === 'LTLImplies');
});

test('parser: U (until)', () => {
  const f = parseLTL('a U b');
  assert(f.type === 'LTLUntil');
  assert(f.left.type === 'LTLProp');
  assert(f.right.type === 'LTLProp');
});

test('parser: R (release)', () => {
  const f = parseLTL('a R b');
  assert(f.type === 'LTLRelease');
});

test('parser: V as release', () => {
  const f = parseLTL('a V b');
  assert(f.type === 'LTLRelease');
});

test('parser: true/false literals', () => {
  const t = parseLTL('true');
  assert(t.type === 'LTLLit' && t.value === true);
  const ff = parseLTL('false');
  assert(ff.type === 'LTLLit' && ff.value === false);
});

test('parser: precedence G(p -> F q)', () => {
  const f = parseLTL('G (p -> F q)');
  assert(f.type === 'LTLGlobally');
  assert(f.child.type === 'LTLImplies');
  assert(f.child.right.type === 'LTLFinally');
});

test('parser: nested []<> p', () => {
  const f = parseLTL('[] <> p');
  assert(f.type === 'LTLGlobally');
  assert(f.child.type === 'LTLFinally');
  assert(f.child.child.type === 'LTLProp');
});

test('parser: comparison x > 5', () => {
  const f = parseLTL('G x > 5');
  assert(f.type === 'LTLGlobally');
  assert(f.child.type === 'LTLProp');
  assert(f.child.expr.op === '>');
});

test('parser: array indexing a[0]', () => {
  const f = parseLTL('a[0] == 1');
  assert(f.type === 'LTLProp');
  assert(f.expr.left.type === 'Index');
  assert(f.expr.left.base.name === 'a');
});

// ============================================================
// NNF tests
// ============================================================

test('nnf: double negation elimination', () => {
  const f = parseLTL('! ! p');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLProp', `expected LTLProp, got ${nnf.type}`);
});

test('nnf: !G p => F !p => true U !p', () => {
  const f = parseLTL('! G p');
  const nnf = toNNF(f);
  // !G p -> F !p -> true U !p
  assert(nnf.type === 'LTLUntil', `expected LTLUntil, got ${nnf.type}`);
  assert(nnf.left.type === 'LTLLit' && nnf.left.value === true);
  assert(nnf.right.type === 'LTLNot');
  assert(nnf.right.child.type === 'LTLProp');
});

test('nnf: !F p => G !p => false R !p', () => {
  const f = parseLTL('! F p');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLRelease', `expected LTLRelease, got ${nnf.type}`);
  assert(nnf.left.type === 'LTLLit' && nnf.left.value === false);
  assert(nnf.right.type === 'LTLNot');
});

test('nnf: !(p && q) => !p || !q', () => {
  const f = parseLTL('! (p && q)');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLOr');
  assert(nnf.left.type === 'LTLNot');
  assert(nnf.right.type === 'LTLNot');
});

test('nnf: !(p || q) => !p && !q', () => {
  const f = parseLTL('! (p || q)');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLAnd');
});

test('nnf: !(p U q) => !p R !q', () => {
  const f = parseLTL('! (p U q)');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLRelease');
  assert(nnf.left.type === 'LTLNot');
  assert(nnf.right.type === 'LTLNot');
});

test('nnf: implies expansion p -> q => !p || q', () => {
  const f = parseLTL('p -> q');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLOr');
  assert(nnf.left.type === 'LTLNot'); // !p
  assert(nnf.right.type === 'LTLProp'); // q
});

test('nnf: G p => false R p', () => {
  const f = parseLTL('G p');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLRelease');
  assert(nnf.left.type === 'LTLLit' && nnf.left.value === false);
  assert(nnf.right.type === 'LTLProp');
});

test('nnf: F p => true U p', () => {
  const f = parseLTL('F p');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLUntil');
  assert(nnf.left.type === 'LTLLit' && nnf.left.value === true);
  assert(nnf.right.type === 'LTLProp');
});

test('nnf: X p remains X p', () => {
  const f = parseLTL('X p');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLNext');
  assert(nnf.child.type === 'LTLProp');
});

test('nnf: !X p => X !p', () => {
  const f = parseLTL('! X p');
  const nnf = toNNF(f);
  assert(nnf.type === 'LTLNext');
  assert(nnf.child.type === 'LTLNot');
});

// ============================================================
// ltlKey tests
// ============================================================

test('ltlKey: consistent for same formula', () => {
  const f1 = toNNF(parseLTL('G p'));
  const f2 = toNNF(parseLTL('G p'));
  assert(ltlKey(f1) === ltlKey(f2), 'Same formula should produce same key');
});

test('ltlKey: different for different formulas', () => {
  const f1 = toNNF(parseLTL('G p'));
  const f2 = toNNF(parseLTL('F p'));
  assert(ltlKey(f1) !== ltlKey(f2), 'Different formulas should produce different keys');
});

// ============================================================
// ltlToString tests
// ============================================================

test('ltlToString: G p', () => {
  const f = parseLTL('G p');
  const s = ltlToString(f);
  assert(s === 'G p', `expected 'G p', got '${s}'`);
});

test('ltlToString: p -> F q', () => {
  const f = parseLTL('p -> F q');
  const s = ltlToString(f);
  assert(s === '(p -> F q)', `expected '(p -> F q)', got '${s}'`);
});

// ============================================================
// Büchi automaton construction tests
// ============================================================

test('buchi: true produces single accepting state', () => {
  const ba = ltlToBuchi(parseLTL('true'));
  assert(ba.states.length >= 1, 'Should have at least 1 state');
  assert(ba.initial.length >= 1, 'Should have initial states');
  assert(ba.states.some(s => s.accepting), 'Should have accepting state');
  // initial entries now have stateIdx and props
  assert(ba.initial[0].stateIdx !== undefined, 'Initial should have stateIdx');
});

test('buchi: false produces no initial states or empty', () => {
  const ba = ltlToBuchi(parseLTL('false'));
  assert(ba.states.length === 0 || ba.initial.length === 0,
    `false formula should produce empty automaton, got ${ba.states.length} states, ${ba.initial.length} initial`);
});

test('buchi: G p has states and transitions', () => {
  const ba = ltlToBuchi(parseLTL('G p'));
  assert(ba.states.length >= 1, `Should have states, got ${ba.states.length}`);
  assert(ba.initial.length >= 1, `Should have initial states, got ${ba.initial.length}`);
  assert(ba.transitions.length >= 1, `Should have transitions, got ${ba.transitions.length}`);
});

test('buchi: F p has accepting and non-accepting states', () => {
  const ba = ltlToBuchi(parseLTL('F p'));
  assert(ba.states.length >= 1, `Should have states, got ${ba.states.length}`);
  // F p = true U p: the Until creates accepting (right chosen) and non-accepting (waiting) states
  const accepting = ba.states.filter(s => s.accepting);
  assert(accepting.length >= 1, 'F p should have accepting states');
});

test('buchi: p U q has at least 2 states', () => {
  const ba = ltlToBuchi(parseLTL('p U q'));
  assert(ba.states.length >= 2, `p U q should have >= 2 states, got ${ba.states.length}`);
  // Should have both accepting (q satisfied) and non-accepting (waiting for q)
  const accepting = ba.states.filter(s => s.accepting);
  const nonAccepting = ba.states.filter(s => !s.accepting);
  assert(accepting.length >= 1, 'Should have accepting states');
  assert(nonAccepting.length >= 1, 'Should have non-accepting states');
});

test('buchi: G(p -> F q) produces non-trivial automaton', () => {
  const ba = ltlToBuchi(parseLTL('G (p -> F q)'));
  assert(ba.states.length >= 2, `Should have >= 2 states, got ${ba.states.length}`);
  assert(ba.transitions.length >= 2, `Should have >= 2 transitions, got ${ba.transitions.length}`);
  assert(ba.initial.length >= 1, 'Should have initial states');
});

test('buchi: transition props reflect propositions', () => {
  const ba = ltlToBuchi(parseLTL('G p'));
  const allProps = [...ba.initial.flatMap(i => i.props), ...ba.transitions.flatMap(t => t.props)];
  const hasP = allProps.some(p => p.expr.type === 'Var' && p.expr.name === 'p');
  assert(hasP, 'G p automaton should reference proposition p');
});

test('buchi: G p - initial and transitions reference p', () => {
  const ba = ltlToBuchi(parseLTL('G p'));
  // Initial states or their transitions should reference p
  const allProps = [...ba.initial.flatMap(i => i.props), ...ba.transitions.flatMap(t => t.props)];
  const hasP = allProps.some(p => p.expr.type === 'Var' && p.expr.name === 'p');
  assert(hasP, 'G p automaton should reference proposition p');
});

// ============================================================
// Integration tests: Promela + LTL → Verifier
// ============================================================

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

test('parser: ltl block parsed', () => {
  const ast = parse(`
    int x = 0;
    active proctype P() { x = 1 }
    ltl { [] x >= 0 }
  `);
  assert(ast.ltl.length === 1, `expected 1 ltl block, got ${ast.ltl.length}`);
  assert(ast.ltl[0].name === null);
});

test('parser: named ltl block', () => {
  const ast = parse(`
    int x = 0;
    active proctype P() { x = 1 }
    ltl safety { [] x >= 0 }
  `);
  assert(ast.ltl[0].name === 'safety');
});

test('parser: multiple ltl blocks', () => {
  const ast = parse(`
    int x = 0;
    active proctype P() { x = 1 }
    ltl p1 { [] x >= 0 }
    ltl p2 { <> x == 1 }
  `);
  assert(ast.ltl.length === 2);
});

test('verifier+ltl: G(x >= 0) holds for simple program', () => {
  const result = verify(`
    int x = 0;
    active proctype P() {
      x = 1;
      x = 2;
      x = 3
    }
    ltl { [] x >= 0 }
  `);
  const ltlErrors = result.errors.filter(e => e.type === 'ltl');
  assert(ltlErrors.length === 0, `Expected no LTL errors, got ${ltlErrors.length}`);
});

test('verifier+ltl: G(x > 0) violated when x starts at 0', () => {
  const result = verify(`
    int x = 0;
    active proctype P() {
      x = 1
    }
    ltl { [] x > 0 }
  `);
  const ltlErrors = result.errors.filter(e => e.type === 'ltl');
  assert(ltlErrors.length > 0, `Expected LTL violation, got none`);
});

test('verifier+ltl: F(x == 5) holds for counting program', () => {
  const result = verify(`
    int x = 0;
    active proctype P() {
      x = 1;
      x = 2;
      x = 3;
      x = 4;
      x = 5
    }
    ltl { <> x == 5 }
  `);
  const ltlErrors = result.errors.filter(e => e.type === 'ltl');
  assert(ltlErrors.length === 0, `Expected no LTL errors, got ${ltlErrors.length}`);
});

test('verifier+ltl: F(x == 5) violated when x never reaches 5', () => {
  const result = verify(`
    int x = 0;
    active proctype P() {
      x = 1;
      x = 2
    }
    ltl { <> x == 5 }
  `);
  const ltlErrors = result.errors.filter(e => e.type === 'ltl');
  assert(ltlErrors.length > 0, `Expected LTL violation, got none`);
});

test('verifier+ltl: G(x >= 0) with concurrent processes', () => {
  const result = verify(`
    int x = 0;
    active proctype P0() { x = x + 1 }
    active proctype P1() { x = x + 1 }
    ltl { [] x >= 0 }
  `);
  const ltlErrors = result.errors.filter(e => e.type === 'ltl');
  assert(ltlErrors.length === 0, `Expected no LTL errors, got ${ltlErrors.length}`);
});

test('verifier+ltl: no ltl blocks - regular verification only', () => {
  const result = verify(`
    int x = 0;
    active proctype P() { x = 1; assert(x == 1) }
  `);
  assert(result.errors.length === 0, `Expected no errors, got ${result.errors.length}`);
});

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed > 0) process.exit(1);
