// Shared iOS-style on/off switch, registered as a global EJS helper (see app.locals.toggleSwitch
// in server.js) so every view can render one without its own copy of the markup — replaces the
// <select><option>Off</option><option>Activated</option></select> pattern that used to cover every
// plain boolean setting in the app (SSO/rclone/backup-schedule Enabled, MQTT TLS, Retain, HTTPS, ...).
// A checkbox underneath (not a hidden input pair) so unchecked submits exactly like an empty-string
// select option did before it — omitted from the POST body entirely, which every server route
// already treats as falsy (`req.body.x ? 1 : 0`), so no route needed changing to support this.
function toggleSwitch(name, checked, opts = {}) {
  const value = opts.value != null ? opts.value : '1';
  const id = opts.id ? ` id="${opts.id}"` : '';
  const disabled = opts.disabled ? ' disabled' : '';
  return `<label class="switch"><input type="checkbox" name="${name}" value="${value}"${id}${checked ? ' checked' : ''}${disabled}><span class="switch-track"><span class="switch-thumb"></span></span></label>`;
}

module.exports = { toggleSwitch };
