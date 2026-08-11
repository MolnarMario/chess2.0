'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameCore = require('../game-core.js');
const Net = require('../net-protocol.js');

const { newPiece } = GameCore;
const {
  mulberry32, normalizeRoomCode, randomRoomId, isSquareRef, saneMs,
  sanePiece, saneBoard, saneClockConfig, saneOnlineConfig, pickOffered
} = Net;

function emptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}

function standardish() {
  const b = emptyBoard();
  b[7][4] = newPiece('K', 'w');
  b[0][4] = newPiece('K', 'b');
  return b;
}

// ---------- Seeded dice: the basis for replaying a gamble on both clients ----------

test('mulberry32: same seed replays the same sequence, different seeds diverge', () => {
  const a = mulberry32(12345), b = mulberry32(12345), c = mulberry32(12346);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  const seqC = Array.from({ length: 8 }, () => c());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `${v} out of range`);
});

// ---------- Room codes ----------

test('randomRoomId: prefixed, 8 chars, no look-alike characters, not repeating', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = randomRoomId();
    assert.match(id, /^chess2-[abcdefghijkmnpqrstuvwxyz23456789]{8}$/);
    ids.add(id);
  }
  assert.ok(ids.size > 190, `expected near-unique ids, got ${ids.size}/200`);
});

test('normalizeRoomCode: forgiving about what a player pastes, strict about shape', () => {
  assert.equal(normalizeRoomCode('  CHESS2-AB23CD45 '), 'chess2-ab23cd45');
  assert.equal(normalizeRoomCode('ab23cd45'), 'chess2-ab23cd45'); // bare suffix
  assert.equal(normalizeRoomCode(''), null);
  assert.equal(normalizeRoomCode('abc'), null);                    // too short
  assert.equal(normalizeRoomCode('chess2-../../etc'), null);
  assert.equal(normalizeRoomCode('chess2-<img src=x>'), null);
  assert.equal(normalizeRoomCode(null), null);
  assert.equal(normalizeRoomCode({}), null);
});

// ---------- Field-level validation ----------

test('isSquareRef: only real, integral board coordinates', () => {
  assert.ok(isSquareRef({ r: 0, c: 0 }));
  assert.ok(isSquareRef({ r: 7, c: 7 }));
  assert.ok(!isSquareRef({ r: 8, c: 0 }));
  assert.ok(!isSquareRef({ r: -1, c: 0 }));
  assert.ok(!isSquareRef({ r: 1.5, c: 0 }));
  assert.ok(!isSquareRef({ r: '0', c: '0' }));
  assert.ok(!isSquareRef(null));
  assert.ok(!isSquareRef(undefined));
});

test('saneMs: clamps to a plausible clock reading, falls back otherwise', () => {
  assert.equal(saneMs(5000, 1), 5000);
  assert.equal(saneMs(-1, 42), 42);
  assert.equal(saneMs(NaN, 42), 42);
  assert.equal(saneMs(Infinity, 42), 42);
  assert.equal(saneMs('nope', 42), 42);
  assert.equal(saneMs(999 * 3600 * 1000, 42), 42); // absurdly long
});

test('sanePiece: rebuilds known fields and drops anything else the sender attached', () => {
  const p = sanePiece({ t: 'Q', c: 'w', pts: 3, moved: 1, amazon: 'yes', evil: () => 1, __proto__: { x: 1 } });
  assert.deepEqual(p, { t: 'Q', c: 'w', pts: 3, moved: true, amazon: true });
  assert.equal(p.evil, undefined);

  assert.equal(sanePiece({ t: 'X', c: 'w' }), null);      // not a piece type
  assert.equal(sanePiece({ t: 'Q', c: 'green' }), null);  // not a colour
  assert.equal(sanePiece('Q'), null);
  assert.equal(sanePiece(null), null);
  assert.equal(sanePiece({ t: 'Q', c: 'w', pts: 1e9 }).pts, 99); // clamped
  assert.equal(sanePiece({ t: 'Q', c: 'w', pts: 'x' }).pts, 0);
});

test('saneBoard: accepts a real position and rebuilds it as a fresh 8x8', () => {
  const b = standardish();
  b[6][0] = newPiece('P', 'w');
  const out = saneBoard(b);
  assert.ok(out);
  assert.equal(out.length, 8);
  assert.ok(out.every(row => row.length === 8));
  assert.deepEqual(out[7][4], { t: 'K', c: 'w', pts: 0, moved: false, amazon: false });
  assert.notEqual(out[7][4], b[7][4]); // a copy, not the sender's object
});

test('saneBoard: rejects wrong shapes, bad pieces, and illegal king counts', () => {
  assert.equal(saneBoard(null), null);
  assert.equal(saneBoard('rnbqkbnr/...'), null);
  assert.equal(saneBoard([]), null);
  assert.equal(saneBoard(Array.from({ length: 8 }, () => Array(7).fill(null))), null); // jagged
  assert.equal(saneBoard(emptyBoard()), null);                                          // no kings

  const twoKings = standardish();
  twoKings[3][3] = newPiece('K', 'w');
  assert.equal(saneBoard(twoKings), null);

  const badPiece = standardish();
  badPiece[4][4] = { t: 'DRAGON', c: 'w' };
  assert.equal(saneBoard(badPiece), null);
});

test('saneClockConfig: substitutes defaults rather than passing junk through', () => {
  const c = saneClockConfig({ time: { w: -5, b: 1000 }, inc: { w: 'x' }, mode: 'weird', thresholdMs: -1 });
  assert.equal(c.time.w, 300000); // fallback
  assert.equal(c.time.b, 1000);
  assert.equal(c.inc.w, 0);
  assert.equal(c.mode, 'fischer'); // unknown mode is not preserved
  assert.equal(c.thresholdMs, 0);
  assert.equal(saneClockConfig(null), null);
});

test('saneOnlineConfig: accepts a well-formed host config and derives the host colour', () => {
  const cfg = saneOnlineConfig({
    seed: 99, board: standardish(), sideToMove: 'w', guestColor: 'b',
    evolutionOn: true, gambleOn: false, clock: { on: false }
  });
  assert.ok(cfg);
  assert.equal(cfg.hostColor, 'w');
  assert.equal(cfg.guestColor, 'b');
  assert.equal(cfg.evolutionOn, true);
  assert.equal(cfg.gambleOn, false);
  assert.equal(cfg.clock.on, false);
});

test('saneOnlineConfig: refuses configs a hostile or broken host could send', () => {
  const ok = { seed: 1, board: standardish(), sideToMove: 'w', guestColor: 'b', clock: { on: false } };
  assert.equal(saneOnlineConfig(null), null);
  assert.equal(saneOnlineConfig('hello'), null);
  assert.equal(saneOnlineConfig(Object.assign({}, ok, { board: undefined })), null);
  assert.equal(saneOnlineConfig(Object.assign({}, ok, { guestColor: 'x' })), null);
  assert.equal(saneOnlineConfig(Object.assign({}, ok, { sideToMove: 'x' })), null);
  assert.equal(saneOnlineConfig(Object.assign({}, ok, { seed: 'abc' })).seed, 0);
});

// ---------- Replayed modal answers ----------

test('pickOffered: a replayed choice must be one the reducer offered', () => {
  assert.equal(pickOffered(['Q', 'R', 'B', 'N'], 'R'), 'R');
  assert.equal(pickOffered(['Q', 'R', 'B', 'N'], 'K'), 'Q');    // a second king, refused
  assert.equal(pickOffered(['Q', 'R', 'B', 'N'], 'AMAZON'), 'Q');
  assert.equal(pickOffered(['Q', 'R', 'B', 'N'], undefined), 'Q'); // truncated choices list
  assert.equal(pickOffered(['Q', 'R', 'B', 'N'], { toString: () => 'R' }), 'Q');
});
