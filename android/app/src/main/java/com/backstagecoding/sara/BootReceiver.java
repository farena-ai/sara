package com.backstagecoding.sara;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After the phone restarts: turn instant notifications back on if they were on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            LiveInbox.sync(c.getApplicationContext());
            // Proximity alerts don't survive a restart: set them again.
            Places.syncAsync(c);
            // Phase 126: Hey Sara never starts by itself after a restart (Android 14+ forbids it): it asks.
            WakeService.afterBoot(c);
        }
    }
}
