// 3.0.3: the one place the web app names where sign-in codes for a new phone or computer are made.
// Settings → Connections → Devices and sign-in (page id dh-devices; it sat under Data & health before).
// The desktop apps (desktop/windows/src/main.cpp, desktop/mac/Sources/main.swift), the phone apps and
// the server's `approveIn` repeat the same words; test/devices-findable.test.ts keeps them in step.
export const DEVICES_PAGE = 'dh-devices';
/** "Settings → Connections → Devices and sign-in" in the app's language. */
export const devicesPath = (t) => t('Settings → Connections → Devices and sign-in');
