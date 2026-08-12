'use strict';
// The invariant online play now rests on: a peer sends the move it made and the modal
// answers it gave, never the resulting position, and the receiver re-derives that
// position itself. These tests pin down that the two sides land in the same place —
// including through a gamble, whose dice come from a shared seed rather than the wire.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameCore = require('../game-core.js');
const { mulberry32, pickOffered } = require('../net-protocol.js');

const { newPiece } = GameCore;

function emptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}

function baseCore(board, overrides) {
  return Object.assign({
    board, turn: 'w', ep: null, moveNum: 1, halfmoveClock: 0, captured: { w: 0, b: 0 }
  }, overrides);
}

// Stands in for runMove's two modes. The mover answers its own modals and records what
// it answered; the replayer feeds those recorded answers back into the same reducer.
function asMover(core, move, rules, policy) {
  const gen = GameCore.applyMove(core, move, rules);
  const choices = [];
  const events = [];
  let res = gen.next();
  while (!res.done) {
    const ev = res.value;
    events.push(ev);
    let answer;
    if (ev.type === 'gamble') answer = choices[choices.push(policy.gamble(ev)) - 1];
    else if (ev.type === 'promotion') answer = choices[choices.push(policy.promotion(ev)) - 1];
    else if (ev.type === 'evolutionChoice') answer = choices[choices.push(policy.evolutionChoice(ev)) - 1];
    res = gen.next(answer);
  }
  return { core: res.value, choices, events };
}

function asReplayer(core, move, rules, choices) {
  const gen = GameCore.applyMove(core, move, rules);
  const events = [];
  let i = 0;
  let res = gen.next();
  while (!res.done) {
    const ev = res.value;
    events.push(ev);
    let answer;
    if (ev.type === 'gamble') answer = !!choices[i++];
    else if (ev.type === 'promotion' || ev.type === 'evolutionChoice') answer = pickOffered(ev.options, choices[i++]);
    res = gen.next(answer);
  }
  return { core: res.value, events };
}

const ALWAYS = { gamble: () => true, promotion: () => 'Q', evolutionChoice: () => 'N' };

test('replaying a quiet move reproduces the mover\'s position exactly', () => {
  const board = emptyBoard();
  board[7][4] = newPiece('K', 'w');
  board[0][4] = newPiece('K', 'b');
  board[6][0] = newPiece('P', 'w');
  const move = { from: { r: 6, c: 0 }, to: { r: 4, c: 0 }, double: true };

  const mover = asMover(baseCore(board), move, {}, ALWAYS);
  const replay = asReplayer(baseCore(board), move, {}, mover.choices);

  assert.deepEqual(replay.core, mover.core);
  assert.deepEqual(replay.core.ep, { r: 5, c: 0 });
});

test('a gamble replays identically from a shared seed, with no roll on the wire', () => {
  // Same seed on both sides; neither client is told what the other rolled.
  const seed = 0xC0FFEE;
  const setup = () => {
    const b = emptyBoard();
    b[7][4] = newPiece('K', 'w');
    b[0][4] = newPiece('K', 'b');
    b[4][0] = newPiece('R', 'w');
    b[4][3] = newPiece('Q', 'b');
    return b;
  };
  const move = { from: { r: 4, c: 0 }, to: { r: 4, c: 3 } };
  const rules = () => ({ gambleOn: true, evolutionOn: true, rng: mulberry32(seed) });

  const mover = asMover(baseCore(setup()), move, rules(), ALWAYS);
  const replay = asReplayer(baseCore(setup()), move, rules(), mover.choices);

  const rolled = mover.events.find(e => e.type === 'gambleRolled');
  assert.ok(rolled, 'the setup should actually offer a gamble');
  assert.deepEqual(replay.core, mover.core);
  assert.equal(
    replay.events.find(e => e.type === 'gambleRolled').win,
    rolled.win,
    'both sides must see the same roll'
  );
  // ...and the choices that crossed the wire carried the decision, not the outcome
  assert.deepEqual(mover.choices, [true]);
});

test('a different seed can produce a different gamble outcome (the seed is doing work)', () => {
  const setup = () => {
    const b = emptyBoard();
    b[7][4] = newPiece('K', 'w');
    b[0][4] = newPiece('K', 'b');
    b[4][0] = newPiece('R', 'w');
    b[4][3] = newPiece('Q', 'b');
    return b;
  };
  const move = { from: { r: 4, c: 0 }, to: { r: 4, c: 3 } };
  const outcomes = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const r = asMover(baseCore(setup()), move,
      { gambleOn: true, evolutionOn: true, rng: mulberry32(seed) }, ALWAYS);
    outcomes.add(r.events.find(e => e.type === 'gambleRolled').win);
  }
  assert.equal(outcomes.size, 2, 'seeds should not all roll the same way');
});

test('a whole sequence of moves stays in step across the two clients', () => {
  const setup = () => {
    const b = emptyBoard();
    b[7][4] = newPiece('K', 'w');
    b[0][4] = newPiece('K', 'b');
    b[6][0] = newPiece('P', 'w');
    b[1][7] = newPiece('P', 'b');
    b[4][2] = newPiece('N', 'w');
    b[3][3] = newPiece('R', 'b');
    return b;
  };
  const moves = [
    { from: { r: 6, c: 0 }, to: { r: 5, c: 0 } },            // w pawn
    { from: { r: 1, c: 7 }, to: { r: 3, c: 7 }, double: true }, // b pawn
    { from: { r: 4, c: 2 }, to: { r: 3, c: 3 } },            // w knight takes rook
    { from: { r: 0, c: 4 }, to: { r: 0, c: 3 } }             // b king
  ];
  const rules = { gambleOn: true, evolutionOn: true };

  // two independent clients, each with their own copy of everything
  let mine = baseCore(setup());
  let theirs = baseCore(setup());
  const rngMine = mulberry32(4242), rngTheirs = mulberry32(4242);

  for (const move of moves) {
    const mover = asMover(mine, move, Object.assign({ rng: rngMine }, rules), ALWAYS);
    const replay = asReplayer(theirs, move, Object.assign({ rng: rngTheirs }, rules), mover.choices);
    assert.deepEqual(replay.core, mover.core, `diverged at ${JSON.stringify(move)}`);
    mine = mover.core;
    theirs = replay.core;
  }
  assert.equal(mine.moveNum, 3);
});

// ---------- Resuming a game from its recorded session ----------

function findMove(core, from, to) {
  return GameCore.allLegalMoves(core.board, core.turn, core.ep)
    .find(x => x.from.r === from.r && x.from.c === from.c && x.to.r === to.r && x.to.c === to.c);
}

// Mirrors netReplayGameLog: rebuild a game purely from the opening position, the seed,
// and the recorded session — no positions are carried over from the original run.
function replaySession(startBoard, startTurn, startRules, seed, log) {
  let core = baseCore(GameCore.cloneBoard(startBoard), { turn: startTurn });
  const rules = Object.assign({}, startRules);
  const rng = mulberry32(seed);
  for (const e of log) {
    if (e.kind === 'rule') { rules[e.setting] = e.value; continue; }
    const mv = findMove(core, e.from, e.to);
    assert.ok(mv, `replay hit an illegal move ${JSON.stringify(e)}`);
    core = asReplayer(core, mv, Object.assign({ rng }, rules), e.choices).core;
  }
  return core;
}

test('a recorded session replays to the same position, across a mid-game rule change', () => {
  const setup = () => {
    const b = emptyBoard();
    b[7][4] = newPiece('K', 'w');
    b[0][4] = newPiece('K', 'b');
    b[4][0] = newPiece('R', 'w');
    b[4][3] = newPiece('N', 'b');  // rook captures this one, with gambling ON
    b[5][5] = newPiece('B', 'w');
    b[3][3] = newPiece('P', 'b');  // bishop captures this one, after gambling is OFF
    b[1][7] = newPiece('P', 'b');
    return b;
  };
  const seed = 20260812;
  const script = [
    { from: { r: 4, c: 0 }, to: { r: 4, c: 3 } },
    { from: { r: 1, c: 7 }, to: { r: 2, c: 7 } },
    { rule: 'gambleOn', value: false },
    { from: { r: 5, c: 5 }, to: { r: 3, c: 3 } },
    { from: { r: 2, c: 7 }, to: { r: 3, c: 7 } }
  ];

  // the original game: play it, recording exactly what the session log would record
  const startRules = { gambleOn: true, evolutionOn: true };
  const rules = Object.assign({}, startRules);
  const rng = mulberry32(seed);
  let core = baseCore(setup());
  const log = [];
  for (const step of script) {
    if (step.rule) {
      rules[step.rule] = step.value;
      log.push({ kind: 'rule', setting: step.rule, value: step.value });
      continue;
    }
    const mv = findMove(core, step.from, step.to);
    assert.ok(mv, `setup move should be legal: ${JSON.stringify(step)}`);
    const played = asMover(core, mv, Object.assign({ rng }, rules), ALWAYS);
    log.push({ kind: 'move', from: step.from, to: step.to, choices: played.choices });
    core = played.core;
  }

  // gambling was on for the first capture and off for the second, so the dice were
  // drawn exactly once — a replayer that got that wrong would fall out of step
  assert.equal(log.filter(e => e.kind === 'move' && e.choices.length > 0).length, 1);

  const resumed = replaySession(setup(), 'w', startRules, seed, log);
  assert.deepEqual(resumed, core);
});

test('resuming re-derives captured points and move number, not just the pieces', () => {
  const setup = () => {
    const b = emptyBoard();
    b[7][4] = newPiece('K', 'w');
    b[0][4] = newPiece('K', 'b');
    b[4][0] = newPiece('R', 'w');
    b[4][3] = newPiece('Q', 'b');
    b[1][7] = newPiece('P', 'b');
    return b;
  };
  const seed = 7;
  const rules = { gambleOn: false, evolutionOn: true };
  const rng = mulberry32(seed);
  let core = baseCore(setup());
  const log = [];
  for (const step of [{ from: { r: 4, c: 0 }, to: { r: 4, c: 3 } }, { from: { r: 1, c: 7 }, to: { r: 3, c: 7 } }]) {
    const mv = findMove(core, step.from, step.to);
    const played = asMover(core, mv, Object.assign({ rng }, rules), ALWAYS);
    log.push({ kind: 'move', from: step.from, to: step.to, choices: played.choices });
    core = played.core;
  }
  assert.equal(core.captured.w, GameCore.VALUES.Q);

  const resumed = replaySession(setup(), 'w', rules, seed, log);
  assert.equal(resumed.captured.w, core.captured.w);
  assert.equal(resumed.moveNum, core.moveNum);
  assert.equal(resumed.halfmoveClock, core.halfmoveClock);
  assert.deepEqual(resumed, core);
});

test('a tampered promotion choice cannot put a second king on the replayer\'s board', () => {
  const setup = () => {
    const b = emptyBoard();
    b[7][4] = newPiece('K', 'w');
    b[0][4] = newPiece('K', 'b');
    b[1][0] = newPiece('P', 'w'); // one step from promoting
    return b;
  };
  const move = { from: { r: 1, c: 0 }, to: { r: 0, c: 0 } };

  // the peer claims it promoted to a King — pickOffered falls back to the first option
  const replay = asReplayer(baseCore(setup()), move, { evolutionOn: false }, ['K']);

  const kings = replay.core.board.flat().filter(p => p && p.t === 'K' && p.c === 'w');
  assert.equal(kings.length, 1);
  assert.equal(replay.core.board[0][0].t, 'Q');
});
