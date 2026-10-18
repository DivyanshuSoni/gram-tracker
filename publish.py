"""Publish the current Gram Tracker web app to GitHub, so phones get it from Settings > Check for updates.

Usual flow for an update:
    python release.py 1.2.1 "What changed"      # bump the version + release notes
    python publish.py                            # push files, then the update manifest

How it works: the files are pushed first; the manifest then points at that exact commit
(raw.githubusercontent.com/<owner>/<repo>/<commit>/app/...), so phones never mix old and new files
and every file is checked against its SHA-256 before the app switches over.
"""
import hashlib, json, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).parent
APP = ROOT / "app"
MANIFEST = ROOT / "updates" / "manifest.json"
MIN_SHELL = 2          # raise when new web files need a newer Android shell (then a new APK is required)
SKIP = ("vendor/lang/",)  # the APK bundles the language data unpacked; it never changes between updates


def git(*args, capture=False):
    r = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=capture)
    if r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{r.stderr if capture else ''}")
    return r.stdout.strip() if capture else ""


def owner_repo():
    url = git("remote", "get-url", "origin", capture=True)
    m = re.search(r"github\.com[:/]([^/]+)/([^/.]+)", url)
    if not m:
        sys.exit("origin is not a GitHub repo: " + url)
    return m.group(1), m.group(2)


def ver_tuple(v):
    return tuple(int(x) for x in v.split("."))


def main():
    version_info = json.loads((APP / "version.json").read_text(encoding="utf8"))
    version = version_info["version"]
    owner, repo = owner_repo()

    app_js = (APP / "app.js").read_text(encoding="utf8")
    if f"const UPDATE_REPO = '{owner}/{repo}';" not in app_js:
        sys.exit(f"app.js UPDATE_REPO doesn't match the GitHub repo {owner}/{repo}")

    if MANIFEST.exists():
        last = json.loads(MANIFEST.read_text(encoding="utf8"))["version"]
        if ver_tuple(version) <= ver_tuple(last):
            sys.exit(f"Version {version} is not newer than the published {last}. Run release.py first.")

    # 1) push the files
    git("add", "-A")
    if git("status", "--porcelain", capture=True):
        git("commit", "-q", "-m", f"Gram Tracker {version}")
    git("push", "-q", "origin", "HEAD:main")
    commit = git("rev-parse", "HEAD", capture=True)

    # 2) manifest pinned to that commit
    files = {}
    for f in sorted(APP.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(APP).as_posix()
        if rel.startswith(SKIP):
            continue
        data = f.read_bytes()
        files[rel] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    manifest = {
        "version": version,
        "date": version_info.get("date"),
        "notes": version_info.get("notes", []),
        "minShell": MIN_SHELL,
        "base": f"https://raw.githubusercontent.com/{owner}/{repo}/{commit}/app/",
        "files": files,
    }
    MANIFEST.parent.mkdir(exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf8")
    git("add", str(MANIFEST.relative_to(ROOT)))
    git("commit", "-q", "-m", f"Publish update {version}")
    git("push", "-q", "origin", "HEAD:main")
    print(f"Published {version}: phones will see it under Settings > Check for updates.")


if __name__ == "__main__":
    main()
