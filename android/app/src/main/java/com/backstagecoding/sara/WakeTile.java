package com.backstagecoding.sara;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * Phase 126 (docs/design/WAKE.md §4.8): the Quick Settings tile "Talk to Sara". A tap opens the app
 * (a visible screen, so Android lets it start the microphone service) and talks at once: no phrase,
 * no download, nothing listens before the tap.
 */
public class WakeTile extends TileService {
    @Override
    public void onStartListening() {
        Tile t = getQsTile();
        if (t == null) return;
        t.setState(Tile.STATE_INACTIVE);
        t.setLabel(getString(R.string.hey_tile));
        t.updateTile();
    }

    @Override
    public void onClick() {
        Intent i = new Intent(this, MainActivity.class).setAction(WakeService.ACTION_TALK).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 1265, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        else startActivityAndCollapse(i);
    }
}
