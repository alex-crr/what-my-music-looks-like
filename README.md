# What my music looks like

A live map of what I listen to. Each album I played recently is a circle showing its cover. Albums I tend to play one after the other are linked and gather into coloured groups, the album playing right now beats like a heart, and my last 12 albums sway toward each other in the order I played them.

Live: https://student04.wt.thomasjuldo.com/music/

## The idea

Most "my music" pages are rankings: top artists, top albums, a grid of covers. They say what I play most, not how I listen. I wanted to see the *flow*: which albums lead to which, and which ones belong together for me.

The graph is built only from the order I play things in. Every time I go from one album to another in the same listening session, that counts as a small vote that the two go together. Over a month, groups appear by themselves. I call them **kernels**. No genre data is used anywhere: a kernel is "music I play in the same sitting", so it can mix a folk album with a hip-hop one if that's how I listen. The look borrows from Obsidian's graph view, where notes that link to each other cluster together.

Getting the data took a detour. Deezer has no API for listening history, and its built-in Last.fm link didn't work for me on the Family plan. So a scrobbler app on my phone sends every play to Last.fm, and this app reads Last.fm. The Deezer API then adds what Last.fm lacks: good covers, and with Deezer's personal-data export, my history from before the scrobbler existed.

## Reading the graph

- **Circle:** one album, showing its cover. Size grows with plays, from 10 for an album played once to 40 for my most played one.
- **Colour:** the album's kernel. Each kernel sits in its own faintly tinted area. Grey albums belong to no kernel.
- **Line:** two albums I played one after the other, in the same session, more than once. Thicker means more often, fainter means longer ago.
- **Grey line:** two albums from different kernels.
- **Wide grey band:** two kernels I often switch between, wider the more often.
- **Beating circle:** the album playing now. It swells twice, rests, and pushes its neighbours aside.
- **Albums swaying toward each other:** the last 12 albums I played. Each leans toward the one I played next, then lets go, in a wave that runs from the oldest to the newest. Their lines always show, except across a pause of 30 min or more.
- **Full-colour circles:** my ten most played albums; the others are slightly dimmed.

Hover or tap an album to see all its lines, including those that happened only once, with arrows showing which way I went. The card at the bottom then shows the album, its play count, what I usually play before and after it, and a link to Deezer. With nothing selected, the card shows what is playing now. Drag a circle to move it, scroll or pinch to zoom, drag the background to pan, and press **Fit** to see everything again.

## Motion and "reduce motion"

The page respects your system's **reduce motion** setting. When it is on, nothing moves: the album playing now stays still at half its beat size, the last albums don't sway and the card doesn't pulse. Everything else works the same.

If you see no movement at all, that setting is probably on:

- **Windows 11:** Settings > Accessibility > Visual effects > Animation effects. Performance tweaks also turn it off, through "Animate controls and elements inside windows" in "Adjust the appearance and performance of Windows".
- **macOS:** System Settings > Accessibility > Display > Reduce motion.
- **iPhone and iPad:** Settings > Accessibility > Motion > Reduce Motion.
- **Android:** Settings > Accessibility > Remove animations (the wording varies by phone).

## Set it up for yourself

### What you need

- **Docker** with Compose.
- **A Last.fm account that receives your plays.** Many players connect to Last.fm directly. If yours doesn't (Deezer on a Family plan, for example), use a scrobbler: Pano Scrobbler on Android picks up any player on the phone, and the Web Scrobbler browser extension covers web players on a computer.
- **A Last.fm API key.** Create one at https://www.last.fm/api/account/create. Any name works, and the callback URL can stay empty. Only the *API key* is needed, not the shared secret.

### Run it

```sh
git clone https://github.com/alex-crr/what-my-music-looks-like.git
cd what-my-music-looks-like
cp .env.example .env    # then put your API key and Last.fm user name in .env
docker compose up --build
```

Open http://localhost:8081. On a phone on the same Wi-Fi, open `http://<computer's IP>:8081`. Without a `.env` the app still starts, and the page says the key is missing.

| Setting in `.env` | Meaning |
|---|---|
| `LASTFM_API_KEY` | Your Last.fm API key. Stays on the server, never sent to the browser. |
| `LASTFM_USER` | The Last.fm user whose plays are shown. |
| `HISTORY_DAYS` | With a Deezer history only: how many days back the graph goes. Default 30. |
| `TOP_ALBUMS` | With a Deezer history only: how many of the most played albums are shown, plus the latest ones. Default 120. |

### Add your Deezer history (optional)

Last.fm only knows what was scrobbled since the scrobbler was installed. Deezer's personal-data export (account settings > Personal data) holds your full history. The server can add it under the Last.fm plays:

```sh
pip install openpyxl
python import_deezer.py path/to/deezer-data.xlsx     # writes data/deezer_history.csv
```

Then restart the app. The history is read at start.

- **Only what the graph needs is kept:** start time (UTC), title, artist, album and ISRC. The export's email, birth date, devices and the IP address of every play are left out. Plays under 30 s are skipped, as Last.fm does.
- **No play is counted twice:** the history is used up to the first play Last.fm knows, and Last.fm takes over from there.
- **Last 30 days, 120 most played albums**, plus the albums of the latest plays, so what is playing now is always there. Change this with `HISTORY_DAYS` and `TOP_ALBUMS`.
- **Sessions** are counted on the full sequence, before any album is left out, so a hidden album between two shown ones doesn't fake a pause.
- **Covers** come from Deezer by ISRC, an exact match. Deezer allows about 50 calls per 5 s, so the server spaces its calls. After a restart, all covers are there within about 15 s.
- `data/` and `*.xlsx` are in `.gitignore` and `.dockerignore`, so the history never goes to GitHub or into the image. `compose.yaml` mounts `data/` read-only. Without it, the app uses Last.fm alone.

### Put it online (optional)

The page only uses relative URLs (`api/recent`, `media?url=…`), so it works at the root of a site or under a sub-path behind any reverse proxy that removes the prefix. Mine runs at `/music/` on a server whose Caddy already serves another class project, visit-counter. That Caddy owns ports 80 and 443 and the HTTPS certificate. This app opens no port: it joins the shared Docker network `proxy` under the name `music`.

```
internet ──> Caddy (visit-counter) ── /music/* ──> this app   (network "proxy", name "music", port 8081)
                                   └─ /api/*, / ─> visit counter
```

In the Caddyfile:

```
redir /music /music/
handle_path /music/* {
	reverse_proxy music:8081
}
```

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

To add the Deezer history on the server, copy the file over and restart:

```sh
scp data/deezer_history.csv root@student04.wt.thomasjuldo.com:~/what-my-music-looks-like/data/
docker compose -f compose.yaml -f compose.server.yaml up -d --build
```

After a change: `git pull`, then the same `up -d --build`. Logs: `docker compose logs -f web`.

## How it works

```
browser ──> this server (Flask, port 8081) ──> Last.fm  (recent tracks, cached 60 s)
                                            └─> Deezer  (cover per track, remembered forever)
```

| Route | What it does |
|---|---|
| `/` | The page (`static/`). Plain HTML, CSS and JavaScript, no external files. |
| `/api/recent` | Recent tracks from Last.fm (the last 200 plays), with the Deezer history underneath and a Deezer cover added to each track. Last.fm's own image is used when Deezer finds nothing. |
| `/media?url=…` | Fetches a cover for the browser. It only accepts cover URLs that `/api/recent` itself handed out, so it can't be used to fetch anything else, and it keeps working when Last.fm changes its image host. |

### How the graph is built (`static/app.js`)

1. **Model.** Plays in time order. Each album is a node. Two plays in a row from different albums add a line between them. A line's **weight** grows by 1 each time it happens inside a listening session, and only by 0.2 when a pause of 30 min or more separates the two plays, because a jump after a pause says little about what goes together.
2. **Kernels.** The weights go to **Louvain** community detection (Blondel et al., 2008, the method Gephi uses). Each album moves into the neighbouring group that most raises *modularity*, which compares the weight inside groups with what random lines would give. Then each group becomes one node and it starts again, until nothing moves. Groups of 2 albums or more are kernels. Only listening order goes in: no genre, no artist, no metadata.
3. **Layout.** A small force simulation, written by hand since the page only loads files from my server. Every pair of circles pushes apart, every line is a spring that pulls harder when its weight is higher, and each kernel pulls its albums toward its centre. Circles of different kernels keep 60 units apart instead of 12, so each kernel stands as its own island. A pull toward the middle keeps the whole graph in a box shaped like the frame, so it comes out wide on a laptop, tall on a phone, and fills the frame with circles as big as possible. Each kernel starts in its own part of the frame, and circles may pass through each other until the layout calms down, so no album gets trapped inside another kernel. Most of the layout is worked out before it is drawn, so the graph appears nearly in place. Positions are kept between refreshes, so the graph only moves when a new album appears.
4. **Drawing.** SVG.
   - **Areas and bands:** each kernel's area is a faint radial gradient behind its albums. Pairs of kernels with 3 or more transitions between them inside a session get a band from centre to centre, its width growing with the log of that count.
   - **Sizes:** circles are sized linearly, not by area, because most albums have only a few plays and an area scale squeezes them all to nearly the same size.
   - **Lines:** to keep the graph light, only transitions inside a session are drawn, and those that happened once only show while their album is hovered. Arrowheads only appear on the hovered album's lines, painted in each line's colour. A line takes its kernel's colour; a line or band between two kernels is neutral grey, since colour means kernel. Lines and the 1 px rings keep the same thickness at every zoom.
   - **Motion:** the album playing now swells on a heartbeat curve, two quick bumps every 3 s, and pushes its neighbours away, more the closer they are. The last 12 albums played lean toward the next one, up to 30% of the gap between them, in a wave every 4 s that runs along them. Both are only drawn, so the layout itself never drifts, and only the circles that actually move are redrawn.
   - **Text:** names are not drawn on the graph; they show in the card. Track names are inserted as text, never as HTML.

### The assignment's rules, and where each one is met

| Rule | How |
|---|---|
| The browser talks only to my server | The page calls `/api/recent`. Covers go through `/media`, so not even an image is loaded from Last.fm or Deezer. |
| The key stays on the server | It is read from the `LASTFM_API_KEY` environment variable (`app.py`, top of the file). `.env` is in `.gitignore` and `.dockerignore`. Errors are logged without the request URL, because the URL contains the key. |
| Cache | One Last.fm answer is kept for 60 s and shared by every visitor. A lock means visitors arriving at the same moment still cause only one call. When the 60 s are over, the visitor gets the last answer at once and the server asks Last.fm in the background; the page asks again a few seconds later. Only the very first visit after a start waits for Last.fm. Each call prints `[lastfm] calling …` in `docker compose logs`, so the calls can be counted. |
| Last.fm fails | If an earlier answer exists, the page shows it with a warning saying what time the data is from. Otherwise it shows a message. After a failure the server waits 60 s before trying again, so an outage doesn't cause a flood of retries. Covers Deezer hasn't given yet are filled in as they arrive. |
| Phone and laptop | The SVG fills the width. On a phone the canvas is tall; on a laptop it fits the screen. The layout only re-runs when the width changes. |
| `docker compose up` | One service, built from the `Dockerfile`. |

### Checking the "Done when" list

- **No request to Last.fm:** DevTools > Network, reload. Every request goes to the app's own address.
- **Two reloads = one call:** `docker compose logs -f`, then reload twice. One `[lastfm] calling` line appears.
- **Last.fm unreachable:** start without network, or set a wrong user in `.env`. The page shows a message.
- **Key not on GitHub:** `git log -p | grep -i <your key>` finds nothing.

The self-check runs the whole list with Last.fm, Deezer and the image hosts replaced by fakes, so it needs no network and no key:

```sh
pip install flask requests
python test_app.py
```

When a `.env` and a git repository exist, it also checks that the key is in no other file and in no commit. It ends with the checks that need a browser or Docker, to do by hand.

## Files

| File | Role |
|---|---|
| `app.py` | The whole server |
| `static/index.html`, `style.css`, `app.js` | The page |
| `Dockerfile`, `compose.yaml` | Build and start |
| `compose.server.yaml` | Server additions: no open port, joins the shared `proxy` network |
| `.env.example` | The settings, to copy to `.env` |
| `import_deezer.py` | Deezer export (.xlsx) to `data/deezer_history.csv` |
| `test_app.py` | Self-check |
