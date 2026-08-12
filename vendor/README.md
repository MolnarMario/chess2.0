# Vendored dependencies

## peerjs-1.5.4.min.js

WebRTC signalling and data channels for online play.

| | |
|---|---|
| Upstream | https://github.com/peers/peerjs |
| Version | 1.5.4 |
| Fetched from | https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js |
| SHA-256 | `ad5d8870d1e389914f9cba8d35be313c4327c69ee0a221e482e9bf7621136fe5` |
| License | MIT |

Verify with:

```sh
sha256sum vendor/peerjs-1.5.4.min.js
# or
curl -sSL https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js | sha256sum
```

### Why it's checked in

This used to be `await import('https://esm.sh/peerjs@1.5.4')` at runtime. A dynamic
import can't carry a Subresource Integrity hash, so whatever that host served became
script running on the page — with the same access to the origin as the game itself.
Pinning the file here means the code is reviewable, diffable, and can't change under us.

Loaded lazily (only when a player opens the online dialog), so it costs nothing for
local games. It sets `window.Peer`; see `ensurePeerJs()` in `index.html`.

### Upgrading

Fetch the new version, record its hash above, and update the filename in
`ensurePeerJs()`. Keep the version in the filename so a stale cached copy can't be
mistaken for the current one.
