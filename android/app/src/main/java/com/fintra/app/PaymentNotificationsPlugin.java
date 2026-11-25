package com.fintra.app;

import android.content.ComponentName;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Bridge between PaymentNotificationListener and the web app.
 *  isEnabled()      → { enabled } Notification access is on for Fintra
 *  openSettings()   → opens Android's Notification access page
 *  getPending()     → { items: [{ id, pkg, title, text, postedAt }] }
 *  remove({ ids })  → drops handled items from the queue
 *  event "captured" → a new UPI notification while the app is open
 */
@CapacitorPlugin(name = "PaymentNotifications")
public class PaymentNotificationsPlugin extends Plugin {

    @Override
    public void load() {
        PaymentNotificationListener.activePlugin = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (PaymentNotificationListener.activePlugin == this) PaymentNotificationListener.activePlugin = null;
    }

    void onCaptured(JSONObject item) {
        try {
            notifyListeners("captured", JSObject.fromJSONObject(item));
        } catch (JSONException ignored) {
        }
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        boolean enabled = NotificationManagerCompat.getEnabledListenerPackages(getContext())
            .contains(getContext().getPackageName());
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            intent.putExtra(
                Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                new ComponentName(getContext(), PaymentNotificationListener.class).flattenToString()
            );
        } else {
            intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (Exception e) {
            // Some phones lack the detail page; fall back to the list.
            Intent list = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
            list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(list);
        }
        call.resolve();
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSONArray queue = PaymentNotificationListener.readQueue(getContext());
        JSObject ret = new JSObject();
        try {
            ret.put("items", new JSArray(queue.toString()));
        } catch (JSONException e) {
            ret.put("items", new JSArray());
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        JSArray ids = call.getArray("ids");
        Set<String> set = new HashSet<>();
        if (ids != null) {
            for (int i = 0; i < ids.length(); i++) {
                String id = ids.optString(i, null);
                if (id != null) set.add(id);
            }
        }
        PaymentNotificationListener.remove(getContext(), set);
        call.resolve();
    }
}
