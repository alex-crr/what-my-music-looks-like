"""What my music looks like: the browser talks only to this server, this server talks to Last.fm and Deezer."""
import csv
import os
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path
from urllib.parse import quote

import requests
from flask import Flask, Response, jsonify, request

LASTFM_KEY = os.environ.get("LASTFM_API_KEY", "")
LASTFM_USER = os.environ.get("LASTFM_USER", "")
TTL = int(os.environ.get("CACHE_SECONDS", "60"))  # how long one Last.fm answer is reused
DEEZER_BUDGET = 3  # seconds the page waits for covers; the rest arrive on a later refresh
LASTFM_URL = "https://ws.audioscrobbler.com/2.0/"
DEEZER_SEARCH = "https://api.deezer.com/search"
DEEZER_ISRC = "https://api.deezer.com/track/isrc:"
HISTORY_FILE = Path(os.environ.get("HISTORY_FILE", Path(__file__).parent / "data" / "deezer_history.csv"))
HISTORY_DAYS = int(os.environ.get("HISTORY_DAYS", "30"))  # how far back the graph goes when there is a history
TOP_ALBUMS = int(os.environ.get("TOP_ALBUMS", "120"))  # most played albums shown, plus the latest ones
PAUSE = 30 * 60  # seconds of silence that start a new listening session
NO_COVER = "2a96cbd8b46e442fc41c2b86b821562f"  # Last.fm's grey star placeholder image

app = Flask(__name__, static_folder="static", static_url_path="")
cache = {"plays": None, "fetched_at": 0, "tried": 0.0, "error": None}  # one Last.fm answer, shared by every visitor
lock = threading.Lock()  # many visitors at the same moment still make one call
refresher = threading.Thread()  # the background refresh, when one is running
looking_up = set()  # albums whose Deezer lookup is running, so one never starts twice
lookup_lock = threading.Lock()
MISSING = object()  # "not looked up yet", as opposed to None, "Deezer has no match"
deezer = {}  # (artist, title) -> {"cover", "link"} or None; a match never changes, so it never expires
pool = ThreadPoolExecutor(5)  # at most 5 Deezer lookups at once
deezer_gate = threading.Lock()
deezer_last = [0.0]  # time of the last Deezer call
media = {}  # url -> (content type, bytes); ponytail: in memory, lost on restart
issued = set()  # cover URLs this server put in /api/recent: the only ones /media will fetch


class LastfmError(Exception):
    """Last.fm answered, but with an error (wrong user, bad key, rate limit)."""


def load_history():
    """Deezer listening history made by import_deezer.py. Optional: without it, Last.fm alone is used."""
    if not HISTORY_FILE.exists():
        return []
    with HISTORY_FILE.open(encoding="utf-8") as f:
        return [{**row, "played_at": int(row["played_at"]), "now_playing": False, "lastfm_cover": "", "lastfm": None}
                for row in csv.DictReader(f)]


history = load_history()  # read once at start: restart the server after a new import


def as_list(x):
    # Last.fm returns an object, not a list, when there is exactly one track
    return x if isinstance(x, list) else [x] if x else []


def lastfm_recent():
    print(f"[lastfm] calling user.getRecentTracks for {LASTFM_USER}", flush=True)
    r = requests.get(LASTFM_URL, timeout=10, params={
        "method": "user.getrecenttracks", "user": LASTFM_USER,
        "api_key": LASTFM_KEY, "format": "json", "limit": 200,  # 200 is the most Last.fm gives per call
    })
    data = r.json()  # Last.fm also answers errors as JSON
    if "error" in data:
        raise LastfmError(data.get("message", "unknown error"))
    return as_list(data["recenttracks"].get("track"))


def deezer_get(url, **params):
    """Deezer allows about 50 calls per 5 s: space them 0.1 s apart, whatever the number of threads."""
    with deezer_gate:
        pause = deezer_last[0] + 0.1 - time.time()
        if pause > 0:
            time.sleep(pause)
        deezer_last[0] = time.time()
    return requests.get(url, params=params, timeout=5).json()


def deezer_match(artist, title):
    key = (artist.lower(), title.lower())
    if key in deezer:
        return deezer[key]
    hit = None
    try:
        for q in (f'artist:"{artist}" track:"{title}"', f"{artist} {title}"):  # strict first, then loose
            data = deezer_get(DEEZER_SEARCH, q=q, limit=1)
            if "error" in data:  # quota or outage: don't remember, try again next time
                return None
            if data.get("data"):
                hit = data["data"][0]
                break
    except (requests.RequestException, ValueError):
        return None
    # cover_medium (250 px) is enough for the graph and loads faster than cover_big
    deezer[key] = {"cover": hit.get("album", {}).get("cover_medium"), "link": hit.get("link")} if hit else None
    return deezer[key]


def deezer_by_isrc(isrc):
    """Exact match: the history gives each track's ISRC, Deezer finds the track from it."""
    key = ("isrc", isrc)
    if key in deezer:
        return deezer[key]
    try:
        data = deezer_get(DEEZER_ISRC + isrc)
    except (requests.RequestException, ValueError):
        return None
    if "error" in data:
        if data["error"].get("code") == 800:  # 800 = no such track: remember the miss
            deezer[key] = None
        return None  # quota or outage: try again next time
    deezer[key] = {"cover": data.get("album", {}).get("cover_medium"), "link": data.get("link")}
    return deezer[key]


def cover_for(plays):
    """Deezer cover of one album, from any of its plays: ISRC when the history has one, else a search."""
    isrc = next((p["isrc"] for p in reversed(plays) if p.get("isrc")), "")
    found = deezer_by_isrc(isrc) if isrc else None
    if isrc and ("isrc", isrc) not in deezer:
        return None  # Deezer busy or down: try again at the next refresh, don't spend calls on a search
    return found or deezer_match(plays[-1]["artist"], plays[-1]["title"])


def proxied(url):
    if not url:
        return None
    issued.add(url)  # ponytail: grows with every distinct cover seen; a few KB, fine for a class project
    # relative (no leading /): works at / locally and under /music/ behind the server's Caddy
    return f"media?url={quote(url, safe='')}"


def from_lastfm(t):
    """One Last.fm track as one play."""
    cover = next((i["#text"] for i in reversed(t.get("image", [])) if i.get("#text")), "")
    return {
        "artist": t["artist"]["#text"],
        "title": t["name"],
        "album": t.get("album", {}).get("#text", ""),
        "isrc": "",
        "played_at": int(t["date"]["uts"]) if "date" in t else None,  # no date = playing now
        "now_playing": t.get("@attr", {}).get("nowplaying") == "true",
        "lastfm_cover": "" if NO_COVER in cover else cover,
        "lastfm": t.get("url"),
    }


def album_key(p):
    # "Billie Eilish, Khalid" on Deezer is "Billie Eilish" on Last.fm: compare on the first artist
    return f"{(p['album'] or p['title']).lower()}|{p['artist'].split(', ')[0].lower()}"


def merge(recent):
    """Deezer history for the past, Last.fm from its first play on, cut to the albums worth drawing.

    Returns plays oldest first, each with its album key and listening-session number."""
    times = [p["played_at"] for p in recent if p["played_at"]]
    now = time.time()
    start_lastfm = min(times, default=now)  # the history stops where Last.fm starts: no play counted twice
    since = now - HISTORY_DAYS * 86400
    past = [dict(p) for p in history if since <= p["played_at"] < start_lastfm]
    plays = past + sorted(recent, key=lambda p: p["played_at"] or now)
    session, last = 0, None
    for p in plays:  # sessions on the full sequence, before any album is left out
        t = p["played_at"] or now
        if last is not None and t - last >= PAUSE:
            session += 1
        p.update(session=session, key=album_key(p))
        last = t
    if not past:
        return plays  # Last.fm alone: few enough to draw everything
    counts = Counter(p["key"] for p in plays)
    keep = {k for k, _ in counts.most_common(TOP_ALBUMS)} | {p["key"] for p in plays[-20:]}  # always the latest
    return [p for p in plays if p["key"] in keep]


def known_cover(plays):
    """The album's Deezer match if already looked up: a dict, None for no match, MISSING if not known yet."""
    isrc = next((p["isrc"] for p in reversed(plays) if p.get("isrc")), "")
    if isrc:
        hit = deezer.get(("isrc", isrc), MISSING)
        if hit is not None:
            return hit  # a match, or not looked up yet (an ISRC Deezer doesn't know falls back to a search)
    last = plays[-1]
    return deezer.get((last["artist"].lower(), last["title"].lower()), MISSING)


def look_up(key, plays):
    """Start the album's Deezer lookup in the background, unless it is already running."""
    with lookup_lock:
        if key in looking_up:
            return None
        looking_up.add(key)
    job = pool.submit(cover_for, plays)
    job.add_done_callback(lambda _: looking_up.discard(key))
    return job


def build(plays, budget):
    """Plays (newest first) with their covers, and how many covers Deezer hasn't given yet."""
    albums = defaultdict(list)
    for p in plays:
        albums[p["key"]].append(p)
    jobs = [look_up(k, ps) for k, ps in albums.items() if known_cover(ps) is MISSING]
    jobs = [j for j in jobs if j]
    if budget and jobs:
        wait(jobs, timeout=budget)  # only on a first visit, when there is nothing else to show
    covers = {k: known_cover(ps) for k, ps in albums.items()}
    out = []
    for p in reversed(plays):  # newest first, like Last.fm
        match = covers[p["key"]] if isinstance(covers[p["key"]], dict) else None
        lfm_cover = next((q["lastfm_cover"] for q in reversed(albums[p["key"]]) if q["lastfm_cover"]), "")
        out.append({
            "key": p["key"],
            "artist": p["artist"],
            "title": p["title"],
            "album": p["album"],
            "played_at": p["played_at"],
            "now_playing": p["now_playing"],
            "session": p["session"],
            "cover": proxied((match and match["cover"]) or lfm_cover),  # Deezer cover first, Last.fm as fallback
            "deezer": match["link"] if match else None,
            "lastfm": p["lastfm"],
        })
    return out, sum(1 for c in covers.values() if c is MISSING)


def refresh():
    """Ask Last.fm (at most once per TTL, however many visitors) and merge with the history."""
    with lock:
        if time.time() - cache["tried"] < TTL:
            return  # another visitor just did it
        cache["tried"] = time.time()  # also after a failure: no retry storm while Last.fm is down
        try:
            plays = merge([from_lastfm(t) for t in lastfm_recent()])
            cache.update(plays=plays, fetched_at=int(time.time()), error=None)
        except LastfmError as e:
            cache["error"] = f"Last.fm says: {e}."
        except Exception as e:
            print(f"[lastfm] failed: {type(e).__name__}", flush=True)  # not the message: it can hold the URL with the key
            cache["error"] = "Last.fm is not answering right now."


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/recent")
def recent():
    global refresher
    if not (LASTFM_KEY and LASTFM_USER):
        return jsonify(message="The server has no Last.fm key or user. "
                               "Set LASTFM_API_KEY and LASTFM_USER in .env, then restart."), 503
    first = cache["plays"] is None
    if first:
        refresh()  # nothing to show yet: this visit waits for Last.fm
    elif time.time() - cache["tried"] >= TTL and not refresher.is_alive():
        # Expired: answer at once with what we have and refresh in the background; the page asks again soon.
        refresher = threading.Thread(target=refresh, daemon=True)
        refresher.start()
    plays, error = cache["plays"], cache["error"]
    if plays is None:
        return jsonify(message=f"{error} Try again in a minute."), 502
    tracks, pending = build(plays, DEEZER_BUDGET if first else 0)
    return jsonify(user=LASTFM_USER, fetched_at=cache["fetched_at"], tracks=tracks,
                   history_days=HISTORY_DAYS if history else 0, stale=error is not None, message=error,
                   refreshing=refresher.is_alive(), pending=pending)


@app.get("/media")
def media_proxy():
    """Covers go through here, so the browser never loads anything from Last.fm or Deezer."""
    url = request.args.get("url", "")
    if url not in issued:  # only covers we handed out: not an open proxy, whatever host Last.fm or Deezer use
        return "", 400
    if url not in media:
        try:
            r = requests.get(url, timeout=10)
        except requests.RequestException:
            return "", 502
        if r.status_code != 200:
            return "", 502
        if len(media) >= 500:  # ponytail: drop the oldest, an LRU if this ever matters
            media.pop(next(iter(media)))
        media[url] = (r.headers.get("content-type", "image/jpeg"), r.content)
    ctype, body = media[url]
    return Response(body, content_type=ctype, headers={"Cache-Control": "public, max-age=86400"})
