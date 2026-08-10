'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameCore = require('../game-core.js');

const { newPiece, nextEvolutionStage } = GameCore;

function emptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}

function baseCore(board, overrides) {
  return Object.assign({
    board, turn: 'w', ep: null, moveNum: 1, halfmoveClock: 0, captured: { w: 0, b: 0 }
  }, overrides);
}

// Drives applyMove to completion, auto-answering decisions from `policy`
// (defaults: never gamble, always promote to Queen, always evolve pawns to
// Knight) and collecting every yielded event for assertions.
function drive(gen, policy) {
  policy = Object.assign({ gamble: () => false, promotion: () => 'Q', evolutionChoice: () => 'N' }, policy);
  const events = [];
  let result = gen.next();
  while (!result.done) {
    events.push(result.value);
    let answer;
    if (result.value.type === 'gamble') answer = policy.gamble(result.value);
    else if (result.value.type === 'promotion') answer = policy.promotion(result.value);
    else if (result.value.type === 'evolutionChoice') answer = policy.evolutionChoice(result.value);
    result = gen.next(answer);
  }
  return { core: result.value, events };
}

test('plain move: advances turn, resets halfmove clock, sets ep on a double push', () => {
  const board = emptyBoard();
  board[6][0] = newPiece('P', 'w'); // a2
  const core = baseCore(board, { halfmoveClock: 7 });
  const move = { from: { r: 6, c: 0 }, to: { r: 4, c: 0 }, double: true };

  const { core: next, events } = drive(GameCore.applyMove(core, move, {}));

  assert.equal(next.turn, 'b');
  assert.equal(next.moveNum, 1); // only increments after Black's move
  assert.equal(next.halfmoveClock, 0); // pawn move resets it
  assert.deepEqual(next.ep, { r: 5, c: 0 });
  assert.equal(next.board[4][0].t, 'P');
  assert.equal(next.board[6][0], null);
  assert.equal(events.some(e => e.type === 'captureBanked' || e.type === 'captureBust'), false);
});

test('halfmove clock increments on a quiet non-pawn move', () => {
  const board = emptyBoard();
  board[4][4] = newPiece('R', 'w');
  const core = baseCore(board, { halfmoveClock: 7 });
  const move = { from: { r: 4, c: 4 }, to: { r: 4, c: 0 } };

  const { core: next } = drive(GameCore.applyMove(core, move, {}));
  assert.equal(next.halfmoveClock, 8);
});

test('capture without gambling banks points immediately, no gamble offered', () => {
  const board = emptyBoard();
  board[4][0] = newPiece('R', 'w');
  board[4][3] = newPiece('P', 'b');
  const core = baseCore(board);
  const move = { from: { r: 4, c: 0 }, to: { r: 4, c: 3 } };

  const { core: next, events } = drive(GameCore.applyMove(core, move, { gambleOn: false }));

  assert.equal(events.some(e => e.type === 'gamble'), false);
  const banked = events.find(e => e.type === 'captureBanked');
  assert.ok(banked);
  assert.equal(banked.pts, GameCore.VALUES.P);
  assert.equal(banked.gambled, null);
  assert.equal(next.captured.w, GameCore.VALUES.P);
  assert.equal(next.board[4][3].t, 'R');
});

test('gamble win doubles the points; gamble loss busts the capturing piece', () => {
  const winBoard = emptyBoard();
  winBoard[4][0] = newPiece('R', 'w');
  winBoard[4][3] = newPiece('P', 'b');
  const winMove = { from: { r: 4, c: 0 }, to: { r: 4, c: 3 } };
  const win = drive(
    GameCore.applyMove(baseCore(winBoard), winMove, { gambleOn: true, rng: () => 0 }),
    { gamble: () => true }
  );
  assert.ok(win.events.some(e => e.type === 'gambleRolled' && e.win === true));
  const winBank = win.events.find(e => e.type === 'captureBanked');
  assert.equal(winBank.pts, GameCore.VALUES.P * 2);
  assert.equal(winBank.gambled, 'win');
  assert.equal(win.core.board[4][3].t, 'R');

  const bustBoard = emptyBoard();
  bustBoard[4][0] = newPiece('R', 'w');
  bustBoard[4][3] = newPiece('P', 'b');
  const bustMove = { from: { r: 4, c: 0 }, to: { r: 4, c: 3 } };
  const bust = drive(
    GameCore.applyMove(baseCore(bustBoard), bustMove, { gambleOn: true, rng: () => 0.999 }),
    { gamble: () => true }
  );
  assert.ok(bust.events.some(e => e.type === 'gambleRolled' && e.win === false));
  assert.ok(bust.events.some(e => e.type === 'captureBust'));
  assert.equal(bust.core.board[4][3], null); // capturing piece is lost
  assert.equal(bust.core.captured.w, 0);
});

test('gamble is withheld when the capturing piece is shielding its own King', () => {
  const board = emptyBoard();
  board[7][4] = newPiece('K', 'w'); // e1
  board[3][4] = newPiece('R', 'w'); // e5
  board[4][4] = newPiece('P', 'b'); // e4 — captured
  board[0][4] = newPiece('R', 'b'); // e8 — pins the e-file
  const core = baseCore(board);
  const move = { from: { r: 3, c: 4 }, to: { r: 4, c: 4 } };

  const { core: next, events } = drive(GameCore.applyMove(core, move, { gambleOn: true }));

  assert.equal(events.some(e => e.type === 'gamble'), false);
  const banked = events.find(e => e.type === 'captureBanked');
  assert.equal(banked.pts, GameCore.VALUES.P); // no doubling possible — gamble was never offered
  assert.equal(next.board[4][4].t, 'R');
});

test('promotion asks for a choice and applies it before checking evolution', () => {
  const board = emptyBoard();
  board[1][0] = newPiece('P', 'w'); // a7
  const core = baseCore(board);
  const move = { from: { r: 1, c: 0 }, to: { r: 0, c: 0 } };

  const { core: next, events } = drive(GameCore.applyMove(core, move, {}), { promotion: () => 'R' });

  assert.ok(events.some(e => e.type === 'promotion'));
  const promoted = events.find(e => e.type === 'promoted');
  assert.equal(promoted.choice, 'R');
  assert.equal(next.board[0][0].t, 'R');
});

test('evolution chain walks a maxed-out Queen all the way to Amazon', () => {
  const board = emptyBoard();
  const queen = newPiece('Q', 'w');
  queen.pts = GameCore.THRESH.Q; // already eligible before the move
  board[4][4] = queen;
  const core = baseCore(board);
  const move = { from: { r: 4, c: 4 }, to: { r: 4, c: 5 } }; // quiet move — no capture

  const { core: next, events } = drive(GameCore.applyMove(core, move, { evolutionOn: true }));

  const evolved = events.find(e => e.type === 'evolved');
  assert.ok(evolved);
  assert.equal(evolved.from, 'Q');
  assert.equal(evolved.to, 'AMAZON');
  assert.equal(next.board[4][5].amazon, true);
  assert.equal(next.board[4][5].pts, 0);
});

test('evolutionOn: false skips evolution even when a piece is over threshold', () => {
  const board = emptyBoard();
  const rook = newPiece('R', 'w');
  rook.pts = GameCore.THRESH.R;
  board[4][4] = rook;
  const core = baseCore(board);
  const move = { from: { r: 4, c: 4 }, to: { r: 4, c: 5 } };

  const { events } = drive(GameCore.applyMove(core, move, { evolutionOn: false }));
  assert.equal(events.some(e => e.type === 'evolved' || e.type === 'evolutionChoice'), false);
});

test('a busted capture skips promotion and evolution entirely', () => {
  const board = emptyBoard();
  const pawn = newPiece('P', 'w');
  pawn.pts = GameCore.THRESH.P; // would evolve immediately if it survived
  board[1][0] = pawn; // a7
  board[0][0] = newPiece('N', 'b'); // a8 — capture target, also last rank
  const core = baseCore(board);
  const move = { from: { r: 1, c: 0 }, to: { r: 0, c: 0 } };

  const { events } = drive(
    GameCore.applyMove(core, move, { gambleOn: true, rng: () => 1 }),
    { gamble: () => true }
  );

  assert.ok(events.some(e => e.type === 'captureBust'));
  assert.equal(events.some(e => e.type === 'promotion' || e.type === 'evolutionChoice'), false);
});

test('nextEvolutionStage', () => {
  const thresh = GameCore.THRESH;

  const pawn = newPiece('P', 'w'); pawn.pts = thresh.P;
  assert.deepEqual(nextEvolutionStage(pawn, thresh), { cost: thresh.P, choice: true, options: ['N', 'B'] });

  const knight = newPiece('N', 'w'); knight.pts = thresh.N;
  assert.deepEqual(nextEvolutionStage(knight, thresh), { cost: thresh.N, choice: false, to: 'R' });

  const rook = newPiece('R', 'w'); rook.pts = thresh.R;
  assert.deepEqual(nextEvolutionStage(rook, thresh), { cost: thresh.R, choice: false, to: 'Q' });

  const queen = newPiece('Q', 'w'); queen.pts = thresh.Q;
  assert.deepEqual(nextEvolutionStage(queen, thresh), { cost: thresh.Q, choice: false, amazon: true });

  const amazon = newPiece('Q', 'w'); amazon.pts = 999; amazon.amazon = true;
  assert.equal(nextEvolutionStage(amazon, thresh), null);

  const king = newPiece('K', 'w'); king.pts = 999;
  assert.equal(nextEvolutionStage(king, thresh), null);

  const shortPawn = newPiece('P', 'w'); shortPawn.pts = thresh.P - 1;
  assert.equal(nextEvolutionStage(shortPawn, thresh), null);
});
