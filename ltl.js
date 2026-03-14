// LTL formula parser, NNF transformation, and Büchi automaton construction
// for the webspin educational model checker.

// ============================================================
// LTL AST node constructors
// ============================================================

const LTL = {
  prop: (expr) => ({ type: 'LTLProp', expr }),
  not: (child) => ({ type: 'LTLNot', child }),
  and: (left, right) => ({ type: 'LTLAnd', left, right }),
  or: (left, right) => ({ type: 'LTLOr', left, right }),
  implies: (left, right) => ({ type: 'LTLImplies', left, right }),
  next: (child) => ({ type: 'LTLNext', child }),
  until: (left, right) => ({ type: 'LTLUntil', left, right }),
  release: (left, right) => ({ type: 'LTLRelease', left, right }),
  globally: (child) => ({ type: 'LTLGlobally', child }),
  finally: (child) => ({ type: 'LTLFinally', child }),
  tt: () => ({ type: 'LTLLit', value: true }),
  ff: () => ({ type: 'LTLLit', value: false }),
};

// ============================================================
// LTL Parser
// Parses an LTL formula from a token stream (reuses Promela tokens).
// Operator precedence (low to high):
//   ->  ||  &&  U/V/R  X/G/F/!  atom
// ============================================================

import { TOKEN_TYPES } from './lexer.js';

export class LTLParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  advance() { return this.tokens[this.pos++]; }
  match(type) {
    if (this.peek().type === type) return this.advance();
    return null;
  }
  expect(type) {
    const t = this.advance();
    if (t.type !== type) throw new Error(`LTL: expected ${type}, got ${t.type} ('${t.value}')`);
    return t;
  }

  // Check if current token is an LTL temporal keyword
  isTemporalOp(val) {
    return ['G', 'F', 'X', 'U', 'V', 'R'].includes(val);
  }

  // Entry point: parse an LTL formula
  parse() {
    const f = this.parseImplies();
    return f;
  }

  // -> (right-associative)
  parseImplies() {
    let left = this.parseOr();
    if (this.peek().type === TOKEN_TYPES.ARROW) {
      this.advance();
      const right = this.parseImplies();
      return LTL.implies(left, right);
    }
    return left;
  }

  // ||
  parseOr() {
    let left = this.parseAnd();
    while (this.peek().type === TOKEN_TYPES.OR) {
      this.advance();
      left = LTL.or(left, this.parseAnd());
    }
    return left;
  }

  // &&
  parseAnd() {
    let left = this.parseBinary();
    while (this.peek().type === TOKEN_TYPES.AND) {
      this.advance();
      left = LTL.and(left, this.parseBinary());
    }
    return left;
  }

  // U, V, R (binary temporal, right-associative)
  parseBinary() {
    let left = this.parseUnary();
    const tok = this.peek();
    if (tok.type === TOKEN_TYPES.IDENT) {
      if (tok.value === 'U') {
        this.advance();
        return LTL.until(left, this.parseBinary());
      }
      if (tok.value === 'V' || tok.value === 'R') {
        this.advance();
        return LTL.release(left, this.parseBinary());
      }
    }
    return left;
  }

  // Unary: !, G, F, X, [] (G), <> (F)
  parseUnary() {
    const tok = this.peek();

    // ! (negation) - also SEND token since lexer maps '!' to SEND
    if (tok.type === TOKEN_TYPES.SEND || tok.type === TOKEN_TYPES.NOT) {
      this.advance();
      return LTL.not(this.parseUnary());
    }

    if (tok.type === TOKEN_TYPES.IDENT) {
      if (tok.value === 'G') { this.advance(); return LTL.globally(this.parseUnary()); }
      if (tok.value === 'F') { this.advance(); return LTL.finally(this.parseUnary()); }
      if (tok.value === 'X') { this.advance(); return LTL.next(this.parseUnary()); }
    }

    // [] = G, <> = F (SPIN syntax)
    if (tok.type === TOKEN_TYPES.LBRACKET) {
      const next = this.tokens[this.pos + 1];
      if (next && next.type === TOKEN_TYPES.RBRACKET) {
        this.advance(); this.advance(); // consume []
        return LTL.globally(this.parseUnary());
      }
    }
    if (tok.type === TOKEN_TYPES.LT) {
      const next = this.tokens[this.pos + 1];
      if (next && next.type === TOKEN_TYPES.GT) {
        this.advance(); this.advance(); // consume <>
        return LTL.finally(this.parseUnary());
      }
    }

    return this.parseAtom();
  }

  // Atom: true, false, (expr), Promela expression as proposition
  parseAtom() {
    const tok = this.peek();

    if (tok.type === TOKEN_TYPES.TRUE) { this.advance(); return LTL.tt(); }
    if (tok.type === TOKEN_TYPES.FALSE) { this.advance(); return LTL.ff(); }

    if (tok.type === TOKEN_TYPES.LPAREN) {
      this.advance();
      const f = this.parseImplies();
      this.expect(TOKEN_TYPES.RPAREN);
      return f;
    }

    // Promela expression as atomic proposition
    // Parse a comparison/expression using a simplified expression parser
    return LTL.prop(this.parsePromelaExpr());
  }

  // Simplified Promela expression parser for LTL propositions
  // Handles: comparisons, arithmetic, variables, array indexing, literals
  // Stops at LTL operators (U, V, R, G, F, X) and LTL syntax tokens
  parsePromelaExpr() {
    return this.parsePromelaComparison();
  }

  parsePromelaComparison() {
    let left = this.parsePromelaAdditive();
    const tok = this.peek();
    if (tok.type === TOKEN_TYPES.EQ) { this.advance(); return { type: 'BinOp', op: '==', left, right: this.parsePromelaAdditive() }; }
    if (tok.type === TOKEN_TYPES.NEQ) { this.advance(); return { type: 'BinOp', op: '!=', left, right: this.parsePromelaAdditive() }; }
    if (tok.type === TOKEN_TYPES.LT) {
      // Check it's not <> (finally operator)
      if (this.tokens[this.pos + 1]?.type === TOKEN_TYPES.GT) return left;
      this.advance();
      return { type: 'BinOp', op: '<', left, right: this.parsePromelaAdditive() };
    }
    if (tok.type === TOKEN_TYPES.GT) { this.advance(); return { type: 'BinOp', op: '>', left, right: this.parsePromelaAdditive() }; }
    if (tok.type === TOKEN_TYPES.LE) { this.advance(); return { type: 'BinOp', op: '<=', left, right: this.parsePromelaAdditive() }; }
    if (tok.type === TOKEN_TYPES.GE) { this.advance(); return { type: 'BinOp', op: '>=', left, right: this.parsePromelaAdditive() }; }
    return left;
  }

  parsePromelaAdditive() {
    let left = this.parsePromelaMultiplicative();
    while (true) {
      if (this.peek().type === TOKEN_TYPES.PLUS) { this.advance(); left = { type: 'BinOp', op: '+', left, right: this.parsePromelaMultiplicative() }; }
      else if (this.peek().type === TOKEN_TYPES.MINUS) { this.advance(); left = { type: 'BinOp', op: '-', left, right: this.parsePromelaMultiplicative() }; }
      else break;
    }
    return left;
  }

  parsePromelaMultiplicative() {
    let left = this.parsePromelaPrimary();
    while (true) {
      if (this.peek().type === TOKEN_TYPES.STAR) { this.advance(); left = { type: 'BinOp', op: '*', left, right: this.parsePromelaPrimary() }; }
      else if (this.peek().type === TOKEN_TYPES.SLASH) { this.advance(); left = { type: 'BinOp', op: '/', left, right: this.parsePromelaPrimary() }; }
      else if (this.peek().type === TOKEN_TYPES.MOD) { this.advance(); left = { type: 'BinOp', op: '%', left, right: this.parsePromelaPrimary() }; }
      else break;
    }
    return left;
  }

  parsePromelaPrimary() {
    const tok = this.peek();
    if (tok.type === TOKEN_TYPES.MINUS) {
      this.advance();
      const operand = this.parsePromelaPrimary();
      return { type: 'UnaryOp', op: '-', operand };
    }
    if (tok.type === TOKEN_TYPES.NUMBER) { this.advance(); return { type: 'Literal', value: tok.value }; }
    if (tok.type === TOKEN_TYPES.TRUE) { this.advance(); return { type: 'Literal', value: 1 }; }
    if (tok.type === TOKEN_TYPES.FALSE) { this.advance(); return { type: 'Literal', value: 0 }; }
    if (tok.type === TOKEN_TYPES.IDENT && !this.isTemporalOp(tok.value)) {
      // Channel query functions: len(ch), empty(ch), full(ch), nfull(ch), nempty(ch)
      if (['len', 'empty', 'full', 'nfull', 'nempty'].includes(tok.value) && this.tokens[this.pos + 1]?.type === TOKEN_TYPES.LPAREN) {
        const fname = this.advance().value;
        this.advance(); // consume LPAREN
        const arg = this.parsePromelaExpr();
        this.expect(TOKEN_TYPES.RPAREN);
        return { type: 'ChanOp', op: fname, arg, line: tok.line };
      }
      this.advance();
      let node = { type: 'Var', name: tok.value };
      if (this.peek().type === TOKEN_TYPES.LBRACKET) {
        this.advance();
        const index = this.parsePromelaExpr();
        this.expect(TOKEN_TYPES.RBRACKET);
        node = { type: 'Index', base: node, index };
      }
      return node;
    }
    if (tok.type === TOKEN_TYPES.LPAREN) {
      this.advance();
      const expr = this.parsePromelaExpr();
      this.expect(TOKEN_TYPES.RPAREN);
      return expr;
    }
    throw new Error(`LTL: unexpected token ${tok.type} ('${tok.value}') at line ${tok.line}`);
  }
}


// ============================================================
// NNF (Negation Normal Form) transformation
// Push negations inward, expand G/F/implies sugar.
// ============================================================

export function toNNF(formula) {
  return pushNeg(formula, false);
}

function pushNeg(f, neg) {
  switch (f.type) {
    case 'LTLLit':
      return neg ? { type: 'LTLLit', value: !f.value } : f;

    case 'LTLProp':
      return neg ? LTL.not(f) : f;

    case 'LTLNot':
      return pushNeg(f.child, !neg);

    case 'LTLAnd':
      if (neg) return LTL.or(pushNeg(f.left, true), pushNeg(f.right, true));
      return LTL.and(pushNeg(f.left, false), pushNeg(f.right, false));

    case 'LTLOr':
      if (neg) return LTL.and(pushNeg(f.left, true), pushNeg(f.right, true));
      return LTL.or(pushNeg(f.left, false), pushNeg(f.right, false));

    case 'LTLImplies':
      // p -> q = !p || q
      if (neg) return LTL.and(pushNeg(f.left, false), pushNeg(f.right, true));
      return LTL.or(pushNeg(f.left, true), pushNeg(f.right, false));

    case 'LTLNext':
      return LTL.next(pushNeg(f.child, neg));

    case 'LTLUntil':
      if (neg) return LTL.release(pushNeg(f.left, true), pushNeg(f.right, true));
      return LTL.until(pushNeg(f.left, false), pushNeg(f.right, false));

    case 'LTLRelease':
      if (neg) return LTL.until(pushNeg(f.left, true), pushNeg(f.right, true));
      return LTL.release(pushNeg(f.left, false), pushNeg(f.right, false));

    case 'LTLGlobally':
      // G p = false R p
      if (neg) return LTL.until(LTL.tt(), pushNeg(f.child, true)); // !G p = F !p = true U !p
      return LTL.release(LTL.ff(), pushNeg(f.child, false)); // G p = false R p

    case 'LTLFinally':
      // F p = true U p
      if (neg) return LTL.release(LTL.ff(), pushNeg(f.child, true)); // !F p = G !p = false R !p
      return LTL.until(LTL.tt(), pushNeg(f.child, false)); // F p = true U p
  }
  throw new Error(`LTL NNF: unknown node type ${f.type}`);
}


// ============================================================
// GPVW: LTL to Büchi Automaton (Gerth-Peled-Vardi-Wolper)
// ============================================================

// Unique key for an LTL formula (for set membership)
export function ltlKey(f) {
  switch (f.type) {
    case 'LTLLit': return f.value ? 'T' : 'F';
    case 'LTLProp': return `P(${exprKey(f.expr)})`;
    case 'LTLNot': return `!${ltlKey(f.child)}`;
    case 'LTLAnd': return `(${ltlKey(f.left)}&${ltlKey(f.right)})`;
    case 'LTLOr': return `(${ltlKey(f.left)}|${ltlKey(f.right)})`;
    case 'LTLNext': return `X${ltlKey(f.child)}`;
    case 'LTLUntil': return `(${ltlKey(f.left)}U${ltlKey(f.right)})`;
    case 'LTLRelease': return `(${ltlKey(f.left)}R${ltlKey(f.right)})`;
  }
  return '?';
}

function exprKey(e) {
  if (!e) return '?';
  if (e.type === 'Literal') return String(e.value);
  if (e.type === 'Var') return e.name;
  if (e.type === 'Index') return `${e.base.name}[${exprKey(e.index)}]`;
  if (e.type === 'BinOp') return `(${exprKey(e.left)}${e.op}${exprKey(e.right)})`;
  if (e.type === 'UnaryOp') return `${e.op}(${exprKey(e.operand)})`;
  return '?';
}

// Collect all Until subformulas (needed for acceptance condition)
function collectUntils(f, result = new Set()) {
  if (f.type === 'LTLUntil') result.add(ltlKey(f));
  if (f.left) collectUntils(f.left, result);
  if (f.right) collectUntils(f.right, result);
  if (f.child) collectUntils(f.child, result);
  return result;
}

// GPVW node: { id, incoming: Set<id>, now: Map<key, formula>, next: Map<key, formula>, untilsDone: Set<key> }
export function ltlToBuchi(formula) {
  const nnf = toNNF(formula);
  const untilFormulas = collectUntils(nnf);

  let nodeCounter = 0;
  const nodes = new Map(); // nodeKey -> node
  const INIT_ID = 'init';

  // Create initial node with the formula in "new" (to expand)
  function expand(toExpand, now, next, incoming, untilsDone) {
    if (toExpand.length === 0) {
      // All formulas processed; create or merge node
      const nextKey = [...next.keys()].sort().join(',');
      const existingId = [...nodes.values()].find(n => {
        const nNextKey = [...n.next.keys()].sort().join(',');
        return nNextKey === nextKey && sameNow(n.now, now);
      });

      if (existingId) {
        // Merge incoming edges
        for (const inc of incoming) existingId.incoming.add(inc);
        return;
      }

      const id = `n${nodeCounter++}`;
      const node = { id, incoming: new Set(incoming), now: new Map(now), next: new Map(next), untilsDone: new Set(untilsDone) };
      nodes.set(id, node);

      // Start expanding the successor node from 'next'
      const newToExpand = [...next.values()];
      expand(newToExpand, new Map(), new Map(), new Set([id]), new Set());
      return;
    }

    const f = toExpand[0];
    const rest = toExpand.slice(1);
    const key = ltlKey(f);

    if (now.has(key)) {
      // Already processed
      expand(rest, now, next, incoming, untilsDone);
      return;
    }

    // Check for contradiction: f and !f both in now
    if (f.type === 'LTLProp' && now.has(`!P(${exprKey(f.expr)})`)) return; // contradiction
    if (f.type === 'LTLNot' && f.child.type === 'LTLProp' && now.has(`P(${exprKey(f.child.expr)})`)) return;
    if (f.type === 'LTLLit' && !f.value) return; // false literal = contradiction

    // Literal true: skip
    if (f.type === 'LTLLit' && f.value) {
      expand(rest, now, next, incoming, untilsDone);
      return;
    }

    // Atomic proposition or its negation: add to now
    if (f.type === 'LTLProp' || (f.type === 'LTLNot' && f.child.type === 'LTLProp')) {
      const newNow = new Map(now);
      newNow.set(key, f);
      expand(rest, newNow, next, incoming, untilsDone);
      return;
    }

    // Next: add child to next set
    if (f.type === 'LTLNext') {
      const newNow = new Map(now);
      newNow.set(key, f);
      const newNext = new Map(next);
      const childKey = ltlKey(f.child);
      newNext.set(childKey, f.child);
      expand(rest, newNow, newNext, incoming, untilsDone);
      return;
    }

    // And: add both conjuncts
    if (f.type === 'LTLAnd') {
      const newNow = new Map(now);
      newNow.set(key, f);
      expand([f.left, f.right, ...rest], newNow, next, incoming, untilsDone);
      return;
    }

    // Or: split into two branches
    if (f.type === 'LTLOr') {
      const newNow1 = new Map(now); newNow1.set(key, f);
      const newNow2 = new Map(now); newNow2.set(key, f);
      expand([f.left, ...rest], newNow1, new Map(next), new Set(incoming), new Set(untilsDone));
      expand([f.right, ...rest], newNow2, new Map(next), new Set(incoming), new Set(untilsDone));
      return;
    }

    // Until: p U q -> split: either q now, or (p now AND p U q in next)
    if (f.type === 'LTLUntil') {
      const newNow1 = new Map(now); newNow1.set(key, f);
      const newNow2 = new Map(now); newNow2.set(key, f);
      const newNext2 = new Map(next);
      newNext2.set(key, f); // carry p U q into next
      // Branch 1: q is satisfied now (until is done)
      const ud1 = new Set(untilsDone); ud1.add(key);
      expand([f.right, ...rest], newNow1, new Map(next), new Set(incoming), ud1);
      // Branch 2: p now, and p U q persists
      expand([f.left, ...rest], newNow2, newNext2, new Set(incoming), new Set(untilsDone));
      return;
    }

    // Release: p R q -> split: either (p AND q) now, or (q now AND p R q in next)
    if (f.type === 'LTLRelease') {
      const newNow1 = new Map(now); newNow1.set(key, f);
      const newNow2 = new Map(now); newNow2.set(key, f);
      const newNext2 = new Map(next);
      newNext2.set(key, f);
      // Branch 1: both p and q satisfied now
      expand([f.left, f.right, ...rest], newNow1, new Map(next), new Set(incoming), new Set(untilsDone));
      // Branch 2: q now, p R q persists
      expand([f.right, ...rest], newNow2, newNext2, new Set(incoming), new Set(untilsDone));
      return;
    }

    // Fallback: treat as proposition
    const newNow = new Map(now);
    newNow.set(key, f);
    expand(rest, newNow, next, incoming, untilsDone);
  }

  function sameNow(a, b) {
    if (a.size !== b.size) return false;
    for (const k of a.keys()) if (!b.has(k)) return false;
    return true;
  }

  // Start expansion
  expand([nnf], new Map(), new Map(), new Set([INIT_ID]), new Set());

  // Build the Büchi automaton from nodes
  const states = [];
  const transitions = [];
  const initial = [];
  const stateMap = new Map(); // node id -> state index

  for (const [, node] of nodes) {
    const idx = states.length;
    stateMap.set(node.id, idx);

    // A state is accepting if all Until obligations in the NNF are satisfied
    // (i.e., for each Until subformula, either it's not in 'now' or its right side was chosen)
    let accepting = true;
    for (const uKey of untilFormulas) {
      if (node.now.has(uKey) && !node.untilsDone.has(uKey)) {
        accepting = false;
        break;
      }
    }

    states.push({ id: node.id, accepting });
  }

  // Build transitions
  for (const [, node] of nodes) {
    const toIdx = stateMap.get(node.id);
    // Extract propositions from 'now'
    const props = [];
    for (const [, f] of node.now) {
      if (f.type === 'LTLProp') props.push({ positive: true, expr: f.expr });
      else if (f.type === 'LTLNot' && f.child.type === 'LTLProp') props.push({ positive: false, expr: f.child.expr });
    }

    for (const fromId of node.incoming) {
      if (fromId === INIT_ID) {
        initial.push({ stateIdx: toIdx, props });
      } else {
        const fromIdx = stateMap.get(fromId);
        if (fromIdx !== undefined) {
          transitions.push({ from: fromIdx, to: toIdx, props });
        }
      }
    }
  }

  return { states, transitions, initial };
}


// ============================================================
// Pretty-printing for LTL formulas (for UI display)
// ============================================================

export function ltlToString(f) {
  switch (f.type) {
    case 'LTLLit': return f.value ? 'true' : 'false';
    case 'LTLProp': return exprToString(f.expr);
    case 'LTLNot': return `!${ltlToString(f.child)}`;
    case 'LTLAnd': return `(${ltlToString(f.left)} && ${ltlToString(f.right)})`;
    case 'LTLOr': return `(${ltlToString(f.left)} || ${ltlToString(f.right)})`;
    case 'LTLImplies': return `(${ltlToString(f.left)} -> ${ltlToString(f.right)})`;
    case 'LTLNext': return `X ${ltlToString(f.child)}`;
    case 'LTLUntil': return `(${ltlToString(f.left)} U ${ltlToString(f.right)})`;
    case 'LTLRelease': return `(${ltlToString(f.left)} R ${ltlToString(f.right)})`;
    case 'LTLGlobally': return `G ${ltlToString(f.child)}`;
    case 'LTLFinally': return `F ${ltlToString(f.child)}`;
  }
  return '?';
}

function exprToString(e) {
  if (!e) return '?';
  if (e.type === 'Literal') return String(e.value);
  if (e.type === 'Var') return e.name;
  if (e.type === 'Index') return `${e.base.name}[${exprToString(e.index)}]`;
  if (e.type === 'BinOp') return `(${exprToString(e.left)} ${e.op} ${exprToString(e.right)})`;
  return '?';
}
