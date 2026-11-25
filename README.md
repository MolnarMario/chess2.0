<h1 align="center">Chess 2.0</h1>

<p align="center">
  <b>Chess with an RPG layer.</b><br>
  Pieces earn points by capturing and evolve when they have enough: a pawn
  becomes a knight or bishop, a rook becomes a queen, and a queen becomes an
  Amazon. The king never changes. Play a friend, online or on one screen, or
  the computer.
</p>

<p align="center">
  <a href="https://chess.thebarbellengineer.com/"><b>Play it now</b></a> ·
  <a href="https://thebarbellengineer.com/projects/chess-2/">Project page</a> ·
  <a href="#how-to-play">How to play</a> ·
  <a href="LICENSE">MIT license</a>
</p>

<p align="center">
  <img src="https://thebarbellengineer.com/assets/img/chess-1600.webp" alt="A Chess 2.0 game in progress" width="720">
</p>

## Why

Regular chess has fixed pieces: a knight is a knight from move one to the
end. Chess 2.0 adds one idea from role-playing games, that the pieces doing
the work should get stronger. Every capture gives the capturing piece points,
and points turn into an evolution. A pawn that keeps winning trades can end
the game as a rook. It is still chess underneath, with check, castling, en
passant and promotion, and it all runs in one HTML file with nothing to
install.

## What it does

### Pieces that grow

- **Captures earn points** for the piece that made them: 1 for a pawn, 3 for
  a knight or bishop, 5 for a rook, 10 for a queen. You can change these
  values before a game.
- **Evolution spends them.** A pawn with 2 points becomes a knight or bishop
  (your choice), those become a rook at 6, a rook becomes a queen at 10, and a
  queen with 20 becomes an **Amazon**, which also moves like a knight.
- **Gambling mode** (optional). Any capture can become a 50/50 roll that
  doubles the points or destroys your piece. Turn it on from move 1, or only
  once a clock falls under a time you choose.

### Play anyone

- **A friend on the same screen**, taking turns.
- **The computer**, at Easy, Medium or Hard.
- **A friend online.** One player hosts and gets a room code, the other joins
  with it. The connection is peer to peer, a dropped game can be resumed with
  **Reconnect**, and **Rematch** starts the next one. Only the host can change
  a rule mid-game, and the guest has to agree first.

### Set the game up your way

- **Clocks** from bullet (1+0) to classical (30+20), with increment.
- **Starting positions:** the standard one, a random Chess960 position, or an
  empty board you fill yourself in the board editor.
- **Three looks:** Classic, Arcade and Swiss.
- **Undo, resign and a move log** with every evolution and gamble in it.

## How to play

1. Open **https://chess.thebarbellengineer.com/** in any modern browser, on
   a computer or a phone.
2. Pick **2 Players**, **vs AI**, or **🌐 Play Online**.
3. Optionally open **⚙ Board Setup** for a Chess960 or custom position,
   **⏱ Clock** for a time control, and the toggles for evolution and gambling.
4. Press **▶ Start Game**. Move by clicking a piece and then its square. When
   a piece has enough points it evolves, and a pawn asks you to choose.

**Playing online:** the host clicks **Host a Game** and sends the room code;
the other player clicks **Join a Game** and enters it. Both browsers connect
directly over WebRTC.

To play offline, download this repository and open `index.html`. Everything
except online play works from the file.

## How it works

- **One page, no build.** `index.html` holds the board, the dialogs, the AI
  and the online code. There are no dependencies to install.
- **A rules engine with no page attached.** `game-core.js` has no DOM, timers
  or network code. A move walks through capture, gamble, promotion and
  evolution as a generator that pauses wherever a player has to decide, so
  the same engine drives local games, online games and the tests.
- **Online play sends moves, not results.** `net-protocol.js` defines the
  messages. Each side sends only the move, checks it against its own legal
  moves, replays it and compares a position hash after every move, so neither
  player can push a made-up board at the other.
- **Dice nobody controls.** Gamble rolls come from a seed both players
  contribute when they connect, so both boards roll the same result and
  neither side reports its own outcome.
- **PeerJS is vendored**, pinned and hash-checked in `vendor/`, and loaded
  only when someone opens the online dialog. See
  [vendor/README.md](vendor/README.md).

## Development

```sh
node --test "test/*.test.js"
```

Three suites, no dependencies: the rules engine (`game-core.test.js`), the
network protocol (`net-protocol.test.js`) and replaying a game from its moves
(`net-replay.test.js`). For the page itself, open `index.html` or serve the
folder with any static server.

The live site is GitHub Pages from `master`, on the domain in `CNAME`.

## License

[MIT](LICENSE). Built by Mario Molnar.
