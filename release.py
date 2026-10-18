"""Bump Gram Tracker's version everywhere it lives, so phones see and download the update.

Usage:  python release.py 1.0.1 "What changed" "Another change"
Then upload the app/ folder to the hosting site (deploy step).
"""
import json, re, sys, datetime, pathlib

APP = pathlib.Path(__file__).parent / "app"

def main():
    if len(sys.argv) < 3:
        sys.exit('usage: python release.py <version> "note" ["note" ...]')
    ver, notes = sys.argv[1], sys.argv[2:]
    if not re.fullmatch(r"\d+\.\d+\.\d+", ver):
        sys.exit("version must look like 1.2.3")
    for name, pat in (("app.js", r"const APP_VERSION = '[^']*';"), ("sw.js", r"const VERSION = '[^']*';")):
        p = APP / name
        s = p.read_text(encoding="utf8")
        new = re.sub(pat, pat.split("'")[0] + f"'{ver}';", s, count=1)
        if new == s and f"'{ver}'" not in s:
            sys.exit(f"version line not found in {name}")
        p.write_text(new, encoding="utf8")
    (APP / "version.json").write_text(json.dumps(
        {"version": ver, "date": datetime.date.today().isoformat(), "notes": notes}, indent=2) + "\n", encoding="utf8")
    print(f"Gram Tracker is now {ver}")

if __name__ == "__main__":
    main()
