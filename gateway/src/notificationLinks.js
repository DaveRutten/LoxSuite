// Shared by Logs > Notifications (logs-notifications.ejs) and the topbar bell's own popover list
// (partials/notification-center-items.ejs) so the two never drift into two different definitions
// of "what page does this notification actually point at."
function notificationSourceLink(eventType, sourceId, canView) {
  if (!sourceId) return null;
  if ((eventType === 'monitor_threshold' || eventType === 'threshold_ladder') && canView('monitor')) {
    // ?open=settings auto-expands that monitor's own Chart settings drawer (see monitor-detail.ejs)
    // straight to its threshold ladder, rather than just landing on the page.
    return `/monitor/${sourceId}?open=settings`;
  }
  if ((eventType === 'miniserver_status' || eventType === 'firmware_changed') && canView('miniservers')) {
    return `/miniservers?open=${sourceId}`;
  }
  return null;
}

module.exports = { notificationSourceLink };
