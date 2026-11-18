# What my music looks like

My recent listening as a map of what I play after what. Each album is a circle showing its cover; the circle's area grows with the number of plays. An arrow goes from each album to the next one I played. A transition I repeat gets a thicker arrow, old transitions fade, and an arrow is dashed when a pause of 30 minutes or more separates the two plays (a new listening session). The album playing now has a pulsing green ring, and the very last arrow is green.

Hover over a circle, or tap it on a phone, to keep only its arrows and see under the graph where I usually come from and go to after that album.

The data comes from Last.fm (`user.getRecentTracks`, the last 200 plays), fed by a scrobbler on my phone. The covers come from the Deezer API, which has better covers than Last.fm. Last.fm's own image is used when Deezer finds nothing.

## How the graph is built (`static/app.js`)

1. **Model:** the plays are put in time order. Each album becomes a node. When two plays in a row are from different albums, the arrow between them gets +1. Plays of the same album in a row only make its circle bigger.
2. **Layout:** a small force simulation written by hand (no library, since the page only loads files from my server). Every pair of circles pushes apart, every arrow pulls its two circles together, and a weak pull keeps everything near the centre. The forces fade over 300 steps so the layout settles. Positions are kept between refreshes: when no new album has appeared, the layout doesn't run again, so nothing jumps.
3. **Drawing:** SVG. Arrows are curves bent to one side, so A→B and B→A don't overlap. Covers are clipped to circles. Track names are inserted as text, never as HTML.

## Start

```sh
cp .env.example .env    # then put your Last.fm API key and user name in .env
docker compose up
```

Open http://localhost:8081. On a phone on the same Wi-Fi, open `http://<laptop IP>:8081`.

Without a `.env` file the app still starts. The page then explains that the key is missing.

## How it works

```
browser ──> this server (Flask, port 8081) ──> Last.fm  (recent tracks, cached 60 s)
                                            └─> Deezer  (cover per track, remembered forever)
```

| Route | What it does |
|---|---|
| `/` | The page (`static/`). Plain HTML, CSS and JavaScript, no external files. |
| `/api/recent` | Recent tracks from Last.fm, with a Deezer cover added to each track. |
| `/media?url=…` | Fetches a cover for the browser. Only Last.fm and Deezer image hosts are accepted, so it can't be used to fetch anything else. |

## The rules, and where each one is met

| Rule | How |
|---|---|
| The browser talks only to my server | The page calls `/api/recent`. Covers go through `/media`, so not even an image is loaded from Last.fm or Deezer. |
| The key stays on the server | It is read from the `LASTFM_API_KEY` environment variable (`app.py`, top of the file). `.env` is in `.gitignore` and `.dockerignore`. Errors are logged without the request URL, because the URL contains the key. |
| Cache | One Last.fm answer is kept for 60 s and shared by every visitor. A lock means visitors arriving at the same moment still cause only one call. Each call prints `[lastfm] calling …` in `docker compose logs`, so the calls can be counted. |
| Last.fm fails | If an earlier answer exists, the page shows it with a warning saying what time the data is from. Otherwise it shows a message. After a failure the server waits 60 s before trying again, so an outage doesn't cause a flood of retries. |
| Phone and laptop | The SVG fills the width. On a phone the canvas is tall; on a laptop it fits the screen. The layout only re-runs when the width changes. |
| `docker compose up` | One service, built from the `Dockerfile`. |

## Checking the "Done when" list

- **No request to Last.fm:** DevTools > Network, reload. Every request goes to `localhost:8081`.
- **Two reloads = one call:** `docker compose logs -f`, then reload twice. One `[lastfm] calling` line appears.
- **Last.fm unreachable:** start without network, or set a wrong user in `.env`. The page shows a message.
- **Key not on GitHub:** `git log -p | grep -i <your key>` finds nothing.

## Deploy: https://student04.wt.thomasjuldo.com/music/

The server already runs the visit-counter project. Its Caddy owns ports 80/443 and the HTTPS certificate, and it also serves this app under `/music/`. This app has no Caddy of its own and opens no port: it joins the shared `proxy` network under the name `music`.

```
internet ──> Caddy (visit-counter) ── /music/* ──> this app   (network "proxy", name "music", port 8081)
                                   └─ /api/*, / ─> visit counter
```

Caddy removes `/music` before passing a request on, so the app still sees `/`, `/api/recent` and `/media`. The page uses relative URLs only (`api/recent`, `media?url=…`), so the same code works at `/` locally and at `/music/` on the server.

On the server:

```sh
# 1. visit-counter first: it creates the "proxy" network and has the /music route
cd visit-counter && git pull
docker compose -f compose.yaml -f compose.server.yaml up -d --force-recreate caddy
#    (--force-recreate: a running Caddy keeps the old Caddyfile after git pull replaces the file)

# 2. this app
git clone https://github.com/alex-crr/what-my-music-looks-like.git && cd what-my-music-looks-like
cp .env.example .env && nano .env    # the key lives only in this file, on the server
docker compose -f compose.yaml -f compose.server.yaml up -d --build
```

Then open https://student04.wt.thomasjuldo.com/music/. After a change: `git pull`, then the same `up -d --build`. Logs: `docker compose logs -f web`.

## Self-check

```sh
pip install flask requests
python test_app.py
```

It checks the assignment's "Done when" list item by item, with Last.fm, Deezer and the image hosts replaced by fakes, so it needs no network and no key. When a `.env` and a git repository exist, it also checks that the key is in no other file and in no commit. It ends with the checks that need a browser or Docker, to do by hand.

## Files

| File | Role |
|---|---|
| `app.py` | The whole server |
| `static/index.html`, `style.css`, `app.js` | The page |
| `Dockerfile`, `compose.yaml` | Build and start |
| `compose.server.yaml` | Server additions: no open port, joins the shared `proxy` network |
| `.env.example` | The two variables to set |
| `test_app.py` | Self-check |
