package com.fintra.app;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Auto-log UPI payments: Android hands this service each notification once the
 * user turns on Notification access for Fintra. Only notifications from UPI
 * apps are kept; their title and text go into a small on-device queue that the
 * web app reads (PaymentNotificationsPlugin) and parses. Nothing leaves the
 * phone unless the user taps "Log" in Fintra.
 */
public class PaymentNotificationListener extends NotificationListenerService {

    static final String PREFS = "fintra_upi_notifications";
    static final String KEY_QUEUE = "queue";
    private static final int MAX_QUEUE = 50;

    /** UPI apps whose notifications are read. Everything else is ignored. */
    static final Set<String> UPI_PACKAGES = new HashSet<>(Arrays.asList(
        "com.google.android.apps.nbu.paisa.user", // Google Pay
        "com.phonepe.app",                        // PhonePe
        "net.one97.paytm",                        // Paytm
        "in.org.npci.upiapp"                      // BHIM
    ));

    /** Set while the app is open, so new payments show up straight away. */
    static volatile PaymentNotificationsPlugin activePlugin;

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        String pkg = sbn.getPackageName();
        boolean allowed = UPI_PACKAGES.contains(pkg)
            // Debug builds also accept `adb shell cmd notification post` (smoke test).
            || (isDebuggable() && "com.android.shell".equals(pkg));
        if (!allowed) return;

        Notification n = sbn.getNotification();
        if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle extras = n.extras;
        if (extras == null) return;

        String title = text(extras.getCharSequence(Notification.EXTRA_TITLE));
        String body = text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        if (body.isEmpty()) body = text(extras.getCharSequence(Notification.EXTRA_TEXT));
        if (title.isEmpty() && body.isEmpty()) return;

        try {
            JSONObject item = new JSONObject();
            // Same notification + same text = same payment (apps re-post updates).
            item.put("id", pkg + "|" + sbn.getKey() + "|" + (title + body).hashCode());
            item.put("pkg", pkg);
            item.put("title", title);
            item.put("text", body);
            item.put("postedAt", sbn.getPostTime());
            if (enqueue(this, item)) {
                PaymentNotificationsPlugin plugin = activePlugin;
                if (plugin != null) plugin.onCaptured(item);
            }
        } catch (JSONException ignored) {
        }
    }

    private boolean isDebuggable() {
        return (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private static String text(CharSequence cs) {
        return cs == null ? "" : cs.toString().trim();
    }

    /** Adds to the queue unless already there. Returns true when added. */
    static synchronized boolean enqueue(Context ctx, JSONObject item) throws JSONException {
        JSONArray queue = readQueue(ctx);
        String id = item.getString("id");
        for (int i = 0; i < queue.length(); i++) {
            if (id.equals(queue.getJSONObject(i).optString("id"))) return false;
        }
        queue.put(item);
        while (queue.length() > MAX_QUEUE) queue.remove(0);
        prefs(ctx).edit().putString(KEY_QUEUE, queue.toString()).apply();
        return true;
    }

    static synchronized JSONArray readQueue(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString(KEY_QUEUE, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    /** Removes handled items (logged or skipped in the app). */
    static synchronized void remove(Context ctx, Set<String> ids) {
        JSONArray queue = readQueue(ctx);
        JSONArray kept = new JSONArray();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject o = queue.optJSONObject(i);
            if (o != null && !ids.contains(o.optString("id"))) kept.put(o);
        }
        prefs(ctx).edit().putString(KEY_QUEUE, kept.toString()).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
