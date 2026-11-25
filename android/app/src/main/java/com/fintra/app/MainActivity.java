package com.fintra.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin: auto-log UPI payments from notifications.
        registerPlugin(PaymentNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
