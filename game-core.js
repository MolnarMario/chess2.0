// Chess 2.0 — pure rules engine.
//
// No DOM, no timers, no network, no globals: every function here takes the
// state it needs and returns/yields data. Loaded in the browser via
// <script src="game-core.js"> (attaches `window.GameCore`) and in tests via
// require('./game-core.js').
//
// applyMove() is a generator: it walks a move through capture → gamble →
// promotion → evolution and *yields* at every point that used to reach into
// the DOM (a decision to ask, a render checkpoint, a log-worthy event). The
// caller drives it with gen.next(answer) — synchronously for an AI's instant
// answer, or after an async modal / animation for a human's.
(function (root) {
  'use strict';

  const VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 10, K: 0 };
  const THRESH = { P: 2, N: 6, B: 6, R: 10, Q: 20 };
  const NAMES = { P: 'Pawn', N: 'Knight', B: 'Bishop', R: 'Rook', Q: 'Queen', K: 'King' };
  const GAMBLE_WIN = 0.5; // probability a gamble pays off
  const FILES = 'abcdefgh';

  const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const sqName = (r, c) => FILES[c] + (8 - r);
  const enemy = c => (c === 'w' ? 'b' : 'w');

  function cloneBoard(b) {
    return b.map(row => row.map(p => (p ? { ...p } : null)));
  }

  function newPiece(t, c) {
    return { t, c, pts: 0, moved: false, amazon: false };
  }

  function findKing(b, color) {
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (b[r][c] && b[r][c].t === 'K' && b[r][c].c === color) return { r, c };
    return null;
  }

  // ---------- Attack detection ----------
  const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const ROOK_D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const BISHOP_D = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const KING_D = ROOK_D.concat(BISHOP_D);

  function isAttacked(b, r, c, byColor) {
    const dir = byColor === 'w' ? 1 : -1; // attacker sits dir rows "below" target from its own perspective
    for (const dc of [-1, 1]) {
      const pr = r + dir, pc = c + dc;
      if (inB(pr, pc)) {
        const p = b[pr][pc];
        if (p && p.c === byColor && p.t === 'P') return true;
      }
    }
    for (const [dr, dc] of KNIGHT_D) {
      const nr = r + dr, nc = c + dc;
      if (inB(nr, nc)) {
        const p = b[nr][nc];
        if (p && p.c === byColor && (p.t === 'N' || (p.t === 'Q' && p.amazon))) return true;
      }
    }
    for (const [dr, dc] of ROOK_D) {
      let nr = r + dr, nc = c + dc;
      while (inB(nr, nc)) {
        const p = b[nr][nc];
        if (p) {
          if (p.c === byColor && (p.t === 'R' || p.t === 'Q')) return true;
          break;
        }
        nr += dr; nc += dc;
      }
    }
    for (const [dr, dc] of BISHOP_D) {
      let nr = r + dr, nc = c + dc;
      while (inB(nr, nc)) {
        const p = b[nr][nc];
        if (p) {
          if (p.c === byColor && (p.t === 'B' || p.t === 'Q')) return true;
          break;
        }
        nr += dr; nc += dc;
      }
    }
    for (const [dr, dc] of KING_D) {
      const nr = r + dr, nc = c + dc;
      if (inB(nr, nc)) {
        const p = b[nr][nc];
        if (p && p.c === byColor && p.t === 'K') return true;
      }
    }
    return false;
  }

  function inCheck(b, color) {
    const k = findKing(b, color);
    return k ? isAttacked(b, k.r, k.c, enemy(color)) : false;
  }

  // ---------- Move generation ----------
  function pseudoMoves(b, r, c, epSq) {
    const p = b[r][c];
    if (!p) return [];
    const moves = [];
    const add = (nr, nc, extra) => moves.push(Object.assign({ from: { r, c }, to: { r: nr, c: nc } }, extra || {}));

    const slide = dirs => {
      for (const [dr, dc] of dirs) {
        let nr = r + dr, nc = c + dc;
        while (inB(nr, nc)) {
          const q = b[nr][nc];
          if (!q) add(nr, nc);
          else { if (q.c !== p.c) add(nr, nc); break; }
          nr += dr; nc += dc;
        }
      }
    };
    const jump = dirs => {
      for (const [dr, dc] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (inB(nr, nc) && (!b[nr][nc] || b[nr][nc].c !== p.c)) add(nr, nc);
      }
    };

    switch (p.t) {
      case 'P': {
        const dir = p.c === 'w' ? -1 : 1;
        const startRow = p.c === 'w' ? 6 : 1;
        if (inB(r + dir, c) && !b[r + dir][c]) {
          add(r + dir, c);
          if (r === startRow && !b[r + 2 * dir][c]) add(r + 2 * dir, c, { double: true });
        }
        for (const dc of [-1, 1]) {
          const nr = r + dir, nc = c + dc;
          if (!inB(nr, nc)) continue;
          const q = b[nr][nc];
          if (q && q.c !== p.c) add(nr, nc);
          else if (!q && epSq && epSq.r === nr && epSq.c === nc) add(nr, nc, { ep: true });
        }
        break;
      }
      case 'N': jump(KNIGHT_D); break;
      case 'B': slide(BISHOP_D); break;
      case 'R': slide(ROOK_D); break;
      case 'Q':
        slide(KING_D);
        if (p.amazon) jump(KNIGHT_D);
        break;
      case 'K': {
        jump(KING_D);
        if (!p.moved && !isAttacked(b, r, c, enemy(p.c))) {
          const rk = b[r][7];
          if (rk && rk.t === 'R' && rk.c === p.c && !rk.moved &&
              !b[r][5] && !b[r][6] &&
              !isAttacked(b, r, 5, enemy(p.c)) && !isAttacked(b, r, 6, enemy(p.c))) {
            add(r, 6, { castle: 'k' });
          }
          const rq = b[r][0];
          if (rq && rq.t === 'R' && rq.c === p.c && !rq.moved &&
              !b[r][1] && !b[r][2] && !b[r][3] &&
              !isAttacked(b, r, 3, enemy(p.c)) && !isAttacked(b, r, 2, enemy(p.c))) {
            add(r, 2, { castle: 'q' });
          }
        }
        break;
      }
    }
    return moves;
  }

  function applyMoveToBoard(b, m) {
    // mutates b; no evolution / promotion choice here (used for legality sim too)
    const p = b[m.from.r][m.from.c];
    b[m.to.r][m.to.c] = p;
    b[m.from.r][m.from.c] = null;
    if (m.ep) b[m.from.r][m.to.c] = null;
    if (m.castle === 'k') { b[m.to.r][5] = b[m.to.r][7]; b[m.to.r][7] = null; }
    if (m.castle === 'q') { b[m.to.r][3] = b[m.to.r][0]; b[m.to.r][0] = null; }
  }

  function legalMoves(b, r, c, epSq) {
    const p = b[r][c];
    if (!p) return [];
    return pseudoMoves(b, r, c, epSq).filter(m => {
      const sim = cloneBoard(b);
      applyMoveToBoard(sim, m);
      return !inCheck(sim, p.c);
    });
  }

  function allLegalMoves(b, color, epSq) {
    const out = [];
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (b[r][c] && b[r][c].c === color)
          out.push(...legalMoves(b, r, c, epSq));
    return out;
  }

  // ---------- Evolution ----------
  // Where a piece's evolution chain goes next, or null if it isn't eligible
  // (maxed Amazon, King, or under the point threshold). Shared by the real
  // move flow below and by the AI search's cheaper autoEvolve() in index.html
  // — the two used to hand-walk the same THRESH chain independently.
  function nextEvolutionStage(piece, thresh) {
    if (!piece || piece.t === 'K') return null;
    if (piece.t === 'Q' && piece.amazon) return null;
    const need = thresh[piece.t];
    if (piece.pts < need) return null;
    if (piece.t === 'P') return { cost: need, choice: true, options: ['N', 'B'] };
    if (piece.t === 'N' || piece.t === 'B') return { cost: need, choice: false, to: 'R' };
    if (piece.t === 'R') return { cost: need, choice: false, to: 'Q' };
    if (piece.t === 'Q') return { cost: need, choice: false, amazon: true };
    return null;
  }

  // would removing the capturing piece (a lost gamble) leave the mover's own King in check?
  function gambleExposesKing(board, move, moverColor) {
    const sim = cloneBoard(board);
    sim[move.to.r][move.to.c] = null;
    return inCheck(sim, moverColor);
  }

  // ---------- Move application ----------
  //
  // core: { board, turn, ep, moveNum, halfmoveClock, captured }
  // move: a move from legalMoves()
  // rules: { evolutionOn, gambleOn, gambleWin, rng } — all optional
  //
  // Yields (the caller resumes with gen.next(answer) — no answer needed
  // unless noted):
  //   { type: 'moved', board, move, capturedPiece }
  //   { type: 'gamble', square, color, piece:{t,pts}, capturedType, base, board }        → resume(true|false)
  //   { type: 'gambleRolled', win, base, board }
  //   { type: 'captureBanked', square, piece, capturedType, pts, gambled, board }
  //   { type: 'captureBust', square, piece, capturedType, board }
  //   { type: 'promotion', square, color, options, board }                                → resume(pieceType)
  //   { type: 'promoted', square, color, choice, board }
  //   { type: 'evolutionChoice', square, color, options, board }                          → resume(pieceType)
  //   { type: 'evolved', square, color, from, to, board }
  //
  // Returns the new core: { board, turn, ep, moveNum, halfmoveClock, captured, lastMove }
  function* applyMove(core, move, rules) {
    rules = Object.assign({ evolutionOn: true, gambleOn: true, gambleWin: GAMBLE_WIN, rng: Math.random }, rules);

    const board = cloneBoard(core.board);
    const p = board[move.from.r][move.from.c];
    const moverColor = p.c;
    const capturedPiece = move.ep ? board[move.from.r][move.to.c] : board[move.to.r][move.to.c];
    const wasPawnMove = p.t === 'P';

    applyMoveToBoard(board, move);
    p.moved = true;

    const nextEp = move.double ? { r: (move.from.r + move.to.r) / 2, c: move.from.c } : null;
    const nextHalfmove = (wasPawnMove || capturedPiece) ? 0 : core.halfmoveClock + 1;
    const nextMoveNum = core.turn === 'b' ? core.moveNum + 1 : core.moveNum;

    yield { type: 'moved', board, move, capturedPiece };

    const captured = { w: core.captured.w, b: core.captured.b };

    function* evolve(square) {
      for (;;) {
        const piece = board[square.r][square.c];
        const stage = rules.evolutionOn ? nextEvolutionStage(piece, THRESH) : null;
        if (!stage) return;
        const fromType = piece.t;
        let toType;
        if (stage.choice) {
          toType = yield { type: 'evolutionChoice', square, color: piece.c, options: stage.options, board };
          piece.pts -= stage.cost;
          piece.t = toType;
        } else if (stage.amazon) {
          piece.pts -= stage.cost;
          piece.amazon = true;
          toType = 'AMAZON';
        } else {
          piece.pts -= stage.cost;
          piece.t = stage.to;
          toType = stage.to;
        }
        yield { type: 'evolved', square, color: piece.c, from: fromType, to: toType, board };
      }
    }

    let bustedCapture = false;
    if (capturedPiece) {
      const base = VALUES[capturedPiece.t];
      const maxed = p.t === 'Q' && p.amazon;
      const canGamble = rules.gambleOn && p.t !== 'K' && !maxed && !gambleExposesKing(board, move, moverColor);

      let bank = base;
      let gambled = null;
      if (canGamble) {
        const wantsGamble = yield {
          type: 'gamble', square: move.to, color: moverColor,
          piece: { t: p.t, pts: p.pts }, capturedType: capturedPiece.t, base, board
        };
        if (wantsGamble) {
          const win = rules.rng() < rules.gambleWin;
          gambled = win ? 'win' : 'bust';
          yield { type: 'gambleRolled', win, base, board };
          bank = win ? base * 2 : 0;
        }
      }

      if (gambled === 'bust') {
        board[move.to.r][move.to.c] = null; // capturing piece is lost
        bustedCapture = true;
        yield { type: 'captureBust', square: move.to, piece: { t: p.t }, capturedType: capturedPiece.t, board };
      } else {
        p.pts += bank;
        captured[moverColor] += bank;
        yield { type: 'captureBanked', square: move.to, piece: { t: p.t }, capturedType: capturedPiece.t, pts: bank, gambled, board };
      }
    }

    // promotion + evolution — skipped if the capturing piece was busted away
    if (!bustedCapture) {
      const lastRank = moverColor === 'w' ? 0 : 7;
      if (p.t === 'P' && move.to.r === lastRank) {
        const choice = yield { type: 'promotion', square: move.to, color: moverColor, options: ['Q', 'R', 'B', 'N'], board };
        p.t = choice;
        yield { type: 'promoted', square: move.to, color: moverColor, choice, board };
      }
      yield* evolve(move.to);
    }

    return {
      board,
      turn: enemy(core.turn),
      ep: nextEp,
      moveNum: nextMoveNum,
      halfmoveClock: nextHalfmove,
      captured,
      lastMove: Object.assign({}, move, { captured: !!capturedPiece })
    };
  }

  const GameCore = {
    VALUES, THRESH, NAMES, GAMBLE_WIN, FILES,
    inB, sqName, enemy, newPiece,
    cloneBoard, findKing, isAttacked, inCheck,
    pseudoMoves, applyMoveToBoard, legalMoves, allLegalMoves,
    nextEvolutionStage, gambleExposesKing, applyMove
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = GameCore;
  else root.GameCore = GameCore;
})(typeof window !== 'undefined' ? window : globalThis);
