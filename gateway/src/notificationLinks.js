// Shared by Logs > Notifications (logs-notifications.ejs) and the topbar bell's own popover list
// (partials/notification-center-items.ejs) so the two never drift into two different definitions
// of "what page does this notification actually point at."
function notificationSourceLink(eventType, sourceId, canView) {
  // Ollama model-pull completions (see ollamaPullState.js) are a background, app-wide signal, not
  // tied to any one row — hence no sourceId to key off, unlike every other case below. Still worth
  // a link back to where that model actually gets managed.
  if (eventType === 'ai_ollama_pull' && canView('ai_chat')) return '/admin/ai';
  if (!sourceId) return null;
  if ((eventType === 'monitor_threshold' || eventType === 'threshold_ladder') && canView('monitor')) {
    // ?open=settings auto-expands that monitor's own Chart settings drawer (see monitor-detail.ejs)
    // straight to its threshold ladder, rather than just landing on the page.
    return `/monitor/${sourceId}?open=settings`;
  }
  if ((eventType === 'miniserver_status' || eventType === 'firmware_changed') && canView('miniservers')) {
    return `/miniservers?open=${sourceId}`;
  }
  if ((eventType === 'battery_weak' || eventType === 'device_firmware_changed' || eventType === 'device_offline') && canView('hardware')) {
    return `/hardware?miniserver_id=${sourceId}`;
  }
  return null;
}

module.exports = { notificationSourceLink };
