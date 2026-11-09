// Phase 115 (BR1 B3): the step words, shared. The pure part of the step line (a tool name and its
// arguments → "Running the tests…" / "Ran the tests" / an icon key), with no DOM, so the web step
// line (web/steps.js) and the chat apps' progress message (src/bridges/progress.ts) use the same
// verbs in the same six languages. The translate function is passed in.

const TEST_CMD = /(^|[;&|(\s])(npm (run )?(test|check)\b|npm t\b|yarn test|pnpm (run )?test|bun test|node (--\S+ )*--test\b|npx (jest|vitest|mocha)\b|jest\b|vitest\b|pytest\b|python3? -m (pytest|unittest)\b|cargo test\b|go test\b|deno test\b|make (check|test)\b|dotnet test\b)/;

/**
 * The words for one step: [while running, when done, icon]. Known tools read as everyday verbs;
 * others fall back to their plain name (TOOL_NAME in app.js, passed as `named`) or the raw name.
 * `t` translates (the app's t() in the browser, src/i18n.ts tr() on the server).
 */
export function stepWordsWith(t, name, args = {}, named = '') {
  const a = args ?? {};
  const cmd = String(a.command ?? a.url ?? '');
  const act = String(a.action ?? '');
  const pair = (now, done, icon) => [now, done, icon];
  if (/\bwttr\.in\b/i.test(cmd) && (name === 'shell' || name === 'web_fetch')) return pair(t('Checking the weather…'), t('Checked the weather'), 'weather');
  switch (name) {
    case 'shell':
      if (TEST_CMD.test(cmd)) return pair(t('Running the tests…'), t('Ran the tests'), 'flask');
      if (/^\s*git\b/.test(cmd)) return pair(t('Checking the project…'), t('Checked the project'), 'branch');
      if (/\b(npm|pnpm|yarn) (i|install|ci|add)\b|\bpip3? install\b/.test(cmd)) return pair(t('Installing packages…'), t('Installed packages'), 'package');
      if (/\b(npm run build|make\b|tsc\b|cargo build|go build|vite build)/.test(cmd)) return pair(t('Building the project…'), t('Built the project'), 'wrench');
      return pair(t('Running a command…'), t('Ran a command'), 'terminal');
    case 'todo':
      if (act === 'add') return pair(t('Adding a to-do…'), t('Added a to-do'), 'todo');
      if (act === 'done') return pair(t('Ticking off a to-do…'), t('Ticked off a to-do'), 'todo');
      if (act === 'list') return pair(t('Looking at your to-dos…'), t('Looked at your to-dos'), 'todo');
      return pair(t('Updating your to-dos…'), t('Updated your to-dos'), 'todo');
    case 'remind':
      if (act === 'set') return pair(t('Setting a reminder…'), t('Set a reminder'), 'reminder');
      if (act === 'cancel') return pair(t('Cancelling a reminder…'), t('Cancelled a reminder'), 'reminder');
      return pair(t('Checking your reminders…'), t('Checked your reminders'), 'reminder');
    case 'note':
      if (act === 'save') return pair(t('Saving a note…'), t('Saved a note'), 'note');
      return pair(t('Looking through your notes…'), t('Looked through your notes'), 'note');
    case 'recall':
      return pair(t('Looking back at past chats…'), t('Looked back at past chats'), 'recall');
    case 'web_search':
      return pair(t('Searching the web…'), t('Searched the web'), 'search');
    // Phase 100: other agents (A2A).
    case 'a2a_send':
      return pair(t('Asking {name}…', { name: String(a.peer ?? '') }), t('Asked {name}', { name: String(a.peer ?? '') }), 'globe');
    case 'a2a_reply':
      return pair(t('Answering {name}…', { name: String(a.peer ?? t('the agent')) }), t('Answered the agent'), 'globe');
    case 'a2a_status':
      return pair(t('Checking on a task…'), t('Checked on a task'), 'globe');
    case 'a2a_cancel':
      return pair(t('Canceling a task…'), t('Canceled a task'), 'globe');
    case 'a2a_agents':
      return pair(t('Looking at the agents she can ask…'), t('Looked at the agents she can ask'), 'globe');
    case 'web_fetch':
      return pair(t('Reading a web page…'), t('Read a web page'), 'globe');
    case 'calendar_events':
      return pair(t('Looking at your calendar…'), t('Looked at your calendar'), 'calendar');
    case 'calendar_add':
      return pair(t('Adding to your calendar…'), t('Added to your calendar'), 'calendar');
    case 'read_file':
      return pair(t('Reading a file…'), t('Read a file'), 'file');
    case 'write_file':
      return pair(t('Writing a file…'), t('Wrote a file'), 'file-edit');
    case 'edit_file':
      return pair(t('Editing a file…'), t('Edited a file'), 'file-edit');
    case 'list_dir':
    case 'search':
    case 'code_map':
    case 'code_find':
    case 'code_refs':
    case 'code_deps':
      return pair(t('Looking through the files…'), t('Looked through the files'), 'files');
    case 'home_status':
      return pair(t('Checking your home…'), t('Checked your home'), 'home');
    case 'home_control':
      return pair(t('Changing something at home…'), t('Changed something at home'), 'home');
    case 'spotify_search':
    case 'spotify_now_playing':
    case 'spotify_my_playlists':
    case 'spotify_top':
    case 'spotify_devices':
      return pair(t('Looking on Spotify…'), t('Looked on Spotify'), 'music');
    case 'spotify_playlist_create':
    case 'spotify_playlist_add':
      return pair(t('Changing a playlist…'), t('Changed a playlist'), 'music');
    case 'spotify_playback':
      return pair(t('Changing the music…'), t('Changed the music'), 'play');
    case 'take_photo':
      return pair(t('Making a picture…'), t('Made a picture'), 'photo');
    case 'share_photo':
      return pair(t('Picking a picture…'), t('Sent a picture'), 'photo');
    case 'moments':
      return pair(t('Looking through your moments…'), t('Looked through your moments'), 'moments');
    case 'start_job':
      return pair(t('Starting a background task…'), t('Started a background task'), 'job');
    case 'job_status':
      return pair(t('Checking a background task…'), t('Checked a background task'), 'job');
    case 'gmail_search':
    case 'gmail_read':
    case 'gmail_thread':
    case 'gmail_needs_answer':
      return pair(t('Checking your email…'), t('Checked your email'), 'mail');
    case 'gmail_draft':
      return pair(t('Writing an email draft…'), t('Wrote an email draft'), 'mail');
    case 'gmail_send':
      return pair(t('Sending an email…'), t('Sent an email'), 'mail');
    case 'git':
      return pair(t('Checking the project…'), t('Checked the project'), 'branch');
    case 'git_commit':
      return pair(t('Saving a checkpoint…'), t('Saved a checkpoint'), 'branch');
    case 'git_push':
      return pair(t('Sending work to GitHub…'), t('Sent work to GitHub'), 'branch');
    case 'library':
      return pair(t('Reading your documents…'), t('Read your documents'), 'book');
    // Phase 96: her skills (how-tos she follows).
    case 'skill_use':
      return pair(t('Opening a skill…'), t('Used skill: {name}', { name: String(a.name ?? '') }), 'book');
    case 'skill_read':
      return pair(t('Reading a skill file…'), t('Read a skill file'), 'book');
    case 'skill_find':
      return pair(t('Looking for a skill…'), t('Looked for a skill'), 'search');
    case 'skill_run':
      return pair(t("Running a skill's script…"), t("Ran a skill's script"), 'terminal');
    case 'skill_save':
    case 'recipe_save':
      return pair(t('Saving a skill…'), t('Saved a skill'), 'book');
    case 'skill_update':
      return pair(t('Changing a skill…'), t('Changed a skill'), 'book');
    case 'settings_guide':
      return pair(t('Looking up how the app works…'), t('Looked up how the app works'), 'help');
    // Phase 115: a file she shares into the chat.
    case 'send_file':
      return pair(t('Sharing a file…'), t('Shared a file'), 'file');
    case 'preview_start':
      return pair(t('Starting a preview…'), t('Started a preview'), 'monitor');
    default:
      if (/^browser_/.test(name)) return pair(t('Using her test browser…'), t('Used her test browser'), 'compass');
      return [t('Using {tool}…', { tool: named || name }), t('Used {tool}', { tool: named || name }), 'tool'];
  }
}
