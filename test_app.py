"""Checks the assignment's "Done when" list.

Run:  python test_app.py      (needs flask and requests; no network, no Last.fm key)

Last.fm, Deezer and the image hosts are replaced by fakes at the `requests.get` level,
so the real server code runs: parsing, cache, lock, error messages, image proxy.
Items that need a real browser or Docker are listed at the end as manual checks.
"""
import csv
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import requests

ROOT = Path(__file__).parent
KEY = "fake-key-0123456789abcdef"
HISTORY = Path(tempfile.mkdtemp()) / "history.csv"  # never your real data/deezer_history.csv
os.environ.update(LASTFM_API_KEY=KEY, LASTFM_USER="me", HISTORY_FILE=str(HISTORY))
import app as server  # noqa: E402

# ---------- fake internet ----------

TRACK = {"artist": {"#text": "Daft Punk"}, "name": "One More Time", "album": {"#text": "Discovery"},
         "date": {"uts": "1700000000"}, "url": "https://www.last.fm/music/x",
         "image": [{"#text": "https://img.some-new-lastfm-cdn.example/i/u/300x300/abc.png"}]}  # any host: Last.fm has changed it before
net = {"lastfm": "ok", "deezer": "ok", "lastfm_calls": 0, "slow_lastfm": 0, "isrc_calls": 0}
logs = []
server.print = lambda *a, **k: logs.append(" ".join(map(str, a)))  # capture the server's log lines


class Reply:
    def __init__(self, body=None, status=200, raw=b""):
        self.body, self.status_code, self.content = body, status, raw
        self.headers = {"content-type": "image/jpeg"}

    def json(self):
        if self.body is None:
            raise ValueError("not JSON")  # what an HTML error page gives
        return self.body


def fake_get(url, params=None, timeout=None, **_):
    if url == server.LASTFM_URL:
        net["lastfm_calls"] += 1
        time.sleep(net["slow_lastfm"])
        mode = net["lastfm"]
        if mode == "down":  # like a real requests error, the message holds the full URL, key included
            raise requests.ConnectionError(f"cannot reach {url}?api_key={params['api_key']}")
        if mode == "html":
            return Reply(None, 503)
        if mode == "error":
            return Reply({"error": 6, "message": "User not found"}, 404)
        return Reply({"recenttracks": {"track": TRACK}})  # one track: an object, not a list, like the real Last.fm
    if url.startswith(server.DEEZER_ISRC):
        net["isrc_calls"] += 1
        if url.endswith("UNKNOWN"):
            return Reply({"error": {"type": "DataException", "message": "no data", "code": 800}})
        return Reply({"album": {"cover_medium": "https://cdn-images.dzcdn.net/images/cover/isrc/250x250.jpg"},
                      "link": "https://www.deezer.com/track/2"})
    if url == server.DEEZER_SEARCH:
        if net["deezer"] == "none":
            return Reply({"data": []})
        if net["deezer"] == "slow":
            time.sleep(net["deezer_delay"])
        return Reply({"data": [{"album": {"cover_medium": "https://cdn-images.dzcdn.net/images/cover/x/250x250.jpg"},
                                "link": "https://www.deezer.com/track/1"}]})
    return Reply(raw=b"image bytes")  # image hosts


server.requests.get = fake_get
client = server.app.test_client()

# ---------- tiny runner ----------

failures = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def settle():
    """Let background work finish: the Last.fm refresh and the Deezer lookups."""
    if server.refresher.is_alive():
        server.refresher.join()
    while server.looking_up:
        time.sleep(0.02)


def fresh(lastfm="ok", deezer="ok"):
    """Empty caches, as after a server restart."""
    settle()
    server.cache.update(plays=None, fetched_at=0, tried=0.0, error=None)
    server.deezer.clear()
    net.update(lastfm=lastfm, deezer=deezer, lastfm_calls=0, slow_lastfm=0, deezer_delay=3)


def get():
    r = client.get("/api/recent")
    return r.status_code, r.get_json()


# ---------- the list ----------

print("Done when: it shows my recent music in a form I chose")
code, body = (fresh(), get())[1]
check("the API answers with tracks", code == 200 and len(body["tracks"]) == 1, body)
check("the page draws a graph (an svg, not a list)", 'id="graph"' in (ROOT / "static/index.html").read_text())

print("Done when: no request goes to Last.fm in the browser's Network tab")
cover = body["tracks"][0]["cover"]
check("covers are served by this server (media?url=...)", cover.startswith("media?url="), cover)
external = [f"{p.name}: {u}" for p in (ROOT / "static").iterdir()
            for u in re.findall(r"https?://[^\s\"'`)]+", p.read_text()) if not u.startswith("http://www.w3.org/")]
check("the page's files load nothing from another site", not external, external)
check("/media returns an allowed image", client.get("/" + cover).status_code == 200)
page = (ROOT / "static/index.html").read_text() + (ROOT / "static/app.js").read_text()
absolute = re.findall(r'(?:src|href)="/[^"]*"|fetch\("/', page)
check("the page uses relative URLs, so it also works under /music/", not absolute, absolute)
for bad in ("https://evil.example/x.png", "https://cdn-images.dzcdn.net/not-a-cover-we-gave-out.jpg"):
    check(f"/media refuses {bad}", client.get("/media", query_string={"url": bad}).status_code == 400)
fresh(deezer="none")
lfm = client.get("/api/recent").get_json()["tracks"][0]["cover"]
check("a Last.fm cover (no Deezer match) is served too", client.get("/" + lfm).status_code == 200, lfm)

print("Done when: my key is nowhere on GitHub")
gitignore = (ROOT / ".gitignore").read_text().split()
check(".env is in .gitignore", ".env" in gitignore)
check(".env is in .dockerignore", ".env" in (ROOT / ".dockerignore").read_text().split())
check("the key is not in what the browser receives", KEY not in client.get("/api/recent").get_data(as_text=True))
fresh("down")
get()
check("the key is not in the server log when Last.fm fails", not any(KEY in line for line in logs), logs[-1:])
env = ROOT / ".env"
real_key = next((line.split("=", 1)[1].strip().strip('"') for line in env.read_text().splitlines()
                 if line.startswith("LASTFM_API_KEY=")), "") if env.exists() else ""
if real_key:
    files = [p for p in ROOT.rglob("*") if p.is_file() and p.name != ".env" and ".git" not in p.parts]
    check("your key is in no file except .env", not any(real_key in p.read_text(errors="ignore") for p in files))
    if (ROOT / ".git").exists():
        history = subprocess.run(["git", "-C", str(ROOT), "log", "-p", "--all"], capture_output=True, text=True).stdout
        tracked = subprocess.run(["git", "-C", str(ROOT), "ls-files"], capture_output=True, text=True).stdout.split()
        check("your key is in no commit", real_key not in history)
        check(".env was never committed", ".env" not in tracked and "+++ b/.env\n" not in history)
    else:
        print("  skip no git repository yet: run again after your first commit")
else:
    print("  skip no .env with a key here: the scan of your files and git history did not run")

print("Done when: reloading the page twice in a row makes only one call to Last.fm")
fresh()
get(), get()
check("two reloads, one Last.fm call", net["lastfm_calls"] == 1, net["lastfm_calls"])
fresh()
net["slow_lastfm"] = 0.3
answers = []
threads = [threading.Thread(target=lambda: answers.append(get())) for _ in range(5)]
[t.start() for t in threads]
[t.join() for t in threads]
check("five visitors at the same moment, one Last.fm call", net["lastfm_calls"] == 1, net["lastfm_calls"])
check("...and all five get the music, none an error", all(c == 200 and b["tracks"] for c, b in answers),
      [c for c, _ in answers])
server.cache["tried"] = 0  # the 60 s are over
net["slow_lastfm"] = 1
start = time.time()
code, body = get()
waited = time.time() - start
check("after the cache time, the visitor gets the last data at once", code == 200 and body["tracks"] and waited < 0.5,
      f"{waited:.1f} s")
check("...while the server asks Last.fm in the background", body["refreshing"])
get()
settle()
check("...with one new call, even after another reload", net["lastfm_calls"] == 2, net["lastfm_calls"])

print("Done when: with Last.fm unreachable, the page shows a message")
fresh("down")
code, body = get()
check("unreachable, nothing cached: a message", code == 502 and "not answering" in body["message"], body)
get()
check("no retry on every reload while it is down", net["lastfm_calls"] == 1, net["lastfm_calls"])
fresh("html")
code, body = get()
check("an HTML error page instead of JSON: a message", code == 502 and body["message"], body)
fresh("error")
code, body = get()
check("Last.fm error (unknown user): its message is shown", "User not found" in body["message"], body)
fresh()
get()
server.cache["tried"] = 0
net["lastfm"] = "down"
get()  # starts the background refresh, which fails
settle()
code, body = get()
check("unreachable after a success: last data kept, with a warning",
      code == 200 and body["tracks"] and body["message"], body)
fresh(deezer="slow")
net["deezer_delay"] = 1
server.DEEZER_BUDGET, start = 0.3, time.time()
code, body = get()
waited = time.time() - start
server.DEEZER_BUDGET = 3
check("a slow Deezer does not hold the page", code == 200 and waited < 0.8, f"{waited:.1f} s")
check("...shows Last.fm's cover meanwhile, and says a Deezer cover is coming",
      body["pending"] == 1 and "dzcdn" not in body["tracks"][0]["cover"], body)
settle()
code, body = get()
check("covers that arrive later are in the next answer", body["pending"] == 0 and "dzcdn" in body["tracks"][0]["cover"], body)
check("...without asking Last.fm again", net["lastfm_calls"] == 1, net["lastfm_calls"])
js = (ROOT / "static/app.js").read_text()
check("the page has its own message when the server itself is down", "The server is not answering" in js)
check("the page asks again soon while data or covers are on their way", "answer.refreshing || answer.pending" in js)

print("Done when: it starts with docker compose up on a new copy")
compose = (ROOT / "compose.yaml").read_text()
check("compose works without .env (empty default)", "${LASTFM_API_KEY:-}" in compose and "${LASTFM_USER:-}" in compose)
server.LASTFM_KEY = ""
code, body = get()
server.LASTFM_KEY = KEY
check("no key: the server runs and says what is missing", code == 503 and "LASTFM_API_KEY" in body["message"], body)
check("the page itself is served", client.get("/").status_code == 200)

print("Deezer history (optional, from import_deezer.py)")
now = int(time.time())
lfm_start = now - 3600  # the fake Last.fm track: one hour ago
TRACK["date"] = {"uts": str(lfm_start)}
rows = [  # (seconds ago, title, artist, album, isrc)
    (40 * 86400, "Too old", "Old Band", "Old Album", "OLD1"),                   # outside the 30-day window
    (5 * 3600, "Song A", "Band A", "Album A", "ISRCA"),                          # session 0
    (5 * 3600 - 200, "Song B", "Band B, Guest", "Album B", "ISRCB"),             # session 0 (same artist key as "Band B")
    (2 * 3600, "Song C", "Band C", "Album C", "UNKNOWN"),                        # new session after a 2 h pause
    (1800, "Played after Last.fm started", "Band A", "Album A", "ISRCA"),       # Last.fm already has this period
]
with HISTORY.open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["played_at", "title", "artist", "album", "isrc"])
    w.writerows([[now - ago, t, a, al, i] for ago, t, a, al, i in sorted(rows, key=lambda r: -r[0])])
server.history = server.load_history()
fresh()
code, body = get()
titles = [t["title"] for t in body["tracks"]]
check("history plays come before Last.fm, newest first", titles == ["One More Time", "Song C", "Song B", "Song A"], titles)
check("plays older than the window are left out", "Too old" not in titles)
check("plays after Last.fm's first play are not counted twice", "Played after Last.fm started" not in titles)
sessions = [t["session"] for t in body["tracks"]]
check("a pause of 30 min or more starts a new session", sessions == [2, 1, 0, 0], sessions)
check("albums match on the first artist ('Band B, Guest' = 'Band B')", body["tracks"][2]["key"] == "album b|band b")
check("history covers come from Deezer by ISRC", body["tracks"][3]["cover"].endswith("isrc%2F250x250.jpg"), body["tracks"][3]["cover"])
check("an unknown ISRC falls back to a search", "dzcdn" in body["tracks"][1]["cover"])
check("the browser gets no ISRC", all("isrc" not in t for t in body["tracks"]))
real = ROOT / "data" / "deezer_history.csv"
if real.exists():
    with real.open(encoding="utf-8") as f:
        header = next(csv.reader(f))
    check("your history file holds only time, title, artist, album, ISRC", header == ["played_at", "title", "artist", "album", "isrc"], header)
check("data/ and *.xlsx are kept out of git", "data/" in gitignore and "*.xlsx" in gitignore)
check("...and out of the Docker image", {"data", "*.xlsx"} <= set((ROOT / ".dockerignore").read_text().split()))
year = time.gmtime(now).tm_year
check("the timeline lists the history's years", body["years"] == sorted({time.gmtime(now - r[0]).tm_year for r in rows}), body["years"])
calls = net["lastfm_calls"]
r = client.get("/api/recent", query_string={"year": year})
in_year = [t["title"] for t in r.get_json()["tracks"]]
check("one year shows that year's history plays, without calling Last.fm",
      r.status_code == 200 and set(in_year) <= {x[1] for x in rows if time.gmtime(now - x[0]).tm_year == year}
      and "Song A" in in_year and net["lastfm_calls"] == calls, in_year)
check("a year with no history is refused", client.get("/api/recent", query_string={"year": "1999"}).status_code == 404)
check("a year that isn't a number is refused", client.get("/api/recent", query_string={"year": "x'"}).status_code == 404)
server.history = []
server.by_year.clear()
TRACK["date"] = {"uts": "1700000000"}

print("\nManual checks (need a browser, Docker or your GitHub):")
print("  - docker compose up --build on a fresh clone, then open http://localhost:8081")
print("  - DevTools > Network with real data: every request goes to localhost:8081")
print("  - phone on the same Wi-Fi: http://<laptop IP>:8081")
print("  - on the server: https://student04.wt.thomasjuldo.com/music/ and the visit counter at /")
print("  - after pushing: run this file again in the clone, or search GitHub for the key")

print(f"\n{'All checks passed.' if not failures else f'{len(failures)} check(s) failed.'}")
sys.exit(1 if failures else 0)
