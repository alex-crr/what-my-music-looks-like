# What my music looks like

My recent listening as a graph in the style of Obsidian's graph view: albums are circles showing their cover, sized against my most played album (played once: a small dot), linked to the album I played next. Groups of albums I play together, the **kernels**, get a colour and gather in their own faintly tinted area. My ten most played albums show in full colour and drift slightly; a fine white line follows my latest listening up to the album playing now (green ring that ripples). The header gives the totals. The footer card shows what is playing now (pulsing green while a track plays) until you hover or tap an album.

Drag a circle, scroll or pinch to zoom, drag the background to move, **Fit** to see everything again. Hover or tap a circle to keep only its lines and swap the footer card to that album, what I usually play before it and after it, and a link to Deezer. The **i** at the bottom explains how to read the graph.

The data comes from Last.fm (`user.getRecentTracks`, the last 200 plays), fed by a scrobbler on my phone, with my Deezer listening history underneath when it is there (see below). The covers come from the Deezer API, which has better covers than Last.fm. Last.fm's own image is used when Deezer finds nothing.

## How the graph is built (`static/app.js`)

1. **Model.** Plays in time order. Each album is a node. Two plays in a row from different albums add a line between them. A line's **weight** grows by 1 each time it happens inside a listening session, and only by 0.2 when a pause of 30 min or more separates the two plays, because a jump after a pause says little about what goes together.
2. **Kernels.** The weights go to **Louvain** community detection (Blondel et al., 2008, the method Gephi uses): each album moves into the neighbouring group that most raises *modularity* (weight inside groups compared with what random lines would give), then each group becomes one node and it starts again, until nothing moves. Groups of 2 albums or more are kernels.
3. **Layout.** A small force simulation, written by hand since the page only loads files from my server: every pair of circles pushes apart, every line is a spring that pulls harder when its weight is higher, each kernel pulls its albums toward its centre, and a pull toward the middle keeps the whole in a box shaped like the frame, so the layout comes out wide on a laptop and tall on a phone and fills the frame, with circles as big as possible. Each kernel starts in its own part of the frame, and circles may pass through each other until the layout calms down, so no album gets trapped inside another kernel. Most of the layout is worked out before it is drawn, so the graph appears nearly in place and only settles for a moment. Positions are kept between refreshes, so the graph only moves when a new album appears.
4. **Drawing.** SVG. Each kernel's area is a soft radial gradient behind its albums; lines take their kernel's colour, and a line between two kernels fades from one colour to the other. Lines and the 1 px rings keep the same thickness at every zoom. Names are not drawn on the graph: they show in the card when a circle is hovered or tapped. The page only redraws when an answer from the server differs from the last one. Track names are inserted as text, never as HTML.

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
| `/media?url=…` | Fetches a cover for the browser. It only accepts cover URLs that `/api/recent` itself handed out, so it can't be used to fetch anything else, and it keeps working when Last.fm changes its image host. |

## The rules, and where each one is met

| Rule | How |
|---|---|
| The browser talks only to my server | The page calls `/api/recent`. Covers go through `/media`, so not even an image is loaded from Last.fm or Deezer. |
| The key stays on the server | It is read from the `LASTFM_API_KEY` environment variable (`app.py`, top of the file). `.env` is in `.gitignore` and `.dockerignore`. Errors are logged without the request URL, because the URL contains the key. |
| Cache | One Last.fm answer is kept for 60 s and shared by every visitor. A lock means visitors arriving at the same moment still cause only one call. When the 60 s are over, the visitor gets the last answer at once and the server asks Last.fm in the background; the page asks again a few seconds later. Only the very first visit after a start waits for Last.fm. Each call prints `[lastfm] calling …` in `docker compose logs`, so the calls can be counted. |
| Last.fm fails | If an earlier answer exists, the page shows it with a warning saying what time the data is from. Covers Deezer hasn't given yet are filled in as they arrive: the server says how many are missing and the page asks again a few seconds later. Otherwise it shows a message. After a failure the server waits 60 s before trying again, so an outage doesn't cause a flood of retries. |
| Phone and laptop | The SVG fills the width. On a phone the canvas is tall; on a laptop it fits the screen. The layout only re-runs when the width changes. |
| `docker compose up` | One service, built from the `Dockerfile`. |

## Checking the "Done when" list

- **No request to Last.fm:** DevTools > Network, reload. Every request goes to `localhost:8081`.
- **Two reloads = one call:** `docker compose logs -f`, then reload twice. One `[lastfm] calling` line appears.
- **Last.fm unreachable:** start without network, or set a wrong user in `.env`. The page shows a message.
- **Key not on GitHub:** `git log -p | grep -i <your key>` finds nothing.

## Deezer history (optional)

Last.fm only knows what was scrobbled since I installed the scrobbler. Deezer's personal-data export (account settings > Personal data) holds every play since 2021. The server can add it under Last.fm:

```sh
pip install openpyxl
python import_deezer.py path/to/deezer-data.xlsx     # writes data/deezer_history.csv
```

- **Only what the graph needs** is kept: start time (UTC), title, artist, album, ISRC. The export's email, birth date, device and the IP address of every play are left out. Plays under 30 s are skipped, as Last.fm does.
- **No play counted twice**: the history is used up to the first play Last.fm knows; Last.fm takes over from there.
- **Last 30 days, 120 most played albums**, plus the albums of the latest plays, so what is playing now is always there. Change with `HISTORY_DAYS` and `TOP_ALBUMS` in `.env`.
- **Sessions** are counted on the full sequence, before any album is left out, so a hidden album between two shown ones doesn't fake a pause.
- **Covers** come from Deezer by ISRC (an exact match). Deezer allows about 50 calls per 5 s, so the server spaces its calls; after a restart, all covers are there within about 15 s.
- `data/` and `*.xlsx` are in `.gitignore` and `.dockerignore`: the history never goes to GitHub or into the image. `compose.yaml` mounts `data/` read-only. Without it, the app uses Last.fm alone.

On the server, copy the file next to the app and restart it (the history is read at start):

```sh
scp data/deezer_history.csv root@student04.wt.thomasjuldo.com:~/what-my-music-looks-like/data/
docker compose -f compose.yaml -f compose.server.yaml up -d --build
```

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
| `import_deezer.py` | Deezer export (.xlsx) to `data/deezer_history.csv` |
| `test_app.py` | Self-check |
