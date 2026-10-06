// Fields that only matter for a certain choice: data-show-if on the field's wrapper.
//   data-show-if="fuel_auto"            shown while the checkbox/switch fuel_auto is on
//   data-show-if="!fuel_auto"           shown while it is off
//   data-show-if="source=entsoe"        shown while select/radio "source" is entsoe
//   data-show-if="climate_mode=log|on"  one of several values
//   data-show-if="cost_mode=hourly&solar_value=fixed"  all of several rules
// The control is looked up by name in the same form (else the page). Hidden fields keep their value.
(function () {
  function ctrl(scope, name) { return scope.querySelector('[name="' + name + '"]') || document.querySelector('[name="' + name + '"]'); }
  function valueOf(scope, name) {
    var els = scope.querySelectorAll('[name="' + name + '"]');
    if (!els.length) els = document.querySelectorAll('[name="' + name + '"]');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.type === 'checkbox') return e.checked ? (e.value || 'on') : '';
      if (e.type === 'radio') { if (e.checked) return e.value; continue; }
      if (e.type !== 'hidden') return e.value;
    }
    return '';
  }
  function visible(el) {
    var scope = el.closest('form') || document;
    return el.getAttribute('data-show-if').split('&').every(function (r) { return ruleOn(scope, r.trim()); });
  }
  function ruleOn(scope, rule) {
    var neg = rule.charAt(0) === '!';
    if (neg) rule = rule.slice(1);
    var eq = rule.indexOf('=');
    var on;
    if (eq === -1) on = !!valueOf(scope, rule);
    else on = rule.slice(eq + 1).split('|').indexOf(valueOf(scope, rule.slice(0, eq))) !== -1;
    return neg ? !on : on;
  }
  function apply() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-show-if]'), function (el) { el.hidden = !visible(el); });
  }
  document.addEventListener('change', function (e) { if (e.target && e.target.name) apply(); });
  document.addEventListener('input', function (e) { if (e.target && e.target.name && e.target.type === 'text') apply(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
  window.lsShowIf = apply;
})();
