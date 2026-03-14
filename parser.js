import { TOKEN_TYPES } from './lexer.js';

export class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  peekAt(offset) { return this.tokens[this.pos + offset]; }
  advance() { return this.tokens[this.pos++]; }
  expect(type) {
    const t = this.advance();
    if (t.type !== type) throw new Error(`Expected ${type} but got ${t.type} ('${t.value}') at line ${t.line}`);
    return t;
  }
  match(type) {
    if (this.peek().type === type) { return this.advance(); }
    return null;
  }

  parse() {
    const program = { type: 'Program', globals: [], proctypes: [], init: null, ltl: [] };
    while (this.peek().type !== TOKEN_TYPES.EOF) {
      if (this.match(TOKEN_TYPES.SEMI)) continue;
      if (this.peek().type === TOKEN_TYPES.ACTIVE) {
        this.advance();
        program.proctypes.push(this.parseProctype(true));
      } else if (this.peek().type === TOKEN_TYPES.PROCTYPE) {
        program.proctypes.push(this.parseProctype(false));
      } else if (this.peek().type === TOKEN_TYPES.INIT) {
        this.advance();
        program.init = this.parseBody();
      } else if (this.peek().type === TOKEN_TYPES.LTL) {
        program.ltl.push(this.parseLtlBlock());
      } else if (this.peek().type === TOKEN_TYPES.MTYPE) {
        program.globals.push(this.parseMtypeDecl());
      } else {
        program.globals.push(this.parseDecl());
      }
    }
    return program;
  }

  parseLtlBlock() {
    const line = this.peek().line;
    this.advance(); // consume 'ltl'
    let name = null;
    if (this.peek().type === TOKEN_TYPES.IDENT) {
      name = this.advance().value;
    }
    this.expect(TOKEN_TYPES.LBRACE);
    // Collect tokens until matching RBRACE
    const tokens = [];
    let depth = 1;
    while (depth > 0 && this.peek().type !== TOKEN_TYPES.EOF) {
      const t = this.advance();
      if (t.type === TOKEN_TYPES.LBRACE) depth++;
      else if (t.type === TOKEN_TYPES.RBRACE) { depth--; if (depth === 0) break; }
      tokens.push(t);
    }
    // Append EOF token for LTLParser
    tokens.push({ type: TOKEN_TYPES.EOF, value: null, line: this.peek().line });
    return { type: 'LtlBlock', name, tokens, line };
  }

  parseProctype(active) {
    this.expect(TOKEN_TYPES.PROCTYPE);
    const name = this.expect(TOKEN_TYPES.IDENT).value;
    this.expect(TOKEN_TYPES.LPAREN);
    const params = [];
    if (this.peek().type !== TOKEN_TYPES.RPAREN) {
      params.push(this.parseParam());
      while (this.match(TOKEN_TYPES.COMMA)) {
        params.push(this.parseParam());
      }
    }
    this.expect(TOKEN_TYPES.RPAREN);
    const body = this.parseBody();
    return { type: 'Proctype', name, active, params, body };
  }

  parseParam() {
    const varType = this.advance().value;
    const name = this.expect(TOKEN_TYPES.IDENT).value;
    return { varType, name };
  }

  parseMtypeDecl() {
    const line = this.peek().line;
    this.expect(TOKEN_TYPES.MTYPE);
    this.expect(TOKEN_TYPES.ASSIGN);
    this.expect(TOKEN_TYPES.LBRACE);
    const names = [];
    names.push(this.expect(TOKEN_TYPES.IDENT).value);
    while (this.match(TOKEN_TYPES.COMMA)) {
      names.push(this.expect(TOKEN_TYPES.IDENT).value);
    }
    this.expect(TOKEN_TYPES.RBRACE);
    return { type: 'MtypeDecl', names, line };
  }

  parseBody() {
    this.expect(TOKEN_TYPES.LBRACE);
    const stmts = this.parseStmtList();
    this.expect(TOKEN_TYPES.RBRACE);
    return stmts;
  }

  parseStmtList() {
    const stmts = [];
    while (this.peek().type !== TOKEN_TYPES.RBRACE &&
           this.peek().type !== TOKEN_TYPES.FI &&
           this.peek().type !== TOKEN_TYPES.OD &&
           this.peek().type !== TOKEN_TYPES.EOF) {
      if (this.match(TOKEN_TYPES.SEMI)) continue;
      stmts.push(this.parseStmt());
      this.match(TOKEN_TYPES.SEMI);
    }
    return stmts;
  }

  parseStmt() {
    const tok = this.peek();
    // Label: IDENT COLON followed by a statement
    if (tok.type === TOKEN_TYPES.IDENT && this.peekAt(1).type === TOKEN_TYPES.COLON) {
      const name = this.advance().value;
      this.advance(); // consume COLON
      const stmt = this.parseStmt();
      return { type: 'Label', name, stmt, line: tok.line };
    }
    if (tok.type === TOKEN_TYPES.IF) return this.parseIf();
    if (tok.type === TOKEN_TYPES.DO) return this.parseDo();
    if (tok.type === TOKEN_TYPES.ATOMIC) { this.advance(); const body = this.parseBody(); return { type: 'Atomic', body, line: tok.line }; }
    if (tok.type === TOKEN_TYPES.D_STEP) { this.advance(); const body = this.parseBody(); return { type: 'DStep', body, line: tok.line }; }
    if (tok.type === TOKEN_TYPES.BREAK) { this.advance(); return { type: 'Break', line: tok.line }; }
    if (tok.type === TOKEN_TYPES.SKIP) { this.advance(); return { type: 'Skip', line: tok.line }; }
    if (tok.type === TOKEN_TYPES.PRINTF) return this.parsePrintf();
    if (tok.type === TOKEN_TYPES.ASSERT) return this.parseAssert();
    if (tok.type === TOKEN_TYPES.GOTO) { this.advance(); const lbl = this.expect(TOKEN_TYPES.IDENT).value; return { type: 'Goto', label: lbl, line: tok.line }; }
    if (this.isTypeToken(tok.type)) return this.parseDecl();
    return this.parseExprStmt();
  }

  isTypeToken(type) {
    return [TOKEN_TYPES.INT, TOKEN_TYPES.BOOL, TOKEN_TYPES.BYTE, TOKEN_TYPES.SHORT, TOKEN_TYPES.CHAN, TOKEN_TYPES.MTYPE].includes(type);
  }

  parseDecl() {
    const tok = this.peek();
    if (tok.type === TOKEN_TYPES.CHAN) return this.parseChanDecl();
    const varType = this.advance().value;
    const name = this.expect(TOKEN_TYPES.IDENT).value;
    let size = null;
    if (this.match(TOKEN_TYPES.LBRACKET)) {
      size = this.expect(TOKEN_TYPES.NUMBER).value;
      this.expect(TOKEN_TYPES.RBRACKET);
    }
    let init = null;
    if (this.match(TOKEN_TYPES.ASSIGN)) {
      if (size !== null && this.peek().type === TOKEN_TYPES.FALSE) {
        this.advance();
        init = { type: 'Literal', value: 0 };
      } else if (size !== null && this.peek().type === TOKEN_TYPES.TRUE) {
        this.advance();
        init = { type: 'Literal', value: 1 };
      } else {
        init = this.parseExpr();
      }
    }
    return { type: 'Decl', varType, name, size, init, line: tok.line };
  }

  parseChanDecl() {
    this.advance();
    const name = this.expect(TOKEN_TYPES.IDENT).value;
    let arraySize = null;
    if (this.match(TOKEN_TYPES.LBRACKET)) {
      arraySize = this.expect(TOKEN_TYPES.NUMBER).value;
      this.expect(TOKEN_TYPES.RBRACKET);
    }
    this.expect(TOKEN_TYPES.ASSIGN);
    this.expect(TOKEN_TYPES.LBRACKET);
    const bufSize = this.expect(TOKEN_TYPES.NUMBER).value;
    this.expect(TOKEN_TYPES.RBRACKET);
    this.expect(TOKEN_TYPES.OF);
    this.expect(TOKEN_TYPES.LBRACE);
    const msgTypes = [];
    msgTypes.push(this.advance().value);
    while (this.match(TOKEN_TYPES.COMMA)) {
      msgTypes.push(this.advance().value);
    }
    this.expect(TOKEN_TYPES.RBRACE);
    return { type: 'ChanDecl', name, bufSize, msgTypes, arraySize, line: this.peek().line };
  }

  parseIf() {
    this.expect(TOKEN_TYPES.IF);
    const branches = this.parseBranches();
    this.expect(TOKEN_TYPES.FI);
    return { type: 'If', branches };
  }

  parseDo() {
    this.expect(TOKEN_TYPES.DO);
    const branches = this.parseBranches();
    this.expect(TOKEN_TYPES.OD);
    return { type: 'Do', branches };
  }

  parseBranches() {
    const branches = [];
    while (this.peek().type === TOKEN_TYPES.GUARD) {
      this.advance();
      const guard = this.parseExprOrBool();
      this.match(TOKEN_TYPES.ARROW);
      const body = [];
      while (this.peek().type !== TOKEN_TYPES.GUARD &&
             this.peek().type !== TOKEN_TYPES.FI &&
             this.peek().type !== TOKEN_TYPES.OD &&
             this.peek().type !== TOKEN_TYPES.EOF) {
        if (this.match(TOKEN_TYPES.SEMI)) continue;
        body.push(this.parseStmt());
        this.match(TOKEN_TYPES.SEMI);
      }
      branches.push({ guard, body });
    }
    return branches;
  }

  parseExprOrBool() {
    const tok = this.peek();
    if (tok.type === TOKEN_TYPES.ELSE) { this.advance(); return { type: 'Else' }; }
    if (tok.type === TOKEN_TYPES.TIMEOUT) { this.advance(); return { type: 'Timeout' }; }
    // Parse as expression, but check for channel send/recv after
    const expr = this.parseExpr();
    if (this.peek().type === TOKEN_TYPES.SEND) {
      this.advance();
      const values = [this.parseExpr()];
      while (this.match(TOKEN_TYPES.COMMA)) values.push(this.parseExpr());
      return { type: 'Send', chan: expr, values };
    }
    if (this.peek().type === TOKEN_TYPES.RECV) {
      this.advance();
      const vars = [this.parseExpr()];
      while (this.match(TOKEN_TYPES.COMMA)) vars.push(this.parseExpr());
      return { type: 'Recv', chan: expr, vars };
    }
    return expr;
  }

  parsePrintf() {
    this.advance();
    this.expect(TOKEN_TYPES.LPAREN);
    const fmt = this.expect(TOKEN_TYPES.STRING).value;
    const args = [];
    while (this.match(TOKEN_TYPES.COMMA)) {
      args.push(this.parseExpr());
    }
    this.expect(TOKEN_TYPES.RPAREN);
    return { type: 'Printf', fmt, args };
  }

  parseAssert() {
    const line = this.peek().line;
    this.advance();
    this.expect(TOKEN_TYPES.LPAREN);
    const expr = this.parseExpr();
    this.expect(TOKEN_TYPES.RPAREN);
    return { type: 'Assert', expr, line };
  }

  parseExprStmt() {
    const expr = this.parseExpr();
    if (this.match(TOKEN_TYPES.ASSIGN)) {
      const value = this.parseExpr();
      return { type: 'Assign', target: expr, value };
    }
    if (this.peek().type === TOKEN_TYPES.SEND) {
      this.advance();
      const values = [this.parseExpr()];
      while (this.match(TOKEN_TYPES.COMMA)) values.push(this.parseExpr());
      return { type: 'Send', chan: expr, values };
    }
    if (this.peek().type === TOKEN_TYPES.RECV) {
      this.advance();
      const vars = [this.parseExpr()];
      while (this.match(TOKEN_TYPES.COMMA)) vars.push(this.parseExpr());
      return { type: 'Recv', chan: expr, vars };
    }
    return { type: 'ExprStmt', expr };
  }

  parseExpr() { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.match(TOKEN_TYPES.OR)) {
      left = { type: 'BinOp', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseBitOr();
    while (this.match(TOKEN_TYPES.AND)) {
      left = { type: 'BinOp', op: '&&', left, right: this.parseBitOr() };
    }
    return left;
  }

  parseBitOr() {
    let left = this.parseBitXor();
    while (this.match(TOKEN_TYPES.BOR)) {
      left = { type: 'BinOp', op: '|', left, right: this.parseBitXor() };
    }
    return left;
  }

  parseBitXor() {
    let left = this.parseBitAnd();
    while (this.match(TOKEN_TYPES.BXOR)) {
      left = { type: 'BinOp', op: '^', left, right: this.parseBitAnd() };
    }
    return left;
  }

  parseBitAnd() {
    let left = this.parseEquality();
    while (this.match(TOKEN_TYPES.BAND)) {
      left = { type: 'BinOp', op: '&', left, right: this.parseEquality() };
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    while (true) {
      if (this.match(TOKEN_TYPES.EQ)) { left = { type: 'BinOp', op: '==', left, right: this.parseComparison() }; }
      else if (this.match(TOKEN_TYPES.NEQ)) { left = { type: 'BinOp', op: '!=', left, right: this.parseComparison() }; }
      else break;
    }
    return left;
  }

  parseComparison() {
    let left = this.parseShift();
    while (true) {
      if (this.match(TOKEN_TYPES.LT)) { left = { type: 'BinOp', op: '<', left, right: this.parseShift() }; }
      else if (this.match(TOKEN_TYPES.GT)) { left = { type: 'BinOp', op: '>', left, right: this.parseShift() }; }
      else if (this.match(TOKEN_TYPES.LE)) { left = { type: 'BinOp', op: '<=', left, right: this.parseShift() }; }
      else if (this.match(TOKEN_TYPES.GE)) { left = { type: 'BinOp', op: '>=', left, right: this.parseShift() }; }
      else break;
    }
    return left;
  }

  parseShift() {
    let left = this.parseAdditive();
    while (true) {
      if (this.match(TOKEN_TYPES.LSHIFT)) { left = { type: 'BinOp', op: '<<', left, right: this.parseAdditive() }; }
      else if (this.match(TOKEN_TYPES.RSHIFT)) { left = { type: 'BinOp', op: '>>', left, right: this.parseAdditive() }; }
      else break;
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (true) {
      if (this.match(TOKEN_TYPES.PLUS)) { left = { type: 'BinOp', op: '+', left, right: this.parseMultiplicative() }; }
      else if (this.match(TOKEN_TYPES.MINUS)) { left = { type: 'BinOp', op: '-', left, right: this.parseMultiplicative() }; }
      else break;
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (true) {
      if (this.match(TOKEN_TYPES.STAR)) { left = { type: 'BinOp', op: '*', left, right: this.parseUnary() }; }
      else if (this.match(TOKEN_TYPES.SLASH)) { left = { type: 'BinOp', op: '/', left, right: this.parseUnary() }; }
      else if (this.match(TOKEN_TYPES.MOD)) { left = { type: 'BinOp', op: '%', left, right: this.parseUnary() }; }
      else break;
    }
    return left;
  }

  parseUnary() {
    if (this.match(TOKEN_TYPES.MINUS)) {
      return { type: 'UnaryOp', op: '-', operand: this.parseUnary() };
    }
    if (this.match(TOKEN_TYPES.NOT) || this.match(TOKEN_TYPES.SEND)) {
      return { type: 'UnaryOp', op: '!', operand: this.parseUnary() };
    }
    if (this.match(TOKEN_TYPES.BNOT)) {
      return { type: 'UnaryOp', op: '~', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const tok = this.peek();
    if (tok.type === TOKEN_TYPES.NUMBER) { this.advance(); return { type: 'Literal', value: tok.value }; }
    if (tok.type === TOKEN_TYPES.TRUE) { this.advance(); return { type: 'Literal', value: 1 }; }
    if (tok.type === TOKEN_TYPES.FALSE) { this.advance(); return { type: 'Literal', value: 0 }; }
    if (tok.type === TOKEN_TYPES.LPAREN) {
      this.advance();
      const expr = this.parseExpr();
      this.expect(TOKEN_TYPES.RPAREN);
      return expr;
    }
    if (tok.type === TOKEN_TYPES.RUN) {
      this.advance();
      const name = this.expect(TOKEN_TYPES.IDENT).value;
      this.expect(TOKEN_TYPES.LPAREN);
      const args = [];
      if (this.peek().type !== TOKEN_TYPES.RPAREN) {
        args.push(this.parseExpr());
        while (this.match(TOKEN_TYPES.COMMA)) {
          args.push(this.parseExpr());
        }
      }
      this.expect(TOKEN_TYPES.RPAREN);
      return { type: 'Run', name, args, line: tok.line };
    }
    if (tok.type === TOKEN_TYPES.IDENT) {
      // Built-in channel query functions: len(ch), empty(ch), full(ch), nfull(ch), nempty(ch)
      if (['len', 'empty', 'full', 'nfull', 'nempty'].includes(tok.value) && this.peekAt(1).type === TOKEN_TYPES.LPAREN) {
        const fname = this.advance().value;
        this.advance(); // consume LPAREN
        const arg = this.parseExpr();
        this.expect(TOKEN_TYPES.RPAREN);
        return { type: 'ChanOp', op: fname, arg, line: tok.line };
      }
      this.advance();
      let node = { type: 'Var', name: tok.value };
      if (this.match(TOKEN_TYPES.LBRACKET)) {
        const index = this.parseExpr();
        this.expect(TOKEN_TYPES.RBRACKET);
        node = { type: 'Index', base: node, index };
      }
      return node;
    }
    throw new Error(`Unexpected token ${tok.type} ('${tok.value}') at line ${tok.line}`);
  }
}
