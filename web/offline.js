// Try again by itself every 20 seconds. Feature 4: when this device kept chats and notes, the
// page shows them instead (offline-page.js stops this timer and checks the server itself).
window.saraOfflineRetry = setTimeout(() => location.reload(), 20000);
