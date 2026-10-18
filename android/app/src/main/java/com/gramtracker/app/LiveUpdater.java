package com.gramtracker.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Instant updates without the Android installer.
 *
 * The web app (HTML/JS/CSS) ships inside the APK. An update is just the changed web files, downloaded from
 * GitHub into the app's private storage. Pages are served from that folder first and fall back to the bundled
 * files, under the same https://appassets.androidplatform.net origin, so the user's data (IndexedDB) is untouched.
 * After download the WebView reloads: to the user the app simply refreshes into the new version.
 *
 * Safety: every file is checked against the SHA-256 in the manifest; the switch happens only after all files
 * are in place; if the new version doesn't report a good start (bootOk) the previous version comes back.
 */
public class LiveUpdater {
    /** Bump only when the Java shell changes in a way new web files depend on (then a new APK is needed). */
    public static final int SHELL_VERSION = 3;
    private static final String[] ALLOWED_HOSTS = {"api.github.com", "raw.githubusercontent.com"};
    private static final long BOOT_TIMEOUT_MS = 15000;

    private final Activity act;
    private final WebView web;
    private final File root;
    private final SharedPreferences prefs;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<String, String> bundledHashes = new HashMap<>();

    private JSONObject manifest;
    private final List<Item> plan = new ArrayList<>();
    private long planBytes;
    private String stagedDir;
    private volatile boolean busy;

    private static class Item { String path, sha, action; long size; }

    public LiveUpdater(Activity act, WebView web) {
        this.act = act;
        this.web = web;
        this.root = new File(act.getFilesDir(), "web");
        this.prefs = act.getSharedPreferences("live-update", Context.MODE_PRIVATE);
    }

    /* ---------- serving: active update folder first, then the APK's bundled files ---------- */

    public WebViewAssetLoader.PathHandler pathHandler() {
        final WebViewAssetLoader.AssetsPathHandler bundled = new WebViewAssetLoader.AssetsPathHandler(act);
        return new WebViewAssetLoader.PathHandler() {
            @Override
            public WebResourceResponse handle(@NonNull String path) {
                File f = activeFile(path);
                if (f != null) {
                    try { return new WebResourceResponse(mime(path), null, new FileInputStream(f)); }
                    catch (IOException ignored) { }
                }
                return bundled.handle(path);
            }
        };
    }

    private File activeDir() {
        String name = prefs.getString("active", null);
        if (name == null) return null;
        File d = new File(root, name);
        return d.isDirectory() ? d : null;
    }

    /** The updated copy of a file, if the active update has one (and the path stays inside its folder). */
    private File activeFile(String path) {
        File dir = activeDir();
        if (dir == null || path.isEmpty()) return null;
        try {
            File f = new File(dir, path).getCanonicalFile();
            if (!f.getPath().startsWith(dir.getCanonicalPath() + File.separator) || !f.isFile()) return null;
            return f;
        } catch (IOException e) { return null; }
    }

    private static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    /* ---------- boot watchdog: roll back if a new version doesn't start ---------- */

    /** Call from onCreate. If the last update never confirmed a good start, give it one more try, then roll back. */
    public void onAppStart() {
        if (!prefs.getBoolean("pendingBoot", false)) return;
        int tries = prefs.getInt("bootTries", 0) + 1;
        prefs.edit().putInt("bootTries", tries).apply();
        if (tries > 2) rollback(false);
        else armWatchdog();
    }

    private void armWatchdog() {
        ui.postDelayed(() -> { if (prefs.getBoolean("pendingBoot", false)) rollback(true); }, BOOT_TIMEOUT_MS);
    }

    private void rollback(boolean reload) {
        String prev = prefs.getString("previous", null);
        prefs.edit().putString("active", prev).putBoolean("pendingBoot", false).putInt("bootTries", 0)
                .putString("justUpdated", "").putBoolean("rolledBack", true).apply();
        if (reload) { web.clearCache(false); web.reload(); }
    }

    /* ---------- called from the web app (window.GramAndroid) ---------- */

    @JavascriptInterface
    public void bootOk(String version) {
        if (!prefs.getBoolean("pendingBoot", false)) return;
        prefs.edit().putBoolean("pendingBoot", false).putInt("bootTries", 0).apply();
        worker.submit(this::cleanup);
    }

    /** "" normally; the new version after an update; "rolledback" if an update had to be undone. */
    @JavascriptInterface
    public String updateNotice() {
        if (prefs.getBoolean("rolledBack", false)) { prefs.edit().putBoolean("rolledBack", false).apply(); return "rolledback"; }
        String v = prefs.getString("justUpdated", "");
        if (!v.isEmpty()) prefs.edit().putString("justUpdated", "").apply();
        return v;
    }

    @JavascriptInterface
    public int shellVersion() { return SHELL_VERSION; }

    @JavascriptInterface
    public void checkUpdate(final String manifestUrl) {
        if (busy) return;
        busy = true;
        worker.submit(() -> {
            try {
                send(state("checking"));
                JSONObject m = new JSONObject(new String(get(manifestUrl, "application/vnd.github.raw+json", null), StandardCharsets.UTF_8));
                String version = m.getString("version");
                if (m.optInt("minShell", 1) > SHELL_VERSION) { send(state("needs-app").put("version", version)); return; }
                if (compare(version, currentVersion()) <= 0) { send(state("latest")); return; }
                buildPlan(m);
                manifest = m;
                send(state("available").put("version", version).put("bytes", planBytes)
                        .put("notes", m.optJSONArray("notes") == null ? new JSONArray() : m.getJSONArray("notes")));
            } catch (Exception e) {
                send(error("Couldn’t check for updates. Check your internet and try again."));
            } finally { busy = false; }
        });
    }

    @JavascriptInterface
    public void downloadUpdate() {
        if (busy || manifest == null) return;
        busy = true;
        worker.submit(() -> {
            File stage = null;
            try {
                String version = manifest.getString("version");
                String base = manifest.getString("base");
                stage = new File(root, "v" + version + "-" + System.currentTimeMillis());
                if (!stage.mkdirs()) throw new IOException("mkdir");
                File current = activeDir();
                long[] done = {0};
                long[] lastSent = {0};
                for (Item it : plan) {
                    File out = new File(stage, it.path);
                    File parent = out.getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdir");
                    if ("copy".equals(it.action)) {
                        copy(new File(current, it.path), out);
                    } else if ("download".equals(it.action)) {
                        final long before = done[0];
                        get(base + it.path, null, out, n -> {
                            done[0] = before + n;
                            long now = System.currentTimeMillis();
                            if (now - lastSent[0] > 120) { lastSent[0] = now; progress(done[0]); }
                        });
                        done[0] = before + it.size;
                        if (!it.sha.equals(sha256(new FileInputStream(out)))) throw new IOException("checksum " + it.path);
                    }
                }
                progress(planBytes);
                stagedDir = stage.getName();
                send(state("ready").put("version", version));
            } catch (Exception e) {
                if (stage != null) deleteTree(stage);
                send(error("The download didn’t finish. Check your internet and try again."));
            } finally { busy = false; }
        });
    }

    /** Switch to the downloaded version and reload: the "refresh" the user sees. */
    @JavascriptInterface
    public void applyUpdate() {
        if (stagedDir == null || manifest == null) return;
        final String version = manifest.optString("version");
        prefs.edit()
                .putString("previous", prefs.getString("active", null))
                .putString("active", stagedDir)
                .putBoolean("pendingBoot", true).putInt("bootTries", 0)
                .putString("justUpdated", version)
                .apply();
        stagedDir = null;
        manifest = null;
        ui.post(() -> {
            web.clearCache(false);
            web.reload();
            armWatchdog();
        });
    }

    /* ---------- planning ---------- */

    /** For each file in the new version: already bundled (nothing to do), already in the current update (copy), or download. */
    private void buildPlan(JSONObject m) throws Exception {
        plan.clear();
        planBytes = 0;
        File current = activeDir();
        JSONObject files = m.getJSONObject("files");
        for (Iterator<String> keys = files.keys(); keys.hasNext(); ) {
            String path = keys.next();
            if (path.contains("..") || path.startsWith("/")) throw new IOException("bad path");
            JSONObject f = files.getJSONObject(path);
            Item it = new Item();
            it.path = path;
            it.sha = f.getString("sha256");
            it.size = f.optLong("size", 0);
            File inCurrent = current == null ? null : new File(current, path);
            if (inCurrent != null && inCurrent.isFile() && it.sha.equals(sha256(new FileInputStream(inCurrent)))) it.action = "copy";
            else if (it.sha.equals(bundledHash(path))) it.action = "none";
            else { it.action = "download"; planBytes += it.size; }
            plan.add(it);
        }
    }

    private String bundledHash(String path) {
        if (bundledHashes.containsKey(path)) return bundledHashes.get(path);
        String h = "";
        try { h = sha256(act.getAssets().open(path)); } catch (Exception ignored) { }
        bundledHashes.put(path, h);
        return h;
    }

    private String currentVersion() {
        try {
            File f = activeFile("version.json");
            InputStream in = f != null ? new FileInputStream(f) : act.getAssets().open("version.json");
            return new JSONObject(new String(readAll(in), StandardCharsets.UTF_8)).getString("version");
        } catch (Exception e) { return "0.0.0"; }
    }

    private void cleanup() {
        String keepA = prefs.getString("active", null), keepB = prefs.getString("previous", null);
        File[] dirs = root.listFiles();
        if (dirs == null) return;
        for (File d : dirs) if (!d.getName().equals(keepA) && !d.getName().equals(keepB)) deleteTree(d);
    }

    /* ---------- helpers ---------- */

    private interface Progress { void bytes(long n); }

    /** GET over https from GitHub only. Returns the body, or streams it into {@code out} when given. */
    private byte[] get(String url, String accept, File out, Progress p) throws Exception {
        URL u = new URL(url);
        boolean ok = "https".equals(u.getProtocol());
        if (ok) { ok = false; for (String h : ALLOWED_HOSTS) if (h.equals(u.getHost())) ok = true; }
        if (!ok) throw new IOException("host not allowed");
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", "GramTracker-Android");
        c.setRequestProperty("Cache-Control", "no-cache");
        if (accept != null) c.setRequestProperty("Accept", accept);
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                if (out == null) return readAll(in);
                try (OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[32768];
                    long total = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) { os.write(buf, 0, n); total += n; if (p != null) p.bytes(total); }
                }
                return null;
            }
        } finally { c.disconnect(); }
    }

    private byte[] get(String url, String accept, File out) throws Exception { return get(url, accept, out, null); }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream s = in; ByteArrayOutputStream bo = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = s.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        }
    }

    private static String sha256(InputStream in) throws Exception {
        try (InputStream s = in) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[32768];
            int n;
            while ((n = s.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        }
    }

    private static void copy(File from, File to) throws IOException {
        try (InputStream in = new FileInputStream(from); OutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static int compare(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < 3; i++) {
            int p = i < x.length ? Integer.parseInt(x[i].replaceAll("\\D", "")) : 0;
            int q = i < y.length ? Integer.parseInt(y[i].replaceAll("\\D", "")) : 0;
            if (p != q) return Integer.compare(p, q);
        }
        return 0;
    }

    private void progress(long done) {
        try { send(state("downloading").put("done", done).put("total", planBytes)); } catch (Exception ignored) { }
    }

    private static JSONObject state(String s) throws Exception { return new JSONObject().put("state", s); }

    private static JSONObject error(String msg) {
        try { return state("error").put("message", msg); } catch (Exception e) { return new JSONObject(); }
    }

    private void send(JSONObject o) {
        final String js = "window.gtNative && window.gtNative(" + o.toString() + ")";
        ui.post(() -> web.evaluateJavascript(js, null));
    }
}
