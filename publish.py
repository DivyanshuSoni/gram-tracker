"""Publish the current Gram Tracker web app to GitHub, so phones get it from Settings > Check for updates.

Usual flow for an update:
    python release.py 1.2.1 "What changed"      # bump the version + release notes
    python publish.py                            # push files, then the update manifest

When the Android part changed (new SHELL_VERSION in LiveUpdater.java):
    androiduild-apk.cmd                        # builds GramTracker-<version>.apk
    python publish.py --apk                      # also uploads the APK to a GitHub release;
                                                 # phones then offer "Download and install"

How it works: the files are pushed first; the manifest then points at that exact commit
(raw.githubusercontent.com/<owner>/<repo>/<commit>/app/...), so phones never mix old and new files
and every file is checked against its SHA-256 before the app switches over.
"""
import hashlib, json, pathlib, re, subprocess, sys, urllib.request

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


def github_token():
    """The GitHub sign-in Git Credential Manager already keeps on this PC (never printed)."""
    r = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                       text=True, capture_output=True, cwd=ROOT)
    m = re.search(r"^password=(.+)$", r.stdout, re.M)
    if not m:
        sys.exit("No GitHub sign-in found. Run a git push once to sign in.")
    return m.group(1).strip()


def gh_api(method, url, token, data=None, content_type="application/json"):
    body = data if isinstance(data, (bytes, type(None))) else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "User-Agent": "gram-tracker-publish", "Content-Type": content_type})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read() or b"{}")


def upload_apk(owner, repo, version, notes):
    """Create release v<version> with the APK attached; returns the manifest's "apk" entry."""
    apk = ROOT / f"GramTracker-{version}.apk"
    if not apk.exists():
        sys.exit(f"{apk.name} not found. Build it first with android\\build-apk.cmd")
    shell = int(re.search(r"SHELL_VERSION = (\d+);", (ROOT / "android/app/src/main/java/com/gramtracker/app/LiveUpdater.java").read_text(encoding="utf8")).group(1))
    data = apk.read_bytes()
    token = github_token()
    rel = gh_api("POST", f"https://api.github.com/repos/{owner}/{repo}/releases", token, {
        "tag_name": f"v{version}", "name": f"Gram Tracker {version}", "body": "\n".join("- " + n for n in notes)})
    asset = gh_api("POST", f"https://uploads.github.com/repos/{owner}/{repo}/releases/{rel['id']}/assets?name={apk.name}",
                   token, data, "application/vnd.android.package-archive")
    major, minor, patch = (int(x) for x in version.split("."))
    return {"version": version, "versionCode": major * 10000 + minor * 100 + patch, "shell": shell,
            "url": asset["browser_download_url"], "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def ver_tuple(v):
    return tuple(int(x) for x in v.split("."))


def main():
    version_info = json.loads((APP / "version.json").read_text(encoding="utf8"))
    version = version_info["version"]
    owner, repo = owner_repo()

    app_js = (APP / "app.js").read_text(encoding="utf8")
    if f"const UPDATE_REPO = '{owner}/{repo}';" not in app_js:
        sys.exit(f"app.js UPDATE_REPO doesn't match the GitHub repo {owner}/{repo}")

    previous = json.loads(MANIFEST.read_text(encoding="utf8")) if MANIFEST.exists() else {}
    if previous:
        last = previous["version"]
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
    # the latest full app (APK); kept from the previous manifest unless --apk publishes a new one
    apk_entry = upload_apk(owner, repo, version, version_info.get("notes", [])) if "--apk" in sys.argv else previous.get("apk")
    if apk_entry:
        manifest["apk"] = apk_entry
    MANIFEST.parent.mkdir(exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf8")
    git("add", str(MANIFEST.relative_to(ROOT)))
    git("commit", "-q", "-m", f"Publish update {version}")
    git("push", "-q", "origin", "HEAD:main")
    print(f"Published {version}{' with APK ' + manifest['apk']['url'] if '--apk' in sys.argv else ''}: phones will see it under Settings > Check for updates.")


if __name__ == "__main__":
    main()
