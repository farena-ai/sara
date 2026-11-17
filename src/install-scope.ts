// HANKFIX: one Sara in Settings → Apps on Windows. The logic lives in src/update-apply.ts (the update
// runner is copied and run alone, so it can't import); this is its name for everyone else.
export { duplicateInstalls, installsFromReg, readInstalls, SARA_APP_ID, scopeFor, STANDALONE_KEY, UNINSTALL_KEY, type Duplicate, type InstallEntry, type InstallScope } from './update-apply.ts';
