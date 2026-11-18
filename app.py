"""What my music looks like: the browser talks only to this server, this server talks to Last.fm and Deezer."""
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from urllib.parse import quote

import requests
from flask import Flask, Response, jsonify, request

LASTFM_KEY = os.environ.get("LASTFM_API_KEY", "")
LASTFM_USER = os.environ.get("LASTFM_USER", "")
TTL = int(os.environ.get("CACHE_SECONDS", "60"))  # how long one Last.fm answer is reused
DEEZER_BUDGET = 3  # seconds the page waits for covers; the rest arrive on a later refresh
LASTFM_URL = "https://ws.audioscrobbler.com/2.0/"
DEEZER_SEARCH = "https://api.deezer.com/search"
NO_COVER = "2a96cbd8b46e442fc41c2b86b821562f"  # Last.fm's grey star placeholder image

app = Flask(__name__, static_folder="static", static_url_path="")
cache = {"payload": None, "tried": 0.0, "error": None}  # one Last.fm answer, shared by every visitor
lock = threading.Lock()  # many visitors at the same moment still make one call
deezer = {}  # (artist, title) -> {"cover", "link"} or None; a match never changes, so it never expires
pool = ThreadPoolExecutor(5)  # at most 5 Deezer searches at once (Deezer limits request rate)
media = {}  # url -> (content type, bytes); ponytail: in memory, lost on restart
issued = set()  # cover URLs this server put in /api/recent: the only ones /media will fetch


class LastfmError(Exception):
    """Last.fm answered, but with an error (wrong user, bad key, rate limit)."""


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


def deezer_match(artist, title):
    key = (artist.lower(), title.lower())
    if key in deezer:
        return deezer[key]
    hit = None
    try:
        for q in (f'artist:"{artist}" track:"{title}"', f"{artist} {title}"):  # strict first, then loose
            data = requests.get(DEEZER_SEARCH, params={"q": q, "limit": 1}, timeout=5).json()
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


def proxied(url):
    if not url:
        return None
    issued.add(url)  # ponytail: grows with every distinct cover seen; a few KB, fine for a class project
    # relative (no leading /): works at / locally and under /music/ behind the server's Caddy
    return f"media?url={quote(url, safe='')}"


def build(tracks):
    pairs = {(t["artist"]["#text"], t["name"]) for t in tracks}
    jobs = {p: pool.submit(deezer_match, *p) for p in pairs}
    # A slow or down Deezer must not hold the page: wait at most DEEZER_BUDGET seconds.
    # Unfinished lookups keep running and fill the Deezer cache for the next refresh.
    done, _ = wait(jobs.values(), timeout=DEEZER_BUDGET)
    found = {p: job.result() if job in done else None for p, job in jobs.items()}
    out = []
    for t in tracks:
        artist, title = t["artist"]["#text"], t["name"]
        match = found[(artist, title)]
        lfm_cover = next((i["#text"] for i in reversed(t.get("image", [])) if i.get("#text")), "")
        if NO_COVER in lfm_cover:
            lfm_cover = ""
        out.append({
            "artist": artist,
            "title": title,
            "album": t.get("album", {}).get("#text", ""),
            "played_at": int(t["date"]["uts"]) if "date" in t else None,  # no date = playing now
            "now_playing": t.get("@attr", {}).get("nowplaying") == "true",
            "cover": proxied((match and match["cover"]) or lfm_cover),  # Deezer cover first, Last.fm as fallback
            "deezer": match["link"] if match else None,
            "lastfm": t.get("url"),
        })
    return out


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/recent")
def recent():
    if not (LASTFM_KEY and LASTFM_USER):
        return jsonify(message="The server has no Last.fm key or user. "
                               "Set LASTFM_API_KEY and LASTFM_USER in .env, then restart."), 503
    with lock:
        if time.time() - cache["tried"] >= TTL:  # also after a failure: no retry storm while Last.fm is down
            cache["tried"] = time.time()
            try:
                tracks = build(lastfm_recent())
                cache.update(payload={"user": LASTFM_USER, "fetched_at": int(time.time()), "tracks": tracks}, error=None)
            except LastfmError as e:
                cache["error"] = f"Last.fm says: {e}."
            except Exception as e:
                print(f"[lastfm] failed: {type(e).__name__}", flush=True)  # not the message: it can hold the URL with the key
                cache["error"] = "Last.fm is not answering right now."
    payload, error = cache["payload"], cache["error"]
    if payload is None:
        return jsonify(message=f"{error} Try again in a minute."), 502
    return jsonify(**payload, stale=error is not None, message=error)


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
