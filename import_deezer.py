"""Turn Deezer's personal-data export (.xlsx) into data/deezer_history.csv, which the server adds to Last.fm.

Keeps only what the graph needs: when the play started (UTC), title, artist, album, ISRC.
Everything else in the export (email, birth date, the IP address of every play, device) is left out.
Plays shorter than 30 s are skipped, as Last.fm does for scrobbles.

    pip install openpyxl
    python import_deezer.py path/to/deezer-data.xlsx

data/ is in .gitignore: the history stays on your machine and on the server, never on GitHub.
"""
import csv
import sys
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

OUT = Path(__file__).parent / "data" / "deezer_history.csv"
FIELDS = ["played_at", "title", "artist", "album", "isrc"]


def main(xlsx):
    rows = openpyxl.load_workbook(xlsx, read_only=True)["10_listeningHistory"].iter_rows(values_only=True)
    col = {name: i for i, name in enumerate(next(rows))}
    plays = []
    for r in rows:
        seconds = int(r[col["Listening Time"]] or 0)
        if seconds < 30:
            continue
        # The export's date is UTC and marks the END of the play (checked against Last.fm): start = end - duration
        end = datetime.fromisoformat(r[col["Date"]]).replace(tzinfo=timezone.utc)
        plays.append({
            "played_at": int(end.timestamp()) - seconds,
            "title": r[col["Song Title"]],
            "artist": r[col["Artist"]],
            "album": r[col["Album Title"]],
            "isrc": r[col["ISRC"]],
        })
    plays.sort(key=lambda p: p["played_at"])
    OUT.parent.mkdir(exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(plays)
    print(f"{len(plays)} plays written to {OUT}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
