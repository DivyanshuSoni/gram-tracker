package com.gramtracker.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * window.GramNet: fetches a shop's product page (or its photo) for the "product link" feature.
 * Web pages can't read other sites themselves (CORS), so the app does the download and hands the
 * page text or image bytes back to the web app, which does all the parsing (and can be updated without a new APK).
 * Also passes along links shared to Gram Tracker from other apps (Share > Gram Tracker).
 */
public class ProductFetcher {
    private static final int MAX_BYTES = 8 * 1024 * 1024;
    private static final String UA = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";

    private final Context ctx;
    private final WebView web;
    private final ExecutorService worker = Executors.newFixedThreadPool(2);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile String shared = "";

    public ProductFetcher(Context ctx, WebView web) {
        this.ctx = ctx;
        this.web = web;
    }

    /** True when Android reports a working internet connection. */
    @JavascriptInterface
    public boolean isOnline() {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            NetworkCapabilities c = n == null ? null : cm.getNetworkCapabilities(n);
            return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } catch (Exception e) { return true; }
    }

    /** Download a page (binary=false, returns text) or an image (binary=true, returns base64); answers via window.gtNet. */
    @JavascriptInterface
    public void fetch(final String id, final String url, final boolean binary) {
        worker.submit(() -> {
            JSONObject r = new JSONObject();
            try {
                r.put("id", id);
                URL u = new URL(url);
                if (!"https".equals(u.getProtocol()) && !"http".equals(u.getProtocol())) throw new IOException("Only web links are supported");
                HttpURLConnection c = null;
                int hops = 0;
                while (true) {
                    c = (HttpURLConnection) u.openConnection();
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(25000);
                    c.setRequestProperty("User-Agent", UA);
                    c.setRequestProperty("Accept-Language", "en-IN,en;q=0.9");
                    c.setRequestProperty("Accept", binary ? "image/*" : "text/html,application/xhtml+xml,*/*;q=0.8");
                    int code = c.getResponseCode();
                    if (code >= 300 && code < 400 && c.getHeaderField("Location") != null && hops++ < 5) {
                        u = new URL(u, c.getHeaderField("Location"));
                        c.disconnect();
                        continue;
                    }
                    r.put("status", code);
                    break;
                }
                r.put("url", u.toString());
                byte[] body;
                try (InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream()) {
                    body = readCapped(in);
                } finally { c.disconnect(); }
                if (binary) {
                    r.put("type", c.getContentType());
                    r.put("base64", Base64.encodeToString(body, Base64.NO_WRAP));
                } else {
                    r.put("text", new String(body, charsetOf(c.getContentType())));
                }
                r.put("ok", r.getInt("status") < 400);
            } catch (UnknownHostException | ConnectException | SocketTimeoutException e) {
                put(r, "ok", false); put(r, "offline", true);
            } catch (Exception e) {
                put(r, "ok", false); put(r, "error", String.valueOf(e.getMessage()));
            }
            final String js = "window.gtNet && window.gtNet(" + r + ")";
            ui.post(() -> web.evaluateJavascript(js, null));
        });
    }

    /** A link shared into the app from another app, handed over once. */
    @JavascriptInterface
    public String takeShared() { String s = shared; shared = ""; return s; }

    void onShared(String text) {
        Matcher m = Pattern.compile("https?://\\S+").matcher(text == null ? "" : text);
        if (!m.find()) return;
        shared = m.group();
        ui.post(() -> web.evaluateJavascript("window.gtShared && window.gtShared()", null));
    }

    private static byte[] readCapped(InputStream in) throws IOException {
        if (in == null) return new byte[0];
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[32768];
        int n, total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > MAX_BYTES) throw new IOException("Page is too large");
            bo.write(buf, 0, n);
        }
        return bo.toByteArray();
    }

    private static Charset charsetOf(String contentType) {
        try {
            Matcher m = Pattern.compile("charset=([\\w-]+)", Pattern.CASE_INSENSITIVE).matcher(contentType == null ? "" : contentType);
            if (m.find()) return Charset.forName(m.group(1));
        } catch (Exception ignored) { }
        return StandardCharsets.UTF_8;
    }

    private static void put(JSONObject o, String k, Object v) { try { o.put(k, v); } catch (Exception ignored) { } }
}
