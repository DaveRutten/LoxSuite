// Populates the mqtt_topic field's own <datalist id="topic-suggestions"> on both mapping "Add"
// forms (mappings-loxone-to-mqtt.ejs / mappings-mqtt-to-loxone.ejs) from currently-connected
// devices' own topics (see routes/mappings.js's /known-topics.json, backed by
// deviceDiscovery.js's activeTopics()). Fetched once, not server-rendered into the page directly,
// since "who's connected right now" is exactly the kind of thing that's already stale by the time
// a page load reaches the browser.
(function () {
  var datalist = document.getElementById('topic-suggestions');
  if (!datalist) return;

  fetch('/mappings/known-topics.json')
    .then(function (res) { return res.ok ? res.json() : { topics: [] }; })
    .then(function (data) {
      (data.topics || []).forEach(function (topic) {
        var option = document.createElement('option');
        option.value = topic;
        datalist.appendChild(option);
      });
    })
    .catch(function () {}); // no suggestions is a fine fallback — the field still works typed by hand
})();
