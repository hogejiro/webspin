export const EXAMPLES = {
  hello: `/* Hello World */
active proctype hello() {
  printf("Hello from process 1!\\n")
}

active proctype world() {
  printf("Hello from process 2!\\n")
}`,

  counter: `/* Shared counter - data race example
   Two processes read-modify-write a shared counter.
   With interleaving, both may read count=0 and write 1.
   Expected count=2, but Verify finds count=1 is possible.
   The LTL property <>(count==2) is also violated! */
int count = 0;

proctype inc(int id) {
  int tmp;
  tmp = count;
  tmp = tmp + 1;
  count = tmp;
  printf("inc%d: count = %d\\n", id, count)
}

init {
  run inc(1);
  run inc(2)
}

ltl both { <> count == 2 }`,

  chan: `/* Channel communication */
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
}`,

  mutex: `/* Peterson's mutual exclusion
   The LTL property says at most one process is
   in the critical section at any time. Verify
   confirms Peterson's algorithm guarantees this. */
bool flag[2] = false;
int turn = 0;
int critical = 0;

active proctype P0() {
  flag[0] = true;
  turn = 1;
  (flag[1] == false || turn == 0);
  /* critical section */
  critical = critical + 1;
  assert(critical == 1);
  critical = critical - 1;
  flag[0] = false
}

active proctype P1() {
  flag[1] = true;
  turn = 0;
  (flag[0] == false || turn == 1);
  /* critical section */
  critical = critical + 1;
  assert(critical == 1);
  critical = critical - 1;
  flag[1] = false
}

ltl mutex { [] critical <= 1 }`,

  broken_mutex: `/* Broken mutex - no lock, data race!
   Two processes enter the critical section without
   any synchronization. Both assert and LTL catch
   the violation. Compare with "Mutex (Peterson)". */
int critical = 0;

proctype worker() {
  critical = critical + 1;
  assert(critical == 1);
  critical = critical - 1
}

init {
  run worker();
  run worker()
}

ltl mutex { [] critical <= 1 }`,

  dining: `/* Dining Philosophers - DEADLOCK
   Each philosopher picks up their own fork first,
   then their neighbor's. This creates a circular wait.
   Try Verify to see the deadlock trace! */
chan fork[2] = [1] of { int };

proctype phil(int id) {
  int left;
  int right;
  left = id;
  right = 1 - id;
  /* each philosopher: own fork first, then neighbor's */
  do
  :: true ->
    fork[left] ? 1;
    fork[right] ? 1;
    printf("phil%d eating\\n", id);
    fork[left] ! 1;
    fork[right] ! 1;
    printf("phil%d thinking\\n", id)
  od
}

init {
  fork[0] ! 1;
  fork[1] ! 1;
  run phil(0);
  run phil(1)
}`,

  dining_fixed: `/* Dining Philosophers - FIXED (resource ordering)
   Compare with "dining": same proctype, only the
   fork acquisition order changes.
   Fix: always pick up the lower-numbered fork first.
   This breaks the circular wait. Verify finds no deadlock. */
chan fork[2] = [1] of { int };

proctype phil(int id) {
  /* always pick lower-numbered fork first */
  do
  :: true ->
    fork[0] ? 1;
    fork[1] ? 1;
    printf("phil%d eating\\n", id);
    fork[0] ! 1;
    fork[1] ! 1;
    printf("phil%d thinking\\n", id)
  od
}

init {
  fork[0] ! 1;
  fork[1] ! 1;
  run phil(0);
  run phil(1)
}`,

  goto_statemachine: `/* State Machine with goto
   A traffic light controller modeled as explicit
   states with goto transitions. Labels mark each
   state, and goto implements the transitions.
   LTL: the controller always completes 3 cycles. */
#define RED    1
#define YELLOW 2
#define GREEN  3

int light = RED;
int cycles = 0;

active proctype traffic() {
  red: light = RED;
  printf("RED\\n");
  goto green;

  green: light = GREEN;
  printf("GREEN\\n");
  goto yellow;

  yellow: light = YELLOW;
  printf("YELLOW\\n");
  cycles = cycles + 1;
  if
  :: cycles < 3 -> goto red
  :: cycles >= 3 -> goto done
  fi;

  done: printf("done after %d cycles\\n", cycles);
  assert(cycles == 3)
}

ltl completes { <> cycles == 3 }`,

  producer: `/* Producer-Consumer with bounded buffer
   LTL: all 6 items are eventually consumed. */
chan buf = [3] of { int };
int consumed = 0;

active proctype producer() {
  int i = 0;
  do
  :: i < 6 ->
    buf ! i;
    printf("produced %d\\n", i);
    i = i + 1
  :: i >= 6 -> break
  od;
  printf("producer done\\n")
}

active proctype consumer() {
  int val;
  do
  :: buf ? val ->
    printf("consumed %d\\n", val);
    consumed = consumed + 1
  :: timeout -> break
  od;
  printf("total consumed: %d\\n", consumed)
}

ltl all_consumed { <> consumed == 6 }`,

  elevator: `/* Elevator controller for 4 floors (0-3)
   LTL: if the elevator is moving, the door must
   be closed. This is a safety invariant. */
int floor = 0;
int door = 0;
int moving = 0;
chan request = [4] of { int };
int served = 0;

active proctype controller() {
  int target;
  do
  :: request ? target ->
    printf("request for floor %d (at %d)\\n", target, floor);
    do
    :: floor < target ->
      assert(door == 0);
      moving = 1;
      floor = floor + 1;
      printf("  moving up to %d\\n", floor)
    :: floor > target ->
      assert(door == 0);
      moving = 1;
      floor = floor - 1;
      printf("  moving down to %d\\n", floor)
    :: floor == target -> break
    od;
    moving = 0;
    door = 1;
    printf("  arrived, door open\\n");
    door = 0;
    served = served + 1
  :: timeout -> break
  od;
  printf("served %d requests\\n", served)
}

active proctype passengers() {
  request ! 3;
  request ! 1;
  request ! 0;
  request ! 2
}

ltl safe_move { [] (moving == 1 -> door == 0) }`,

  abp: `/* Alternating Bit Protocol */
chan toR = [1] of { int, int };
chan toS = [1] of { int };
int delivered = 0;

active proctype sender() {
  int seq = 0;
  int msg = 10;
  int ack;
  do
  :: msg < 13 ->
    toR ! msg, seq;
    printf("sent msg=%d seq=%d\\n", msg, seq);
    toS ? ack;
    if
    :: ack == seq ->
      printf("ack ok seq=%d\\n", seq);
      seq = 1 - seq;
      msg = msg + 1
    :: ack != seq ->
      printf("ack mismatch, resend\\n")
    fi
  :: msg >= 13 -> break
  od;
  printf("sender done, delivered=%d\\n", delivered)
}

active proctype receiver() {
  int expect = 0;
  int msg;
  int seq;
  do
  :: toR ? msg, seq ->
    printf("recv msg=%d seq=%d\\n", msg, seq);
    if
    :: seq == expect ->
      delivered = delivered + 1;
      expect = 1 - expect
    :: seq != expect -> skip
    fi;
    toS ! seq
  :: timeout -> break
  od
}`,

  atomic_mutex: `/* Atomic mutex - fixing the broken mutex with atomic blocks
   Compare with "broken_mutex": without atomic, the assert fails.
   With atomic, the critical section is indivisible. */
int critical = 0;

active proctype P0() {
  atomic {
    critical = critical + 1;
    assert(critical == 1);
    critical = critical - 1
  }
}

active proctype P1() {
  atomic {
    critical = critical + 1;
    assert(critical == 1);
    critical = critical - 1
  }
}`,

  run_workers: `/* Worker Pool with init + run
   init spawns 3 workers via run, each processes
   a task from a shared channel. The channel acts
   as a work queue. */
#define NWORKERS 3
#define NTASKS 5
chan tasks = [NTASKS] of { int };
int done = 0;

proctype worker(int id) {
  int task;
  do
  :: tasks ? task ->
    printf("worker%d: task %d\\n", id, task);
    done = done + 1
  :: timeout -> break
  od;
  printf("worker%d finished\\n", id)
}

init {
  int i = 0;
  do
  :: i < NTASKS ->
    tasks ! i;
    i = i + 1
  :: i >= NTASKS -> break
  od;
  i = 0;
  do
  :: i < NWORKERS ->
    run worker(i);
    i = i + 1
  :: i >= NWORKERS -> break
  od
}`,

  protocol: `/* Client-Server Protocol with mtype */
#define NREQ 3

mtype = { request, response, error };

chan toServer = [2] of { mtype, int };
chan toClient = [2] of { mtype, int };
int served = 0;

active proctype client() {
  int i = 0;
  mtype reply;
  int data;
  do
  :: i < NREQ ->
    toServer ! request, i;
    printf("client: sent request %d\\n", i);
    toClient ? reply, data;
    if
    :: reply == response ->
      printf("client: got response data=%d\\n", data)
    :: reply == error ->
      printf("client: got error\\n")
    fi;
    i = i + 1
  :: i >= NREQ -> break
  od;
  printf("client done\\n")
}

active proctype server() {
  mtype msg;
  int data;
  do
  :: toServer ? msg, data ->
    if
    :: msg == request ->
      printf("server: handling request %d\\n", data);
      toClient ! response, data * 10;
      served = served + 1
    :: else ->
      toClient ! error, 0
    fi
  :: timeout -> break
  od;
  printf("server done, served %d\\n", served);
  assert(served == NREQ)
}`,

  chan_query: `/* Channel Query Functions
   len(ch)    - number of messages buffered
   empty(ch)  - 1 if buffer is empty, 0 otherwise
   full(ch)   - 1 if buffer is full, 0 otherwise
   nfull(ch)  - 1 if buffer is NOT full
   nempty(ch) - 1 if buffer is NOT empty
   These can be used as expressions or guards. */
chan buf = [3] of { int };
int produced = 0;
int consumed = 0;

active proctype producer() {
  do
  :: produced < 6 ->
    (nfull(buf));        /* guard: wait until space */
    buf ! produced;
    printf("sent %d (len=%d)\\n", produced, len(buf));
    produced = produced + 1
  :: produced >= 6 -> break
  od;
  printf("producer done\\n")
}

active proctype consumer() {
  int val;
  do
  :: nempty(buf) ->      /* guard: wait until data */
    buf ? val;
    consumed = consumed + 1;
    printf("recv %d (len=%d empty=%d)\\n", val, len(buf), empty(buf))
  :: timeout -> break
  od;
  printf("consumed %d items\\n", consumed)
}

ltl all_done { <> consumed == 6 }`,

  rendezvous: `/* Rendezvous (synchronous) channel
   chan ch = [0] means buffer size 0: no buffering.
   Send blocks until a receiver is ready, and vice
   versa. The handshake is atomic - both sides
   proceed simultaneously. Compare with "chan" which
   uses buffered (asynchronous) channels. */
chan ch = [0] of { int };
int received = 0;

active proctype sender() {
  ch ! 1;
  printf("handshake 1 done\\n");
  ch ! 2;
  printf("handshake 2 done\\n");
  ch ! 3;
  printf("handshake 3 done\\n")
}

active proctype receiver() {
  int v;
  ch ? v; printf("got %d\\n", v); received = received + 1;
  ch ? v; printf("got %d\\n", v); received = received + 1;
  ch ? v; printf("got %d\\n", v); received = received + 1;
  printf("total: %d\\n", received)
}

ltl all_received { <> received == 3 }`,

  rv_deadlock: `/* Rendezvous Deadlock
   Two processes each try to SEND on a rendezvous
   channel before receiving. Neither can proceed
   because rendezvous requires a matching partner.
   This is a classic deadlock pattern. Try Verify! */
chan a = [0] of { int };
chan b = [0] of { int };

active proctype P() {
  a ! 1;       /* blocks: no one is receiving on a */
  int v;
  b ? v;
  printf("P got %d\\n", v)
}

active proctype Q() {
  b ! 2;       /* blocks: no one is receiving on b */
  int v;
  a ? v;
  printf("Q got %d\\n", v)
}`,

  flow_control: `/* Flow Control with full/nfull
   A fast producer and slow consumer with explicit
   backpressure. The producer checks nfull() before
   sending and counts how many times it had to wait.
   LTL verifies the buffer never overflows. */
chan pipe = [2] of { int };
int sent = 0;
int received = 0;

active proctype fast_sender() {
  do
  :: sent < 4 ->
    (nfull(pipe));
    pipe ! sent;
    printf("send %d (buf=%d/%d)\\n", sent, len(pipe), 2);
    sent = sent + 1
  :: sent >= 4 -> break
  od
}

active proctype slow_receiver() {
  int v;
  do
  :: pipe ? v ->
    printf("recv %d (buf=%d)\\n", v, len(pipe));
    received = received + 1
  :: timeout -> break
  od;
  printf("total received: %d\\n", received)
}

ltl safe { [] len(pipe) <= 2 }
ltl complete { <> received == 4 }`,

  ltl_safety: `/* LTL Safety: counter never goes negative
   The ltl block specifies a temporal property.
   [] means "globally" (in every reachable state).
   Verify checks this holds on all execution paths. */
int count = 0;

active proctype inc() {
  count = count + 1;
  count = count + 1;
  count = count + 1
}

active proctype dec() {
  count = count - 1
}

ltl safe { [] count >= -1 }`,

  ltl_liveness: `/* LTL Liveness: eventually done
   <> means "finally" (eventually becomes true).
   This property says every execution eventually
   reaches done == 1. Try changing the loop bound
   or removing the assignment to see violations. */
int done = 0;
int x = 0;

active proctype worker() {
  do
  :: x < 5 -> x = x + 1
  :: x >= 5 -> break
  od;
  done = 1
}

ltl finish { <> done == 1 }`,

  ltl_response: `/* LTL Response: request leads to ack
   [] (p -> <> q) means "every request is
   eventually acknowledged". The server uses a
   blocking guard (req == 1) so it cannot spin
   forever ignoring the request. */
int req = 0;
int ack = 0;

active proctype client() {
  req = 1
}

active proctype server() {
  (req == 1);    /* blocks until req == 1 */
  ack = 1
}

ltl response { [] (req == 1 -> <> ack == 1) }`,

  ltl_violation: `/* LTL Violation Demo: x is always positive?
   This property is VIOLATED because x starts at 0.
   Verify will find a counterexample showing that
   x == 0 in the initial state. */
int x = 0;

active proctype P() {
  x = 1;
  x = 2;
  x = 3
}

ltl always_pos { [] x > 0 }`
};
