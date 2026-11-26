package com.fintra.app;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Parcelable;
import android.provider.Telephony;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Auto-log UPI payments: Android hands this service each notification once the
 * user turns on Notification access for Fintra. Kept: notifications from UPI
 * apps, and SMS-app notifications that mention a rupee amount (bank debit SMS).
 * Anything with an OTP is never kept; every other app is ignored. Title and
 * text go into a small on-device queue that the web app reads
 * (PaymentNotificationsPlugin) and parses. Nothing leaves the phone unless the
 * user taps "Log" in Fintra.
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

    /**
     * SMS apps: bank debit SMS ("Rs.1.00 debited from A/c XX1234 to VPA …")
     * arrive for every UPI payment, even when the UPI app shows no notification.
     * The phone's default SMS app is added at runtime.
     */
    static final Set<String> SMS_PACKAGES = new HashSet<>(Arrays.asList(
        "com.google.android.apps.messaging", // Google Messages
        "com.samsung.android.messaging",     // Samsung Messages
        "com.android.mms",                   // Xiaomi / AOSP Messages
        "com.truecaller"                     // Truecaller
    ));

    /** A rupee amount: only these SMS are kept. */
    private static final Pattern MONEY =
        Pattern.compile("(₹|\\bRs\\.?|\\bINR)\\s*[\\d,]+|debited by\\s*[\\d,]+", Pattern.CASE_INSENSITIVE);
    /** One-time passwords are never stored, even with an amount in them. */
    private static final Pattern OTP =
        Pattern.compile("\\bOTP\\b|one[ -]?time password|verification code|\\bpasscode\\b|\\bCVV\\b", Pattern.CASE_INSENSITIVE);

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        String pkg = sbn.getPackageName();
        boolean upiApp = UPI_PACKAGES.contains(pkg)
            // Debug builds also accept `adb shell cmd notification post` (smoke test).
            || (isDebuggable() && "com.android.shell".equals(pkg));
        boolean smsApp = SMS_PACKAGES.contains(pkg) || pkg.equals(defaultSmsPackage());
        if (!upiApp && !smsApp) return;

        Notification n = sbn.getNotification();
        if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle extras = n.extras;
        if (extras == null) return;

        String title = text(extras.getCharSequence(Notification.EXTRA_TITLE));
        List<String> bodies = new ArrayList<>();
        // Chat-style SMS notifications list each message separately.
        Parcelable[] messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (messages != null) {
            for (Parcelable p : messages) {
                if (p instanceof Bundle) {
                    String t = text(((Bundle) p).getCharSequence("text"));
                    if (!t.isEmpty()) bodies.add(t);
                }
            }
        }
        if (bodies.isEmpty()) {
            String body = text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
            if (body.isEmpty()) body = text(extras.getCharSequence(Notification.EXTRA_TEXT));
            bodies.add(body);
        }

        for (String body : bodies) {
            if (title.isEmpty() && body.isEmpty()) continue;
            String all = title + " " + body;
            if (OTP.matcher(all).find()) continue;
            if (smsApp && !upiApp && !MONEY.matcher(all).find()) continue;
            try {
                JSONObject item = new JSONObject();
                // Same app + same text = same payment (apps re-post updates).
                item.put("id", pkg + "|" + (title + "|" + body).hashCode());
                item.put("pkg", pkg);
                item.put("kind", smsApp && !upiApp ? "sms" : "app");
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
    }

    private String defaultSmsPackage() {
        try {
            String p = Telephony.Sms.getDefaultSmsPackage(this);
            return p == null ? "" : p;
        } catch (Exception e) {
            return "";
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
