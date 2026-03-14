class Channel {
  constructor(bufSize) {
    this.bufSize = bufSize;
    this.buffer = [];
    // Rendezvous (bufSize=0): synchronous handshake
    // A pending send stores values here until a matching recv picks them up
    this.rvPending = null; // { values, sender } for rendezvous
  }
  isRendezvous() { return this.bufSize === 0; }
  canSend() {
    if (this.isRendezvous()) return false; // needs partner; checked externally
    return this.buffer.length < this.bufSize;
  }
  canRecv() {
    if (this.isRendezvous()) return this.rvPending !== null;
    return this.buffer.length > 0;
  }
  send(values) { this.buffer.push(values); }
  recv() {
    if (this.isRendezvous() && this.rvPending) {
      const values = this.rvPending.values;
      this.rvPending = null;
      return values;
    }
    return this.buffer.shift();
  }
}

class Process {
  constructor(name, pid, stmts) {
    this.name = name;
    this.pid = pid;
    this.stmts = stmts;
    this.originalStmts = stmts; // preserved for goto (splice-safe)
    this.pc = 0;
    this.locals = {};
    this.blocked = false;
    this.done = false;
    this.callStack = [];
    this.timeoutEnabled = false;
    this.useTimeout = false;
    this.inAtomic = false;
    this.atomicDepth = 0;
  }
}

export class Interpreter {
  constructor(program, logger, mode = 'simulate') {
    this.program = program;
    this.log = logger;
    this.mode = mode;
    this.globals = {};
    this.processes = [];
    this.pidCounter = 0;
    this.stepCount = 0;
    this.maxSteps = 10000;
    this.errors = [];
    this.stopped = false;
    this.finished = false;
    this.deadlocked = false;
    this.trace = []; // execution trace for UI
    this.mtypeCounter = 1;
  }

  // Initialize processes without running
  init() {
    for (const decl of this.program.globals) {
      this.execDecl(decl, this.globals);
    }
    for (const pt of this.program.proctypes) {
      if (pt.active) this.spawnProcess(pt.name, pt.body);
    }
    if (this.program.init) this.spawnProcess('init', this.program.init);
    if (this.processes.length === 0) {
      this.log('No active processes to run.', 'log-warn');
      this.finished = true;
      return;
    }
    this.log(`Started ${this.processes.length} process(es)`, 'log-info');
  }

  // Execute a single scheduling step. Returns info about what happened.
  stepOnce() {
    if (this.finished || this.stopped) return null;

    const alive = this.processes.filter(p => !p.done);
    if (alive.length === 0) {
      this.finished = true;
      this.log(`\nAll processes terminated. Steps: ${this.stepCount}`, 'log-info');
      return { type: 'finished' };
    }
    if (this.stepCount >= this.maxSteps) {
      this.finished = true;
      this.log(`\nMax steps (${this.maxSteps}) reached.`, 'log-warn');
      return { type: 'maxsteps' };
    }

    for (const p of alive) { if (p.blocked) p.blocked = false; }

    const runnable = [];
    for (const p of alive) {
      if (this.canStep(p)) runnable.push(p);
    }

    // Atomic priority: if a process is in atomic mode, force-select it
    const atomicProc = alive.find(p => p.inAtomic && !p.done);
    if (atomicProc && !this.canStep(atomicProc)) {
      // Blocking breaks atomicity
      atomicProc.inAtomic = false;
      atomicProc.atomicDepth = 0;
      // Re-evaluate runnable since atomicProc may now be considered differently
      runnable.length = 0;
      for (const p of alive) {
        if (this.canStep(p)) runnable.push(p);
      }
    }

    if (runnable.length === 0) {
      let timeoutResolved = false;
      for (const p of alive) {
        if (p.timeoutEnabled) {
          p.useTimeout = true;
          timeoutResolved = true;
          runnable.push(p);
          break;
        }
      }
      if (!timeoutResolved) {
        this.finished = true;
        this.deadlocked = true;
        this.log('\n*** DEADLOCK detected ***', 'log-error');
        for (const p of alive) {
          this.log(`  ${p.name} (pid ${p.pid}) blocked at pc=${p.pc}`, 'log-error');
        }
        return { type: 'deadlock', blocked: alive.map(p => p.name) };
      }
    }

    if (runnable.length === 0) return null;

    let proc;
    if (atomicProc && atomicProc.inAtomic && runnable.includes(atomicProc)) {
      proc = atomicProc;
    } else {
      proc = runnable[Math.floor(Math.random() * runnable.length)];
    }
    const stmtBefore = proc.pc < proc.stmts.length ? proc.stmts[proc.pc] : null;
    this.step(proc);
    this.stepCount++;

    const entry = {
      type: 'step',
      step: this.stepCount,
      pid: proc.pid,
      name: proc.name,
      stmt: stmtBefore ? stmtBefore.type : 'end',
      done: proc.done,
    };
    this.trace.push(entry);
    return entry;
  }

  run() {
    try {
      this.init();
      while (!this.stopped && !this.finished) {
        this.stepOnce();
      }
      if (this.errors.length > 0) {
        this.log(`\n${this.errors.length} error(s) found.`, 'log-error');
      }
    } catch (e) {
      this.log(`\nRuntime error: ${e.message}`, 'log-error');
    }
  }

  // Get snapshot of current state (for UI)
  getState() {
    const channels = {};
    for (const [name, val] of Object.entries(this.globals)) {
      if (val instanceof Channel) {
        channels[name] = { buf: [...val.buffer], size: val.bufSize };
      } else if (Array.isArray(val) && val[0] instanceof Channel) {
        for (let i = 0; i < val.length; i++) {
          channels[`${name}[${i}]`] = { buf: [...val[i].buffer], size: val[i].bufSize };
        }
      }
    }
    const vars = {};
    for (const [name, val] of Object.entries(this.globals)) {
      if (!(val instanceof Channel) && !(Array.isArray(val) && val[0] instanceof Channel)) {
        vars[name] = val;
      }
    }
    return {
      step: this.stepCount,
      finished: this.finished,
      deadlocked: this.deadlocked,
      errors: this.errors.length,
      processes: this.processes.map(p => ({
        pid: p.pid,
        name: p.name,
        blocked: p.blocked,
        done: p.done,
        pc: p.pc,
      })),
      vars,
      channels,
    };
  }

  stop() { this.stopped = true; }

  spawnProcess(name, stmts) {
    const proc = new Process(name, this.pidCounter++, [...stmts]);
    this.processes.push(proc);
    return proc;
  }

  canStep(proc) {
    if (proc.pc >= proc.stmts.length) return true; // will terminate
    const stmt = proc.stmts[proc.pc];
    // Check if the current statement can execute
    if (stmt.type === 'ExprStmt') {
      if (stmt.expr.type === 'Run') return true; // side-effectful, don't eval for executability check
      return !!this.evalExpr(proc, stmt.expr);
    }
    if (stmt.type === 'Send') {
      try {
        const ch = this.resolveChan(proc, stmt.chan);
        if (ch.isRendezvous()) return this.hasRendezvousPartner(proc, ch, 'recv');
        return ch.canSend();
      } catch { return false; }
    }
    if (stmt.type === 'Recv') {
      try {
        const ch = this.resolveChan(proc, stmt.chan);
        if (ch.isRendezvous()) return ch.rvPending !== null || this.hasRendezvousPartner(proc, ch, 'send');
        return ch.canRecv();
      } catch { return false; }
    }
    if (stmt.type === 'If') return this.hasEnabledBranch(proc, stmt);
    if (stmt.type === 'Do') return this.hasEnabledBranch(proc, stmt);
    if (stmt.type === 'Label') {
      // Label is executable if its inner statement is
      const saved = proc.stmts;
      const savedPc = proc.pc;
      proc.stmts = [stmt.stmt];
      proc.pc = 0;
      const result = this.canStep(proc);
      proc.stmts = saved;
      proc.pc = savedPc;
      return result;
    }
    if (stmt.type === 'DStep') {
      // d_step is executable iff its first statement is executable
      if (stmt.body.length === 0) return true;
      const saved = proc.stmts;
      const savedPc = proc.pc;
      proc.stmts = stmt.body;
      proc.pc = 0;
      const result = this.canStep(proc);
      proc.stmts = saved;
      proc.pc = savedPc;
      return result;
    }
    return true;
  }

  hasEnabledBranch(proc, stmt) {
    for (const br of stmt.branches) {
      if (br.guard.type === 'Else') return true;
      if (br.guard.type === 'Timeout' && proc.useTimeout) return true;
      if (this.isGuardEnabled(proc, br.guard)) return true;
    }
    return false;
  }

  step(proc) {
    if (proc.pc >= proc.stmts.length) { proc.done = true; return; }
    this.execStmt(proc, proc.stmts[proc.pc]);
  }

  execStmt(proc, stmt) {
    switch (stmt.type) {
      case 'Decl': this.execDecl(stmt, proc.locals); proc.pc++; break;
      case 'ChanDecl': this.execChanDecl(stmt); proc.pc++; break;
      case 'Assign': this.execAssign(proc, stmt); proc.pc++; break;
      case 'Send': this.execSend(proc, stmt); break;
      case 'Recv': this.execRecv(proc, stmt); break;
      case 'Printf': this.execPrintf(proc, stmt); proc.pc++; break;
      case 'Assert': this.execAssert(proc, stmt); proc.pc++; break;
      case 'If': this.execIf(proc, stmt); break;
      case 'Do': this.execDo(proc, stmt); break;
      case 'Break': this.execBreak(proc); break;
      case 'Skip': proc.pc++; break;
      case '_DoMarker': proc.pc++; break;
      case 'ExprStmt': this.execExprStmt(proc, stmt); break;
      case 'Atomic': this.execAtomic(proc, stmt); break;
      case 'DStep': this.execDStep(proc, stmt); break;
      case 'Label': this.execLabel(proc, stmt); break;
      case 'Goto': this.execGoto(proc, stmt); break;
      case '_AtomicEnd': proc.atomicDepth--; if (proc.atomicDepth <= 0) { proc.inAtomic = false; proc.atomicDepth = 0; } proc.pc++; break;
      case '_DStepEnd': proc.pc++; break;
      default: this.log(`Unknown statement: ${stmt.type}`, 'log-error'); proc.pc++;
    }
  }

  execAtomic(proc, stmt) {
    proc.atomicDepth++;
    proc.inAtomic = true;
    const continuation = proc.stmts.slice(proc.pc + 1);
    proc.stmts = [
      ...proc.stmts.slice(0, proc.pc),
      ...stmt.body,
      { type: '_AtomicEnd' },
      ...continuation
    ];
  }

  execDStep(proc, stmt) {
    // d_step: execute entire body as a single indivisible step.
    // SPIN semantics: first statement must be executable to enter.
    // If blocked mid-execution, lose atomicity (like atomic) and yield.
    // Non-deterministic choices are resolved deterministically (first enabled).
    const continuation = proc.stmts.slice(proc.pc + 1);
    proc.stmts = [
      ...proc.stmts.slice(0, proc.pc),
      ...stmt.body,
      { type: '_DStepEnd' },
      ...continuation
    ];
    proc.inAtomic = true;
    proc.atomicDepth++;
    // Execute until _DStepEnd, blocked, or done
    let safety = 0;
    while (proc.pc < proc.stmts.length && !proc.done && safety < 10000) {
      safety++;
      const s = proc.stmts[proc.pc];
      if (s.type === '_DStepEnd') {
        proc.atomicDepth--;
        if (proc.atomicDepth <= 0) { proc.inAtomic = false; proc.atomicDepth = 0; }
        proc.pc++;
        return;
      }
      this.execStmt(proc, s);
      if (proc.blocked) {
        // Blocked mid-d_step: lose atomicity, let scheduler handle it
        proc.atomicDepth--;
        if (proc.atomicDepth <= 0) { proc.inAtomic = false; proc.atomicDepth = 0; }
        return;
      }
    }
  }

  execLabel(proc, stmt) {
    // Label is transparent: execute the inner statement, keep Label in stmts for goto
    this.execStmt(proc, stmt.stmt);
    // If the inner stmt didn't advance pc (e.g., it blocked), don't advance
    // If it did advance, the pc is already correct
  }

  execGoto(proc, stmt) {
    // Restore the original stmts to undo any if/do splicing, then jump to the label
    proc.stmts = [...proc.originalStmts];
    proc.callStack = [];
    for (let i = 0; i < proc.stmts.length; i++) {
      if (proc.stmts[i].type === 'Label' && proc.stmts[i].name === stmt.label) {
        proc.pc = i;
        return;
      }
    }
    this.log(`goto: label '${stmt.label}' not found in ${proc.name}`, 'log-error');
    proc.pc++;
  }

  execDecl(decl, scope) {
    if (decl.type === 'ChanDecl') { this.execChanDecl(decl); return; }
    if (decl.type === 'MtypeDecl') {
      for (const name of decl.names) {
        this.globals[name] = this.mtypeCounter++;
      }
      return;
    }
    const init = decl.init ? this.evalExpr(null, decl.init) : 0;
    scope[decl.name] = decl.size !== null ? new Array(decl.size).fill(init) : init;
  }

  execChanDecl(decl) {
    if (decl.arraySize) {
      this.globals[decl.name] = Array.from({ length: decl.arraySize }, () => new Channel(decl.bufSize));
    } else {
      this.globals[decl.name] = new Channel(decl.bufSize);
    }
  }

  execAssign(proc, stmt) {
    this.setVar(proc, stmt.target, this.evalExpr(proc, stmt.value));
  }

  execSend(proc, stmt) {
    const ch = this.resolveChan(proc, stmt.chan);
    if (ch.isRendezvous()) {
      // Rendezvous: deposit values and let the partner recv in the same scheduling round
      const values = stmt.values.map(v => this.evalExpr(proc, v));
      ch.rvPending = { values, senderPid: proc.pid };
      // Find a partner recv and execute it immediately
      const partner = this.findRendezvousPartner(proc, ch, 'recv');
      if (!partner) {
        ch.rvPending = null;
        proc.blocked = true;
        return;
      }
      proc.blocked = false;
      proc.pc++;
      // Execute the partner's recv
      this.execRendezvousRecv(partner, ch);
      return;
    }
    if (!ch.canSend()) { proc.blocked = true; return; }
    proc.blocked = false;
    ch.send(stmt.values.map(v => this.evalExpr(proc, v)));
    proc.pc++;
  }

  execRecv(proc, stmt) {
    const ch = this.resolveChan(proc, stmt.chan);
    if (ch.isRendezvous()) {
      if (ch.rvPending) {
        // Partner already deposited values (we're the recv side of a handshake)
        proc.blocked = false;
        const values = ch.recv();
        for (let i = 0; i < stmt.vars.length; i++) {
          if (stmt.vars[i].type === 'Var') this.setVar(proc, stmt.vars[i], values[i]);
        }
        proc.pc++;
        return;
      }
      // No pending send - try to find a send partner and let it go first
      const partner = this.findRendezvousPartner(proc, ch, 'send');
      if (!partner) { proc.blocked = true; return; }
      // Execute the partner's send, which will call execRendezvousRecv on us
      this.execSend(partner, partner.stmts[partner.pc]);
      // If the handshake succeeded, our recv should already be done
      // (execSend -> execRendezvousRecv advanced our pc)
      return;
    }
    if (!ch.canRecv()) { proc.blocked = true; return; }
    proc.blocked = false;
    const values = ch.recv();
    for (let i = 0; i < stmt.vars.length; i++) {
      if (stmt.vars[i].type === 'Var') this.setVar(proc, stmt.vars[i], values[i]);
    }
    proc.pc++;
  }

  execRendezvousRecv(proc, ch) {
    const stmt = proc.stmts[proc.pc];
    if (stmt.type !== 'Recv') return;
    const values = ch.recv();
    if (!values) return;
    for (let i = 0; i < stmt.vars.length; i++) {
      if (stmt.vars[i].type === 'Var') this.setVar(proc, stmt.vars[i], values[i]);
    }
    proc.blocked = false;
    proc.pc++;
  }

  hasRendezvousPartner(proc, ch, lookFor) {
    return !!this.findRendezvousPartner(proc, ch, lookFor);
  }

  findRendezvousPartner(proc, ch, lookFor) {
    const alive = this.processes.filter(p => !p.done && p.pid !== proc.pid);
    for (const p of alive) {
      if (p.pc >= p.stmts.length) continue;
      const s = p.stmts[p.pc];
      if (lookFor === 'recv' && s.type === 'Recv') {
        try { if (this.resolveChan(p, s.chan) === ch) return p; } catch {}
      }
      if (lookFor === 'send' && s.type === 'Send') {
        try { if (this.resolveChan(p, s.chan) === ch) return p; } catch {}
      }
    }
    return null;
  }

  resolveChan(proc, expr) {
    if (expr.type === 'Var') return this.getVar(proc, expr);
    if (expr.type === 'Index') {
      const arr = this.getVar(proc, expr.base);
      return arr[this.evalExpr(proc, expr.index)];
    }
    throw new Error('Invalid channel expression');
  }

  execPrintf(proc, stmt) {
    let output = stmt.fmt;
    let argIdx = 0;
    output = output.replace(/%(-?\d*)?[dioxX]/g, () =>
      argIdx < stmt.args.length ? this.evalExpr(proc, stmt.args[argIdx++]) : '?'
    );
    output = output.replace(/%s/g, () =>
      argIdx < stmt.args.length ? this.evalExpr(proc, stmt.args[argIdx++]) : '?'
    );
    this.log(`[${proc.name}] ${output}`, 'log-print');
  }

  execAssert(proc, stmt) {
    if (!this.evalExpr(proc, stmt.expr)) {
      const msg = `Assertion failed at line ${stmt.line} in ${proc.name}`;
      this.log(`*** ${msg} ***`, 'log-error');
      this.errors.push(msg);
      if (this.mode === 'verify') this.stopped = true;
    }
  }

  execIf(proc, stmt) {
    const executable = [];
    for (let i = 0; i < stmt.branches.length; i++) {
      const br = stmt.branches[i];
      if (br.guard.type === 'Else' || this.isGuardEnabled(proc, br.guard)) {
        executable.push(i);
      }
    }
    if (executable.length === 0) { proc.blocked = true; return; }
    proc.blocked = false;
    const br = stmt.branches[executable[Math.floor(Math.random() * executable.length)]];
    const continuation = proc.stmts.slice(proc.pc + 1);
    const guardStmt = this.guardToStmts(br.guard);
    proc.stmts = [...proc.stmts.slice(0, proc.pc), ...guardStmt, ...br.body, ...continuation];
  }

  execDo(proc, stmt) {
    // Save timeoutEnabled before this do potentially overwrites it
    const savedTimeoutEnabled = proc.timeoutEnabled;

    const executable = [];
    let hasTimeout = false;
    for (let i = 0; i < stmt.branches.length; i++) {
      const br = stmt.branches[i];
      if (br.guard.type === 'Else') {
        executable.push(i);
      } else if (br.guard.type === 'Timeout') {
        hasTimeout = true;
        if (proc.useTimeout) { executable.push(i); proc.useTimeout = false; }
      } else if (this.isGuardEnabled(proc, br.guard)) {
        executable.push(i);
      }
    }
    proc.timeoutEnabled = hasTimeout;
    if (executable.length === 0) { proc.blocked = true; return; }
    proc.blocked = false;

    const br = stmt.branches[executable[Math.floor(Math.random() * executable.length)]];
    const continuation = proc.stmts.slice(proc.pc + 1);
    const guardStmt = this.guardToStmts(br.guard);

    // Check if this is a re-iteration of the same do loop (top of callStack owns this stmt)
    const top = proc.callStack.length > 0 ? proc.callStack[proc.callStack.length - 1] : null;
    const isReiteration = top && top.doStmt === stmt;

    const doMarker = { type: '_DoMarker', continuation };
    proc.stmts = [
      ...proc.stmts.slice(0, proc.pc),
      ...guardStmt,
      ...br.body,
      stmt,
      doMarker,
      ...continuation
    ];
    if (isReiteration) {
      top.doMarker = doMarker;
    } else {
      // prevTimeoutEnabled = value BEFORE this do modified it
      proc.callStack.push({ doMarker, doStmt: stmt, prevTimeoutEnabled: savedTimeoutEnabled });
    }
  }

  execBreak(proc) {
    if (proc.callStack.length === 0) { proc.pc++; return; }
    const frame = proc.callStack.pop();
    proc.timeoutEnabled = frame.prevTimeoutEnabled || false;
    for (let i = proc.pc; i < proc.stmts.length; i++) {
      if (proc.stmts[i].type === '_DoMarker') {
        const cont = proc.stmts[i].continuation;
        proc.stmts = [...proc.stmts.slice(0, proc.pc), ...cont];
        return;
      }
    }
    proc.pc++;
  }

  execExprStmt(proc, stmt) {
    if (this.evalExpr(proc, stmt.expr)) { proc.blocked = false; proc.pc++; }
    else { proc.blocked = true; }
  }

  guardToStmts(guard) {
    if (guard.type === 'Else' || guard.type === 'Timeout') return [];
    // Send/Recv guards need to actually execute (consume/produce messages)
    if (guard.type === 'Send' || guard.type === 'Recv') return [guard];
    // Boolean expression guards: already evaluated, just skip
    return [{ type: 'Skip' }];
  }

  isGuardEnabled(proc, guard) {
    try {
      if (guard.type === 'Send') {
        const ch = this.resolveChan(proc, guard.chan);
        if (ch.isRendezvous()) return this.hasRendezvousPartner(proc, ch, 'recv');
        return ch.canSend();
      }
      if (guard.type === 'Recv') {
        const ch = this.resolveChan(proc, guard.chan);
        if (ch.isRendezvous()) return ch.rvPending !== null || this.hasRendezvousPartner(proc, ch, 'send');
        return ch.canRecv();
      }
      return !!this.evalExpr(proc, guard);
    } catch { return false; }
  }

  evalExpr(proc, expr) {
    switch (expr.type) {
      case 'Literal': return expr.value;
      case 'Var': return this.getVar(proc, expr);
      case 'Index': {
        const arr = this.getVar(proc, expr.base);
        return arr[this.evalExpr(proc, expr.index)];
      }
      case 'BinOp': return this.evalBinOp(proc, expr);
      case 'UnaryOp': {
        const val = this.evalExpr(proc, expr.operand);
        if (expr.op === '-') return -val;
        if (expr.op === '!') return val ? 0 : 1;
        if (expr.op === '~') return ~val;
        return val;
      }
      case 'ChanOp': {
        const ch = this.resolveChan(proc, expr.arg);
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
        const pt = this.program.proctypes.find(p => p.name === expr.name);
        if (!pt) { this.log(`run: unknown proctype '${expr.name}'`, 'log-error'); return 0; }
        const newProc = this.spawnProcess(pt.name, pt.body);
        // Bind arguments to parameters
        if (pt.params) {
          for (let i = 0; i < pt.params.length; i++) {
            newProc.locals[pt.params[i].name] = i < expr.args.length ? this.evalExpr(proc, expr.args[i]) : 0;
          }
        }
        this.log(`Started ${pt.name} (pid ${newProc.pid})`, 'log-info');
        return newProc.pid;
      }
      default: throw new Error(`Cannot evaluate: ${expr.type}`);
    }
  }

  evalBinOp(proc, expr) {
    const l = this.evalExpr(proc, expr.left);
    const r = this.evalExpr(proc, expr.right);
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
      default: throw new Error(`Unknown operator: ${expr.op}`);
    }
  }

  getVar(proc, expr) {
    const name = expr.name;
    if (proc && name in proc.locals) return proc.locals[name];
    if (name in this.globals) return this.globals[name];
    return 0;
  }

  setVar(proc, target, value) {
    if (target.type === 'Var') {
      const name = target.name;
      if (proc && name in proc.locals) { proc.locals[name] = value; return; }
      if (name in this.globals) { this.globals[name] = value; return; }
      if (proc) proc.locals[name] = value;
      else this.globals[name] = value;
    } else if (target.type === 'Index') {
      const name = target.base.name;
      const idx = this.evalExpr(proc, target.index);
      if (proc && name in proc.locals) { proc.locals[name][idx] = value; return; }
      if (name in this.globals) { this.globals[name][idx] = value; return; }
    }
  }
}

export class Verifier {
  constructor(program, logger) {
    this.program = program;
    this.log = logger;
  }

  // Synchronous verify (for tests / Node.js)
  verify() {
    this.log('=== Verification Mode ===', 'log-info');
    this.log('Running random simulation with multiple seeds...', 'log-info');

    let totalErrors = 0;
    const NUM_RUNS = 100;

    for (let run = 0; run < NUM_RUNS; run++) {
      const interp = new Interpreter(this.program, () => {}, 'verify');
      interp.maxSteps = 5000;
      interp.run();
      if (interp.errors.length > 0) {
        totalErrors++;
        for (const err of interp.errors) {
          this.log(`Run ${run}: ${err}`, 'log-error');
        }
      }
    }

    this._reportResult(totalErrors, NUM_RUNS);
  }

  // Async verify (for browser UI - yields to event loop every CHUNK_SIZE runs)
  verifyAsync(onDone) {
    this.log('=== Verification Mode ===', 'log-info');
    this.log('Running random simulation with multiple seeds...', 'log-info');

    const NUM_RUNS = 100;
    const CHUNK_SIZE = 10;
    let totalErrors = 0;
    let run = 0;

    const runChunk = () => {
      const end = Math.min(run + CHUNK_SIZE, NUM_RUNS);
      for (; run < end; run++) {
        const interp = new Interpreter(this.program, () => {}, 'verify');
        interp.maxSteps = 5000;
        interp.run();
        if (interp.errors.length > 0) {
          totalErrors++;
          for (const err of interp.errors) {
            this.log(`Run ${run}: ${err}`, 'log-error');
          }
        }
      }
      this.log(`  progress: ${run}/${NUM_RUNS}...`, 'log-info');
      if (run < NUM_RUNS) {
        setTimeout(runChunk, 0);
      } else {
        this._reportResult(totalErrors, NUM_RUNS);
        if (onDone) onDone(totalErrors);
      }
    };
    setTimeout(runChunk, 0);
  }

  _reportResult(totalErrors, numRuns) {
    if (totalErrors === 0) {
      this.log(`\n${numRuns} random runs completed. No errors found.`, 'log-info');
      this.log('(Note: this is random simulation, not exhaustive verification)', 'log-warn');
    } else {
      this.log(`\n${totalErrors}/${numRuns} runs had errors.`, 'log-error');
    }
  }
}
