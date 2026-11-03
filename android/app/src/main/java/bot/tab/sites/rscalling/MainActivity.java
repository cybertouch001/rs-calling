package bot.tab.sites.rscalling;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.CallLog;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * R&S Calling: the caller's list and the admin screens are the bundled web app (served from the APK at the server's own
 * address, so it opens even without internet; data goes to the server's API). This shell adds what the web can't do:
 * placing the call and reading the phone's call history to check each call placed from the app (number, start time,
 * talk time). Nothing is recorded; only the call-log rows of calls placed from the app are sent.
 */
public class MainActivity extends Activity {
    static final String SERVER = BuildConfig.SERVER;
    static final String START = SERVER + "/app/";
    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private static final int REQ_PERMS = 7, REQ_FILE = 41;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0b2545"));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setupWeb();
        if (state == null || web.restoreState(state) == null) web.loadUrl(START);
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    private void setupWeb() {
        if (BuildConfig.WEB_DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " RSCallingAndroid/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new Bridge(), "RSC");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl(); String x = u.toString();
                if (x.startsWith(SERVER + "/app") || x.startsWith(SERVER + "/api/")) return false;
                openExternal(u); return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl(); String x = u.toString();
                if (!"GET".equals(req.getMethod()) || !x.startsWith(SERVER + "/app/")) return null;
                String path = u.getPath(); if (path == null) return null;
                String rel = path.substring(1); if (rel.endsWith("/")) rel += "index.html";
                if (rel.contains("..")) return null;
                try {
                    InputStream in = getAssets().open(rel);
                    Map<String, String> h = new HashMap<>(); h.put("Cache-Control", "no-cache"); h.put("Access-Control-Allow-Origin", SERVER);
                    return new WebResourceResponse(mime(rel), rel.endsWith(".js") || rel.endsWith(".css") || rel.endsWith(".html") ? "utf-8" : null, 200, "OK", h, in);
                } catch (Exception e) { return null; }   // not bundled: load from the server
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT); i.addCategory(Intent.CATEGORY_OPENABLE); i.setType("*/*");
                try { startActivityForResult(Intent.createChooser(i, "Choose file"), REQ_FILE); } catch (ActivityNotFoundException e) { fileCb = null; return false; }
                return true;
            }
        });
    }

    static String mime(String p) {
        if (p.endsWith(".html")) return "text/html"; if (p.endsWith(".js")) return "application/javascript"; if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png"; if (p.endsWith(".svg")) return "image/svg+xml"; if (p.endsWith(".json")) return "application/json"; return "application/octet-stream";
    }

    private void openExternal(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { Toast.makeText(this, "No app found to open this link", Toast.LENGTH_SHORT).show(); }
    }

    private boolean has(String p) { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

    @Override protected void onResume() {
        super.onResume();
        web.postDelayed(() -> web.evaluateJavascript("window.rscOnResume && window.rscOnResume()", null), 300);
    }

    @Override public void onRequestPermissionsResult(int code, String[] p, int[] r) {
        web.evaluateJavascript("window.rscOnPermissions && window.rscOnPermissions()", null);
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE && fileCb != null) {
            Uri[] r = null; if (res == RESULT_OK && data != null && data.getData() != null) r = new Uri[]{ data.getData() };
            fileCb.onReceiveValue(r); fileCb = null; return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }

    /** What the web app can call: window.RSC.* */
    class Bridge {
        @JavascriptInterface public String server() { return ""; }   // same origin: the web app uses relative /api/ paths
        @JavascriptInterface public String version() { return BuildConfig.VERSION_NAME; }
        @JavascriptInterface public String deviceName() { return (Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE).trim(); }
        @JavascriptInterface public void setLoggedIn(boolean b) { }
        @JavascriptInterface public String permissions() {
            try {
                JSONObject o = new JSONObject();
                o.put("call_log", has(Manifest.permission.READ_CALL_LOG)); o.put("call_phone", has(Manifest.permission.CALL_PHONE)); o.put("phone_state", has(Manifest.permission.READ_PHONE_STATE));
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public void requestPermissions() {
            runOnUiThread(() -> MainActivity.this.requestPermissions(new String[]{ Manifest.permission.READ_CALL_LOG, Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE }, REQ_PERMS));
        }
        @JavascriptInterface public void call(String number) {
            final String n = number == null ? "" : number.replaceAll("[^0-9+]", "");
            runOnUiThread(() -> {
                Uri u = Uri.parse("tel:" + n);
                try {
                    if (has(Manifest.permission.CALL_PHONE)) startActivity(new Intent(Intent.ACTION_CALL, u));
                    else startActivity(new Intent(Intent.ACTION_DIAL, u));
                } catch (Exception e) {
                    try { startActivity(new Intent(Intent.ACTION_DIAL, u)); } catch (Exception e2) { Toast.makeText(MainActivity.this, "This device can't make calls", Toast.LENGTH_LONG).show(); }
                }
            });
        }
        /** Outgoing/incoming call-log rows since a time (ms). Only used to match calls placed from the app. */
        @JavascriptInterface public String readCallLog(String since) {
            JSONArray a = new JSONArray();
            if (!has(Manifest.permission.READ_CALL_LOG)) return a.toString();
            long t = 0; try { t = Long.parseLong(since); } catch (Exception ignored) { }
            String[] proj = { CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE };
            try (Cursor c = getContentResolver().query(CallLog.Calls.CONTENT_URI, proj, CallLog.Calls.DATE + " >= ?", new String[]{ String.valueOf(t) }, CallLog.Calls.DATE + " ASC")) {
                if (c != null) {
                    int k = 0;
                    while (c.moveToNext() && k++ < 300) {
                        JSONObject o = new JSONObject();
                        o.put("number", c.getString(0)); o.put("date", c.getLong(1)); o.put("duration", c.getLong(2));
                        int ty = c.getInt(3);
                        o.put("type", ty == CallLog.Calls.OUTGOING_TYPE ? "outgoing" : ty == CallLog.Calls.INCOMING_TYPE ? "incoming" : ty == CallLog.Calls.MISSED_TYPE ? "missed" : "other");
                        a.put(o);
                    }
                }
            } catch (Exception e) { /* return what we have */ }
            return a.toString();
        }
        /** Save an export (Excel / PDF) to Downloads and open it. */
        @JavascriptInterface public void saveFile(String b64, String name, String mime) {
            try {
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT); Uri uri;
                String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues(); v.put(MediaStore.Downloads.DISPLAY_NAME, safe); v.put(MediaStore.Downloads.MIME_TYPE, mime);
                    uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    try (OutputStream o = getContentResolver().openOutputStream(uri)) { o.write(bytes); }
                } else {
                    File d = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS); File f = new File(d, safe);
                    try (FileOutputStream o = new FileOutputStream(f)) { o.write(bytes); }
                    uri = null;
                    runOnUiThread(() -> Toast.makeText(MainActivity.this, "Saved: " + f.getAbsolutePath(), Toast.LENGTH_LONG).show());
                }
                final Uri fu = uri;
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, "Saved to Downloads: " + safe, Toast.LENGTH_LONG).show();
                    if (fu != null) try { Intent i = new Intent(Intent.ACTION_VIEW); i.setDataAndType(fu, mime); i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); startActivity(i); } catch (Exception ignored) { }
                });
            } catch (Exception e) { runOnUiThread(() -> Toast.makeText(MainActivity.this, "Could not save the file", Toast.LENGTH_LONG).show()); }
        }
    }
}
