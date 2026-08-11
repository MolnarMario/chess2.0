'use strict';
// Wire format for online play, and everything that decides whether a message from the
// peer is worth acting on. Pure functions only — no DOM, no PeerJS, no game state — so
// the checks that stand between a hostile peer and the board can be unit tested.
//
// The rule these all serve: a peer is never trusted with our position. It may tell us
// what it *did* (a move, its modal answers, its own clock); it may never tell us what
// the result *is*. Everything here either rebuilds a value from scratch or rejects it.
(function (root) {

  const NET_PROTO_V = 2;
  const NET_SETTINGS = ['evolutionOn', 'gambleOn', 'clockOn'];
  const PIECE_TYPES = ['P', 'N', 'B', 'R', 'Q', 'K'];
  const MAX_CLOCK_MS = 24 * 3600 * 1000;

  // Deterministic PRNG. Online, both clients seed one of these identically at connect
  // time and draw from it in move order, so a gamble comes out the same on both
  // screens without either side having to be believed about the roll it got.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomUint32() {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0];
  }

  // 8 chars of an unambiguous alphabet (no o/0/l/1) — 40 bits of CSPRNG, and still
  // short enough to read out over a call. The old code used Math.random().toString(36).
  function randomRoomId() {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 chars, so byte % 32 stays uniform
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += alphabet[b % 32];
    return 'chess2-' + s;
  }

  // Accepts what a player is likely to paste — with or without the prefix, any case,
  // surrounding whitespace — and rejects anything that isn't shaped like a room code.
  function normalizeRoomCode(raw) {
    const m = String(raw == null ? '' : raw).trim().toLowerCase()
      .match(/^(?:chess2-)?([a-z0-9]{4,16})$/);
    return m ? 'chess2-' + m[1] : null;
  }

  function isSquareRef(s) {
    return !!s && Number.isInteger(s.r) && Number.isInteger(s.c) &&
           s.r >= 0 && s.r < 8 && s.c >= 0 && s.c < 8;
  }

  function saneMs(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= MAX_CLOCK_MS ? n : fallback;
  }

  // Rebuilt field by field: whatever else the sender attached to the object is dropped
  // rather than spread onto one of our pieces.
  function sanePiece(p) {
    if (!p || typeof p !== 'object') return null;
    if (!PIECE_TYPES.includes(p.t) || (p.c !== 'w' && p.c !== 'b')) return null;
    const pts = Number(p.pts);
    return {
      t: p.t,
      c: p.c,
      pts: Number.isFinite(pts) ? Math.max(0, Math.min(99, Math.trunc(pts))) : 0,
      moved: !!p.moved,
      amazon: !!p.amazon
    };
  }

  // Insists on a real 8x8 grid with exactly one king a side — below that, none of the
  // move generation, check detection or draw logic downstream means anything.
  function saneBoard(b) {
    if (!Array.isArray(b) || b.length !== 8) return null;
    const out = [];
    const kings = { w: 0, b: 0 };
    for (let r = 0; r < 8; r++) {
      if (!Array.isArray(b[r]) || b[r].length !== 8) return null;
      const row = [];
      for (let c = 0; c < 8; c++) {
        if (!b[r][c]) { row.push(null); continue; }
        const p = sanePiece(b[r][c]);
        if (!p) return null;
        if (p.t === 'K') kings[p.c]++;
        row.push(p);
      }
      out.push(row);
    }
    return kings.w === 1 && kings.b === 1 ? out : null;
  }

  function saneClockConfig(c) {
    if (!c || typeof c !== 'object') return null;
    return {
      time: { w: saneMs(c.time && c.time.w, 300000), b: saneMs(c.time && c.time.b, 300000) },
      inc: { w: saneMs(c.inc && c.inc.w, 0), b: saneMs(c.inc && c.inc.b, 0) },
      mode: c.mode === 'delay' ? 'delay' : 'fischer',
      thresholdMs: saneMs(c.thresholdMs, 0)
    };
  }

  // The host's opening config is the one message that legitimately carries a position,
  // so it gets the strictest treatment: rebuilt entirely, or refused entirely.
  function saneOnlineConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    if (cfg.guestColor !== 'w' && cfg.guestColor !== 'b') return null;
    if (cfg.sideToMove !== 'w' && cfg.sideToMove !== 'b') return null;
    const board = saneBoard(cfg.board);
    if (!board) return null;
    const clockOn = !!(cfg.clock && cfg.clock.on);
    return {
      seed: (Number(cfg.seed) || 0) >>> 0,
      board,
      sideToMove: cfg.sideToMove,
      hostColor: cfg.guestColor === 'w' ? 'b' : 'w',
      guestColor: cfg.guestColor,
      evolutionOn: !!cfg.evolutionOn,
      gambleOn: !!cfg.gambleOn,
      clock: clockOn ? Object.assign({ on: true }, saneClockConfig(cfg.clock)) : { on: false }
    };
  }

  // A replayed modal answer still has to be one the reducer actually offered, or the
  // wire could promote a pawn into a second king (or into a piece that wasn't on the
  // menu) on our board while the sender's board shows something else entirely.
  function pickOffered(options, v) {
    return Array.isArray(options) && options.includes(v) ? v : (options && options[0]);
  }

  const NetProtocol = {
    NET_PROTO_V, NET_SETTINGS, PIECE_TYPES,
    mulberry32, randomUint32, randomRoomId, normalizeRoomCode,
    isSquareRef, saneMs, sanePiece, saneBoard,
    saneClockConfig, saneOnlineConfig, pickOffered
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = NetProtocol;
  else root.NetProtocol = NetProtocol;
})(typeof window !== 'undefined' ? window : globalThis);
