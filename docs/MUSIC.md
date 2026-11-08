# Music: Spotify

Sara can search Spotify, tell you what you're listening to, read your playlists and your most-played
music, and, if you allow it, make playlists and control playback. She talks to Spotify's official Web
API through a small Spotify developer app that **you** own. Nothing goes through anyone else's server.

> **Spotify Premium:** since March 2026 Spotify only runs developer apps ("Development Mode") for app
> owners with an active Spotify Premium subscription. Making the app is free; without Premium the app
> stops answering until Premium is back. Playback control also needs Premium.

## Set it up (about 5 minutes, once)

1. Open **Settings → Connections → Spotify** in Sara. It shows the *redirect address* to copy.
2. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard), sign in and press
   **Create app** (any name, e.g. "Sara").
3. Under **Redirect URIs** paste the address Sara showed, e.g. `https://sara.example.com/api/spotify/callback`.
   Spotify only accepts `https://` addresses here, or `http://127.0.0.1:<port>` on the same computer
   (not `localhost`). If you reach Sara over plain http on your network, open her https address first
   (Tailscale Serve, your own domain) and set it up from there; the page warns you when the address
   won't be accepted.
4. Tick **Web API**, accept the terms and press **Save**.
5. Open the app's **Settings**, copy the **Client ID** into Sara and press **Save**. There is no
   secret: Sara signs in with Authorization Code + PKCE.
6. Choose what she may do (below), then press **Connect Spotify** and allow access.

## What she may do

| Always (runs on its own) | *Let her make and change playlists* | *Let her control playback* |
| --- | --- | --- |
| Search songs, albums, artists, playlists (`spotify_search`) · what's playing (`spotify_now_playing`) · your playlists (`spotify_my_playlists`) · most-played songs and artists (`spotify_top`) · your devices (`spotify_devices`) | Make a private playlist (`spotify_playlist_create`) · add songs to one of yours (`spotify_playlist_add`). **Each change asks you first.** | Play, pause, next, previous, volume, shuffle, queue on a device you choose (`spotify_playback`). Low risk and undoable, so it runs without a card, and only when you ask for music. |

Each tick adds its Spotify permission at the next sign-in: after ticking one, press **Connect again**
(the page reminds you). Unticking takes effect at once. The read-only sign-in asks Spotify only for:
currently playing, playback state, recently played, top items, private and collaborative playlists.

She never starts music on her own. Ask "what am I listening to?", "find me something calm for
reading", "queue Clair de Lune" or "make a playlist of the songs we talked about". If Spotify answers
that an action needs Premium, she says so plainly. If no device is open, she asks you to open Spotify
on a phone, computer or speaker.

Every Spotify tool can be set to *Allowed*, *Ask me first* or *Off* in **Settings → Coding → Tools**
(group *Music*).

## Disconnect

**Disconnect Spotify** makes Sara forget the sign-in (the tokens are deleted from her vault). Spotify
has no "sign out this app" call, so to take away access on Spotify's side too, open
[spotify.com/account/apps](https://www.spotify.com/account/apps/) and remove the app. **Remove the
Spotify app** also forgets the Client ID.

## Privacy

Sara sends your Spotify requests (searches, playlist names, songs to add, player commands) straight to
`accounts.spotify.com` and `api.spotify.com` from your server. Tokens are kept in the encrypted vault.
Names that come back from Spotify are treated as information, never as instructions. Household members
and the demo don't get Spotify.
