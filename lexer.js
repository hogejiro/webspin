export const TOKEN_TYPES = {
  PROCTYPE: 'PROCTYPE', ACTIVE: 'ACTIVE', INIT: 'INIT', ATOMIC: 'ATOMIC', D_STEP: 'D_STEP', RUN: 'RUN', LTL: 'LTL',
  INT: 'INT', BOOL: 'BOOL', BYTE: 'BYTE', SHORT: 'SHORT',
  MTYPE: 'MTYPE',
  CHAN: 'CHAN', OF: 'OF',
  IF: 'IF', FI: 'FI', DO: 'DO', OD: 'OD',
  ELSE: 'ELSE', BREAK: 'BREAK', GOTO: 'GOTO', SKIP: 'SKIP',
  TRUE: 'TRUE', FALSE: 'FALSE',
  PRINTF: 'PRINTF', ASSERT: 'ASSERT',
  TIMEOUT: 'TIMEOUT',
  LBRACE: 'LBRACE', RBRACE: 'RBRACE', LPAREN: 'LPAREN', RPAREN: 'RPAREN',
  LBRACKET: 'LBRACKET', RBRACKET: 'RBRACKET',
  SEMI: 'SEMI', COMMA: 'COMMA', DOT: 'DOT', COLON: 'COLON',
  ARROW: 'ARROW', GUARD: 'GUARD',
  SEND: 'SEND', RECV: 'RECV',
  ASSIGN: 'ASSIGN', EQ: 'EQ', NEQ: 'NEQ',
  LT: 'LT', GT: 'GT', LE: 'LE', GE: 'GE',
  PLUS: 'PLUS', MINUS: 'MINUS', STAR: 'STAR', SLASH: 'SLASH', MOD: 'MOD',
  AND: 'AND', OR: 'OR', NOT: 'NOT',
  BAND: 'BAND', BOR: 'BOR', BXOR: 'BXOR', BNOT: 'BNOT',
  LSHIFT: 'LSHIFT', RSHIFT: 'RSHIFT',
  NUMBER: 'NUMBER', STRING: 'STRING', IDENT: 'IDENT',
  EOF: 'EOF',
};

const KEYWORDS = {
  'proctype': TOKEN_TYPES.PROCTYPE, 'active': TOKEN_TYPES.ACTIVE, 'init': TOKEN_TYPES.INIT, 'atomic': TOKEN_TYPES.ATOMIC, 'd_step': TOKEN_TYPES.D_STEP, 'run': TOKEN_TYPES.RUN,
  'int': TOKEN_TYPES.INT, 'bool': TOKEN_TYPES.BOOL, 'byte': TOKEN_TYPES.BYTE, 'short': TOKEN_TYPES.SHORT,
  'mtype': TOKEN_TYPES.MTYPE,
  'chan': TOKEN_TYPES.CHAN, 'of': TOKEN_TYPES.OF,
  'if': TOKEN_TYPES.IF, 'fi': TOKEN_TYPES.FI, 'do': TOKEN_TYPES.DO, 'od': TOKEN_TYPES.OD,
  'else': TOKEN_TYPES.ELSE, 'break': TOKEN_TYPES.BREAK, 'goto': TOKEN_TYPES.GOTO, 'skip': TOKEN_TYPES.SKIP,
  'true': TOKEN_TYPES.TRUE, 'false': TOKEN_TYPES.FALSE,
  'printf': TOKEN_TYPES.PRINTF, 'assert': TOKEN_TYPES.ASSERT,
  'timeout': TOKEN_TYPES.TIMEOUT,
  'ltl': TOKEN_TYPES.LTL,
};

class Token {
  constructor(type, value, line) { this.type = type; this.value = value; this.line = line; }
}

export function tokenize(source) {
  const tokens = [];
  let i = 0, line = 1;
  while (i < source.length) {
    if (source[i] === '\n') { line++; i++; continue; }
    if (/\s/.test(source[i])) { i++; continue; }
    if (source[i] === '/' && source[i+1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source[i] === '/' && source[i+1] === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i+1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (/\d/.test(source[i])) {
      let num = '';
      while (i < source.length && /\d/.test(source[i])) num += source[i++];
      tokens.push(new Token(TOKEN_TYPES.NUMBER, parseInt(num), line));
      continue;
    }
    if (source[i] === '"') {
      i++;
      let str = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          i++;
          if (source[i] === 'n') str += '\n';
          else if (source[i] === 't') str += '\t';
          else if (source[i] === '\\') str += '\\';
          else if (source[i] === '"') str += '"';
          else str += source[i];
        } else {
          str += source[i];
        }
        i++;
      }
      i++;
      tokens.push(new Token(TOKEN_TYPES.STRING, str, line));
      continue;
    }
    if (/[a-zA-Z_]/.test(source[i])) {
      let id = '';
      while (i < source.length && /[a-zA-Z0-9_]/.test(source[i])) id += source[i++];
      const type = KEYWORDS[id] || TOKEN_TYPES.IDENT;
      tokens.push(new Token(type, id, line));
      continue;
    }
    const two = source.substring(i, i+2);
    if (two === '::') { tokens.push(new Token(TOKEN_TYPES.GUARD, '::', line)); i += 2; continue; }
    if (two === '->') { tokens.push(new Token(TOKEN_TYPES.ARROW, '->', line)); i += 2; continue; }
    if (two === '==') { tokens.push(new Token(TOKEN_TYPES.EQ, '==', line)); i += 2; continue; }
    if (two === '!=') { tokens.push(new Token(TOKEN_TYPES.NEQ, '!=', line)); i += 2; continue; }
    if (two === '<=') { tokens.push(new Token(TOKEN_TYPES.LE, '<=', line)); i += 2; continue; }
    if (two === '>=') { tokens.push(new Token(TOKEN_TYPES.GE, '>=', line)); i += 2; continue; }
    if (two === '&&') { tokens.push(new Token(TOKEN_TYPES.AND, '&&', line)); i += 2; continue; }
    if (two === '||') { tokens.push(new Token(TOKEN_TYPES.OR, '||', line)); i += 2; continue; }
    if (two === '<<') { tokens.push(new Token(TOKEN_TYPES.LSHIFT, '<<', line)); i += 2; continue; }
    if (two === '>>') { tokens.push(new Token(TOKEN_TYPES.RSHIFT, '>>', line)); i += 2; continue; }
    const ch = source[i];
    const singles = {
      '{': TOKEN_TYPES.LBRACE, '}': TOKEN_TYPES.RBRACE,
      '(': TOKEN_TYPES.LPAREN, ')': TOKEN_TYPES.RPAREN,
      '[': TOKEN_TYPES.LBRACKET, ']': TOKEN_TYPES.RBRACKET,
      ';': TOKEN_TYPES.SEMI, ',': TOKEN_TYPES.COMMA, '.': TOKEN_TYPES.DOT, ':': TOKEN_TYPES.COLON,
      '!': TOKEN_TYPES.SEND, '?': TOKEN_TYPES.RECV,
      '=': TOKEN_TYPES.ASSIGN,
      '<': TOKEN_TYPES.LT, '>': TOKEN_TYPES.GT,
      '+': TOKEN_TYPES.PLUS, '-': TOKEN_TYPES.MINUS,
      '*': TOKEN_TYPES.STAR, '/': TOKEN_TYPES.SLASH, '%': TOKEN_TYPES.MOD,
      '&': TOKEN_TYPES.BAND, '|': TOKEN_TYPES.BOR, '^': TOKEN_TYPES.BXOR, '~': TOKEN_TYPES.BNOT,
    };
    if (singles[ch]) {
      tokens.push(new Token(singles[ch], ch, line));
      i++;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' at line ${line}`);
  }
  tokens.push(new Token(TOKEN_TYPES.EOF, null, line));
  return tokens;
}

export function preprocess(source) {
  const defines = {};
  const lines = source.split('\n');
  const output = [];

  for (const line of lines) {
    const m = line.match(/^\s*#define\s+([A-Za-z_]\w*)\s+(.+?)\s*$/);
    if (m) {
      defines[m[1]] = m[2];
      output.push(''); // preserve line numbering
      continue;
    }
    let result = line;
    // Apply substitutions, avoiding replacements inside string literals
    for (const [name, value] of Object.entries(defines)) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      // Split on strings, only substitute outside them
      const parts = result.split(/("(?:[^"\\]|\\.)*")/);
      for (let i = 0; i < parts.length; i += 2) {
        parts[i] = parts[i].replace(re, value);
      }
      result = parts.join('');
    }
    output.push(result);
  }
  return output.join('\n');
}
