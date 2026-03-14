// Exhaustive state-space model checker for Promela
// Implements on-the-fly DFS over the full reachable state graph.

import { LTLParser, toNNF, ltlToBuchi, ltlKey } from './ltl.js';

// ============================================================
// Step 1: Flatten AST to a Control Flow Graph (CFG)
// Each proctype becomes a flat array of instructions with explicit jumps.
// ============================================================

function flattenProc(stmts) {
  const insns = [];
  const labels = {}; // label name -> pc
  const gotoFixups = []; // { pc, label } - Jump instructions to patch
  function emit(insn) { insns.push(insn); return insns.length - 1; }

  function flatten(stmts, breakTarget) {
    for (const s of stmts) {
      flattenStmt(s, breakTarget);
    }
  }

  function flattenStmt(s, breakTarget) {
    switch (s.type) {
      case 'Decl':
        emit({ type: 'Decl', varType: s.varType, name: s.name, size: s.size, init: s.init, line: s.line });
        break;
      case 'ChanDecl':
        emit({ type: 'ChanDecl', name: s.name, bufSize: s.bufSize, msgTypes: s.msgTypes, arraySize: s.arraySize });
        break;
      case 'Assign':
        emit({ type: 'Assign', target: s.target, value: s.value });
        break;
      case 'Send':
        emit({ type: 'Send', chan: s.chan, values: s.values });
        break;
      case 'Recv':
        emit({ type: 'Recv', chan: s.chan, vars: s.vars });
        break;
      case 'Printf':
        emit({ type: 'Printf', fmt: s.fmt, args: s.args });
        break;
      case 'Assert':
        emit({ type: 'Assert', expr: s.expr, line: s.line });
        break;
      case 'Skip':
        emit({ type: 'Skip' });
        break;
      case 'ExprStmt':
        emit({ type: 'ExprStmt', expr: s.expr });
        break;
      case 'Break':
        emit({ type: 'Jump', target: breakTarget });
        break;
      case 'Goto': {
        const pc = emit({ type: 'Jump', target: -2 }); // -2 = goto placeholder
        gotoFixups.push({ pc, label: s.label });
        break;
      }
      case 'Label':
        labels[s.name] = insns.length; // next instruction's pc
        flattenStmt(s.stmt, breakTarget);
        break;
      case 'Atomic':
        emit({ type: 'AtomicStart' });
        flatten(s.body, breakTarget);
        emit({ type: 'AtomicEnd' });
        break;
      case 'DStep':
        emit({ type: 'DStepStart' });
        flatten(s.body, breakTarget);
        emit({ type: 'DStepEnd' });
        break;
      case 'If':
        flattenBranch(s.branches, null, breakTarget);
        break;
      case 'Do':
        flattenDo(s.branches, breakTarget);
        break;
      default:
        emit({ type: 'Skip' }); // fallback
    }
  }

  // if: branch point, each guard leads to its body, all bodies join at the end
  function flattenBranch(branches, loopTop, breakTarget) {
    // Emit a Branch instruction (placeholder, will be patched)
    const branchPc = emit({ type: 'Branch', branches: [] });
    const bodyEndJumps = [];

    for (const br of branches) {
      const bodyStart = insns.length;
      // If the guard is a Send/Recv, emit it as an instruction
      if (br.guard.type === 'Send' || br.guard.type === 'Recv') {
        emit({ type: br.guard.type, chan: br.guard.chan,
               values: br.guard.values, vars: br.guard.vars });
      }
      flatten(br.body, breakTarget);
      bodyEndJumps.push(emit({ type: 'Jump', target: -1 })); // placeholder
      insns[branchPc].branches.push({
        guard: br.guard,
        bodyStart,
      });
    }

    const joinPc = insns.length;
    for (const jpc of bodyEndJumps) {
      insns[jpc].target = joinPc;
    }
    insns[branchPc].joinPc = joinPc;
  }

  function flattenDo(branches, outerBreakTarget) {
    const loopTop = insns.length;
    const afterLoop = -1; // will be resolved

    // Emit Branch at loopTop
    const branchPc = emit({ type: 'DoBranch', branches: [], loopTop });
    const bodyEndJumps = [];

    for (const br of branches) {
      const bodyStart = insns.length;
      if (br.guard.type === 'Send' || br.guard.type === 'Recv') {
        emit({ type: br.guard.type, chan: br.guard.chan,
               values: br.guard.values, vars: br.guard.vars });
      }
      // break inside body should jump to afterLoop
      // We use a placeholder and patch it later
      flatten(br.body, -1); // breakTarget = -1, will be patched
      bodyEndJumps.push(emit({ type: 'Jump', target: loopTop })); // loop back
      insns[branchPc].branches.push({
        guard: br.guard,
        bodyStart,
      });
    }

    const afterLoopPc = insns.length;
    insns[branchPc].joinPc = afterLoopPc;

    // Patch break targets: all Jump instructions targeting -1 between branchPc and afterLoopPc
    // that were emitted by Break statements (not bodyEnd jumps which target loopTop)
    for (let i = branchPc + 1; i < afterLoopPc; i++) {
      if (insns[i].type === 'Jump' && insns[i].target === -1) {
        insns[i].target = afterLoopPc;
      }
    }
  }

  flatten(stmts, insns.length); // breakTarget for top level = end
  // Add terminal instruction
  emit({ type: 'End' });
  // Patch goto targets
  for (const { pc, label } of gotoFixups) {
    if (label in labels) {
      insns[pc].target = labels[label];
    } else {
      insns[pc].target = insns.length - 1; // jump to End if label not found
    }
  }
  return insns;
}


// ============================================================
// Step 2: Expression evaluator
// NOTE: Most cases are pure, but 'Run' mutates state (spawns a process).
// ============================================================

// Returns true if the expression has side effects and should not be evaluated
// just to test executability (e.g., during enabledTransitions checks).
function isSideEffectExpr(expr) {
  return expr.type === 'Run';
}

const MAX_PROCS = 255; // SPIN default limit

// evalCtx is optional: { state, cfgs, program } - needed for `run` expressions
function evalExpr(expr, locals, globals, evalCtx) {
  switch (expr.type) {
    case 'Literal': return expr.value;
    case 'Var': {
      const name = expr.name;
      if (name in locals) return locals[name];
      if (name in globals) return globals[name];
      return 0;
    }
    case 'Index': {
      const name = expr.base.name;
      const idx = evalExpr(expr.index, locals, globals, evalCtx);
      if (name in locals) return locals[name][idx];
      if (name in globals) return globals[name][idx];
      return 0;
    }
    case 'BinOp': {
      const l = evalExpr(expr.left, locals, globals, evalCtx);
      const r = evalExpr(expr.right, locals, globals, evalCtx);
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r !== 0 ? Math.trunc(l / r) : 0;
        case '%': return r !== 0 ? l % r : 0;
        case '==': return l === r ? 1 : 0;
        case '!=': return l !== r ? 1 : 0;
        case '<': return l < r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        case '&&': return (l && r) ? 1 : 0;
        case '||': return (l || r) ? 1 : 0;
        case '&': return l & r;
        case '|': return l | r;
        case '^': return l ^ r;
        case '<<': return l << r;
        case '>>': return l >> r;
      }
      return 0;
    }
    case 'UnaryOp': {
      const val = evalExpr(expr.operand, locals, globals, evalCtx);
      if (expr.op === '-') return -val;
      if (expr.op === '!') return val ? 0 : 1;
      if (expr.op === '~') return ~val;
      return val;
    }
    case 'ChanOp': {
      // Resolve channel using evalCtx (verifier) or fall back to globals lookup
      let ch = null;
      if (evalCtx) {
        const proc = evalCtx.proc || { locals: locals };
        ch = resolveChannel(evalCtx.state, proc, expr.arg);
      }
      if (!ch) return 0;
      switch (expr.op) {
        case 'len': return ch.buffer.length;
        case 'empty': return ch.buffer.length === 0 ? 1 : 0;
        case 'nempty': return ch.buffer.length > 0 ? 1 : 0;
        case 'full': return ch.buffer.length >= ch.bufSize ? 1 : 0;
        case 'nfull': return ch.buffer.length < ch.bufSize ? 1 : 0;
      }
      return 0;
    }
    case 'Run': {
      if (!evalCtx) return 0;
      const { state, cfgs, program } = evalCtx;
      if (state.procs.length >= MAX_PROCS) return 0;
      const ptIdx = program.proctypes.findIndex(p => p.name === expr.name);
      if (ptIdx === -1) return 0;
      const pid = state.procs.length;
      const newLocals = {};
      const pt = program.proctypes[ptIdx];
      if (pt.params) {
        for (let i = 0; i < pt.params.length; i++) {
          newLocals[pt.params[i].name] = i < expr.args.length ? evalExpr(expr.args[i], locals, state.globals, evalCtx) : 0;
        }
      }
      state.procs.push({
        pc: 0, locals: newLocals, done: false,
        name: expr.name, pid, cfgIdx: ptIdx,
        atomicDepth: 0, dstepDepth: 0,
      });
      return pid;
    }
  }
  return 0;
}


// ============================================================
// Step 3: State representation
// ============================================================

// State: { globals: {name: val|arr}, procs: [{pc, locals, done}], channels: {name: {bufSize, buffer}} }
// Channels are stored separately from globals for clarity.

function makeInitialState(program, cfgs) {
  const globals = {};
  const channels = {};

  // Execute global declarations
  let mtypeCounter = 1;
  for (const decl of program.globals) {
    if (decl.type === 'MtypeDecl') {
      for (const name of decl.names) {
        globals[name] = mtypeCounter++;
      }
    } else if (decl.type === 'ChanDecl') {
      if (decl.arraySize) {
        for (let i = 0; i < decl.arraySize; i++) {
          channels[`${decl.name}[${i}]`] = { bufSize: decl.bufSize, buffer: [] };
        }
        globals[decl.name] = { _chanArray: true, size: decl.arraySize, baseName: decl.name };
      } else {
        channels[decl.name] = { bufSize: decl.bufSize, buffer: [] };
      }
    } else {
      const init = decl.init ? evalExpr(decl.init, {}, globals) : 0;
      globals[decl.name] = decl.size !== null ? new Array(decl.size).fill(init) : init;
    }
  }

  const procs = [];
  let pid = 0;
  for (const pt of program.proctypes) {
    if (pt.active) {
      procs.push({ pc: 0, locals: {}, done: false, name: pt.name, pid: pid++, cfgIdx: cfgs.findIndex((_, i) => program.proctypes[i] === pt), atomicDepth: 0, dstepDepth: 0 });
    }
  }

  // init block becomes a process
  if (program.init) {
    const initCfgIdx = cfgs.length;
    cfgs.push(flattenProc(program.init));
    procs.push({ pc: 0, locals: {}, done: false, name: 'init', pid: pid++, cfgIdx: initCfgIdx, atomicDepth: 0, dstepDepth: 0 });
  }

  return { globals, procs, channels };
}

function cloneState(state) {
  const globals = {};
  for (const [k, v] of Object.entries(state.globals)) {
    if (Array.isArray(v)) globals[k] = [...v];
    else if (v && typeof v === 'object' && v._chanArray) globals[k] = { ...v };
    else globals[k] = v;
  }
  const channels = {};
  for (const [k, ch] of Object.entries(state.channels)) {
    channels[k] = { bufSize: ch.bufSize, buffer: ch.buffer.map(msg => [...msg]) };
  }
  const procs = state.procs.map(p => ({
    pc: p.pc,
    locals: cloneLocals(p.locals),
    done: p.done,
    name: p.name,
    pid: p.pid,
    cfgIdx: p.cfgIdx,
    atomicDepth: p.atomicDepth,
    dstepDepth: p.dstepDepth,
  }));
  return { globals, procs, channels };
}

function cloneLocals(locals) {
  const result = {};
  for (const [k, v] of Object.entries(locals)) {
    result[k] = Array.isArray(v) ? [...v] : v;
  }
  return result;
}

function stateKey(state) {
  // Canonical string for visited-set comparison
  const parts = [];
  // Globals (sorted keys for determinism)
  const gkeys = Object.keys(state.globals).sort();
  for (const k of gkeys) {
    const v = state.globals[k];
    if (v && typeof v === 'object' && v._chanArray) continue; // skip channel array markers
    parts.push(Array.isArray(v) ? `${k}=[${v}]` : `${k}=${v}`);
  }
  // Processes
  for (const p of state.procs) {
    const lkeys = Object.keys(p.locals).sort();
    const locals = lkeys.map(k => {
      const v = p.locals[k];
      return Array.isArray(v) ? `${k}=[${v}]` : `${k}=${v}`;
    }).join(',');
    parts.push(`P${p.pid}:${p.done ? 'D' : p.pc}:a${p.atomicDepth}:d${p.dstepDepth}:{${locals}}`);
  }
  // Channels
  const ckeys = Object.keys(state.channels).sort();
  for (const k of ckeys) {
    const ch = state.channels[k];
    parts.push(`C${k}:[${ch.buffer.map(m => m.join(',')).join('|')}]`);
  }
  return parts.join(';');
}


// ============================================================
// Step 4: Transition enumeration and execution
// ============================================================

function resolveChannel(state, proc, expr) {
  if (expr.type === 'Var') {
    return state.channels[expr.name] || null;
  }
  if (expr.type === 'Index') {
    const idx = evalExpr(expr.index, proc.locals, state.globals);
    return state.channels[`${expr.base.name}[${idx}]`] || null;
  }
  return null;
}

function getVar(proc, globals, name) {
  if (name in proc.locals) return proc.locals[name];
  if (name in globals) return globals[name];
  return 0;
}

function setVar(proc, globals, target, value) {
  if (target.type === 'Var') {
    const name = target.name;
    if (name in proc.locals) { proc.locals[name] = value; return; }
    if (name in globals) { globals[name] = value; return; }
    proc.locals[name] = value;
  } else if (target.type === 'Index') {
    const name = target.base.name;
    const idx = evalExpr(target.index, proc.locals, globals);
    if (name in proc.locals) { proc.locals[name][idx] = value; return; }
    if (name in globals) { globals[name][idx] = value; return; }
  }
}

// Returns list of { pid, branchIdx, procName, pc, insn }
function enabledTransitions(state, cfgs, allowTimeout) {
  const transitions = [];
  const alive = state.procs.filter(p => !p.done);

  for (const proc of alive) {
    const cfg = cfgs[proc.cfgIdx];
    const insn = cfg[proc.pc];
    const base = { pid: proc.pid, procName: proc.name, pc: proc.pc, insn: insn.type, desc: describeInsn(insn) };

    if (insn.type === 'End') {
      transitions.push({ ...base, branchIdx: null });
      continue;
    }

    if (insn.type === 'Branch' || insn.type === 'DoBranch') {
      let hasElse = false;
      let someEnabled = false;
      for (let i = 0; i < insn.branches.length; i++) {
        const br = insn.branches[i];
        if (br.guard.type === 'Else') { hasElse = true; continue; }
        if (br.guard.type === 'Timeout') {
          if (allowTimeout) {
            transitions.push({ ...base, branchIdx: i, guard: 'timeout' });
          }
          continue;
        }
        if ((br.guard.type === 'Send' || br.guard.type === 'Recv') && isRendezvousGuard(state, proc, br.guard)) {
          // Rendezvous guard in branch: enumerate partners
          someEnabled = true;
          const ch = resolveChannel(state, proc, br.guard.chan);
          const lookFor = br.guard.type === 'Send' ? 'Recv' : 'Send';
          for (const rv of findRendezvousPartners(state, cfgs, proc, ch, br.guard.chan, lookFor)) {
            const guardDesc = describeGuard(br.guard);
            transitions.push({ ...base, branchIdx: i, guard: guardDesc, desc: guardDesc, insn: br.guard.type, chanName: describeExpr(br.guard.chan), rvPartner: rv });
          }
        } else if (isGuardEnabled(state, proc, br.guard)) {
          someEnabled = true;
          const guardDesc = describeGuard(br.guard);
          const tr = { ...base, branchIdx: i, guard: guardDesc, desc: guardDesc };
          if (br.guard.type === 'Send' || br.guard.type === 'Recv') {
            tr.insn = br.guard.type;
            tr.chanName = describeExpr(br.guard.chan);
          }
          transitions.push(tr);
        }
      }
      if (!someEnabled && hasElse) {
        for (let i = 0; i < insn.branches.length; i++) {
          if (insn.branches[i].guard.type === 'Else') {
            transitions.push({ ...base, branchIdx: i, guard: 'else' });
          }
        }
      }
      continue;
    }

    if (insn.type === 'Send') {
      const ch = resolveChannel(state, proc, insn.chan);
      if (ch && ch.bufSize === 0) {
        // Rendezvous: find matching recv partners
        for (const rv of findRendezvousPartners(state, cfgs, proc, ch, insn.chan, 'Recv')) {
          transitions.push({ ...base, branchIdx: null, chanName: describeExpr(insn.chan), rvPartner: rv });
        }
      } else if (ch && ch.buffer.length < ch.bufSize) {
        transitions.push({ ...base, branchIdx: null, chanName: describeExpr(insn.chan) });
      }
    } else if (insn.type === 'Recv') {
      const ch = resolveChannel(state, proc, insn.chan);
      if (ch && ch.bufSize === 0) {
        // Rendezvous: find matching send partners
        for (const rv of findRendezvousPartners(state, cfgs, proc, ch, insn.chan, 'Send')) {
          transitions.push({ ...base, branchIdx: null, chanName: describeExpr(insn.chan), rvPartner: rv });
        }
      } else if (ch && ch.buffer.length > 0) {
        transitions.push({ ...base, branchIdx: null, chanName: describeExpr(insn.chan) });
      }
    } else if (insn.type === 'ExprStmt') {
      if (isSideEffectExpr(insn.expr) || evalExpr(insn.expr, proc.locals, state.globals, { state, proc })) {
        transitions.push({ ...base, branchIdx: null });
      }
    } else if (insn.type === 'DStepStart') {
      // d_step is executable iff the first real instruction after DStepStart is executable
      if (isDStepExecutable(state, proc, cfg, proc.pc + 1)) {
        transitions.push({ ...base, branchIdx: null });
      }
    } else {
      transitions.push({ ...base, branchIdx: null });
    }
  }

  return transitions;
}

function isDStepExecutable(state, proc, cfg, startPc) {
  // Check if the first executable instruction in the d_step body can proceed
  const insn = cfg[startPc];
  if (!insn || insn.type === 'DStepEnd') return true; // empty d_step
  if (insn.type === 'Send') {
    const ch = resolveChannel(state, proc, insn.chan);
    return ch && ch.buffer.length < ch.bufSize;
  }
  if (insn.type === 'Recv') {
    const ch = resolveChannel(state, proc, insn.chan);
    return ch && ch.buffer.length > 0;
  }
  if (insn.type === 'ExprStmt') {
    if (isSideEffectExpr(insn.expr)) return true;
    return !!evalExpr(insn.expr, proc.locals, state.globals, { state, proc });
  }
  if (insn.type === 'Branch' || insn.type === 'DoBranch') {
    for (const br of insn.branches) {
      if (br.guard.type === 'Else') return true;
      if (br.guard.type === 'Timeout') continue;
      if (isGuardEnabled(state, proc, br.guard)) return true;
    }
    return false;
  }
  return true; // Decl, Assign, Skip, etc. are always executable
}

function describeGuard(guard) {
  if (guard.type === 'Send') {
    const vals = guard.values ? guard.values.map(describeExpr).join(', ') : '...';
    return `${describeExpr(guard.chan)} ! ${vals}`;
  }
  if (guard.type === 'Recv') {
    const vars = guard.vars ? guard.vars.map(describeExpr).join(', ') : '...';
    return `${describeExpr(guard.chan)} ? ${vars}`;
  }
  return describeExpr(guard);
}

function describeExpr(expr) {
  if (!expr) return '?';
  if (expr.type === 'Literal') return String(expr.value);
  if (expr.type === 'Var') return expr.name;
  if (expr.type === 'Index') return `${expr.base.name}[${describeExpr(expr.index)}]`;
  if (expr.type === 'BinOp') return `${describeExpr(expr.left)} ${expr.op} ${describeExpr(expr.right)}`;
  if (expr.type === 'UnaryOp') return `${expr.op}${describeExpr(expr.operand)}`;
  if (expr.type === 'Run') return `run ${expr.name}(${(expr.args || []).map(describeExpr).join(', ')})`;
  if (expr.type === 'ChanOp') return `${expr.op}(${describeExpr(expr.arg)})`;
  return expr.type;
}

function describeInsn(insn) {
  switch (insn.type) {
    case 'Assign': return `${describeExpr(insn.target)} = ${describeExpr(insn.value)}`;
    case 'Send': {
      const vals = insn.values ? insn.values.map(describeExpr).join(', ') : '';
      return `${describeExpr(insn.chan)} ! ${vals}`;
    }
    case 'Recv': {
      const vars = insn.vars ? insn.vars.map(describeExpr).join(', ') : '';
      return `${describeExpr(insn.chan)} ? ${vars}`;
    }
    case 'Assert': return `assert(${describeExpr(insn.expr)})`;
    case 'Printf': return `printf("${insn.fmt.replace(/\n/g, '\\n').slice(0, 20)}${insn.fmt.length > 20 ? '...' : ''}")`;
    case 'ExprStmt': return `(${describeExpr(insn.expr)})`;
    case 'Decl': return `${insn.varType} ${insn.name}${insn.init ? ' = ' + describeExpr(insn.init) : ''}`;
    case 'ChanDecl': return `chan ${insn.name}`;
    case 'Skip': return 'skip';
    case 'Jump': return 'jump';
    case 'End': return 'end';
    case 'Branch': case 'DoBranch': return 'branch';
    case 'AtomicStart': return 'atomic {';
    case 'AtomicEnd': return '} /* atomic */';
    case 'DStepStart': return 'd_step {';
    case 'DStepEnd': return '} /* d_step */';
    default: return insn.type;
  }
}

function isRendezvousGuard(state, proc, guard) {
  if (guard.type !== 'Send' && guard.type !== 'Recv') return false;
  const ch = resolveChannel(state, proc, guard.chan);
  return ch && ch.bufSize === 0;
}

// Find processes that can be rendezvous partners for proc on channel ch.
// lookFor: 'Send' or 'Recv' - the type of operation we need the partner to perform.
// Returns array of { pid, branchIdx (null or index), pc } objects.
function findRendezvousPartners(state, cfgs, proc, ch, chanExpr, lookFor) {
  const partners = [];
  const alive = state.procs.filter(p => !p.done && p.pid !== proc.pid);
  const chanName = chanExpr.type === 'Var' ? chanExpr.name :
    chanExpr.type === 'Index' ? `${chanExpr.base.name}[${evalExpr(chanExpr.index, proc.locals, state.globals)}]` : null;
  if (!chanName) return partners;

  for (const p of alive) {
    const cfg = cfgs[p.cfgIdx];
    const insn = cfg[p.pc];

    if (insn.type === lookFor) {
      const pch = resolveChannel(state, p, insn.chan);
      if (pch === ch || resolveChanName(state, p, insn.chan) === chanName) {
        partners.push({ pid: p.pid, branchIdx: null, pc: p.pc });
      }
    } else if (insn.type === 'Branch' || insn.type === 'DoBranch') {
      for (let i = 0; i < insn.branches.length; i++) {
        const br = insn.branches[i];
        if (br.guard.type === lookFor) {
          const pch = resolveChannel(state, p, br.guard.chan);
          if (pch === ch || resolveChanName(state, p, br.guard.chan) === chanName) {
            partners.push({ pid: p.pid, branchIdx: i, pc: p.pc });
          }
        }
      }
    }
  }
  return partners;
}

function resolveChanName(state, proc, expr) {
  if (expr.type === 'Var') return expr.name;
  if (expr.type === 'Index') {
    const idx = evalExpr(expr.index, proc.locals, state.globals);
    return `${expr.base.name}[${idx}]`;
  }
  return null;
}

function isGuardEnabled(state, proc, guard) {
  if (guard.type === 'Send') {
    const ch = resolveChannel(state, proc, guard.chan);
    if (!ch) return false;
    if (ch.bufSize === 0) return false; // rendezvous handled separately
    return ch.buffer.length < ch.bufSize;
  }
  if (guard.type === 'Recv') {
    const ch = resolveChannel(state, proc, guard.chan);
    if (!ch) return false;
    if (ch.bufSize === 0) return false; // rendezvous handled separately
    return ch.buffer.length > 0;
  }
  return !!evalExpr(guard, proc.locals, state.globals, { state, proc });
}

// Execute one transition, modifying state in-place. Returns error message or null.
// rvPartner: { pid, branchIdx, pc } for rendezvous handshake (optional)
function executeTransition(state, cfgs, pid, branchIdx, program, rvPartner) {
  const proc = state.procs.find(p => p.pid === pid);
  const cfg = cfgs[proc.cfgIdx];
  const insn = cfg[proc.pc];

  if (insn.type === 'End') {
    proc.done = true;
    return null;
  }

  if (insn.type === 'Branch' || insn.type === 'DoBranch') {
    const br = insn.branches[branchIdx];
    // If guard is Send/Recv, the guard instruction is at bodyStart
    // and execution continues from there
    if (br.guard.type === 'Send' || br.guard.type === 'Recv') {
      proc.pc = br.bodyStart; // points to the Send/Recv instruction
      return executeInsn(state, cfgs, proc, program, rvPartner); // execute the Send/Recv
    }
    // For boolean/else/timeout guards: skip to bodyStart
    proc.pc = br.bodyStart;
    return null;
  }

  return executeInsn(state, cfgs, proc, program, rvPartner);
}

function executeInsn(state, cfgs, proc, program, rvPartner) {
  const cfg = cfgs[proc.cfgIdx];
  const insn = cfg[proc.pc];

  switch (insn.type) {
    case 'Decl': {
      const ctx = program ? { state, cfgs, program, proc } : undefined;
      const init = insn.init ? evalExpr(insn.init, proc.locals, state.globals, ctx) : 0;
      proc.locals[insn.name] = insn.size !== null ? new Array(insn.size).fill(init) : init;
      proc.pc++;
      return null;
    }
    case 'ChanDecl': {
      if (insn.arraySize) {
        for (let i = 0; i < insn.arraySize; i++) {
          state.channels[`${insn.name}[${i}]`] = { bufSize: insn.bufSize, buffer: [] };
        }
        state.globals[insn.name] = { _chanArray: true, size: insn.arraySize, baseName: insn.name };
      } else {
        state.channels[insn.name] = { bufSize: insn.bufSize, buffer: [] };
      }
      proc.pc++;
      return null;
    }
    case 'Assign': {
      const ctx = program ? { state, cfgs, program, proc } : undefined;
      const value = evalExpr(insn.value, proc.locals, state.globals, ctx);
      setVar(proc, state.globals, insn.target, value);
      proc.pc++;
      return null;
    }
    case 'Send': {
      const ctx = program ? { state, cfgs, program, proc } : undefined;
      const ch = resolveChannel(state, proc, insn.chan);
      const values = insn.values.map(v => evalExpr(v, proc.locals, state.globals, ctx));
      if (ch.bufSize === 0 && rvPartner) {
        // Rendezvous: transfer values directly to partner's recv
        const partner = state.procs.find(p => p.pid === rvPartner.pid);
        const partnerCfg = cfgs[partner.cfgIdx];
        let recvInsn;
        if (rvPartner.branchIdx !== null) {
          const branchInsn = partnerCfg[partner.pc];
          const br = branchInsn.branches[rvPartner.branchIdx];
          recvInsn = br.guard;
          partner.pc = br.bodyStart + 1; // skip past the Recv instruction at bodyStart
        } else {
          recvInsn = partnerCfg[partner.pc];
          partner.pc++;
        }
        if (recvInsn && recvInsn.vars) {
          for (let i = 0; i < recvInsn.vars.length; i++) {
            if (recvInsn.vars[i].type === 'Var' || recvInsn.vars[i].type === 'Index') {
              setVar(partner, state.globals, recvInsn.vars[i], values[i]);
            }
          }
        }
        proc.pc++;
        return null;
      } else if (ch.bufSize === 0 && !rvPartner) {
        // Rendezvous without partner - should not happen in normal flow
        return null;
      }
      ch.buffer.push(values);
      proc.pc++;
      return null;
    }
    case 'Recv': {
      const ch = resolveChannel(state, proc, insn.chan);
      if (ch.bufSize === 0 && rvPartner) {
        // Rendezvous: transfer values from partner's send
        const partner = state.procs.find(p => p.pid === rvPartner.pid);
        const partnerCfg = cfgs[partner.cfgIdx];
        let sendInsn;
        if (rvPartner.branchIdx !== null) {
          const branchInsn = partnerCfg[partner.pc];
          const br = branchInsn.branches[rvPartner.branchIdx];
          sendInsn = br.guard;
          partner.pc = br.bodyStart + 1; // skip past the Send instruction at bodyStart
        } else {
          sendInsn = partnerCfg[partner.pc];
          partner.pc++;
        }
        const ctx = program ? { state, cfgs, program, proc: partner } : undefined;
        const values = sendInsn.values.map(v => evalExpr(v, partner.locals, state.globals, ctx));
        if (insn.vars) {
          for (let i = 0; i < insn.vars.length; i++) {
            if (insn.vars[i].type === 'Var' || insn.vars[i].type === 'Index') {
              setVar(proc, state.globals, insn.vars[i], values[i]);
            }
          }
        }
        proc.pc++;
        return null;
      }
      const values = ch.buffer.shift();
      if (insn.vars) {
        for (let i = 0; i < insn.vars.length; i++) {
          if (insn.vars[i].type === 'Var' || insn.vars[i].type === 'Index') {
            setVar(proc, state.globals, insn.vars[i], values[i]);
          }
        }
      }
      proc.pc++;
      return null;
    }
    case 'Printf': {
      // No side effect in verifier (no output)
      proc.pc++;
      return null;
    }
    case 'Assert': {
      const ctx = program ? { state, cfgs, program, proc } : undefined;
      const val = evalExpr(insn.expr, proc.locals, state.globals, ctx);
      proc.pc++;
      if (!val) {
        return `Assertion failed at line ${insn.line} in ${proc.name}`;
      }
      return null;
    }
    case 'Skip': {
      proc.pc++;
      return null;
    }
    case 'ExprStmt': {
      // Re-evaluate with evalCtx to handle run() expressions
      const ctx = program ? { state, cfgs, program, proc } : undefined;
      evalExpr(insn.expr, proc.locals, state.globals, ctx);
      proc.pc++;
      return null;
    }
    case 'Jump': {
      proc.pc = insn.target;
      return null;
    }
    case 'AtomicStart': {
      proc.atomicDepth++;
      proc.pc++;
      return null;
    }
    case 'AtomicEnd': {
      proc.atomicDepth--;
      if (proc.atomicDepth < 0) proc.atomicDepth = 0;
      proc.pc++;
      return null;
    }
    case 'DStepStart': {
      proc.dstepDepth++;
      proc.atomicDepth++; // d_step implies atomic
      proc.pc++;
      return null;
    }
    case 'DStepEnd': {
      proc.dstepDepth--;
      if (proc.dstepDepth < 0) proc.dstepDepth = 0;
      proc.atomicDepth--;
      if (proc.atomicDepth < 0) proc.atomicDepth = 0;
      proc.pc++;
      return null;
    }
  }
  proc.pc++;
  return null;
}


// ============================================================
// Step 5: Exhaustive DFS verifier
// ============================================================

function hasTimeoutBranch(state, cfgs) {
  for (const proc of state.procs) {
    if (proc.done) continue;
    const cfg = cfgs[proc.cfgIdx];
    const insn = cfg[proc.pc];
    if (insn.type === 'DoBranch' || insn.type === 'Branch') {
      for (const br of insn.branches) {
        if (br.guard.type === 'Timeout') return true;
      }
    }
  }
  return false;
}

export class ExhaustiveVerifier {
  constructor(program, logger) {
    this.program = program;
    this.log = logger;
    this.maxStates = 500000;
    this.cfgs = [];
  }

  buildCFGs() {
    this.cfgs = this.program.proctypes.map(pt => flattenProc(pt.body));
  }

  verify() {
    this.log('=== Exhaustive Verification ===', 'log-info');
    this.buildCFGs();

    // Parse and check LTL properties if present
    const ltlSpecs = this._parseLTLSpecs();

    const initial = makeInitialState(this.program, this.cfgs);
    const visited = new Set();
    // Stack entries: { state, parentKey, transition }
    const stack = [{ state: initial, parentKey: null, transition: null }];
    let statesExplored = 0;
    const errors = [];
    let deadlocks = 0;
    // For counter-example trace: parentKey -> { parentKey, transition }
    const parents = new Map();

    while (stack.length > 0) {
      const { state, parentKey, transition } = stack.pop();
      const key = stateKey(state);

      if (visited.has(key)) continue;
      visited.add(key);
      statesExplored++;

      if (parentKey !== null) {
        parents.set(key, { parentKey, transition });
      }

      if (statesExplored > this.maxStates) {
        this.log(`State limit (${this.maxStates}) reached. Explored ${statesExplored} states.`, 'log-warn');
        break;
      }

      // Get enabled transitions, respecting atomic priority
      let { transitions, deadlock, alive } = this._getTransitions(state);
      if (deadlock) {
        deadlocks++;
        const trace = this._reconstructTrace(parents, key);
        errors.push({ type: 'deadlock', trace, blocked: alive.map(p => p.name) });
        if (errors.length >= 10) break;
        continue;
      }

      for (const tr of transitions) {
        const newState = cloneState(state);
        const err = this._executeTransition(newState, tr);
        if (err) {
          const newKey = stateKey(newState);
          parents.set(newKey, { parentKey: key, transition: tr });
          const trace = this._reconstructTrace(parents, newKey);
          errors.push({ type: 'assertion', message: err, trace });
          if (errors.length >= 10) break;
          continue;
        }
        stack.push({ state: newState, parentKey: key, transition: tr });
      }
    }

    // LTL verification via nested DFS on the product automaton
    for (const spec of ltlSpecs) {
      const ltlResult = this._verifyLTL(spec);
      if (ltlResult) {
        errors.push(ltlResult);
      }
    }

    this._report(statesExplored, visited.size, errors, deadlocks);
    return { statesExplored, uniqueStates: visited.size, errors, deadlocks };
  }

  verifyAsync(onDone, onProgress) {
    this.log('=== Exhaustive Verification ===', 'log-info');
    this.buildCFGs();

    const initial = makeInitialState(this.program, this.cfgs);
    const visited = new Set();
    const stack = [{ state: initial, parentKey: null, transition: null }];
    let statesExplored = 0;
    const errors = [];
    let deadlocks = 0;
    const parents = new Map();
    const CHUNK = 500;

    // Parse LTL specs up front
    const ltlSpecs = this._parseLTLSpecs();

    const finalize = () => {
      for (const spec of ltlSpecs) {
        const ltlResult = this._verifyLTL(spec);
        if (ltlResult) errors.push(ltlResult);
      }
      this._report(statesExplored, visited.size, errors, deadlocks);
      if (onDone) onDone({ statesExplored, uniqueStates: visited.size, errors, deadlocks });
    };

    const processChunk = () => {
      for (let i = 0; i < CHUNK && stack.length > 0; i++) {
        const { state, parentKey, transition } = stack.pop();
        const key = stateKey(state);

        if (visited.has(key)) continue;
        visited.add(key);
        statesExplored++;

        if (parentKey !== null) {
          parents.set(key, { parentKey, transition });
        }

        if (statesExplored > this.maxStates) {
          this.log(`State limit (${this.maxStates}) reached.`, 'log-warn');
          finalize();
          return;
        }

        let { transitions, deadlock, alive } = this._getTransitions(state);
        if (deadlock) {
          deadlocks++;
          const trace = this._reconstructTrace(parents, key);
          errors.push({ type: 'deadlock', trace, blocked: alive.map(p => p.name) });
          if (errors.length >= 10) { stack.length = 0; break; }
          continue;
        }

        for (const tr of transitions) {
          const newState = cloneState(state);
          const err = this._executeTransition(newState, tr);
          if (err) {
            const newKey = stateKey(newState);
            parents.set(newKey, { parentKey: key, transition: tr });
            const trace = this._reconstructTrace(parents, newKey);
            errors.push({ type: 'assertion', message: err, trace });
            if (errors.length >= 10) { stack.length = 0; break; }
            continue;
          }
          stack.push({ state: newState, parentKey: key, transition: tr });
        }
      }

      if (onProgress) onProgress(statesExplored, visited.size);

      if (stack.length > 0 && errors.length < 10) {
        setTimeout(processChunk, 0);
      } else {
        finalize();
      }
    };

    setTimeout(processChunk, 0);
  }

  _getTransitions(state) {
    const alive = state.procs.filter(p => !p.done);

    // Check if any process is in atomic mode
    const atomicProc = alive.find(p => p.atomicDepth > 0);

    let transitions = enabledTransitions(state, this.cfgs, false);

    if (atomicProc) {
      // Filter to only atomic process's transitions
      const atomicTransitions = transitions.filter(t => t.pid === atomicProc.pid);
      if (atomicTransitions.length > 0) {
        transitions = atomicTransitions;
      } else {
        // Atomic process is blocked - break atomicity
        const newState = cloneState(state);
        const proc = newState.procs.find(p => p.pid === atomicProc.pid);
        proc.atomicDepth = 0;
        // Re-enumerate with atomicity broken (but use original state's transitions
        // since we don't want to modify state in-place during enumeration)
        // All processes can now be scheduled
      }
    }

    if (transitions.length === 0 && alive.length > 0) {
      // Try timeout
      if (hasTimeoutBranch(state, this.cfgs)) {
        transitions = enabledTransitions(state, this.cfgs, true);
        if (atomicProc) {
          const atomicTransitions = transitions.filter(t => t.pid === atomicProc.pid);
          if (atomicTransitions.length > 0) {
            transitions = atomicTransitions;
          }
        }
      }
      if (transitions.length === 0) {
        return { transitions: [], deadlock: true, alive };
      }
    }

    return { transitions, deadlock: false, alive };
  }

  // Execute a transition, and if the process is inside a d_step,
  // keep executing until d_step ends.
  // d_step semantics (SPIN-compatible):
  //   - Deterministic: non-deterministic choices pick the first enabled branch
  //   - If blocked mid-d_step: lose atomicity (like atomic), continue normally
  _executeTransition(state, tr) {
    const err = executeTransition(state, this.cfgs, tr.pid, tr.branchIdx, this.program, tr.rvPartner);
    if (err) return err;

    const proc = state.procs.find(p => p.pid === tr.pid);
    if (!proc || proc.done) return null;

    let safety = 0;
    while (proc.dstepDepth > 0 && !proc.done && safety < 10000) {
      safety++;
      const cfg = this.cfgs[proc.cfgIdx];
      const insn = cfg[proc.pc];

      if (insn.type === 'Branch' || insn.type === 'DoBranch') {
        let chosen = -1;
        for (let i = 0; i < insn.branches.length; i++) {
          const br = insn.branches[i];
          if (br.guard.type === 'Else') continue;
          if (br.guard.type === 'Timeout') continue;
          if (isGuardEnabled(state, proc, br.guard)) { chosen = i; break; }
        }
        if (chosen === -1) {
          for (let i = 0; i < insn.branches.length; i++) {
            if (insn.branches[i].guard.type === 'Else') { chosen = i; break; }
          }
        }
        if (chosen === -1) {
          proc.dstepDepth = 0;
          proc.atomicDepth = 0;
          break;
        }
        const stepErr = executeTransition(state, this.cfgs, proc.pid, chosen, this.program);
        if (stepErr) return stepErr;
      } else if (insn.type === 'Send') {
        const ch = resolveChannel(state, proc, insn.chan);
        if (!ch || ch.buffer.length >= ch.bufSize) {
          proc.dstepDepth = 0;
          proc.atomicDepth = 0;
          break;
        }
        const stepErr = executeInsn(state, this.cfgs, proc, this.program);
        if (stepErr) return stepErr;
      } else if (insn.type === 'Recv') {
        const ch = resolveChannel(state, proc, insn.chan);
        if (!ch || ch.buffer.length === 0) {
          proc.dstepDepth = 0;
          proc.atomicDepth = 0;
          break;
        }
        const stepErr = executeInsn(state, this.cfgs, proc, this.program);
        if (stepErr) return stepErr;
      } else if (insn.type === 'ExprStmt') {
        if (!isSideEffectExpr(insn.expr) && !evalExpr(insn.expr, proc.locals, state.globals, { state, proc })) {
          proc.dstepDepth = 0;
          proc.atomicDepth = 0;
          break;
        }
        const stepErr = executeInsn(state, this.cfgs, proc, this.program);
        if (stepErr) return stepErr;
      } else {
        const stepErr = executeInsn(state, this.cfgs, proc, this.program);
        if (stepErr) return stepErr;
      }
    }
    return null;
  }

  _reconstructTrace(parents, key) {
    const rawTrace = [];
    let current = key;
    while (parents.has(current)) {
      const { parentKey, transition } = parents.get(current);
      rawTrace.unshift(transition);
      current = parentKey;
    }
    return this._replayTrace(rawTrace);
  }

  // Replay trace from initial state, capturing variable snapshots at each step
  _replayTrace(rawTrace) {
    const state = makeInitialState(this.program, this.cfgs);
    const enriched = [];
    const procNames = state.procs.map(p => p.name);

    for (const tr of rawTrace) {
      const varsBefore = this._snapshotVars(state);
      this._executeTransition(state, tr);
      // Update procNames if new processes were spawned
      for (const p of state.procs) {
        if (!procNames.includes(p.name)) procNames.push(p.name);
      }
      const varsAfter = this._snapshotVars(state);

      // Find what changed
      const changes = {};
      for (const [k, v] of Object.entries(varsAfter)) {
        if (JSON.stringify(varsBefore[k]) !== JSON.stringify(v)) {
          changes[k] = v;
        }
      }

      enriched.push({
        ...tr,
        changes,
        varsAfter,
      });
    }

    enriched.procNames = procNames;
    return enriched;
  }

  _snapshotVars(state) {
    const vars = {};
    for (const [k, v] of Object.entries(state.globals)) {
      if (v && typeof v === 'object' && v._chanArray) continue;
      vars[k] = Array.isArray(v) ? [...v] : v;
    }
    // Include channel buffer state
    for (const [k, ch] of Object.entries(state.channels)) {
      vars[`ch:${k}`] = ch.buffer.length;
    }
    return vars;
  }

  _formatTrace(trace) {
    const lines = [];
    for (let i = 0; i < trace.length; i++) {
      const t = trace[i];
      if (!t) continue;
      const desc = t.insn === 'End' ? 'terminated' : (t.desc || t.insn);
      const changes = t.changes ? Object.entries(t.changes)
        .filter(([k]) => !k.startsWith('ch:'))
        .map(([k, v]) => `${k}=${Array.isArray(v) ? '['+v+']' : v}`)
        .join(', ') : '';
      const suffix = changes ? `  -> ${changes}` : '';
      lines.push(`    ${i + 1}: ${t.procName}  ${desc}${suffix}`);
    }
    return lines;
  }

  _report(statesExplored, uniqueStates, errors, deadlocks) {
    this.log(`\nExplored ${statesExplored} states (${uniqueStates} unique).`, 'log-info');
    if (errors.length === 0) {
      this.log('No errors found. All reachable states verified.', 'log-info');
    } else {
      const assertions = errors.filter(e => e.type === 'assertion');
      const dls = errors.filter(e => e.type === 'deadlock');
      if (assertions.length > 0) {
        this.log(`${assertions.length} assertion violation(s) found.`, 'log-error');
        // Show first counter-example in detail
        const first = assertions[0];
        this.log(`  ${first.message}`, 'log-error');
        if (first.trace.length > 0) {
          this.log(`  Counter-example trace (${first.trace.length} steps):`, 'log-warn');
          for (const line of this._formatTrace(first.trace)) {
            this.log(line, 'log-warn');
          }
        }
        if (assertions.length > 1) {
          this.log(`  (${assertions.length - 1} more assertion violation(s) omitted)`, 'log-error');
        }
      }
      if (dls.length > 0) {
        this.log(`${dls.length} deadlock state(s) found.`, 'log-error');
        const first = dls[0];
        this.log(`  Blocked: ${first.blocked.join(', ')}`, 'log-error');
        if (first.trace.length > 0) {
          this.log(`  Trace to deadlock (${first.trace.length} steps):`, 'log-warn');
          for (const line of this._formatTrace(first.trace)) {
            this.log(line, 'log-warn');
          }
        }
        if (dls.length > 1) {
          this.log(`  (${dls.length - 1} more deadlock state(s) omitted)`, 'log-error');
        }
      }
    }
    if (statesExplored > this.maxStates) {
      this.log('(Verification incomplete - state limit reached)', 'log-warn');
    }
  }

  // ============================================================
  // LTL Verification: Nested DFS on product automaton
  // ============================================================

  _parseLTLSpecs() {
    const specs = [];
    if (!this.program.ltl) return specs;
    for (const block of this.program.ltl) {
      const parser = new LTLParser(block.tokens);
      const formula = parser.parse();
      // Negate the property: build Büchi for !phi
      // If the negated property has an accepting run, the property is violated
      const negFormula = { type: 'LTLNot', child: formula };
      const buchi = ltlToBuchi(negFormula);
      specs.push({ name: block.name, formula, buchi, line: block.line });
    }
    return specs;
  }

  // Evaluate an LTL proposition (Promela expression) against system state
  _evalLTLProp(expr, state) {
    // Evaluate using global variables (LTL props reference globals)
    return evalExpr(expr, {}, state.globals, { state, proc: { locals: {} } });
  }

  // Check if a Büchi transition's propositions are satisfied by a system state
  _buchiTransitionSatisfied(props, state) {
    for (const p of props) {
      const val = this._evalLTLProp(p.expr, state);
      if (p.positive && !val) return false;
      if (!p.positive && val) return false;
    }
    return true;
  }

  // LTL model checking via product automaton + cycle detection
  // Returns error object if property is violated, null otherwise
  _verifyLTL(spec) {
    const { name, buchi } = spec;
    const propName = name || 'ltl';
    this.log(`\nChecking LTL property: ${propName}`, 'log-info');

    if (buchi.states.length === 0 || buchi.initial.length === 0) {
      this.log(`  Property ${propName}: satisfied (no counterexample automaton)`, 'log-info');
      return null;
    }

    // Build the product graph, then check if any accepting state is on a cycle.
    // A product state is (system state, büchi state index).
    const initial = makeInitialState(this.program, this.cfgs);
    const productStates = new Map(); // productKey -> { sysKey, buchiIdx, successorKeys }
    let statesExplored = 0;

    const productKeyFn = (sysKey, buchiIdx) => `${sysKey}|B${buchiIdx}`;

    // BFS/DFS to build the product graph
    const worklist = [];
    for (const { stateIdx, props } of buchi.initial) {
      if (this._buchiTransitionSatisfied(props, initial)) {
        const sk = stateKey(initial);
        const pk = productKeyFn(sk, stateIdx);
        if (!productStates.has(pk)) {
          productStates.set(pk, { sysKey: sk, buchiIdx: stateIdx, successorKeys: [] });
          worklist.push({ state: cloneState(initial), buchiIdx: stateIdx, pk });
        }
      }
    }

    while (worklist.length > 0) {
      statesExplored++;
      if (statesExplored > this.maxStates) {
        this.log(`  LTL check: state limit reached`, 'log-warn');
        return null;
      }

      const { state, buchiIdx, pk } = worklist.pop();
      const node = productStates.get(pk);
      const { transitions: sysTrans } = this._getTransitions(state);

      // Collect system successors (including stuttering for terminal states)
      const sysSuccessors = [];
      if (sysTrans.length === 0) {
        // Terminal: stutter (same state)
        sysSuccessors.push({ state: cloneState(state), transition: null });
      } else {
        for (const tr of sysTrans) {
          const newState = cloneState(state);
          const err = this._executeTransition(newState, tr);
          if (!err) sysSuccessors.push({ state: newState, transition: tr });
        }
      }

      // For each system successor, check matching Büchi transitions
      for (const { state: newSysState } of sysSuccessors) {
        for (const bt of buchi.transitions) {
          if (bt.from === buchiIdx && this._buchiTransitionSatisfied(bt.props, newSysState)) {
            const newSk = stateKey(newSysState);
            const newPk = productKeyFn(newSk, bt.to);
            node.successorKeys.push(newPk);
            if (!productStates.has(newPk)) {
              productStates.set(newPk, { sysKey: newSk, buchiIdx: bt.to, successorKeys: [] });
              worklist.push({ state: cloneState(newSysState), buchiIdx: bt.to, pk: newPk });
            }
          }
        }
      }
    }

    // Check: does any accepting state lie on a cycle?
    // Tarjan's SCC algorithm - O(V+E) for the entire graph.
    // An accepting state is on a cycle iff its SCC has size >= 2,
    // or size == 1 with a self-loop.
    const acceptingSet = new Set();
    for (const [pk, node] of productStates) {
      if (buchi.states[node.buchiIdx].accepting) {
        acceptingSet.add(pk);
      }
    }

    if (acceptingSet.size === 0) {
      this.log(`  Property ${propName}: verified (${statesExplored} product states)`, 'log-info');
      return null;
    }

    // Tarjan's SCC (iterative to avoid stack overflow on large graphs)
    let index = 0;
    const nodeInfo = new Map(); // pk -> { index, lowlink, onStack }
    const stack = [];
    const onStack = new Set();
    let violated = false;

    // Iterative Tarjan using an explicit call stack
    // Each frame: { pk, succIdx } where succIdx tracks iteration over successors
    for (const startPk of productStates.keys()) {
      if (violated) break;
      if (nodeInfo.has(startPk)) continue;

      const callStack = [{ pk: startPk, succIdx: -1 }];
      nodeInfo.set(startPk, { index, lowlink: index });
      index++;
      stack.push(startPk);
      onStack.add(startPk);

      while (callStack.length > 0) {
        if (violated) break;
        const frame = callStack[callStack.length - 1];
        const node = productStates.get(frame.pk);
        const succs = node ? node.successorKeys : [];

        frame.succIdx++;

        if (frame.succIdx < succs.length) {
          const w = succs[frame.succIdx];
          if (!nodeInfo.has(w)) {
            // Recurse into w
            nodeInfo.set(w, { index, lowlink: index });
            index++;
            stack.push(w);
            onStack.add(w);
            callStack.push({ pk: w, succIdx: -1 });
          } else if (onStack.has(w)) {
            // Back edge: update lowlink
            const info = nodeInfo.get(frame.pk);
            info.lowlink = Math.min(info.lowlink, nodeInfo.get(w).index);
          }
        } else {
          // All successors processed - check if this is an SCC root
          const info = nodeInfo.get(frame.pk);
          if (info.lowlink === info.index) {
            // Pop SCC members from the stack
            const scc = [];
            let w;
            do {
              w = stack.pop();
              onStack.delete(w);
              scc.push(w);
            } while (w !== frame.pk);

            // Check if this SCC contains an accepting state on a cycle
            const hasAccepting = scc.some(pk => acceptingSet.has(pk));
            if (hasAccepting) {
              if (scc.length >= 2) {
                violated = true;
              } else {
                // Size 1: cycle only if self-loop exists
                const selfNode = productStates.get(scc[0]);
                if (selfNode && selfNode.successorKeys.includes(scc[0])) {
                  violated = true;
                }
              }
            }
          }

          // Return from recursion: update parent's lowlink
          callStack.pop();
          if (callStack.length > 0) {
            const parentInfo = nodeInfo.get(callStack[callStack.length - 1].pk);
            parentInfo.lowlink = Math.min(parentInfo.lowlink, info.lowlink);
          }
        }
      }
    }

    if (violated) {
      this.log(`  Property ${propName} VIOLATED: acceptance cycle found`, 'log-error');
      return {
        type: 'ltl',
        message: `LTL property "${propName}" violated`,
        trace: [],
      };
    }

    this.log(`  Property ${propName}: verified (${statesExplored} product states)`, 'log-info');
    return null;
  }
}
