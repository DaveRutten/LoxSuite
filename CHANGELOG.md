# Changelog

All notable changes to this project are documented in this file.

## [0.54.1-alpha.1] - 2026-10-09

### Fixed
- **"Without the ferry" didn't change the distance, and said no route without it was possible** (asked: "the
  distance doesn't seem to be calculated again when I choose without the ferry" — "it says a route isn't possible
  without the ferry, but that's nonsense: Bergen (L) to Vierlingsbeek can take the ferry, but also the bridge at
  Well"): the public OSRM servers refuse to leave out ferries, toll roads or motorways ("Exclude flag combination
  is not supported"), so LoxSuite got the plain route back. A route that avoids something is now asked from
  **Valhalla** (the FOSSGIS server, OpenStreetMap data too), which says per route whether it still takes a
  ferry, toll road or motorway — Bergen (L) → Vierlingsbeek: 2.3 km with the ferry, 18.7 km over the bridge at
  Well without. Without route options it stays OSRM, as before. Distance, travel time, kWh and leave time follow;
  routes cached by 0.54.0 with route options are looked up again.
  - *Not possible on this route* now only shows when there really is no other way (an island). When the route
    service can't be reached, the appointment says so instead, keeps the plain route's distance meanwhile and
    tries again later.
- **Chips keep their size** (asked: "the button size still jumps when I switch it on or off, like the ferry —
  mainly the height"): every chip has the same height and weight on or off, and an on/off chip (*without the
  ferry*, *Route: avoid* in the settings) has its tick box there both ways — only the tick appears. The first
  letter of each chip and the chips next to it stay where they are.

## [0.54.0-alpha.1] - 2026-10-09

### Added
- **Route options** (asked: "the shortest route to this appointment is over the ferry — but that must be a choice,
  just like toll roads"): the route can avoid **ferries**, **toll roads** and **motorways**.
  - **Default** for every address in the agenda settings (*Route: avoid*, chips; nothing = the shortest route).
  - **Per address**: where an appointment's route takes one of them (or you avoid it), the appointment shows one
    *Route* row with a chip per kind — *without the ferry*, *without toll roads*, *without motorways* — on or off,
    for every appointment at that address; ↺ back to the default. Only what the route actually takes is shown, so
    the row stays out of the way, and another kind later is just another chip. When no route without it exists the
    appointment says so.
  - The distance, travel time, kWh and leave time follow the chosen route; each set of options is cached on its
    own (the address is looked up once), drives between appointments use the options of both addresses (avoiding
    wins), and addresses looked up before are checked once more to see what their route takes.
- **Which car** (asked: "in the agenda you must be able to choose car x or y when there are several cars in
  LoxSuite"): with more than one car an appointment has a *Which car* row, for that day or the whole series
  (linked by name, like the other choices). Default: the calendar's car, else the first. Smart charging plans the
  drive for that car (its consumption and battery), and its plug-in reminders only for that car.
- **A calendar's name, colour and car** can be changed under Settings → Calendars (asked: "the calendar colour must
  be adjustable in the settings, and the name too"): click the name or ✏️ — stored in LoxSuite only, the calendar
  itself isn't changed. The colour is a small square that opens the colour picker (also when adding a calendar).

### Changed
- **Shorter appointment details** (asked: "the texts on the screen more concise, no fuss — and think again about
  those drop-down menus"): the drop-downs are now rows of chips with short labels — *Car needed* yes / no, *Trip*
  there and back / drop off / pick up / drop off and pick up, *After dropping off* back home / drive on to …,
  *Afterwards* back home / drive on to … / via …, then home. A row only shows when it matters (no *after* rows
  without a next appointment), where a choice comes from (*from the calendar*, *from the series*) is a small note
  instead of an extra option, and ↺ goes back to the series or to automatic instead of a *default* entry.
- **Today stands out** in the agenda (asked: "today could have had a shading, now only the number is green"): a
  light tint over the whole day in the week, day and month view, and the date in a filled dot.
- The numbers under it: *Basis* shows the whole sum (e.g. *4 × 47 km + 40 km margin* for drop off and pick up)
  instead of a separate distance row, and the travel time reads *Leave (41 min drive)*.

## [0.53.0-alpha.1] - 2026-10-08

### Added
- **Change a learned departure** (asked: "move, change or delete the learned departure lines — in a good way, so
  that everything gets better from it"): the "ready" lines in the agenda's week and day view are handles.
  - **Drag** a line up or down (5 minutes a step) to move that one day; **click** it for the details: what it is
    based on (learned ready time, when it usually leaves, confidence) and *only this day* / *on every Monday* — a
    time, *No departure*, or back (*As usual* / *Back to learned*).
  - **Only this day** plans with your time that day — also on a day off (away, holiday, working from home), where
    the plan otherwise doesn't count on a departure — or with no departure that day.
  - **Every week**: your own time for that weekday, or *no usual departure* on it (also on the Learned page: "-"
    in *Own time*).
  - **It learns from it**: a corrected day that has passed counts as what really happened on that day (a real
    departure that morning goes first), so the learned pattern follows what you tell it; the Learned page shows
    how many of a weekday's departures were your corrections. Change the same weekday a few times (twice or more in
    eight weeks, within half an hour) and the details offer to make it your time for every week.
  - The lines show where they come from: learned (gray, dashed), your own every week (violet, dashed), changed for
    this day (violet, solid), no departure (faint, struck through), a day off (faint) — with a legend.
- The "left before it was ready" correction (the learned time moves earlier) now only learns from departures
  LoxSuite planned with its learned time — not from a time you set or an agenda appointment.

## [0.52.1-alpha.1] - 2026-10-08

### Changed
- **Keys in every legend** (asked: "in the details overview it would help to see that import from the grid is the
  pink stripe and solar surplus the yellow one — for all legends"): a key shaped like the mark it stands for — a
  stripe for a line, a square for columns, a dashed stripe for a dashed line, a light block for a band
  (`LsChart.key`, `.ls-key` in style.css).
  - **Smart charging**: the summary when you point (price, planned, battery level, solar surplus, import from the
    grid), the details of a tapped hour, and the panel legends (solar surplus and the battery as a line, not a
    square).
  - **Energy manager**: the summary when you point (columns and bars as squares, solar as a stripe) and the details
    of an hour.
  - **Meters**: solar and house as stripes, the Wallbox, import and export as squares.
  - **Learned**: the solar forecast (expected stripe, low – high as a light block, now with a legend under the
    chart), the last days (measured yield square, the forecast stripe) and the house profile (workday stripe,
    weekend dashed).

## [0.52.0-alpha.1] - 2026-10-08

### Changed
- **Negative prices in the charts** (asked: "have you taken into account that the hour / quarter prices are
  sometimes negative — mainly the display?"): the planning already took a negative price as the cheapest, but the
  charts drew it as a sliver (Smart charging) or almost invisible (energy manager). Now the price scale runs from the
  lowest price to the highest, a negative price hangs below a zero line in green (*negative price* in the legend),
  the details say *negative: you are paid to use power*, and an amount below zero reads as −€ 0,05. Note: the charts
  show the all-in price (with energy tax), which is only negative when the market price is below about −€ 0,10.
- **The energy manager's plan in the same style as the other energy charts** (asked: "the heatmap in the same
  style, and more detail than blocks of an hour"; "the texts fall over the heatmap"): lanes over one time axis with
  each label above its lane (never over the data, long names cut off); the price per quarter as soft columns, the
  solar surplus as a smooth line with a light wash, the car's planned charging at its real times (e.g. 13:00–13:32)
  instead of whole hours, and per consumer a run of hours as one bar — on/off neutral gray, a setpoint up or down in
  orange / blue with its value inside. Hours, days, midnight and *now* like Smart charging; point at it for a summary
  per quarter, tap for the details of that hour (highlighted). The consumers themselves are still planned per hour.

## [0.51.1-alpha.1] - 2026-10-08

### Fixed
- **Telegram stopped working** ("Bad Request: can't parse entities: Can't find end of the entity starting at byte
  offset 29"): the Docker image installs the newest apprise, and apprise 2.0 now converts the text it gets into
  Telegram's own Markdown itself — it made the title bold and escaped LoxSuite's own Markdown again, so Telegram
  found a bold that never ended. LoxSuite now hands apprise 2 plain Markdown (`-i markdown`) with every special
  character escaped, the title without formatting (apprise makes it bold) and the field labels in italics, and asks
  for MarkdownV2 (where an escaped character inside bold text stays escaped — legacy Markdown ends the bold there).
  With apprise 1.x it sends as before. A Telegram URL with its own `format=` is left alone.
- The Docker image stays on apprise 2.x (`apprise>=2.0.1,<3`), so a next major can't change this unnoticed.

## [0.51.0-alpha.1] - 2026-10-07

### Changed
- **A series is linked by name** (asked: "a series that is always on Monday, moved to Tuesday some weeks — the
  setting should go along, but it seems to land on the appointment I always have on Tuesday"): the calendar keeps a
  series' ID on its weekday, so two appointments swapped by renaming them took each other's choices. What you choose
  *for the whole series* now counts for every appointment in that calendar with the same name — the name without
  markers, emoji and punctuation, "&" / "+" / "and" = "en" ("Opvang bij opa & oma" = "Opvang bij opa en oma").
  - An appointment renamed to the name of another series follows that series (the details say *Linked by name to the
    series "…"*); one renamed to a name of its own keeps its own series.
  - Separate appointments with the same name (every week a new one) are a series too.
  - Choices made earlier for a series (stored per calendar ID) follow the name as well; setting it again stores it by
    name and replaces the day choices of every appointment with that name.
- **This day or the whole series, first**: for a repeating appointment the details start with *only this day* /
  *the whole series*; the dropdowns show what is chosen for that, and a change is saved straight away (before, a
  second step appeared below the dropdowns — easy to miss, and then nothing was saved, so choosing *default* again
  seemed not to be accepted).
- **Default for one day**: with *only this day*, *as the series — …* follows the series, and *default — …* gives the
  default for that day even when the series has a choice (before, *default* for one day fell back to the series).
- **Drop off and pick up stand out in the week view**: a solid band with 🚗 *drop off* / *pick up* and the time at
  the start and the end, the time in between light with a dashed edge (the car is home then); *the car stays there*
  stays one solid block. Also in the legend.

## [0.50.0-alpha.1] - 2026-10-07

### Changed
- **Own solar in Smart charging** (asked: "tomorrow you charge at 9.6 kW at 14:00 with only 2.6 kW of solar — why
  not the minimum power there, and at 16:00 with 4.4 kW expected surplus another hour at the minimum?"): with net
  metering a kWh of solar counted as exactly the price of that hour, so the plan saw no reason to use it — the
  cheapest quarters got full power from the grid, and the sunny 16:00 counted as its price, above the plug-in
  hybrid's fuel break-even, so it was skipped. Now:
  - **Prefer own solar** (€/kWh, default 0.05) counts for Smart charging too — it was an energy manager setting
    only; it moved to *Settings → Energy → Smart charging*, next to *Value of exported solar* (an existing value is
    taken over). Own solar counts that much cheaper than what exporting it yields — for your supplier's feed-in
    costs, or because you would rather use it yourself. A sunny hour then runs at the minimum power before grid
    power is added in an equally cheap hour, and a sunny hour can fall below the price cap.
  - **Net metering ends on 1 January 2027**: *Net metering until the end of 2026, then the market price* — from
    that moment solar automatically counts as the bare market price of that hour (without energy tax and VAT;
    derived from the all-in price when the source has no market price). New option *Market price of that moment
    (no net metering)*; the feed-in tariff field shows only with *Fixed feed-in tariff*.
  - One valuation (`src/solarValue.js`) for Smart charging, the energy manager, the "plug in" reminder and the
    charging costs on *Driving & costs*.
  - Tap an hour in the Smart charging chart: the solar tile says what a kWh of own solar counts as there.

## [0.49.0-alpha.1] - 2026-10-07

### Changed
- **One chart style in the whole energy part** (asked for: Meters still had hard lines; "the same style
  everywhere"): a shared `public/ls-chart.js` (smooth lines that never overshoot, a light wash below, soft columns
  with a rounded end, hairline grid, a crosshair with a summary when you point at a chart) and one palette for all
  energy charts (`--en-*` in style.css, light and dark, checked to be told apart — also with colour blindness):
  solar yellow, import from the grid red, export green, the car / Wallbox blue, the house gray, the battery and
  *ready by* violet, the price gray.
  - **Meters**: solar as a smooth line with a wash, the house as a calm line, import / Wallbox / export as soft
    columns (export below zero, rounded at the bottom); point at an hour for all values of that hour; the tiles show
    their value in text color with a color key.
  - **Smart charging**: planned hours and charging in the car's blue (as in the energy manager), import red.
  - **Energy manager**: the same colors in the plan; the expected kWh per hour of a consumer as a smooth line.
  - **Consumer page**: the last 48 hours as soft blocks on a light track, kWh per hour as soft columns.
  - **Learned**: the solar forecast as a smooth line in a light band (low – high) and the yield per day as soft
    columns; the house profile (workday solid, weekend dashed) smooth; point at both for the values.
  - **Driving & costs**: km per month as soft stacked columns, the consumption per month as a smooth line with dots.
  - **Charge log**: still steps (set values jump), in the shared colors with a light wash under the power.

### Added
- **Back home via where the drive started** (asked for: drop off at appointment 1, drive on to appointment 2, and
  from there back via appointment 1 — to pick up — before going home): after an appointment that isn't where the
  drive started there is a third choice, *via the first address, then home*. The route gets that stop again
  (home → 1 → 2 → 1 → home) with the distances and times of each leg, and the car is back home after it.

### Fixed
- **A series moved to another day** (asked for: a Tuesday series with some weeks on another day): that occurrence
  already showed on its new day with the series' choices; now a choice made for that one day (drop off / pick up,
  driving on, own value, climate) stays with it when it is moved, and the agenda says where it was moved from. The
  occurrence's original start (RECURRENCE-ID) is kept as `calendar_events.recurrence_at` (migration 038).
- Learned: the solar history chart broke when there was no forecast for tomorrow (no width).

## [0.48.0-alpha.1] - 2026-10-07

### Changed
- **Smart charging chart in the style of the energy manager** (asked for: smoother lines, softer colors, a light
  gradient; "the energy manager chart is a hundred times better"): four panels over one time axis instead of
  everything on top of each other with three scales — price (planned intervals green, the rest gray and lighter
  where cheaper), charging (kW, solar part yellow), expected battery level, and solar surplus with the import from
  the grid. Soft rounded columns with air between them on a light track per panel, smooth lines (monotone, so the
  battery never seems to go above 100% or below empty) with a light wash below, hairline grid, labels in text color,
  colors checked for telling apart (also with color blindness) in light and dark. Pointing at an hour shows a
  crosshair and a summary (price, planned, battery, solar, import); tapping still opens the details.

### Fixed
- **Expected battery when the car comes home was too high** (reported: 80% shown, while it left at 100% = 120 km in
  this weather and drives 2 × 17 km, so about 72%): the consumption came from what LoxSuite learned over the summer.
  Now the car's own electric range for the energy in its battery is used first (it follows the weather; your own
  kWh/km in the vehicle settings still goes before it) — for the km still to drive, trips in the agenda and the
  fuel break-even of a plug-in hybrid. And while the car is out on a drive from the agenda, what is left of that
  drive counts (its km without the margin, minus what the odometer counted since it left) instead of the usual km
  of the day.

## [0.47.0-alpha.1] - 2026-10-07

### Added
- **More detail in the Smart charging chart** (asked for):
  - **expected battery level** (%, purple): from the start of the plan (now, or when the car is expected
    home), up while charging, down during the car's drives in the agenda (their expected use, without the
    margin) or the usual drive of that weekday the plan reckons with, capped at the charge limit and never below
    empty; the level at the start, when it has to be ready and around each drive is written next to it; dashed
    when the starting level is an estimate (no reading from the car), the reserve as a dotted line;
  - **finer time axis**: a tick every hour and a label every 1–3 hours (what fits), the days below the hours with
    a line at midnight, a *now* line; the chart is a bit taller;
  - **tap (or click) a bar** for that interval below the chart: price (and the four quarter prices of an hour,
    also when the chart shows hours), what is planned (kWh, kW, solar part), the solar surplus with the expected
    solar and house use of that hour, the expected import from the grid, what the grid part costs, and the
    battery level after it.

## [0.46.0-alpha.1] - 2026-10-07

### Added
- **Drop off and pick up** (asked for: an appointment in the agenda is a period, but you drive there in the
  morning, go home, and drive there again in the evening): an appointment with the car can now be *the car stays
  there* (as before), **drop off and pick up** (there and back at the start, home in between — so it can charge —
  and there and back again at the end), *only drop off* or *only pick up*. Set it with `#brengen` and/or `#halen`
  in the title or description (also `#brengenhalen`, `#brengen en halen`, `#drop`, `#pickup`; it marks the car as
  needed too), or choose it in the agenda — for a repeating appointment for that day or **the whole series**
  (what you choose in LoxSuite goes before the calendar text). Each drive from home counts on its own: the plan
  gets the car ready for the drop-off, may charge it at home in between, and again before the pick-up.
- **Driving on** (asked for: from appointment 1 on to 2, then 3, then home): per stop *back home* or *drive on to
  the next appointment* (after dropping off and after picking up separately), per day or for the series. The stops
  become one route — home → 1 → 2 → 3 → home — with the road distances between them (OpenStreetMap OSRM, looked up
  in the background and cached; until then an estimate, marked ≈), the margin once, and the car gone from leaving
  home until back home. An appointment with its own value (km/kWh/full) counts at least that. A drive between two
  appointments that takes longer than the time between them is marked *tight*.
- The agenda shows each drive: *Coming up with the car* lists the drives from home (with their times and kWh), an
  appointment shows its drop-off / pick-up / route with the stops and distances, and in the week view an
  appointment you only drop off or pick up at has a thick edge at the start and/or the end instead of being filled
  (the car isn't gone the whole time).

### Changed
- **Energy manager plan only as far as the prices are known** (asked for: why 36 hours when only part of it has
  data): the chart now runs until the last known price — until midnight, or until tomorrow midnight once
  tomorrow's prices are out — at least 12 hours; the title says until when.
- Agenda detail: every choice (car needed, how you drive, after dropping off / picking up, temperature) has its
  text above a dropdown as wide as the panel; the next appointment you would drive on to is shown in full under it.
- The planner, plug-in reminders, the expected arrival home and climate at departure work per drive from home
  (`agenda.tours`) instead of per appointment.

## [0.45.1-alpha.1] - 2026-10-07

### Fixed
- **Tomorrow's prices didn't come** (reported: Wednesday well after 13:00 still no prices for Thursday, while
  the Loxone Spot Price Optimizer had them): LoxSuite asked EnergyZero's old API
  (`api.energyzero.nl/v1/energyprices`), which no longer gets the next day's prices — at 17:00 it still ended
  at midnight. It now uses EnergyZero's public API (`public.api.energyzero.nl/public/v1/prices`), which had
  Thursday's prices. One call per local day brings that day and, once published, the next; a day that isn't
  out yet (404) is simply not there yet. The old API is only used when the public one gives nothing at all.
- **Waiting for tomorrow's prices**: after 13:00 LoxSuite checks every 15 minutes until tomorrow's prices are
  in, instead of once an hour.

### Changed
- **EnergyZero per quarter**: the public API gives quarter-hour prices, so *Prices in the charts → per quarter
  of an hour* now works with EnergyZero too (no ENTSO-E key needed); the plan keeps what your contract bills.
- **ENTSO-E filled from EnergyZero**: what ENTSO-E lacks (tomorrow not in yet, a token or service problem) is
  filled from EnergyZero. Settings shows it (*missing prices from EnergyZero*) and keeps showing the ENTSO-E
  problem.

## [0.45.0-alpha.1] - 2026-10-07

### Added
- **Last session** on Smart charging (asked for: in the morning an overview of what happened at night): a tile
  in the *Now* card with the newest charging session — the one going on (*This session*) or the last one:
  plugged in and unplugged, when it actually charged (short pauses joined) and up to how many kW, the kWh the
  Wallbox counted, what it cost and the average €/kWh (each hour at its price, the solar part at its value, from
  the Wallbox and grid meters), the battery before and after, and a link to that session in the charge log.
  From the charge log; without it, from the Wallbox's own session list (times and kWh only).

## [0.44.5-alpha.1] - 2026-10-06

### Fixed
- **Škoda: too many requests** (reported: the MyŠkoda app said "too many requests" and the car gave no data):
  Škoda allows 20 requests per hour per car, failed ones included, and blocks the car — the app too — when
  that is passed. LoxSuite went over it with a read at every restart (an update is a restart), three extra
  reads at every plug-in and 15 reads per hour while plugged in. Now:
  - a **budget of 12 requests per hour per car** (reads, the extra read at plug-in, climate commands and the
    *Test* button), counted in the database so a restart or update doesn't read again within the interval —
    the rest is left for the MyŠkoda app;
  - every 10 min, every 6 min while plugged in (was 4);
  - at a plug-in one extra read after 3 min (was now, after 1 and after 3 min);
  - after "too many requests" or "no car data" it waits 30 min, then 1 h, then 2 h, until Škoda answers again.

## [0.44.4-alpha.1] - 2026-10-06

### Fixed
- **Škoda source said "ok" while the car gave no data** (reported: "the car API doesn't work any more"): the
  MyŠkoda API answered with the car's name and plate but "Vehicle status / Fuel status / Odometer reading /
  Parking position could not be retrieved" for every part, and LoxSuite stored that as an empty reading. Now an
  answer without any of the car's data is a failure with Škoda's own explanation ("the car may be in deep sleep
  or without connection"): the last known values stay, it is tried again, and the *Vehicle data source failing*
  notification can fire.

## [0.44.3-alpha.1] - 2026-10-06

### Changed
- **Calmer forms** (reported: too much text around fields and buttons): the explanations under form fields
  are hidden behind **one ⓘ per block** — next to the title of the card or fold-out they are in; a tap shows
  or hides that block's explanations, hovering says how many. Explanations at the top of a card fold to one
  line sooner (90 characters). The lightbulb in the top bar still shows everything. Status lines that
  scripts fill in, coloured warnings and explanations with buttons or links stay as they are.
- **Shorter labels and choices** in the energy manager's consumers (*Control via*: Virtual inputs / Device
  (direct); *Start via LoxSuite*: Off / Log only / On; *Max. pause (h)*, *Done within (h)* …), the appliance
  explanation in two short lines (the wiring line only with virtual inputs), *Use learned patterns* and *keep
  my kW* on one line with their explanation as a tooltip.
- **Save and Delete side by side** at the bottom of every consumer — and everywhere: Delete now sits right next to Save on the left, with the same gap, instead of pushed to the far right.

### Fixed
- **Sub-menu showed the wrong part at the bottom of the page**: the lit chip is now the last part whose
  heading scrolled up to the bars, the last part at the very bottom, and the clicked one after a click (until
  you scroll). One shared script (`public/section-nav.js`) for every page with such a sub-menu.

## [0.44.2-alpha.1] - 2026-10-06

### Added
- **Control an appliance through its device, not virtual inputs** (switchable per appliance, *Control via*):
  *virtual inputs* (`LoxSuite_<name>_Start/_Pauze/_Verder`, as before) or *the linked device directly* — the
  pulse goes straight to the device's own input (Home Connect: *Start geselecteerd programma*, *Pause*,
  *Verder*, *Stop*, found by name in the linked device), no wiring in Loxone Config.
- **Test a command** (Pause / Resume / Stop / Start) from the appliance's settings — sent at once, as saved,
  whatever *Start via LoxSuite* says, and logged. A pause while the machine is off does nothing on the machine
  but shows whether the Miniserver accepts the command; Start asks first.
- **Remaining program time** (Home Connect, seconds) as a signal: the consumer's page shows "done at ~14:30".

## [0.44.1-alpha.1] - 2026-10-06

### Fixed
- **Ready to start needs a ready status**: Home Connect keeps *Starten op afstand actief* on while the machine
  is off (*Inactief*); with a status it now also has to say *Gereed* before LoxSuite would start it.

### Added
- **Link a Loxone device to a consumer** (reported: "why so many fields when I can link the device"): choose
  the device once (best matches by name on top, the rest per room → category) and its states fill the signals
  by name — status (*Bedrijfstoestand*, a Status block's text, *operationState*), ready to start (*Starten op
  afstand actief*), on/off, power, energy counter, temperature; a meter device fills the meter field too. The
  separate signal fields fold away under *Signals one by one* (change one there if needed). *show what the
  device offers* opens the device as the Miniserver describes it (type, states, details) — the base for
  controlling Home Connect directly later.
- **Home Connect appliances as one device**: Loxone shows a Home Connect washer's and dryer's outputs as loose
  controls with the same names (*Bedrijfstoestand*, *Deur*, *Starten op afstand actief* … twice). LoxSuite
  groups them per appliance by their shared uuid start and names the group after *Online status Wasmachine* —
  so the device list has *Wasmachine* and *Droger*, and choosing one links status and ready to start.
- The consumer's settings link to *History from Loxone* on its own page (that is where the import is).

## [0.44.0-alpha.1] - 2026-10-06

### Added
- **History from Loxone per consumer** (reported: the dryer had nothing to learn from yet): on a consumer's
  page *History from Loxone* reads the kWh per hour from the Miniserver's own statistics (its meter block) for
  the last 7 days, 30 days, 3 months or a year, and learns from it straight away — for an appliance its runs
  are derived from the hours as well (hours in a row above stand-by), so its usual times and kWh per run are
  known at once. Hours and runs LoxSuite measured itself are kept. The overview's import goes up to a year too.
- **Scheduled start (Home Connect)**: a washer or dryer that is *scheduled* ("Ingepland", "Uitgestelde
  start") waits — not running — and when LoxSuite knows when it starts, that run is planned in: its kWh go in
  that hour, and no usual run or best start is planned besides it. The start comes from a new optional
  signal *Start in* (h / min / s — Home Connect's time until a delayed start) or from the status text itself
  ("start over 3 uur", "start om 14:30"). The consumer's page and the overview show "starts at ~14:30".

- **Start a washer or dryer in the best hour (Home Connect)**: when the machine is loaded and set to remote
  start (Home Connect *Starten op afstand actief*, a new optional signal *Ready to start*, or a status
  *Gereed* / "Startklaar"), the energy manager plans the cheapest / sunniest start within *done within* hours
  (default: the appliance's *look for a better start*). Per appliance **Start via LoxSuite**: *off*, *log only*
  (default — it writes down when it would have started) or *on* — then, in the planned hour and only while the
  machine still says it is ready, one pulse on the virtual input `LoxSuite_<name>_Start` (wire it to the
  Home Connect block's *Start geselecteerd programma*), at most once per 30 minutes, in the system log.
- **A run in steps (optional)**: per appliance *Pause in between: at most (h)* (default 0 = never) and
  *pauses per run*. With pausing allowed the run may be split over cheaper hours with gaps of at most that
  long: a pulse on `LoxSuite_<name>_Pauze` at the start of a gap and on `LoxSuite_<name>_Verder` at the next
  step (wire them to the Home Connect block's *Pause* and *Verder*). It only pauses while the machine runs,
  always resumes once a pause has lasted its maximum (+15 min), and keeps a started run's hours — a re-plan
  doesn't move a running wash. Mind wet laundry in a paused washer and creases in a paused dryer.
- **Home Connect's operation state** (*Bedrijfstoestand*, 0–8): *Fill in: Home Connect* fills the values in
  (and does so by itself for a state that looks like it), with 3 *Programma loopt* as running; *Inactief* is
  off, *Gereed* is ready to start, *Uitgestelde start* is scheduled; finished, error, aborted, action required
  and paused are not running. The pickers find *Bedrijfstoestand* and *Starten op afstand actief* by name.

### Changed
- **"Uitgeschakeld" is off**: words that just mean off ("Uitgeschakeld", "Off", "Stand-by") are booked as
  *off*, the same as the on/off signal's off — also the hours already booked apart. Done, paused, waiting or
  scheduled stay their own status in a light grey; the running statuses (Drogen, Kreukbescherming …) get the
  colours.

## [0.43.2-alpha.1] - 2026-10-06

### Changed
- **OCPP → Costs & reimbursement: only the fields that count** (reported: a feed-in value next to "the price
  of that hour (net metering)", where it does nothing): the fixed rate only with *Fixed rate*, the value of
  solar kWh only with *Real hourly price + solar share*, and the feed-in value only when solar is valued at
  *a fixed feed-in value*. `data-show-if` takes several rules joined with `&`.

## [0.43.1-alpha.1] - 2026-10-06

### Fixed
- **Days away → presence from Loxone kept no state** (reported: after saving it showed "— none —" again):
  typing in the search box only filtered the list and chose nothing, which on a phone looks like a choice.
  Searching now picks the first match, a saved state stays in the list even when it is not among the loaded
  ones, and a state the server doesn't accept gives a message instead of being dropped silently.

### Added
- **No price = clearly marked**: in the Smart charging chart every stretch without a price is hatched over the
  full height, with what is going on — "prices not known yet — out around 13:00 on Wednesday" for tomorrow's
  day-ahead prices, "no prices yet — LoxSuite keeps trying" when they should have been there, "no price known"
  for a gap. In the energy manager an hour without a price (planned with the median) is hatched as well.
- **Quarter-hour prices in the charts**: Administration → Energy & charging → Prices → *Prices in the charts*
  per hour or per quarter. With quarters (ENTSO-E; EnergyZero only gives hours) the Smart charging chart shows a
  bar per quarter and the energy manager's price row four blocks per hour, also when the contract bills per
  hour — the plan itself keeps the intervals the contract bills.
- **Energy manager: a status from a Loxone Status block just works** (reported: the washer's and dryer's
  status had to be typed in by hand):
  - the text itself is the status — the consumer's name in front and a countdown or clock time are left off
    ("Wasmachine wassen - nog 45 min" → *Wassen*), no value list needed (it is hidden for a text status);
  - off, idle, done, paused, delayed or waiting ("uitgeschakeld", "klaar", "pauze", "uitgestelde start" …)
    count as not running — "Wasmachine uitgeschakeld" used to count as running; a numbered status labelled
    *Done* is not running either;
  - the state pickers work like Live Data: each state with its value now, the best matches for this consumer
    on top (its name + the kind of state: a Status block's text for the status, *actual* for power, *total*
    for the counter), the rest grouped per room → category; a single clear match is suggested;
  - statuses it has seen appear as buttons — tap the ones that mean running;
  - a new consumer named like an appliance (washer, dryer, dishwasher …) gets the kind *Appliance*.
  The pickers use the core (Loxone structure + live values), not the Live Data page, so the energy manager
  stays independent of other modules.
- **Energy manager: details per hour**: tap (or click) an hour in *Plan — next 36 hours* for price (per
  quarter), solar surplus, the car, and per consumer what it would send and why. Works on a phone, where
  hovering doesn't.

## [0.43.0-alpha.1] - 2026-10-06

### Added
- **Import from the grid visible, apart from export**:
  - Meters, tile *Grid*: importing or exporting now, and today and this month what was taken from the grid (▲)
    and fed in (▼);
  - Meters, chart per hour: import as bars above zero (the Wallbox in front of it), export as bars below zero,
    with both totals in the legend (import used to be a thin dashed line);
  - MQTT for Monitor and dashboards: `loxsuite/energy/grid/today_export_kwh`, `week_import_kwh`, `week_export_kwh`,
    `month_import_kwh`, `month_export_kwh` (today's import stays `grid/today_kwh`), in the *Use in Monitor* picker;
  - Smart charging chart: the expected import from the grid per interval (the house beyond the expected solar +
    the grid part of the planned charging) as a dashed line, with a kW scale and the value on hover.

## [0.42.0-alpha.1] - 2026-10-06

### Changed
- **Smart plan: full and ready** (reported: charging stopped at 15:00 with cheap power and a half-full battery,
  the rest — too little — planned for Wednesday 13:00):
  - after a trip the rest is what it takes to be **full again**: the trip's own kWh come out of the battery
    (it used to stop at the room there was before leaving, 10.4 instead of 19.2 kWh);
  - before leaving it charges at most what still fits then;
  - the rest is **ready before the car is needed next** (its next learned departure or your own departure time,
    else within 24 hours), in hours it is home — no longer at Wednesday 13:00 when it leaves at 05:30;
  - appointments with the car right after each other (the next one starts before it is back, or within 45
    minutes) are one trip: their kWh add up and it is away until the last one is over;
  - **buffer for an unexpected trip** (default 40 km): right after plugging in or coming home that much range
    comes first, within 3 hours, in the cheapest of those hours;
  - **earlier is worth** (default € 0.03/kWh per day): an hour that is only slightly dearer but earlier wins,
    so the battery is full sooner — e.g. now at € 0.26 instead of a night hour at € 0.31;
  - working-from-home days (agenda words) have no learned departure, like days away and holidays;
  - all under Administration → Energy & charging → Smart charging → *Full and ready*, with the choice
    *only what the next departure usually needs + buffer*. For a plug-in hybrid nothing above the fuel
    break-even price is planned.
- The plan on Smart charging shows what is charged before leaving, after it is back, by when it is full again
  and the buffer.

### Fixed
- The jump links on Administration → Energy & charging stick just below the top bar instead of under it, and a
  jump to a card lands below both.
- **Docker `:latest` is always the newest main**: a version tag whose commit is on main also wrote `:latest`
  (`{{is_default_branch}}` is true for those), so after pushing several tags together `:latest` was whichever
  build finished last (v0.39.0 instead of v0.41.0). `:latest` now comes only from main, one main build at a time
  (a newer push cancels the older build). Version tags still get their own image.

## [0.41.0-alpha.1] - 2026-10-06

### Changed
- **One look on every page**: shared building blocks in `style.css`, used by all energy pages:
  - figures in a row (`.ls-tile`): the same label, value and line below on Smart charging, Meters, Vehicles,
    Driving & costs, the energy manager, the consumer page, OCPP and Learned (they were styled by hand per page,
    in five slightly different ways);
  - sub-headings inside a card (`.subhead`) with a thin line above, instead of big headings and emoji;
  - fold-outs with a chevron instead of the browser's triangle, and lists of fold-outs with a line between them;
  - Save on the left and a red Delete on the right (`.form-actions`); every delete button is red now, as the
    button colours already promised (green adds, yellow changes, red deletes, purple tests, grey looks);
  - a card's header row keeps its title on the left and its buttons and fold chevron on the right; labels in a
    row of fields look like the labels in a form.
- **Smart charging** in two cards: *Now* (mode as a segmented control, the session buttons, the live figures and
  why) and *Plan* (what fits in the battery or is needed before leaving, ready by, expected home — as figures —
  the plan and the chart). The one-time "ready by" is a fold-out that is no longer redrawn while you type.
- **Energy manager**: a consumer's card is compact — what it learned, the last 7 days (kWh and costs), its share
  of own solar and what it could save (for an appliance: runs, their costs and what the best start would have
  saved), its notes, patterns and the expected use for the next 24 hours, and a *Details* button. The day-by-day
  table and the runs with their savings moved to the consumer's page. The expected-use chart is drawn at the
  card's real width (its hour labels were stretched unreadably wide).
- **Administration → Energy & charging**: jump links over the page (they stick while scrolling and mark the part
  on screen); Smart charging's settings split into *Output to Loxone*, *Wiring in Loxone Config* and *Solar and
  planning*; the car's priority among the consumers has its own heading and a proper Save button.
- **Vehicles, OCPP**: the settings form has a title (*Settings*), Save and Delete on one line; on the OCPP page it
  moved below the sessions. Long tables (recent trips, OCPP sessions) show 10 rows with *Show all*.
- A link to a card (e.g. *Administration → Energy & charging* from Smart charging) unfolds it when it was folded.
- Page titles of a vehicle and a consumer are just their name; tab rows wrap on a narrow window; untranslated bits
  fixed (legend in Driving and the agenda, consumer kinds in the settings, "Runs").

## [0.40.1-alpha.1] - 2026-10-06

### Changed
- **Advise/live and the other settings out of the overviews**: Smart charging's settings (charging, *Output*
  advise or live with the virtual inputs and the test value, reminders) and the energy manager's consumers (their
  signals, priority, settings, shadow mode) plus the car's priority moved to Administration → Energy & charging.
  The Smart charging and Energy manager pages are overviews only: no "Advise mode" banner, no "advise only" /
  "shadow" labels, no "later, to let LoxSuite drive it" lines — just a link to where it is set.

## [0.40.0-alpha.1] - 2026-10-06

### Added
- **Kind of day** (`dayType.js`, Administration → Energy & charging → *Days away & holidays*): away (an agenda
  appointment with an "away" word — vakantie, holiday, op reis…, a period you set, or a Loxone presence state that
  said nobody was home for 20+ hours), Dutch public holidays (Easter, King's Day, Ascension, Whitsun, Christmas…),
  working from home (agenda words), weekend, workday. The next two weeks are shown there and above the energy
  manager's plan. Away days are left out of what is learned (house profile, consumer patterns and runs); in the
  plan an away day gets no tap water, no usual appliance run, no learned departure and only the house's base
  load; a holiday is planned like a weekend day.
- **Recognising what is going on**:
  - a running appliance shows how long and how many kWh are still to come (from its usual run), or that it takes
    longer than usual;
  - **standby**: on, but using much less than when it runs;
  - **something off**: a status that draws clearly more power than in the weeks before, or a heat pump that uses
    more than the weather explains — shown on the card and the consumer's page;
  - **unknown consumers**: what the house uses beyond the known consumers, above each day's base load, coming
    back at about the same time ("every day 18:00–19:00, ~1.6 kWh") — give it a name.
- Tests: `dayTypeRecognition.test.js` (Easter and holidays, day types, house profile per day type, run progress,
  anomalies, unknown consumers against a real database).

## [0.39.0-alpha.1] - 2026-10-06

### Added
- **Weather in the plan** (`temperature.js`): the outdoor temperature per hour comes with the solar forecast
  (Open-Meteo, past hours included). A heat pump's — and the house's — kWh per day is fitted against heating
  degrees (18 °C − the day's mean); when that explains enough (≥ 30%, ≥ 7 days) a cold day is expected to use
  more and a mild one less: the house use in Smart charging and the energy manager, a consumer's expected use,
  and a heat pump's share of released hours follow the forecast.
- **How fast it cools down**: a consumer can have a **temperature** signal (living room for a heat pump, tank for
  a boiler). From the hours it was off LoxSuite learns how many degrees per hour it loses per degree of
  difference with outside. A heat pump is then never held off longer than the room keeps half a degree (in
  place of the fixed "never block longer than", switchable); for a boiler it shows the loss per hour.
- The energy manager cards, the consumer page and the Learned page (house) show the weather link (+kWh per
  degree colder, how well it fits, today's factor) and the cooling.
- Tests: `weatherModel.test.js` (line fit, heat model, day factor, no-link case, cooling and hold hours).

## [0.38.0-alpha.1] - 2026-10-06

### Added
- **How good are my predictions?** (Learned page). Every plan writes down what it expects — solar and house kWh
  per hour (an hour ahead and the day before), each consumer's kWh per hour, when the car would be ready and
  when it would be home — and the real value goes next to it (`forecast_log`). The page shows per prediction how
  far off it was on average, as a share, and in which direction; how often the car was ready on time; and how far
  off "expected home" was.
- **LoxSuite corrects itself with that**: the planned house use is scaled with what the house really used over
  the last two weeks (×0.75–×1.33), the same per consumer, and learned departures move earlier when the car
  left before it was ready more than 1 in 10 times (by how early it usually was, at most an hour). The page
  says what is corrected now.
- **Certainty of a learned departure** (Smart charging → Settings): *safe* (ready before 9 in 10 departures),
  *normal* (3 in 4, as before) or *relaxed* (half; cheapest).
- **Patterns: "not right"** next to every learned pattern of a consumer: it is left out (and not planned for);
  *put back* undoes it.

### Changed
- **Newer data counts more**: departures (half-life 45 days) and the house profile (10 days) use recency-weighted
  quantiles, so a new habit outweighs an old one within weeks.
- **A change in use is noticed**: when the house or a consumer used clearly more or less in the last week than in
  the three before (>35%), LoxSuite learns from the last week only and says so.

## [0.37.0-alpha.1] - 2026-10-06

### Added
- **Energy manager: more signals per consumer**, all optional next to its Loxone meter (picked from the
  Miniserver's states with a search field):
  - **On/off** (the basis; can be inverted) — LoxSuite learns when and how long it runs.
  - **Status (enumerator)** with value labels (*0 = Off, 1 = Washing, 2 = Spinning, 3 = Done*) and the values that
    count as running — so it knows what it is doing, also while it is on.
  - **Power** (W or kW) and an **energy counter** (kWh or Wh) for the real consumption.
  Every minute LoxSuite books the minutes and kWh per status (`load_status_hourly`) and every change
  (`load_events`); without power or energy it estimates from the consumer's kW. It learns the typical power per
  status and the kW while on. An appliance's runs follow its on/off or status (ending 2 minutes after it goes off).
- **A page per consumer** (Energy manager → a consumer → Details): state now and for how long, power, last 24
  hours, what it learned, a 48-hour timeline per status, kWh per hour over 7 days, per status (hours, per day, kWh,
  typical power) and the runs.
- The energy manager's *Now* table shows the state (on/off or status, and since when); each consumer card shows
  what it learned per status.
- Tests: `energyLoadSignals.test.js` (status values, on/off, status, power/energy units, per-status learning, the
  timeline, and sampling against a real database: minutes, estimated kWh, change events, a run from on/off).

## [0.36.4-alpha.1] - 2026-10-05

### Added
- **Regression tests** for everything changed in 0.34–0.36, so it stays right:
  - `regressionsEnergyUi.test.js`: the split around a trip (trip + reserve before leaving, never charging while
    away, your own departure time as the same trip), trips whose battery drop came before the odometer (and
    ordinary trips / charging before leaving unchanged), agenda text colour and overlapping lanes, address
    candidates, "&amp;" in names, the ready margin of 0, picking the newest tag, the Administration tabs per
    role, no Translations/Settings in the side menu, Charge log under Logs, Sync left of the views.
  - `regressionsEnergyDb.test.js` (in-memory database): repeating appointments and "car needed" for the series
    vs one day, calendar names with "&", Smart charging starting now when prices are missing, and the Loxone
    price source giving every hour a price.
  - `httpEnergy.test.js` (the real server, energy modules on): every energy page renders, the Administration
    tabs, the agenda layout script, and saving a ready margin of 0 shows 0.

### Changed
- The split and the agenda layout are now small pure functions (`planner.planSplit`, `planner.sameTrip`,
  `public/agenda-layout.js`) so the tests can check them directly.

## [0.36.3-alpha.1] - 2026-10-05

### Fixed
- **Driving: a trip whose battery drop came in before the odometer** (the car's cloud often updates the SoC
  first) showed as a few minutes with no electric/fuel split ("1% → 4%"). The drop while the odometer still
  showed the old value now belongs to the drive: it starts at the last reading before the drop (not earlier
  than the drive could take), ends at the lowest SoC (charging right after arriving doesn't count), and the
  electric/fuel km follow. Works for past trips too.
- **"Ready this long before leaving" couldn't be set to 0**: it was saved, but the page showed an unused
  default of 15 from Smart charging. It now shows the agenda's own value (and is a number field).

## [0.36.2-alpha.1] - 2026-10-05

### Fixed
- **The split before a trip didn't apply when your own (or the learned) departure time came first**, e.g. 06:30
  set for Tuesday while the appointment needs the car ready at 06:41: then it still planned the whole battery.
  An appointment within 3 hours of the deadline now counts as the same trip.

### Added
- Without an appointment, a learned departure splits too: what the car usually drives that weekday (odometer,
  plus the margin) and the reserve before leaving, the rest after the time it is usually back.

## [0.36.1-alpha.1] - 2026-10-05

### Changed
- Smart charging: "Needs" is now **Room in the battery** when it comes from the car's state of charge (it is what
  still fits, not what has to go in), and **To charge (estimate)** otherwise. With an appointment: "Needs before
  leaving", with the room in the battery underneath.

## [0.36.0-alpha.1] - 2026-10-05

### Changed
- **Smart charging splits the need around an appointment**: plugged in before a trip in the agenda, only what
  that trip needs plus the car's reserve has to be in before leaving. The rest is planned in the cheapest free
  hours — before leaving, or within a day after the car is back (so with solar when there is sun) — never while
  the car is away for a later trip, and a later trip's own energy comes first, before that trip leaves. The page
  shows "Needs before leaving", what comes after it is back, and a "back ~" line in the chart.
- Agenda: the details stay beside the calendar in every view (as before 0.35.3).

## [0.35.3-alpha.1] - 2026-10-05

### Changed
- **Agenda Day / Week / Month / Year tidied up**: an hour is taller, so text no longer falls away; titles and
  times stay on their own line with "…" when they don't fit (the full text on hover); overlapping appointments
  are staggered instead of thin strips; text is black or white depending on the calendar colour; the hour
  lines are every hour; the day header stays visible while scrolling. Week and Month use the full width (the
  details go underneath). The learned "ready" line sits on top with a readable label. Year: a red dot for a day
  with the car instead of a tiny car.
- **Sync** sits left of Day / Week / Month / Year.
- Month view: the car always in its own space in front of the time; "Coming up with the car" no longer shows
  the car twice.

## [0.35.2-alpha.1] - 2026-10-05

### Added
- **Agenda: Sync button** next to Day / Week / Month / Year.
- **Repeating appointments**: changing *Car needed* asks whether it is for this day only or for the whole
  series. A day's own choice still wins over the series.

### Fixed
- **Distance "Address not found"** for a location with a name in front ("Coöperatie VGZ Nieuwe Stationsstraat
  12, 6811 KS Arnhem, Nederland"): LoxSuite now also tries without the name, without leading parts and finally
  postcode + town. Appointments with an address but no distance are looked up by themselves — on opening and
  in the background, also ones not marked for the car — and failed ones are tried again after 6 hours (or
  straight away with *Try again*).
- **"&amp;" in calendar names** (iCloud): shown as "&", also for event titles and locations.
- Month view: appointments without a car keep the car's space empty, so the times line up.
- Day / Week / Month / Year are translated.

## [0.35.1-alpha.1] - 2026-10-05

### Fixed
- **Price source Loxone left hours out**: hours of the day without samples got no price at all. The estimate
  now also uses the Spot Price Optimizer's own history of the last two weeks (its statistics, through the
  Miniserver's MCP server when that is authorized), hours without data get the median, and the hours that
  already passed today use the real price. Loxone's API only gives the current price and its history, not the
  day-ahead forecast the Loxone app shows — so this stays an estimate; Settings says how many values it is
  made from.
- "48 intervals, until …" on Energy & charging is now translated.

## [0.35.0-alpha.1] - 2026-10-05

### Changed
- **Administration** is the one place for settings: General, Settings, Energy & charging, Users, Access Roles,
  Backups, Notifications, Security, Modules, Languages and **Translations** are tabs there (same addresses as
  before). The separate Settings item in the account menu and Translations in the side menu are gone. Someone
  without admin rights still sees the tabs they may use (Settings, Energy & charging, Translations).

### Added
- **Expected home from the car itself**: while the car drives (Škoda: in motion), home = the moment it set off
  from where it was parked + the drive from there (OpenStreetMap routing, +10%); while it is parked away, home
  is not before the drive from there. The plan is redone as soon as the car sets off or parks. The learned
  pattern and the agenda remain the fallback.

### Fixed
- **Smart charging started at midnight** when today's electricity prices were missing: hours without a price
  now get a place in the chart and the plan (so it starts now and shows "expected home"), LoxSuite fetches the
  prices again (at most every 30 minutes) and the page says from when prices are missing.

## [0.34.1-alpha.1] - 2026-10-05

### Fixed
- **Update notice** picks the newest tag by version number instead of GitHub's list order, and only shows when
  that tag is really newer than the running version. Pushing several tags at once (v0.33.0, v0.33.1, v0.34.0)
  could show an older one as "available". Checks every 6 hours instead of once a day.

## [0.34.0-alpha.1] - 2026-10-05

### Changed
- **Settings → Energy & charging**: electricity price, home & solar forecast and fuel moved there from the Smart
  charging page, and connecting calendars plus the agenda settings (car markers, margin, climate at departure)
  from the Agenda page — the Agenda page itself keeps the calendar and the trips. Smart charging keeps its own
  settings (charging & output to Loxone, reminders). Settings has tabs: *General* and *Energy & charging*.
- **Charge log** moved from the Energy & charging menu to **Logs**.
- **README and screenshots updated**: every screenshot redone (light and dark) now that cards fold, explanations
  are compact and the interface is translatable, plus new ones of the whole energy side — Smart charging, Meters,
  Agenda, Vehicles, Energy manager, OCPP & charging costs, Learned, Driving & costs — and of Modules,
  Translations, folded cards and the interface in Dutch. The README describes the Energy manager, Driving &
  costs, Modules, Languages & display, the Škoda source, iCloud/CalDAV, climate at departure, push per alert,
  quarter-hour/fixed prices and fuel type.
- The screenshot pipeline (`dev/screenshots/`) seeds the energy side too (`seed-energy-data.js`), answers outside
  services with synthetic data (`offline-stubs.js`) and can run without Docker (`run-local.sh`).

### Fixed
- In English (the default) the "Use in Monitor" pickers, the car map and the fields that only show for a choice
  did nothing: their scripts were only loaded when a translation was active.
- The Translations page could run off the screen when a text had no spaces to break at.
- Example values in forms no longer use a real name and NFC tag.

## [0.33.1-alpha.1] - 2026-10-05

### Added
- **Several calendars at once.** Paste several ICS links (one per line) in Agenda → Add calendar; each becomes
  its own calendar, named after the calendar's own name (X-WR-CALNAME) unless you give one. With iCloud/CalDAV
  you tick as many calendars of the account as you like. The list of calendars has no limit.

## [0.33.0-alpha.1] - 2026-10-05

### Added
- **iCloud and other CalDAV calendars** (Agenda → Add calendar → Type). iCloud only offers a public ICS link;
  LoxSuite now signs in with an **app-specific password** (appleid.apple.com → App-Specific Passwords), finds
  the calendars of the account and lets you tick which to add. Also for Nextcloud, Fastmail and other CalDAV
  servers. The password is stored encrypted and only used to read; your Apple ID password is never asked for.
  Google keeps using its "secret address in iCal format", which is private (not public).
- **"Ready by" for when the car is back, with the distance.** On Smart charging you can set a one-time ready
  time while the car is out (e.g. tomorrow 07:30) plus how far ("120 km", "30 kWh" or "full"); it is kept when
  the car is plugged in, survives an update/restart, shows as "set by you · 120 km (24 kWh)" and can be cleared.
  For a fixed weekly change use your own time per weekday under Learned; for one appointment, the agenda.
- **Electricity: quarter-hour or hour, and fixed contracts with a low tariff.** Choose whether your dynamic
  contract bills per hour (average of the quarters, most suppliers) or per quarter (ENTSO-E delivers quarters).
  A fixed contract can have a normal and a low (dal) price, with low hours (default weekdays 23:00–07:00) and
  the whole weekend.
- **Energy manager uses the real values, not only the forecast.** The current hour is planned with the solar
  and house power the meters show now; the next three hours are corrected for how far the solar forecast is off
  (70/45/20 %). While the forecast is far off it re-plans every 5 minutes, and an hour planned on solar that
  isn't there waits instead of running on the grid. The status line shows solar now vs. forecast.
- **A small map of where the car is** on the vehicles overview (all cars) and the vehicle page — OpenStreetMap,
  street map, click to open it larger.
- **Settings only show what applies** (show-if): ENTSO-E token only for ENTSO-E, fixed prices only for a fixed
  contract, the manual fuel price only when not automatic, solar details only with the forecast on, reminder
  times only with reminders on, climate options only when climate is not off, CalDAV fields only for CalDAV.

## [0.32.4-alpha.1] - 2026-10-05

### Changed
- **Faster Docker builds after a version bump.** The dependency layer was rebuilt whenever package.json changed,
  so every release recompiled better-sqlite3 & co. for arm64 under emulation (10+ minutes per build, much longer
  with several tags at once). The build now installs dependencies from package.json without its version, so a
  release without dependency changes reuses the cached layer.

## [0.32.3-alpha.1] - 2026-10-05

### Changed
- **"Use in Monitor" on the vehicle and OCPP pages** is tidier: compact tiles (name with the topic under it),
  more per row, a bit more room under the title. Values that already have a monitor show as checked with an
  "in Monitor →" link — what you added before is visible again after a reload or an update (before, the same
  three boxes were simply pre-ticked every time). The button adds only the newly ticked values.

### Fixed
- **Driving & costs said no odometer / battery % was mapped for a car on the Škoda API** — the Škoda API always
  provides both; the check now also looks at the readings themselves. The warnings and two tile texts are Dutch
  now.

## [0.32.2-alpha.1] - 2026-10-05

### Fixed
- **Solar missing in a planned hour** ("14:00–15:00 3,3 kWh ⚡" while there was surplus): with saldering an hour's
  extra (top-up) part costs the same as its base, so it could be picked on its own — without solar and below the
  Wallbox minimum. A top-up now only runs together with its base, and the solar part of every planned interval
  is counted as it physically goes: while the car charges, that interval's expected surplus goes in first.
- The sun shows as an emoji (☀️) like the lightning bolt.

## [0.32.1-alpha.1] - 2026-10-05

### Fixed
- **Automatic fuel price showed € 1.30** — the price of 1 January 2006: the CBS API ignores `$orderby` and returns
  the oldest rows first. LoxSuite now asks for the last 30 days only and takes the newest day (e.g. Euro95
  € 2.465 on 28-09-2026). A CBS price older than 14 days is not used.

### Added
- **What do you tank?** Euro95 (E10), diesel or LPG from the same CBS data, plus a surcharge per litre for
  Super 98 / E5 or a dearer station. The settings line shows type, price, CBS date and surcharge. The CBS price
  is the average Dutch pump price including VAT and excise duty.

## [0.32.0-alpha.1] - 2026-10-05

### Added
- **Smart charging plans from when the car is expected home.** While the car is out, the plan starts at the time
  it is expected back: an appointment with the car that is going on now (its end + travel time), else the
  learned weekday pattern (end of the last trip of the day from the odometer, or the usual plug-in time). The
  page shows *Expected home*, a blue line in the chart, and below the plan what it would do if the car came home
  now (or another car were plugged in), outlined in the chart. Plugging in always re-plans from that moment.
- **Learning from the odometer.** Per weekday: on how many days the car is driven, how far (usual and long
  day), when it leaves and when it is back — over the last 8 weeks (Wallbox → Learned, *Driving per weekday*).
  While the car is out, the km it usually still drives that day are added to what it needs; a car without a
  state of charge is estimated from the usual km of that weekday.
- **Fold cards away.** Every card with a title has a chevron; a folded card shows only its title. Remembered on
  that device/browser, so phone and PC each keep their own layout.
- **Long explanations on one line.** With help text off (the lightbulb in the top bar, off by default and
  remembered per device), long explanations show as one line with ⓘ: hover for the whole text, click to unfold.
  Lightbulb on shows them in full.

### Fixed
- The plan said "grid" while there was solar: the solar part of intervals where solar is below the Wallbox
  minimum is now counted and shown (e.g. "11,0 kWh (2,9 ☀ + 8,1 ⚡)", yellow part in the bars), with a note why
  the rest comes from the grid.
- Leftover English on the planner and Learned page ("Plan: … interval(s) … expected", "ready 09:35",
  "learned wed departure (medium)", "Monday morning").

## [0.31.1-alpha.1] - 2026-10-05

### Changed
- **Climate at departure has an on/off switch** per appointment or trip (with the temperature next to it), so you
  can leave it off when you don't want it. For a weekly trip, switching it off skips just that week (the other weeks
  keep their temperature); "Switch off for every week" turns it off for good. The last temperature you picked is
  remembered for the next one. Appointments with climate on show 🌡️ in the agenda.

### Fixed
- Weekday names in the agenda (Mon, Tue …) follow the user's language.

## [0.31.0-alpha.1] - 2026-10-05

### Added
- **Climate at departure** (Wallbox → Agenda). Choose a cabin temperature (16–26 °C) per appointment or trip — click
  it in the agenda, or pick it when planning a trip. At a set time before you have to leave (default 20 min),
  LoxSuite asks the car to start its air conditioning through the official Škoda API, once per departure; a failed
  start is retried at most twice while there is time. Global switch in the agenda settings: off, **log only
  (default: nothing is sent, LoxSuite only writes down what it would send)**, or on; plus "also when not plugged in
  (uses the battery)". What happened per departure is shown in the agenda and in the settings, and notification
  trigger *Car: climate at departure* reports started/failed. Only for cars with the Škoda API as data source.
- **Choose where notifications go: your channel, push, or both.** Profile → Notifications has "Push to my devices"
  and, per subscribed alert, *Channel and push* / *Only my channel* / *Only push*. "Send my personal notifications
  as push" on the App page no longer replaces your own channel (Telegram etc.); users whose channel had been
  replaced by push get push switched on and an empty channel. Alerts an administrator sends to the
  *LoxSuite app (all devices)* channel are still set per rule under Administration → Notifications.

### Fixed
- Leftover English in Dutch: "NEEDS"/"READY BY" on the planner, "no"/"yes" and other one-word values (e.g.
  "Ingestoken: NO"). Labels in capitals are now translated too.

## [0.30.0-alpha.1] - 2026-10-05

### Added
- **Škoda as a vehicle data source** — the official MyŠkoda Public API, next to Homey, Home Assistant, MQTT and HTTP.
  Create an API key for the car in the MyŠkoda app and paste it with the VIN (stored encrypted; no password needed).
  LoxSuite reads battery %, electric and total range, plugged in, charging state and power, charge limit, odometer,
  parking position and fuel level. Škoda allows 20 requests per hour per car: LoxSuite reads every 10 minutes, every
  4 minutes while the car is plugged in or the Wallbox has a car, and waits when Škoda says the limit is reached. The
  vehicle page shows how many requests are left and until when the API key is valid (warning two weeks ahead).
  Read-only for now; starting climate or charging comes later.
- **The whole interface in Dutch.** Every page is now translatable — about 3,600 texts, all translated into Dutch:
  - texts in the pages themselves (t() in the views, wrapped automatically),
  - texts the browser builds (charts, tables, status lines, messages) and messages from the server, translated in
    the browser by public/i18n.js, also when a text is built from pieces ("Learned: 2.4 kWh/day …"),
  - country names in Geo-blocking via the browser/Node's own region names.
  `scripts/i18n-extract.js` collects the texts of scripts and server messages; a test keeps the Dutch file complete.
- **Language, clock and timezone together** under Settings → General → Display. The clock is 24-hour by default
  (12-hour optional) and dates and numbers follow the user's language instead of the browser's own settings.
  Administration → Languages keeps adding/switching languages and translating.

### Changed
- Energy manager reasons are complete sentences now (e.g. "cheap hour: pre-heat"), so they translate well.

## [0.29.0-alpha.1] - 2026-10-05

### Added
- **OCPP costs & reimbursement** per bridge: what the charged kWh cost you and what you get back, with the balance.
  - Reimbursement tariffs per kWh with the date they take effect (a new row per change). Blank by default — no
    reimbursement is shown until you add one.
  - Cost from the real hourly price plus the solar share (grid part at that hour's all-in price, solar at the price of
    that hour, a fixed feed-in value or free), else the average price during the session, or a fixed rate.
  - VAT: tariff entered incl. or excl. VAT, amounts shown incl. or excl. VAT.
  - Only reported sessions count (cars set to "report" under Vehicles).
  - Tiles for this month, quarter and year; the balance per month under the monthly chart; a quarterly export "with
    cost, reimbursement & balance" next to the unchanged Laadloon layout; MQTT topics for cost, reimbursement and
    balance (month/quarter/year).
- **Languages and translating.** English is the base language; Dutch is the first translation.
  - Each user chooses a language in their profile; the installation default is set under Administration → Languages.
  - Administration → Languages: switch languages on/off, choose the default, add a language, export/import JSON.
  - New Translations page: progress per module, search, "not translated only", translate in place. Permission area
    **Translate** (view = look, edit = translate). Texts not translated yet show in English.
  - Translated so far: the menu, the tab bar, the administration tabs, Modules, Languages, Translations and the
    language choice; the other pages follow step by step.
- **Modules: status, getting started, export and wipe.** Per module a checklist of what still has to be done, the rows
  per table, an export of its data (zip with JSON + CSV per table, secrets removed) and wiping its data (only while the
  module is off, after typing its key).
- **Energy manager: learned patterns.** From the last 8 weeks per consumer: when it usually runs, how long and how
  much — every day (tap water ~19:00), on one weekday, or appliance runs at about the same time (washer Saturday
  ~10:00, 2 h, 1.1 kWh) — and which appliance usually follows another (dryer ~40 min after the washer). Shown per
  consumer with the expected use for the next 24 hours. In the (shadow) plan: tap water is hot before its usual use,
  and an appliance's usual run gets a best start from its usual time up to "flex" hours later. Can be switched off per
  consumer ("Use learned patterns").

### Changed
- **Switching the MQTT bridge off now really stops it**: the MQTT client, the Loxone UDP listener, Mosquitto log
  tailing and the Loxone → MQTT HTTP endpoint stop, and in Docker the Mosquitto broker itself stops within seconds
  (and starts again when switched on). The entrypoint now also restarts Mosquitto if it exits unexpectedly instead of
  restarting the whole container.
- **Access roles per module**: Energy, Vehicles & driving, Smart charging, Energy manager and OCPP & charging costs are
  their own permission areas instead of "Miniservers". Each role gets the rights it had on Miniservers, so nothing
  changes with the update. Areas of modules that are off are hidden in Access Roles (their rights are kept).
- Notification rules of a module that is off can't be chosen and don't fire (existing rules are kept).
- Monitor polling and Loxone log polling pause while their module is off.

## [0.28.0-alpha.1] - 2026-10-05

### Added
- **Modules** (Administration → Modules): LoxSuite is now a fixed core plus nine modules you switch on or off per
  installation — MQTT bridge, Monitor & dashboards, Loxone logs, AI assistant, Energy, Vehicles, Smart charging,
  OCPP & charging costs and Energy manager.
  - A module that is off disappears from the menu, its pages answer "this module is switched off", and its background
    work stops (energy meters, prices, solar forecast, vehicles, planner, charge log, agenda, reminders, OCPP bridges,
    energy manager) — no restart needed. Its data is kept.
  - A module that needs another switches it on along with it (Smart charging → Energy + Vehicles, Energy manager →
    Energy, Monitor → MQTT bridge); switching one off also switches off what depends on it, after a confirmation.
  - **Existing installations keep everything they use**: on the first start after the update, every module that is in
    use is switched on. A new installation starts with the core, MQTT bridge, Monitor and Loxone logs.
- The Wallbox menu is now **Energy & charging**, with only the items of the modules that are on.

### Notes
- The MQTT bridge module hides its pages for now; stopping Mosquitto and the MQTT client when it is off follows in a
  next version, as do separate access-role areas per module.

## [0.27.2-alpha.1] - 2026-10-04

### Changed
- **A full battery can simply stay plugged in.** Once the battery is full in a plug-in session — the car stopped taking
  power, it reports a full battery after the plug-in, or its charging state says so — LoxSuite remembers that until the
  car is unplugged (also across a restart). By default the Wallbox then stays open at the minimum power, so the car tops
  itself up and pre-heats from the grid without any starting and stopping; or choose "nothing until unplugged"
  (Smart charging → Charging → *Battery full, still plugged in*). The minimum top-up (1 kWh) is a setting too.
- **Filled in the cheapest intervals**: when there is too little solar, the plan fills the car in the cheapest intervals
  (full power there when needed, never below the Wallbox minimum); a little solar below the minimum is used first and
  topped up from the grid. "Now" still charges at full power.

## [0.27.1-alpha.1] - 2026-10-04

### Fixed
- **Smart charging switched on and off every few minutes for a nearly full battery** (seen live: 11 kW for ~90 s, then
  0, then again). The need came from the car's battery % (99% = 0.26 kWh), which lags behind; a partial interval was
  charged at full power for a minute; and nothing stopped quick restarts. Now:
  - the energy charged since the car's last battery reading is subtracted from the need;
  - in Smart plan mode no grid charging is started for less than 1 kWh (setting *min_topup_kwh*; solar surplus still
    counts);
  - a partial interval charges at lower power for longer (never below the Wallbox minimum of 4.16 kW) instead of full
    power for a minute;
  - once charging it keeps going at least 5 minutes, once stopped it waits 5 minutes before starting again (except
    when the car is unplugged, the target is reached, or the mode is Off/Now).
- **Charge log**: a lower power than asked at 90%+ battery is reported as the car tapering, not as a failure.

## [0.27.0-alpha.1] - 2026-10-04

### Added
- **Energy manager** (Wallbox → Energy manager), in **shadow mode**: other big consumers planned together with the car
  from the prices, the solar forecast and the learned house load. LoxSuite measures each consumer with its own Loxone
  meter, makes a 36-hour plan and shows per minute what it *would* send to Loxone — nothing is sent yet.
  - **Tap water**: the best block of the day (solar surplus first, else the cheapest hours), a buffer setpoint in
    cheap/solar hours, and a live override when there is surplus now.
  - **Heat pump** (heating/cooling, living room leads): release in the cheapest share of the hours and whenever there is
    surplus, never blocked longer than a set number of hours, plus a setpoint correction to pre-heat/pre-cool in
    cheap/solar hours and ease off in expensive ones.
  - **Appliances** (washer, dryer): runs are measured (kWh, duration, cost) with the best start in hindsight and what
    it would have saved; a "ready by" request gets a planned start.
  - The solar surplus is shared in priority order, with the car at its own place in that order.
  - Per consumer and per day: kWh, cost, solar share, the share in the hours LoxSuite would have chosen and what moving
    the rest there could have saved. History can be imported from the Loxone meters (30 days).
  - The virtual input names to connect later are shown per consumer; output stays in shadow mode for now.

### Fixed
- **Charge log**: right after sending a value the start check now waits (up to 2 minutes) instead of reporting a
  failure; a (nearly) full battery (95%+) is reported as such; and it says whether the Wallbox released the charge (and
  the car took nothing) or did not release it.
- **Smart charging chart**: prices on the axis now show the € sign.

## [0.26.2-alpha.1] - 2026-10-04

### Changed
- **Charge log in the menu**: Wallbox → Charge log, right under Smart charging (it was only reachable from the Output
  settings).

## [0.26.1-alpha.1] - 2026-10-04

### Fixed
- **Push to an iPhone failed** ("Received unexpected response code"): the VAPID contact sent to the push services was a
  made-up address (`mailto:admin@loxsuite.local`), which Apple rejects (403 BadJwtToken). LoxSuite now uses the https
  address it is opened on (taken when a device switches push on), or a contact set by an administrator under
  App & push → Push contact.
- **Push errors are explained**: the push service's status and reason are shown (with what to do), also per device.
- **App & push shows whether push is already on** for this device, and when notifications are blocked in the phone's
  settings.

## [0.26.0-alpha.1] - 2026-10-04

### Added
- **Charge log** (Smart charging → Charge log): every charging session is recorded automatically — what the Wallbox
  did (connected, enabled, active, power, limit, mode, session kWh), what LoxSuite sent to the virtual inputs (test
  button or Live output, including failures), what the planner advised and what the car reported (battery %, plugged,
  its own charging state). Every 10 s on change and at least once a minute, kept 45 days. Per session LoxSuite checks:
  no charging at 0 kW, the car waits without an error, it starts within 2 minutes when asked (also after waiting 10+
  minutes), the power follows the value sent, it stops at 0, and values reach Loxone. With a chart, an event list, a
  CSV download and a copyable summary — so the Wallbox control can be tested whenever it suits and looked at later.
  Values sent with no car connected are listed too.

## [0.25.2-alpha.1] - 2026-10-04

### Fixed
- **Smart charging could not write to Loxone at all**: *Send test value* and the Live output failed with
  "sendHttpVirtualInput is not a function" (the function was never exported). A new test checks every destructured
  `require` in the code against what the module really exports, so this kind of mistake fails the build.

## [0.25.1-alpha.1] - 2026-10-04

### Fixed
- **Writing to a Loxone virtual input reported success when it failed**: the Miniserver answers HTTP 200 even when the
  input doesn't exist or the user has no rights; LoxSuite now reads Loxone's own result code and says what is wrong
  (input missing on that Miniserver, or no rights for the LoxSuite user). Affects Smart charging's output and its
  *Send test value* button.

## [0.25.0-alpha.1] - 2026-10-04

### Added
- **Driving & costs** (Wallbox → Driving & costs), from the car's own odometer and battery %:
  - trips (date, duration, km, battery from → to, kWh, kWh/100 km), recognised from the odometer moving between readings;
  - **learned electric consumption** (kWh/100 km) from the battery drop per km on stretches where the battery didn't run
    empty and wasn't charged; once there is enough data it is used by the planner, agenda and reminders whenever no
    consumption is set by hand (the vehicle form shows the learned value);
  - for a plug-in hybrid **km on electricity vs. km on fuel**, with the level at which it switches to fuel learned from
    the lowest battery % it reaches;
  - **costs**: € per kWh charged per month from the Wallbox and grid meters (grid part at that hour's all-in price,
    solar at its feed-in value, as in Smart charging), € per km electric vs. on fuel, and what driving electric saved;
  - km and consumption per month (seasonal differences show up), solar share of the charged energy.
  Odometer changes of 1 km or more are now kept in the vehicle history so trips can be found.
- **Smart charging → Output**: choice of the Miniserver that holds the virtual inputs (gateway/client projects), and the
  wiring explained per input of the Wallbox block: power → **Lm1**, optional "charging allowed" → **Ec**, parameter
  **Muv** = 1.

### Changed
- **Charts use the full width** of their card on every page (Smart charging, Meters, Learned, Driving, OCPP statistics)
  and are redrawn when the window changes size, instead of a fixed width.

## [0.24.4-alpha.1] - 2026-10-04

### Fixed
- **Car plugged in shows up within a minute**: a Homey or Home Assistant car was only read every 5 minutes (the default
  poll interval), so a plug-in could take minutes to appear. Now every car is read immediately when the Wallbox (Loxone
  or the OCPP bridge) sees a plug-in or unplug, again after 1 and 3 minutes, and local sources (Homey, Home Assistant)
  are read every minute while a car is connected or reports itself plugged in/charging.
- **More plug states understood**: MySkoda-style charging states (`CONNECT_CABLE` = no cable, `READY_FOR_CHARGING`,
  `CONSERVING`, `CHARGING`) now set *plugged in* correctly when mapped to the plugged field.

## [0.24.3-alpha.1] - 2026-10-04

### Fixed
- **Giant icons on desktop**: the phone tab bar (0.24.0) showed below every page on a desktop browser with huge icons.
  A stray `}` at the end of the existing AI-chat styles made browsers drop the rule that hides the tab bar outside phone
  widths. The brace is removed, the tab-bar icons carry a fixed size of their own, and a test now checks that
  `style.css` has balanced braces.

## [0.24.1-alpha.1] - 2026-10-04

### Fixed
- **MySQL/MariaDB**: the migrations of 0.23/0.24 failed there ("Specified key was too long") because indexed and unique
  text columns were TEXT; they are now VARCHAR on MySQL (unchanged on SQLite/Postgres). The migrations also skip tables
  that a half-finished earlier run left behind, so they can be retried.
- **MySQL**: `wallbox_settings.key` is renamed to `setting_key` (KEY is a reserved word there), and push subscriptions are
  unique by a SHA-256 of the endpoint instead of the endpoint itself (too long to index on MySQL). Verified against
  MariaDB, Postgres and SQLite, including upgrading an existing 0.24 SQLite database.

## [0.24.0-alpha.1] - 2026-10-04

### Added
- **Smart charging** (Wallbox → Smart charging): modes Off / Now / Solar / Min + Solar / Smart plan, session buttons
  (*Charge now*, *Pause*, ready-by), a plan for the connected car that is ready on time at the lowest cost (solar
  valued at its export value, cheapest intervals, price cap, fuel break-even for plug-in hybrids), a 30 s control loop
  with solar start/stop delays and the grid connection limit, and output to Loxone virtual inputs — in *Advise* mode by
  default (shows what it would do) until set to *Live*; a test button for the wiring.
- **Electricity prices**: EnergyZero or ENTSO-E day-ahead prices, all-in by tariff formula or calibrated against a Loxone
  Spot Price Optimizer; an estimate from the Spot Price Optimizer without internet prices; fixed price option.
- **Meters** (Wallbox → Meters): grid / PV / Wallbox / home battery from Loxone, live, per minute and per hour, derived house
  load, history import from the Miniserver statistics (MCP), MQTT topics, and the notification trigger *Energy meter
  failing/recovered*.
- **Learned** (Wallbox → Learned): departures per weekday with own overrides, energy per trip, solar forecast (Open-Meteo,
  corrected per hour with the PV meter, error band, last 28 days) and the house profile with tomorrow's expected surplus.
  Wallbox sessions are kept beyond the Wallbox's own log.
- **Agenda** (Wallbox → Agenda): ICS calendars in day/week/month/year views, car markers (🚗, #auto) and hints (km/kWh/full),
  *Car needed* per appointment, LoxSuite trips (one-off or weekly), driving distance from home (OpenStreetMap) plus a margin
  turned into kWh, and the planner's deadline from the agenda.
- **App & push**: LoxSuite installable on the home screen (manifest, service worker, icons) and web push as a notification
  channel (`loxsuite-push://all` / `loxsuite-push://user/<id>`), with buttons in notifications.
- **Car reminders**: notification triggers *Car: plug in / swap reminders* (with the saving against fuel for hybrids,
  snooze / not today, learns from ignored reminders) and *Car: charging plan warnings*.
- **Several cars on one Wallbox**: per vehicle NFC tags, Loxone users and *Report over OCPP*; sessions of a car that isn't
  reported are not sent to the OCPP backend and left out of the quarterly export; push question when the car can't be told.
- **Phone layout / app feel**: a bottom tab bar on phones (Home, Charging, Agenda, Monitor, Menu), wide tables and tab rows
  scroll within themselves instead of widening the page (checked on all pages at 390 px), no zoom-in on input focus, live
  status badges (online/offline, connected…) shrink to their coloured dot, the agenda opens in day view on a phone.
  *App & push* lives in the account menu (it isn't Wallbox-specific).
- **Vehicles**: separate *total range incl. fuel* for plug-in hybrids (Homey's range is usually the combined one); the
  electric range is estimated from the battery % when the car doesn't report it.

## [0.23.1-alpha.1] - 2026-10-04

### Fixed
- **OCPP bridge on container restart/stop** — on SIGTERM every bridge now saves its state and closes
  its backend connection with a normal close (1000) instead of the socket dying with the process, so
  the backend doesn't keep a stale connection for the ChargePoint ID. A session whose stop delay was
  still running stays open over the restart and is then closed with the unplug time Loxone recorded
  (reason EVDisconnected) instead of the restart time.

## [0.23.0-alpha.1] - 2026-10-04

### Added
- **Vehicles** (new *Wallbox* menu section) — the cars charged at home, full electric or plug-in hybrid,
  with usable battery, the car's charge limit, reserve, consumption and (hybrid) fuel use: the input
  for the upcoming charging planner.
- **Live vehicle data from Homey, Home Assistant, MQTT or HTTP** — state of charge, range, plugged in,
  charging, charge limit, odometer and location, read from a Homey Pro (local Web API, device and
  capability pickers), Home Assistant (REST API, entity/attribute pickers), MQTT topics on the LoxSuite
  broker (Node-RED, evcc, TeslaMate, …; topic picker with current values, JSON paths, presets) or any
  JSON URL. *Test source* shows raw and interpreted values before saving. Secrets are stored encrypted.
- **"At home" detection** from the car's coordinates (radius around home) or a location text.
- **Monitoring of the vehicle data source** — *failing* when reading keeps failing or the car's data is
  older than a configurable limit (default 24 h), shown on the vehicle pages; new notification trigger
  *Vehicle data source failing/recovered* reports both transitions.
- **Vehicle values on MQTT** — retained topics `loxsuite/vehicles/<id>/…` for Monitor, dashboards and
  Loxone mappings, plus a reading history in the database.

### Changed
- **OCPP moved to the new *Wallbox* menu section** as *OCPP (charging costs)*.

## [0.22.0-alpha.1] - 2026-10-03

### Added
- **Charging statistics on each OCPP bridge page** — tiles for today, this week, this month, this
  quarter, the previous quarter (with a direct export link) and this year, plus a per-month bar chart
  and the last session's kWh. Day/week/month/year come straight from the Wallbox's own counters in
  Loxone; quarters and the monthly chart are built from charging sessions (the bridge's own, else the
  Wallbox's session log), with months older than that log shown as "no data".
- **Charging statistics in Monitor & dashboards** — LoxSuite publishes these values as retained MQTT
  topics `loxsuite/ocpp/<id>/{today,week,month,quarter,prev_quarter,year,last_session}_kwh`,
  `power_kw` and `meter_kwh` (checked every minute, published on change). *Use in Monitor &
  dashboards* on the bridge page adds the chosen ones as monitors in one click, so they can be charted
  over time and put on dashboards like any other value.

## [0.21.0-alpha.1] - 2026-10-03

### Added
- **OCPP bridge: automatic ID tag** — the ID tag can now be *Fixed* (as before) or *Automatic*: the tag
  of a badge read on a chosen NFC Code Touch around plug-in (normalised like Loxone's own OCPP
  connector does: hex, without the "EC" specifier and trailing zeros), else the tag mapped to the
  Loxone user the Wallbox reports for the session ("User = TAG" lines), else the fixed tag as
  fallback. StartTransaction waits up to a configurable time for that authorization but keeps the
  plug-in time and meter reading. The session list shows which tag was sent and where it came from.
- **Choose a Loxone NFC tag** — a picker next to the ID tag that lists the NFC tags in the
  Miniserver's user management (also ones never used at the Wallbox), so one can be used as the
  bridge's tag. Needs the LoxSuite Miniserver user to have user-management rights.
- **Last session on the OCPP overview** — each bridge row shows the kWh and end time of its most
  recent charging session.
- **Serial number suggestion** — when adding a bridge, the serial is pre-filled from the Hardware
  page's device list if it shows a Wallbox (the Wallbox block itself carries no serial).

### Fixed
- **OCPP page times** (status, sessions, log) are now shown in LoxSuite's display time zone instead
  of UTC. The OCPP messages themselves keep their UTC timestamps, as the protocol requires.

## [0.20.0-alpha.1] - 2026-10-03

### Added
- **OCPP bridge (Loxone → OCPP)** — reports a Loxone Wallbox to an OCPP 1.6 backend (for example
  Laadloon, for home-charging reimbursement / ERE registration) as a charge point, using the live
  Wallbox data LoxSuite already receives over the Miniserver websocket. Built for setups where
  Loxone's own OCPP Server Connector can't be used: that connector needs the Wallbox block and its
  Charging Point on the same current-generation Miniserver, so a Wallbox on a Gen 1 Client of a Gen 2
  Gateway reports "Wallbox Offline / Selfcheck Failed" and never sends a session (the API connector
  can't be passed through a memory flag). New page **Loxone → OCPP**: pick the Wallbox, enter the
  backend URL, ChargePoint ID, password (encrypted at rest) and ID tag. Starts in **Dry run** (logs
  every message it would send, connects to nothing); switch to Live when ready. A session starts at
  plug-in and stops after unplug with a configurable delay (default 90 s) so the Wallbox's
  once-a-minute MID meter update is still captured; Start/Stop/MeterValues go through a persistent
  queue, so a backend outage or a LoxSuite restart loses nothing. The bridge identifies itself
  honestly as `Loxone / WallboxTree-LoxSuite`. Includes a **Test connection** button (short
  connection to the backend, no OCPP messages; plus a Wallbox live-data check), live status, a
  session list and a message log.
- **Quarterly charging-session export (Excel/CSV)** on each OCPP bridge page — every session of a
  quarter with the MID meter reading at start and end, in the layout already accepted for manual
  uploads (title row with serial/EAN, sessie / starttijd / eindtijd / startwaarde / eindwaarde /
  verbruik_kWh, totals row). Sessions recorded by the bridge (dry run or live) use the readings taken
  at plug-in/unplug; older ones come from the Wallbox's own session log on the Miniserver with
  readings derived from the current meter total, marked as such per row. Works whether or not the
  bridge itself is enabled.

## [0.19.4-alpha.1] - 2026-09-21

### Added
- **Geo-blocking (Administration → Security)** — block, or allow only, visitors from specific
  countries, looked up locally against a free [MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data)
  database instead of a per-request call to a third party. Off by default; turning it on needs your
  own free MaxMind account (Account ID + license key), which LoxSuite uses to download and then
  auto-refresh the database roughly daily — the database file itself is never bundled with the app,
  per MaxMind's own license. Applies to the whole app on every request (not just the login form),
  the same "re-checked continuously, not just at login" design as the existing "Require SSO from
  outside the local network" setting — and, like that setting, a request from your own local network
  is always exempt, so misconfiguring this can't lock you out from home, and a Loxone Miniserver's
  own callback (always LAN-local in a normal setup) is unaffected either way. The country picker
  shows each option's flag and name, and lets you search rather than scrolling a list of ~195
  countries.
- **Multi-arch Docker image: `linux/arm64` alongside the existing `linux/amd64`** — `ghcr.io/daverutten/loxsuite`
  now publishes both architectures from one workflow run (QEMU cross-build in CI), so `docker compose
  pull`/`up` on a 64-bit Raspberry Pi 3B+/4/5 (DietPi or Raspberry Pi OS) just works, with nothing to
  build from source on the device itself. See the README's new "Running on a Raspberry Pi / DietPi"
  section for setup steps, and `docs/raspberry-pi-testing.md` for the manual verification checklist
  covering what's actually been confirmed on real hardware versus what's expected to work from the
  image being multi-arch. Deliberately not also building `armv7` (32-bit) — see "Known scope
  limitations" in the README for why.

### Fixed
- **Clicking a Hardware notification could highlight a device that was silently invisible** — the
  deep-link (added in 0.19.0) scrolls to and flashes the device's row, but didn't account for that
  table's own client-side pagination (added since): if the device wasn't on the page shown by
  default, the row got highlighted and scrolled to while hidden by `display:none`, with no visible
  effect at all. `tables.js` now exposes a small `revealTableRow()` helper that switches to whichever
  page a given row is actually on first, and the Hardware page uses it before highlighting.
  (Separately noticed while fixing this: Miniservers' own similar "?open=&lt;id&gt;" deep-link is
  stale leftover code from before that page's diagnostics UI moved into a Tabulator-backed dialog —
  not fixed here, tracked separately.)

## [0.19.3-alpha.1] - 2026-08-29

### Changed
- **Faster MQTT mapping match on a busy broker.** The gateway subscribes to `#`, so its message
  handler runs for every message on the broker — and it used to scan every enabled mapping with a
  topic-pattern match per message (O(mappings)). Almost every mapping is an exact topic, so they're
  now split into a Map keyed by exact topic plus a small list of the genuine wildcard (`+`/`#`)
  mappings: the common case is a single Map lookup. Same set of matches as before (pinned by a
  test); the win shows up with many mappings and/or high message volume.

### Fixed
- **Two top-bar icon controls were missing an `aria-label`** (the auto-refresh interval selector and
  the help-text show/hide toggle) — they had hover tooltips but nothing for screen readers. Added,
  matching the labelling every other top-bar control already had.

## [0.19.2-alpha.1] - 2026-08-29

### Added
- **Pre-migration dump for Postgres and MySQL/MariaDB.** 0.19.0 added an automatic pre-migration
  snapshot for SQLite; the other backends only got a log warning. Now, before applying any pending
  migration, LoxSuite takes a real `pg_dump` / `mysqldump` (reusing the backup engines) into
  `backups/`, giving an actual restore point. This matters most on MySQL/MariaDB, where DDL
  auto-commits — a migration that fails partway can't roll back and leaves the schema half-changed,
  so a fresh dump is the difference between a clean restore and a manual repair. Same guards as the
  SQLite snapshot: only when there's something pending on an already-migrated database (not on a
  fresh install), the newest five are kept, and it never blocks startup — a failed dump is logged
  and the migration still runs. Verified end to end against a real MariaDB 10.11 and Postgres 16.

## [0.19.1-alpha.1] - 2026-08-29

### Fixed
- **The MySQL/MariaDB backend actually works now — it was broken across several migrations and had
  never been run end to end against either server.** The new CI backend jobs (0.19.0) caught it
  immediately:
  - Migrations 003/010/011 dropped a CHECK constraint with `ALTER TABLE ... DROP CHECK`, which is
    MySQL syntax; MariaDB rejects it and needs `DROP CONSTRAINT`. Both share the mysql2 client, so
    they're now told apart at runtime by the server's `VERSION()` string.
  - Migration 009's index on `monitors(source_type, enabled)` failed with "key too long" because
    `source_type` was a `TEXT` column — MySQL/MariaDB can't fully index TEXT under utf8mb4.
    `source_type` is now a bounded string on MySQL/MariaDB (matching every other indexed enum column
    in the schema), still `TEXT` on SQLite/Postgres.
  Verified end to end against a real MariaDB and Postgres (all 16 migrations + the facade smoke
  test), with the full SQLite suite still green. Existing SQLite/Postgres installs are unaffected;
  no MySQL/MariaDB install had ever gotten past migration 003, so there is nothing to migrate back.

## [0.19.0-alpha.1] - 2026-08-29

### Added
- **Notification rules now default to sending through the channels you actually have.** Adding a
  rule pre-ticks every enabled channel under "Send via" instead of leaving them all unchecked, and
  the Hardware page's one-click enable buttons now wire the new rule to those channels too rather
  than creating it with none. Both used to produce an *enabled* rule attached to zero channels —
  which faithfully logged every alert to the Notification Center while silently never sending it
  anywhere. You can still untick a channel; the change is only about the default.
- **The rules table flags a rule that's enabled but goes nowhere.** A rule that's on with no
  channel selected now shows a "No channel" warning in the Channels column (and the same flag in
  the Tech report's rule list), so the "shows in the Notification Center but never actually sends"
  state is visible at a glance instead of only discoverable by cross-checking enabled-vs-channels.
- **Per-rule delivery status.** The rules table has a new "Last sent" column showing when a rule
  last delivered, or a red "Last send failed" badge (with the underlying error on hover) when its
  most recent attempt errored — previously that only ever lived in the System log.
- **Clicking a hardware notification jumps to the device, not just the list.** Battery-weak,
  device-offline and device-firmware-changed notifications now link straight to the device that
  caused them and highlight its row, instead of only opening the whole (Miniserver-filtered)
  Hardware list. Backed by a new `source_ref` on notification events carrying the device's stable
  key; older events recorded before this fall back to the previous list-only behaviour.
- **Dead-man's-switch heartbeat.** LoxSuite can now ping an external watchdog URL
  (healthchecks.io, an Uptime Kuma push monitor, ...) on a configurable interval — Settings >
  Health monitoring. Because a dead gateway can't send you its own "I'm down" alert, the watchdog
  alerts *you* when the pings stop instead. Off by default (blank URL / 0 minutes); read live, so
  changing it takes effect without a restart.
- **Failed notifications retry before they're lost.** A send that fails outright (an Apprise
  timeout, the box briefly offline, a 5xx it gives up on) is now retried on a short backoff (~30s,
  2m, 5m) instead of the alert only ever landing in the Notification Center. Each channel retries
  independently and detached, so a slow or retrying send never holds up the others or the poll that
  fired the rule; a genuinely wrong channel URL still stops after the scheduled attempts rather than
  looping forever, and shows up under "Last sent" as a failure.
- **Automatic pre-migration database snapshot (SQLite).** Because `main` auto-publishes to GHCR on
  every push, a schema migration reaches a live install unattended on its next restart — and a bad
  one on a single SQLite file has no server-side recovery to fall back on. Now, right before
  applying any *pending* migration, LoxSuite copies the database to a timestamped `.bak` beside it
  via SQLite's own WAL-safe online backup, keeping the five most recent. It's skipped on ordinary
  boots (nothing pending) and on a fresh install (no data to protect), and never blocks startup — a
  failed snapshot is logged and the migration still runs. Postgres/MySQL (which have their own
  server-side backups) instead get a clear log warning before an unattended migration runs.

### Changed
- **A broken push to `main` no longer publishes a Docker image.** The image-publish workflow now
  runs the gateway's test suite first and only pushes `:latest` to GHCR if it passes, instead of
  the build and the tests running as two independent workflows — so a red test run can't ship a
  broken `:latest` to installs that auto-update.
- **The Postgres and MySQL/MariaDB backends are now tested in CI against real servers.** They ship
  and are recommended for larger installs, but every DB-touching test only ever ran on SQLite, so a
  dialect bug in a migration or the async db facade (BIGINT `COUNT(*)` coming back as a string,
  `insertReturningId`'s `RETURNING`-vs-`lastInsertRowid` split, transactions on a real pool) could
  only surface on a user's live server. New `test-postgres` / `test-mysql` jobs run a dedicated
  `dbBackendSmoke.test.js` — all migrations plus the facade's dialect-sensitive operations — against
  a real Postgres and MariaDB service container. (Verified locally against Postgres; the same test
  covers MariaDB in CI.)

### Fixed
- **Corrected a stale code comment claiming the MySQL/MariaDB backend "isn't reachable".** The
  comment in `db/index.js` said `resolveDbConfig()` refuses `DB_BACKEND=mysql` — untrue since the
  MySQL/MariaDB backend shipped in 0.13.0; it's a fully supported backend. No behaviour change,
  just an actively misleading note removed.
- Added a unit test pinning the gettoken auth-failure rule (only a literal 401 is a permanent,
  never-retry failure; every other non-200 code stays retryable) — the exact distinction behind the
  0.18.27 "stuck in auth_failed after a simultaneous restart" fix, now guarded against regression.

## [0.18.29-alpha.1] - 2026-08-28

### Added
- **Tech report now lists every notification rule by name** — trigger type, enabled/disabled, and
  which channel(s) it's wired to. The existing rule *count* alone couldn't say which rules those
  were, or whether any had quietly ended up disabled — exactly the question that came up
  troubleshooting a report of notification settings appearing to reset after an update.

## [0.18.28-alpha.1] - 2026-08-23

### Fixed
- **Shelly devices could stay showing their raw MQTT client ID (instead of their real topic
  prefix) on Client Activity after the gateway and the MQTT broker restarted together**, only
  clearing up once the device itself was power-cycled by hand. The gateway already asked every
  Shelly to re-announce itself once, right after its own reconnect — not enough when the broker
  restarted too, since every device's session dies at once and a Shelly reconnecting to the fresh
  broker can still be a beat behind that one request. Now repeats the request a few times over the
  following minute instead of asking just once — verified against a real broker.

## [0.18.27-alpha.1] - 2026-08-23

### Fixed
- **A Miniserver (reported on a Gateway one specifically) could get stuck showing "Auth failed"
  after the gateway container and the Miniserver restarted together** (e.g. an unattended Docker
  backup snapshot restarting the container) — even though the credentials were never actually
  wrong; a manual "Test now" always worked instantly. Two related causes: the live websocket
  connection treated ANY non-200 token response as a permanently-wrong-password, never-retry
  condition, when only Loxone's own documented 401 ("Unauthorized") actually means that — a stale
  session/lockout right after a simultaneous restart isn't 401 and isn't permanent either, it
  clears up on its own within the normal reconnect backoff now instead of needing a manual kick.
  Separately, the recurring healthcheck sweep used to skip an "Auth failed" Miniserver forever once
  marked — it now gets a real recheck again automatically every 15 minutes, so a transient
  rejection there self-heals too instead of sitting stuck until someone notices.

## [0.18.26-alpha.1] - 2026-08-18

### Added
- **Disable a user without deleting their account** — Administration > Users has a Disable/Enable
  action alongside Delete. A disabled account can't log in (local password or SSO) and, if it's
  already signed in somewhere, is signed out on its very next request rather than staying valid
  until the session happens to expire. Same self-service and last-administrator guards as Delete.
- **Administration > Security now warns about a misconfigured reverse proxy/tunnel** — without
  `TRUST_PROXY` set, every visitor looks like they're on the local network to this app, which
  silently defeats both "Require SSO from outside the local network" and the login rate limit's
  per-IP tracking. Now detected and flagged on the page with what to fix.

### Fixed
- **A local (non-SSO) account could keep working from outside the local network after logging in**
  — "Require SSO from outside the local network" (Administration > Security) was only enforced at
  the login form itself; an already-open session (or a "Remember me" cookie) kept working from
  anywhere afterward. Now re-checked on every request, so access is cut the moment the account is
  no longer on the local network.

## [0.18.25-alpha.1] - 2026-08-17

### Fixed
- **Dashboard loading skeleton could overlap a group's header with the panel above it**
  (0.18.24-alpha.1) — the per-panel/per-zone pixel position it pre-computed could fall short of
  GridStack's own real, settled layout (a panel that grows to fit its content, a freshly-added
  empty group, ...), letting the next group's header render up into the panel above it. Replaced
  with a generic, position-independent placeholder shown over the whole grid while loading — it no
  longer touches any real panel's own position or height, so this can't recur.

## [0.18.24-alpha.1] - 2026-08-17

### Added
- **Separate right-axis minimum/maximum on chart panels** — a series routed to the right Y-axis
  previously had no way to fix its own range; only the left axis had a Min/Max override.
- **Group selector in Add/Edit panel** — pick which existing group a panel belongs to right from
  the form, instead of only being able to move it there afterwards by dragging.
- **"Replace" a monitor from a panel's Edit drawer** — swap a checked monitor for another one and
  carry its Series settings/Threshold/Value-per-name overrides over to the new monitor, instead of
  starting blank. Mainly useful right after duplicating a panel.

### Changed
- **Adding a panel no longer reloads the whole dashboard** — the Add-panel form now grafts the new
  panel straight into the live grid (`fetch()` + GridStack's own `makeWidget()`), falling back to a
  normal page load on any failure. One known trade-off: opening that specific brand-new panel's own
  Edit drawer still forces a single reload the first time, since its settings-form JS can't be
  wired up without one — every other panel is unaffected.
- **Dashboard panels no longer visibly jump into place while loading** — GridStack only ever
  positions panels via JS, so before that ran (and again after its own load-time compaction/min-size
  correction passes) everything briefly rendered stacked at the top. Panels now render with their
  known position already baked in, and stay behind a pulsing placeholder until GridStack's layout is
  genuinely final and every chart has actually painted.

### Fixed
- **Loxone Logbook's "no permission" notice no longer gets clipped** — the table card had no
  minimum height, so a 0/1-row error state shrank it down until the notice sitting on top of it was
  cut off by the card's own rounded-corner clipping.

## [0.18.23-alpha.1] - 2026-08-16

### Fixed
- **Off-center icons on the new Favorite/Lock panels/Auto order buttons** — the same
  icon-only-button-needs-its-text-margin-removed bug already fixed once for the notification bell;
  these three just weren't in that exclusion list yet. Measured 0.00px left/right gap difference
  now, in every state (favorited/unfavorited, locked/unlocked).

## [0.18.22-alpha.1] - 2026-08-16

### Changed
- **Favorite/Lock panels/Auto order are now icon-only**, grouped together at the right edge of the
  Dashboard/My Dashboards toolbar — Favorite moved there from its own separate row. Favorited and
  Locked now read from the button's own color + filled icon (the same convention Favorite's star
  already used), not text.

## [0.18.21-alpha.1] - 2026-08-16

### Added
- **"Lock panels" on the Dashboard and every My Dashboards board** — locked, a panel can't be
  dragged, resized, or dropped into another group (everything else — opening a panel's own edit
  drawer, tapping a control inside it — still works). Defaults to locked on a phone/tablet-sized
  screen, where a stray touch can trigger a drag by accident, and unlocked everywhere else;
  remembered per-device from there on (one shared preference across every dashboard, not a
  per-board setting).

## [0.18.20-alpha.1] - 2026-08-15

### Added
- **The gateway now registers its own MQTT Last Will and Testament** (`loxsuite/gateway/status`,
  retained) — the same "I went away" signal Shelly/Zigbee2MQTT/Tasmota devices already give the
  broker, which the gateway itself never had. An ungraceful stop (crash, OOM-kill, a yanked network
  cable, a killed container) now flips that topic to `offline` automatically via the broker's own
  Will delivery, with no code involved since the process is already gone; a graceful stop
  explicitly publishes `offline` first so an intentional restart reports the same accurate status
  instead of leaving the topic frozen on `online`. Verified against a real broker: SIGKILL → broker
  auto-delivers `offline`; SIGTERM → explicit `offline` publish completes before the process exits.
  Any other MQTT-side integration (Node-RED, Home Assistant, a monitoring dashboard, ...) can now
  watch this topic to know if LoxSuite's own gateway is actually up.

## [0.18.19-alpha.1] - 2026-08-15

### Added
- **"Clear retained" button on Live Data / Incoming Messages** — purges the broker's own retained
  copy of a topic (publishes a zero-length retained message, the MQTT spec's own standard way to do
  it) so a stale value from a renamed/replaced/removed device stops replaying to every new
  subscriber. Only shown on a topic currently flagged Retained (see 0.18.17-alpha.1's own retained
  badge).

## [0.18.18-alpha.1] - 2026-08-15

### Added
- **Per-user "Extra permissions" on MQTT Users** — each user row now has a Permissions section
  showing what its role already grants (read-only, edit that on MQTT Roles instead) plus that one
  user's own extra ACLs on top, for the rare case where a single device needs something beyond its
  shared role without loosening that role for everyone else who has it. Under the hood this is a
  second, auto-managed role held only by that user (Mosquitto's dynsec plugin has no real per-client
  ACL concept at all — confirmed against a real broker) — verified against a real broker that an
  admin's `Deny` on the base role always wins over an `Allow` added here for the same topic,
  regardless of role-attach order: the base role someone else manages always has the final word.

## [0.18.17-alpha.1] - 2026-08-15

### Added
- **Real Mosquitto broker stats** (Tech report's Live status card) — uptime, connected/registered
  client counts, messages/bytes sent & received, retained-message count, and active subscription
  count, read straight from the broker's own `$SYS/broker/#` topics rather than only ever showing
  LoxSuite's own count of what it happened to see. No config change needed — the bundled broker
  already publishes these every ~10s, nothing was subscribed to them before now.
- **"Retained" badge on Live Data / Incoming Messages** — a topic whose current value came from the
  broker replaying its last retained message (e.g. right after a reconnect) now reads visibly
  different from a genuinely fresh publish.

### Removed
- `device_monitor_status` dropped from the Tech report's Miniserver section — confirmed dead
  (superseded by `plc_state` years ago, nothing has written to it since), so it only ever showed
  a meaningless `null`.

## [0.18.16-alpha.1] - 2026-08-15

### Added
- **Tech report now covers four more diagnostic areas**: DB sequence health (Postgres/MySQL only —
  flags any table whose id-generator has fallen behind its actual data, the exact class of bug
  behind the "Internal Server Error" seen right after a database migration), backup status
  (schedule, last run/result, rclone remote status, and whether the backup directory itself is
  writable — never the decrypted rclone config), extended per-Miniserver diagnostics (PLC state,
  CPU load, heap status, task count), and feature flags (AI assistant/SSO enabled state and
  provider/model — never their credentials).
- **Unhandled route errors are now also logged to the System log**, not just the container's
  console/stderr — so they show up in a Tech report (and the in-app Logs page) instead of only
  ever being visible to whoever happens to be tailing the raw container output when it happens.

## [0.18.15-alpha.1] - 2026-08-14

### Added
- **Tech report** (Administration → General → Tech report) — a single diagnostic snapshot: LoxSuite/
  DB/Node versions, the most recent System/MQTT/Loxone Commands log lines, config counts (mappings,
  monitors, Miniservers, dashboards, ...), and live MQTT/Miniserver connection status. Viewable in
  the browser or downloadable as one JSON file, admin-only, generated fresh every time (never
  cached/stored). Passwords/tokens/secrets are never included; usernames are partially masked
  (first + last character) everywhere except a System-log audit line's own free-text sentence
  (e.g. `"admin" created user "newuser".`), which can still name a real username in its prose.

## [0.18.14-alpha.1] - 2026-08-14

### Fixed
- **Shelly (and other MQTT) devices could get stuck showing "Disconnected" in Client Activity after
  an update/restart, even though they were genuinely connected** — a device quick enough to
  reconnect before the gateway's very first Mosquitto-log replay finished had its fresh "connected"
  status wiped right along with genuinely stale, pre-restart leftovers. Now uses Mosquitto's own
  `mosquitto version X starting` log line as a hard reset point at the moment it's seen instead of
  blindly clearing everyone still marked "connected" once replay finishes, so a fast reconnect can
  no longer be mistaken for stale state regardless of how soon after boot it happened to log.
- **A renamed Shelly showed its raw factory MQTT client ID instead of its real (custom) topic
  prefix on Client Activity, and its topics never got picked up for the mqtt_topic autocomplete on
  the mapping "Add" forms** — same root cause as above: a Shelly's identity-announcing MQTT message
  is a one-shot, non-retained broadcast sent only on (re)connect, easily missed if it fires before
  the gateway's own MQTT subscribe completes, with no way to recover it afterward. The gateway now
  asks every currently-connected Shelly Gen1 device to re-announce itself (Shelly's own
  `shellies/command` "announceall" feature) right after every successful MQTT (re)connect, so a
  missed announce is retried automatically. A new "Rescan devices" button on Client Activity
  triggers the same request on demand, without needing to restart anything.

### Added
- The mapping "Add" forms (both directions) now offer mqtt_topic autocomplete suggestions, sourced
  from currently-connected devices' own topics only — a disconnected device's last-known topics
  aren't suggested, since mapping one of those would just never see a value come in.

## [0.18.13-alpha.1] - 2026-08-14

### Fixed
- CI: `Test` workflow's own `/admin/backup` smoke test failed on GitHub's runner (though never
  locally) — `backup.js` defaults `BACKUP_DIR` to the real production mount point, `/data/backups`,
  and every request to that page unconditionally `mkdir`s it first. The real Docker image runs as
  root, which can always create a fresh top-level directory; the bare `node src/server.js` this
  test spawns runs as whichever user invokes `npm test` — root locally, but GitHub Actions' own
  unprivileged runner user, which can't create `/data` at all. Verified against the actual failure
  mode (reproduced locally by running the exact same test as a non-root user, confirmed fixed
  the same way): the test now points `BACKUP_DIR` at its own throwaway temp directory instead.

## [0.18.12-alpha.1] - 2026-08-14

### Fixed
- **A Postgres/MySQL install could get "Internal Server Error" on an otherwise-ordinary insert**
  (e.g. adding a Loxone → MQTT mapping) if that table's id-generator (a Postgres sequence /
  MySQL AUTO_INCREMENT counter) had fallen behind the table's real data — the classic aftermath of
  rows being copied in with their own explicit ids (the SQLite → Postgres/MySQL transfer tool does
  exactly this) without also resyncing the counter afterward. Every currently-known path already
  did that resync, but that's an easy invariant for some future path to quietly miss, and once it
  happens the failure just sits there until whoever's first to insert into that specific table hits
  it. Now handled centrally and reactively instead of per-path: the DB facade itself recognizes this
  exact failure (a primary-key collision, not a real duplicate), repairs the counter, and
  transparently retries the same insert once — self-healing on the very next request that hits it,
  no manual SQL or migration step required, regardless of which table or what caused the drift.
- CI: `actions/checkout@v4` and `actions/setup-node@v4` in both GitHub Actions workflows bumped to
  v5 — the v4 releases are pinned to the Node 20 action runtime GitHub is deprecating (runs now get
  forced onto Node 24 with a warning instead).

## [0.18.11-alpha.1] - 2026-08-13

### Fixed
- **State bar panels could show "No data" at the start of a short range even when the real state
  was well known** — a state that hasn't changed in days (recorded only on change) can have zero
  readings within a short range like 24h, and the query never looked further back to check what
  was actually in effect at the range's start. A longer range (e.g. 7 days) happened to reach far
  enough back to include that same still-relevant reading and showed it correctly — same real
  state, two disagreeing answers depending only on which range was picked. Now seeds the first
  segment from the last known reading before the range starts.
- **A current-value panel could show an unwanted scrollbar** for a single value that was a pixel or
  two taller than its available space (line-height/padding rounding) — content that plainly never
  needed to scroll. Scrolling now only turns on for a panel that actually holds more than one value.
- The Monitor detail page's chart-truncation notice now correctly describes only the raw list below
  it — the chart itself isn't limited by that anymore since 0.18.10's downsampling fix.

## [0.18.10-alpha.1] - 2026-08-13

### Added
- **Downsample large chart series** setting (Settings → General, on by default). A monitor with far
  more readings than a chart's own point budget (2000) used to silently show only its newest slice
  within whatever range was requested — a fast-changing reading (a live power draw, say) could blow
  through that budget within just the last few hours of a 24h+ chart, with nothing indicating the
  rest of the range's older data even existed. On, each series is now averaged down to that budget
  instead, so a chart always covers the full requested range. Off restores the old exact-raw-values
  behavior (no averaging), at the cost of that same silent truncation for a fast monitor on a wide
  range.

### Changed
- Backup file sizes on Administration → Backups now show as KB/MB/GB (auto-scaled), not always KB —
  a multi-GB backup used to print as an unreadable 6+ digit KB figure.

## [0.18.9-alpha.1] - 2026-08-13

### Fixed
- **Backups silently stopped landing on persistent storage after unsetting `DB_PATH`** (the
  reasonable thing to do once switching from SQLite to Postgres/MySQL, since nothing about the
  actual DB connection needs it then) — `BACKUP_DIR` used to be derived from `DB_PATH`'s own
  directory, so once that variable was gone, every backup silently fell back to a path inside the
  container's own writable layer instead of the bind-mounted `/data` volume. `createBackup()` still
  reported success (a real, downloadable file existed — right up until the next deploy/recreate
  wiped it along with the rest of that layer, with nothing anywhere having said so). `BACKUP_DIR`
  is now its own setting (`/data/backups` by default, or `BACKUP_DIR` to override), completely
  independent of `DB_PATH`/the DB backend. **If you run Postgres/MySQL with `DB_PATH` unset: check
  whether your actual backups since that switch still exist under `/data/backups` on the host — if
  they don't, they were never really there.**
- Manual and scheduled backups now log to Logs > System (success and failure alike) — previously
  silent there, visible only via a configured notification channel (if any) or the Backups page's
  own "Last run" line.

## [0.18.8-alpha.1] - 2026-08-13

### Added
- **Self-signed HTTPS listener**, on port 5583 by default (`HTTPS_PORT`), bootstrapped once by
  docker-entrypoint.sh into `/data/tls` and never regenerated afterward. Root cause finally traced
  (via the 0.18.6/0.18.7 diagnostics, now removed) for the AI Assistant's MCP Authorize failing
  outright on some deployments: Loxone's cloud rejects any OAuth redirect_uri that isn't HTTPS or
  literally `http://localhost` — a Miniserver reached over a plain-HTTP LAN address (the normal
  case for a self-hosted instance with no reverse proxy) will never satisfy that. Visiting the
  Miniserver edit page at `https://<host>:5583/...` instead of the usual `:5582` and clicking
  Authorize from there now registers an `https://` redirect_uri Loxone actually accepts — one-time
  self-signed-certificate browser warning, no external domain or reverse proxy required.
- **`TRUST_PROXY` environment variable** (unset/off by default — see .env.example) for anyone
  running LoxSuite behind a reverse proxy or tunnel (Cloudflare Tunnel, Nginx Proxy Manager,
  Traefik...) that terminates HTTPS and forwards over plain HTTP internally. Without it, LoxSuite
  has no way to know the outside world sees HTTPS: SSO (Pocket ID, etc.) and Loxone MCP OAuth
  callback URLs get built as `http://...` and get rejected, and the SSO break-glass "always allow
  local login from the local network" exemption looks permanently true for every visitor — local or
  remote — since every request's visible address is the proxy's own local one.

## [0.18.6-alpha.1] - 2026-08-13

### Changed
- **Temporary diagnostics** for the "server_error" a specific Miniserver's MCP OAuth endpoint
  returns with no description: every discovery/registration/token request the MCP OAuth flow
  makes is now traced (method, URL, status, response body) to stdout as `[MCP-OAUTH-TRACE]` lines,
  to see which exact leg is failing and what that server actually sent back. Will be removed once
  diagnosed — not meant to stay past the next version.
- **"Start new login" now also appears** for a Miniserver that never finished authorizing at all
  (`mcp_access_token` still null) as long as *any* OAuth state got stored along the way — a prior
  Dynamic Client Registration or refresh token — since Authorize/Re-authorize can still try to
  reuse that stale state and fail the same "does nothing" way. Previously only shown once an
  access token existed.

## [0.18.5-alpha.1] - 2026-08-13

### Fixed
- **MCP Authorize/Re-authorize/Start new login failures logged a blank error message.** The OAuth
  SDK's error classes (`InvalidClientError`, `InvalidGrantError`, etc.) build their `.message` from
  the server's own `error_description` field, which is optional — a Miniserver/Loxone response that
  omits it produced a real `Error` with a genuinely empty message, so "Last MCP connection error"
  and the System log both showed nothing useful ("...failed: " with nothing after it). Now falls
  back to the error's own class name and OAuth error code (e.g. "InvalidGrantError
  (invalid_grant)") when the server doesn't send a description.

## [0.18.4-alpha.1] - 2026-08-13

### Fixed
- **Authorize/Re-authorize/Start new login never logged anything to Logs > System**, success or
  failure, on two of the three routes — only the OAuth callback route did. So after a failed (or
  timed-out) attempt, the one place a user would naturally go to check "what happened" showed
  nothing at all, regardless of whether the fix in 0.18.3-alpha.1 actually did anything. All three
  routes now log both outcomes there.

## [0.18.3-alpha.1] - 2026-08-13

### Fixed
- **Authorize/Re-authorize/Start new login could still hang forever on some hosts**, even after
  0.18.2-alpha.1. That fix only covered the case where the OAuth SDK's `auth()` call *resolves*
  without redirecting; it did nothing for a network path where the request is silently dropped
  (packets never come back at all, rather than a clean refusal) — the underlying call has no
  timeout of its own, so nothing ever settled and the click just sat there with zero error, zero
  log output, forever. Now bounded at a hard 25-second ceiling: a genuine network-reachability
  problem now surfaces as a clear "Timed out... check that this container can actually reach it
  over the network" error under "Last MCP connection error" instead of hanging silently.

## [0.18.2-alpha.1] - 2026-08-13

### Fixed
- **Miniserver edit page's Authorize/Re-authorize/Start new login buttons could hang forever with
  no error.** The MCP OAuth SDK's `auth()` call can succeed by silently refreshing the stored token
  internally, without ever redirecting the browser anywhere — and nothing else in these routes sent
  a response in that case, so the click just sat there indefinitely. Now redirects back to the edit
  page itself (showing "Authorized.") whenever `auth()` resolves without already having redirected.

## [0.18.1-alpha.1] - 2026-08-13

### Fixed
- **False "device firmware changed" alerts** for an Audioserver: its own `/version` endpoint
  ("17.02.08.11") and the Miniserver status XML's fallback (used whenever that direct fetch
  fails — different subnet, firewalled, a transient blip — "MINISERVER V 17.2.08.11 &lt;mac&gt; |
  ~API:2.0~") describe the identical firmware differently; comparing them verbatim fired a
  notification every time reachability happened to flip. Now compared by their actual dotted
  version number, normalized for each segment's own leading zeros, so the two representations of
  one unchanged version no longer read as a change.
- Monitor/Dashboard charts: a value that stays unchanged for a long stretch (change-only history
  dedup, especially for an MQTT-sourced monitor that only publishes on change) drew as a diagonal
  line to whenever it was next recorded instead of a flat one. A gap over 30 minutes between two
  real readings now gets a synthetic point holding the prior value right before the next real one,
  so the line reads as flat across it — without forcing every other, normally-sampled series into
  a stepped look. An axis with every one of its series toggled off in the legend now hides itself
  instead of falling back to Chart.js's own broken-looking 0-1 default range.
- Raised the System log's "Slow query" threshold from 200ms to 3000ms — a brief burst of
  contention right after boot (retention purges + MQTT/websocket reconnects all firing at once)
  routinely pushed even trivial single-row lookups into the hundreds-of-ms range for a few
  seconds, drowning out the genuinely slow (multi-second) queries this log exists to surface.

## [0.18.0-alpha.1] - 2026-08-13

### Added
- **AI Assistant: multi-provider support**. Ollama/OpenWebUI is now the bundled default
  (`docker-compose.yml` ships an `ollama` service out of the box, no API key, no per-token
  billing) — Claude (Anthropic), ChatGPT (OpenAI), and Gemini (Google) are optional alternatives,
  each with their own API key field and a short recommended-model list (or type any custom one).
  Administration → AI Assistant checks whether the chosen Ollama model is already pulled and, if
  not, pulls it right there with a live progress log — survives navigating away, and a
  Notification Center entry fires once it's ready. Downloaded Ollama models can also be deleted
  from the same page.
- **AI Assistant: local-data fast path**. For "what's the current value of X" questions, LoxSuite
  now tries to resolve the answer directly from its own already-live data (the same cache Live
  Data/dashboards use) before the model ever makes a tool call — no network round trip to the
  Miniserver on a hit. Two new tools (`local_find`/`local_state`) are offered to every provider
  alongside the Miniserver's own MCP tools, and a deterministic pre-fetch step resolves the common
  single-room/single-value case in plain code, handing the model a ready-made fact instead of
  relying on it to fetch one correctly. Falls back to the Miniserver's own MCP tools for anything
  else (history/statistics, writes, or a value not yet reflected in the live cache).
- **AI Assistant: chat widget polish** — Markdown rendering (bold/lists/code) instead of literal
  `**asterisks**`; a Retry button on any failed reply; message timestamps that reflect when a
  reply actually finished, not when it started; an unread badge on the launcher for a reply that
  finished while the panel was closed or showing a different conversation; new conversations
  pre-select the first available Miniserver; the panel now only closes via its own close button or
  Escape (not by clicking elsewhere), so it reliably stays open across page navigation.
- Miniserver edit page: a **Start new login** button next to Re-authorize, for when a stuck token
  refresh needs a clean slate instead of repeating the same failing refresh. The Miniservers list's
  own row-level "Test now" popover now shows the AI Assistant (MCP) check result too, with the same
  colored icons as the edit page.
- System log entries for Miniserver and AI Assistant settings saves now show what actually
  changed (`field: old → new`) instead of a bare "updated X."

### Fixed
- **Slow query**: `Logs → Loxone Commands` (and any other Logs tab where its own source is a small
  fraction of a much larger `log_entries` table) could take 3+ seconds — the existing index
  supported the date-range filter, not the `ORDER BY id DESC` this page's own query actually needs,
  so a rare source in an otherwise huge table forced a near-full-table scan. Added the missing
  `(source, id)` index.
- Ollama performance tuning for CPU-only inference: keeps the model resident far longer
  (`OLLAMA_KEEP_ALIVE`), quantized KV cache + flash attention, a capped context length, trimmed
  tool descriptions, a hard cap on how much of an oversized tool result gets fed back to the model,
  and a cap on reply length — together, these cut a cold multi-tool-call turn from 100+ seconds to
  a small fraction of that in testing.
- The AI Assistant's system prompt now explicitly forbids stating a value it didn't literally see
  in a tool result, and requires it to actually call a tool rather than describe or narrate one —
  both verified against real (if imperfect, especially on small local models) improvements.

## [0.17.1-alpha.1] - 2026-08-12

### Fixed
- **Postgres**: opening a Monitor's detail page (and several other pages — Dashboards' own sharing
  lists, Logs export, Transformations' mapping lists, the Monitor list's Dashboard/panel-count
  columns, and every panel's "current value") crashed or silently showed missing data, because
  Postgres folds an *unquoted* SQL alias to lowercase while SQLite preserves it as written — a
  hand-written query aliasing a column as `recordedAt` came back from Postgres as `recordedat`,
  so the app's own `row.recordedAt` read `undefined`. Only surfaced now because this is the first
  time an existing install's real data has actually round-tripped through Postgres. Every affected
  alias across the app is now explicitly quoted so its case survives on Postgres too; SQLite and
  MySQL/MariaDB are unaffected either way.

## [0.17.0-alpha.1] - 2026-08-12

### Added
- **AI Assistant (optional)**: LoxSuite can now connect to a Loxone Gen2 Miniserver's own MCP
  server plugin and to Claude (Anthropic), to power a chat page that can read — and, if you
  explicitly allow it per Miniserver, control — a connected installation. Off by default at two
  independent levels (Administration > AI Assistant's own enable switch, and a per-Miniserver
  toggle on its edit page) — with nothing configured, nothing changes: no new outbound calls, no
  new nav item, existing dashboard suggestions unaffected. Connecting a Miniserver's MCP server is
  a one-time Loxone-account OAuth login from that Miniserver's edit page; every write-capable tool
  call the assistant makes is logged in Logs > Loxone commands like any other command, tagged with
  its own source.

### Fixed
- **Postgres**: migration `003_backup_succeeded_trigger.js` (first shipped in 0.13.8-alpha.1)
  failed on Postgres with `bind message supplies 11 parameters, but prepared statement "" requires
  0` — Postgres's DDL parser doesn't accept bound parameters inside an `ALTER TABLE ... ADD
  CONSTRAINT ... CHECK (...)` expression the way it does for ordinary statements. Only surfaced now
  because Postgres had apparently never actually been run through this migration before. Fixed by
  inlining the fixed trigger-type list as escaped literals instead of bind parameters; SQLite and
  MySQL/MariaDB were unaffected.
- A `DATABASE_URL` whose username or password contains a raw, non-percent-encoded `%` crashed the
  whole process with an uncaught `URIError` at boot instead of the clear, boxed configuration error
  every other misconfiguration on this path already gets.

## [0.16.1-alpha.1] - 2026-08-12

### Fixed
- Some Loxone readings (weather-server values like Current Humidity/Temperature/Precipitation)
  now report their value pre-formatted with the unit already appended ("33 %", "28.6 °C")
  instead of a bare number. Parsing that with `Number()` returned `NaN` and treated the whole
  reading as non-numeric — breaking its chart history, threshold coloring, and notifications, and
  showing the panel's own configured unit stacked on top of Loxone's own ("33 % %"). Value/Gauge/
  Stat delta/Threshold panels now correctly parse the leading number regardless of a trailing
  unit, and only fall back to displaying Loxone's own unit when the panel has no Unit field of
  its own configured — an explicit Unit override still always wins.

## [0.16.0-alpha.1] - 2026-08-12

### Added
- Miniservers: a Miniserver that's reachable but rejecting its configured credentials (HTTP
  401/403 — the Loxone user account was disabled, its password changed on the Miniserver side,
  ...) now gets its own **Auth failed** badge, distinct from a plain Offline, on the Miniservers
  list, the Home dashboard's Miniservers widget, and Live Data's connection status.

### Fixed
- The 0.15.0-alpha.1 poll-storm fix bounded *concurrency*, but a Miniserver rejecting credentials
  outright was still retried automatically forever — every poll cycle, every healthcheck cycle,
  every websocket reconnect — even though the exact same request would fail identically every
  single time until the account itself is fixed, unlike a transient network blip. Monitor polling,
  the background healthcheck sweep, and the live websocket's own reconnect loop now all stop
  retrying a Miniserver the moment a 401/403 is seen, and only try again once the user explicitly
  asks — the Miniservers page's **Test now**, or saving that Miniserver's settings.

## [0.15.0-alpha.1] - 2026-08-12

### Added
- Hardware page: Audioserver rows and their Audio zones now show a real **Online**/Offline status
  — the Miniserver's own `/data/status` (this page's usual source) never reports one for either,
  confirmed in Loxone's own Structure File documentation as a real, separate control type
  (`AudioZoneV2`) with its own `serverState`/`clientState`, read the same way every other live
  Loxone value already is in this app (the existing websocket push cache, HTTP as a fallback).
- Each Audio zone now shows which Audioserver it belongs to (**Zone of** column, grouped together
  in the table) and a **Stereo** badge when a Stereo Extension is physically attached to that
  zone, both read from the same Structure File data.
- Topbar: a heart button next to Help/Notifications opens a **Support LoxSuite** dialog linking to
  a GitHub star and a one-time PayPal donation.

### Fixed
- A Miniserver going unreachable (offline, mid firmware-update, ...) could make the whole app's own
  page loads stall, not just Loxone monitor polling. The background poll loop fired one HTTP
  request per due monitor with no concurrency limit at all, and no cap carried over between ticks —
  an outage turned every 5s tick into an uncapped burst of dozens of simultaneous requests, each
  held open up to 8s, piling further on top with every subsequent tick for as long as the outage
  lasted. Confirmed live on a production instance mid firmware-update: bursts of ~90 simultaneous
  timeouts every ~16-18s, severe enough that even the gateway's own loopback connection to its
  bundled MQTT broker, and its own Docker health check, started timing out too. Polling now goes
  through a small persistent worker pool (4 concurrent requests, the same limit Live Data already
  uses for the exact same reason) shared across every tick, so it can never stack up further the
  longer an outage lasts. The MQTT→Loxone command-forwarding path (`sendHttpVirtualInput`) had no
  timeout at all; now capped at 8s like every other Miniserver request.

## [0.14.0-alpha.1] - 2026-08-12

### Added
- **Administration → General → Device templates**: device definitions now load from three tiers —
  this app's own built-ins, anything fetched from GitHub, then your own files — each able to
  override an earlier one's same device. A **Fetch latest built-ins from GitHub** button pulls
  straight from the project's `main` branch (ahead of a full app release), and **Reload from disk**
  picks up either that or a hand-edited file without a restart. Every fetched file is parsed and
  validated before it's written, so a malformed/truncated fetch can never clobber a previously-good
  one. Lists what's actually loaded from each tier, flagging any of your own files that are
  byte-identical to a current built-in/GitHub-fetched device — almost certainly a stale leftover,
  safe to delete so the built-in takes over again.
- Mappings → Common Commands: a **Sync new built-in commands** button (shown once the catalog is
  customized) adds whatever's missing from the built-ins — a new device family, or a new
  command/data point on an existing one (e.g. Shelly's Reboot command) — without touching or
  reintroducing anything already edited or deliberately removed.

### Fixed
- A device-templates file bind-mounted into a real install only ever got copied in **once**, on
  the very first boot ever — any file already sitting there, from whenever that was, permanently
  shadowed a newer built-in with the same name, forever, even after every later update. The
  built-ins are now read directly from the image itself, always current; the bind-mounted folder
  is migrated (once, safely — nothing is ever deleted, only moved) into its own `user/` subfolder
  on upgrade, and only ever holds what you actually put there yourself.
- The point-and-click Common Commands catalog editor has the exact same failure mode one layer
  up — once customized, saved as one complete snapshot that never automatically gained a
  since-added built-in command either, even after an app update. See "Sync new built-in commands"
  above.

## [0.13.9-alpha.1] - 2026-08-11

### Fixed
- Connected Clients' Device column could never learn a Shelly's real name once it had been renamed
  away from the factory topic prefix in the device's own web UI: device discovery only recognized a
  topic prefix as "known" if it still matched that model's exact factory pattern (e.g.
  `shellyplug-s-<mac>`), which a custom name like `shellyplug-ZWEMBADVerwarming` no longer does —
  same effect on the Schedule command device dropdown and Suggest Commands. Fixed by also
  registering any topic prefix seen under a known root namespace (`shellies/`, `zigbee2mqtt/`,
  `homeassistant/`) regardless of which (if any) family pattern matched.
- On top of that, a renamed Shelly's topic prefix and its MQTT client ID can end up sharing no text
  at all — renaming only changes the topic prefix, never the client ID (which stays the factory
  model+MAC value forever) — so the existing best-effort text match had nothing to work from. Now
  resolved using the MAC address the device itself broadcasts on `shellies/announce` whenever it
  (re)connects, matched against that same MAC embedded in its factory client ID: a confirmed fact
  reported by the device, not a guess.

## [0.13.8-alpha.1] - 2026-08-11

### Added
- **Scheduled device commands** — Client Activity's new "Schedule command" button (next to Suggest
  commands, for any device resolved to a known Common Commands family) lets a command be re-sent on
  a repeating schedule: daily, every N days, or weekly on specific days, at a time evaluated in the
  gateway's own configured display timezone (Settings) rather than the container's. Entirely
  opt-in per device — nothing runs unless a schedule is explicitly added. A **Test** button sends
  the picked command once immediately, before committing to a schedule; each saved schedule gets its
  own **Run now**, enable/disable, inline edit (time and repeat pattern), delete, and a
  **Last run**/**Next run** column so a silent failure (broker not connected, ...) is visible
  instead of quietly not happening.
- A real **Reboot** command, added to every built-in Shelly Gen1/Gen2/Gen3 device template — Gen1's
  `shellies/{device}/command` = `reboot`, Gen2/3's RPC `Shelly.Reboot` over MQTT. Shows up in
  Suggest Commands too, not just the new scheduler.
- Loxone Commands log: a rejected "no matching mapping" row now shows **Pending** once a mapping for
  it actually exists — the row itself is a snapshot of what happened at the time, so it used to sit
  there looking permanently Rejected even after being fixed, with no hint that Loxone just hasn't
  sent that exact command again yet (it never retries on its own). A new **Send test command** form
  on that page fires an arbitrary token/value at the gateway's own UDP listener, to see the whole
  Rejected → add a mapping → Pending → send again → Accepted arc on demand.
- **Backup succeeded** is now its own notification trigger, alongside the existing Backup failed —
  kept separate rather than making Backup failed also fire on success, so an existing failure-only
  rule keeps meaning exactly what its name says.
- Chart panel legend redesigned as an actual table (closer to how Grafana's own legend reads):
  swatch/name/Min/Max/Avg/Now as real columns instead of one long sentence per series, capped to a
  share of the panel's own height (scales with the panel, not a fixed value) with its own scrollbar
  past that — a chart with many series can no longer squeeze the plot itself down to a sliver.

### Changed
- A dashboard panel's own drag handle and "…" action button now hide themselves while that exact
  panel's Edit drawer is already open — both were redundant clutter at that point.
- The Edit-panel monitor checklist now sorts a newly-checked monitor to the top immediately, not
  just after the next page reload.
- Chart panel Series settings: Style/Point-style/the per-series color checkbox+swatch now land
  together on one row as intended — a missing CSS rule on the point-style dropdown was stretching it
  to the full row width and forcing everything after it onto its own line.

### Fixed
- A chart panel's canvas didn't correctly resize itself when a legend was present: Chart.js measures
  its available space from the canvas's own direct parent, which never actually shrank just because
  a legend sibling started sharing space in it via flex — so growing a panel left a visible gap
  between the plot and the legend, and shrinking one left axis tick labels cramped/overlapping
  (computed for a size the canvas no longer actually had). Fixed by giving the canvas its own
  dedicated, correctly-flex-constrained box, so Chart.js always measures the real thing.
- The custom chart legend disappeared after the very first 15-second live refresh, even though it
  displayed correctly on initial load — `showLegend`/`resolvedPosition` were only ever computed on
  the code path taken the first time a chart was drawn; every refresh after that hit an early
  return before reaching them, passing `undefined` into the legend builder, which treats that as
  "hide it".

## [0.13.7-alpha.1] - 2026-08-10

### Added
- Loxone Live Data and MQTT Live Traffic now show a **Status** column with small purple badges
  (Monitored/Widget/Mapped) so it's obvious at a glance which values are already tracked somewhere
  else, without needing to click + Monitor or + Widget to find out.
- Both +Monitor and +Widget now grey themselves out once the value already has one — pinning the
  same value on the Dashboard a second time used to silently create a duplicate panel; it's now
  rejected the same way a duplicate monitor already was. Applies to the single-row buttons, the
  per-room bulk actions, and the Miniservers diagnostics "Add to Monitor" button.
- The Miniservers page's diagnostics dialog also greys out "Add to Monitor" once CPU load, heap
  value, and task count are all already being tracked.

### Changed
- Live Data's bulk "Monitor selected"/"Widget selected" now disable the moment even ONE selected
  control is already monitored/widgeted, instead of only once every selected control is — avoids a
  partial bulk add silently skipping some of the selection with no visual warning beforehand.
- A bulk add's rows now update their Status badges and buttons immediately in place once it
  succeeds, without needing a page reload to see the new state.
- Deleting a monitor (or clearing its history) now responds immediately and removes the row from
  the page right away; the actual history purge runs in the background afterwards instead of
  blocking the page load — a monitor with years of history used to make the page hang for a long
  time on delete.

### Fixed
- Manually adding a monitor (Monitor page's own Add form) for a value/topic that already had one
  silently created a second, duplicate monitor — this is the one path that check was missing from.

## [0.13.6-alpha.1] - 2026-08-10

### Added
- **Gauge** panels can now also give one monitor its own minimum/maximum, on top of the per-value
  unit/thresholds added in 0.13.5-alpha.1 — the whole range, not just the coloring, can now differ
  per value (e.g. Temperature at 0-40°C next to Humidity at 0-100% in the same panel).
- A panel's shared Unit/Threshold colors/Min/Max/Value names &amp; colors field now hides itself
  once every currently-selected monitor already has its own override for that specific thing —
  applies to Value (Unit), Chart (Y-axis unit), Gauge (Unit/Min/Max/Threshold colors), and State bar
  (Value names &amp; colors). A field stays visible as long as it's still the real, active fallback
  for at least one selected monitor; nothing disappears just because 2+ monitors are checked.

### Fixed
- A Gauge panel's per-value minimum/maximum override, when left blank, was silently saved as an
  explicit `0` instead of "no override" (`Number(null)` is `0` in JavaScript, not `NaN`) — the
  monitor would then show a broken 0-0 range instead of falling back to the panel's own min/max.

## [0.13.5-alpha.1] - 2026-08-10

### Added
- **Gauge** panels can now give one monitor its own unit and/or threshold colors instead of sharing
  the panel's — e.g. Temperature at °C and Humidity at % in the same panel, each with its own alert
  thresholds. Min/max/scale/decimals stay shared across the panel.
- **State bar** panels can now give one monitor its own value names/colors instead of sharing the
  panel's mapping — e.g. a lock's 0/1 and a mode control's 1/2/3 in the same panel.
- Monitor's table has new (default-hidden, enable via the Columns menu) **Room** and **Category**
  columns showing where a Loxone-sourced monitor's control actually lives.
- New installs now ship with `jLocked` pre-hidden in Settings' "Hidden state names" — near-universal
  noise on any installation with a lockable control, previously something everyone had to discover
  and type in by hand.

### Changed
- A dashboard panel's Edit/Duplicate/Delete buttons now collapse behind a single "…" menu instead
  of three separate icon buttons, matching the same kebab-menu pattern already used for table rows.
- The Edit-panel drawer's monitor checklist now sorts already-checked monitors to the top.
- Monitor history is no longer written on every poll regardless of whether the value changed: a row
  is only inserted when the value actually changes, plus (for numeric monitors only) a 30-minute
  heartbeat so a chart/stat panel filtered to a short range never comes up empty for a monitor
  that's been constant longer than that. This is the main fix for backup size growing every day even
  with no real data changes.
- A State bar panel's own minimum drag-resize height is one grid row-unit shorter than before.

### Fixed
- A **Current value** panel showed an unwanted scrollbar once resized narrow enough for a long
  monitor label to wrap onto multiple lines — labels now truncate with an ellipsis (click to expand,
  same as elsewhere in the app) instead of wrapping and growing the row past the panel's own height.

## [0.13.4-alpha.1] - 2026-08-09

### Added
- A **Current value** panel now has a "Hide name" toggle — drops the monitor label from every row
  and blows the value itself up to a big centered "hero" size instead, for a panel whose title
  already says what it's showing.

## [0.13.3-alpha.1] - 2026-08-09

### Added
- The Loxone → MQTT mapping page's Test dialog now has a proper color picker for a Shelly
  RGBW/White mapping's "RGB" and "RGB (Analog input)" modes, instead of typing a raw HSV/packed
  value by hand — pick a color (or one of several quick-pick palettes) and it's converted to
  exactly the value Loxone itself would send, verified end to end against the real transform.
  - Three new color palettes — Vivid, Pastel, and Muted — join the existing default palette
    everywhere a color picker appears in the app (thresholds, value mappings, annotations, chart
    series, and this new Test dialog), not just here.
  - New "Dimmer (0-100%)" value transform (behaves identically to plain pass-through — it only
    changes what the Test dialog shows) gets a 0-100% slider in the Test dialog instead of a bare
    text box; the same slider is used for a Shelly RGBW/White mapping's "White" mode.
  - Both the color picker and the slider have a genuine Off/On toggle — switching off remembers
    the color or brightness it was on, and switching back on restores it exactly, rather than
    leaving you to re-pick it.
  - A "Paste JSON instead" option on both lets you send an exact payload verbatim when you need to
    test something the picker itself can't produce.

### Fixed
- Several layout issues in the Loxone → MQTT mapping table and its Test dialog: the
  Connection info column's content wasn't vertically centered in its row, the Test dialog could
  show an unwanted vertical scrollbar, its value picker and Send/Close buttons were cramped onto
  one wrapping line, the Off button's position shifted left and right as the value text next to it
  changed length, and that same value text wasn't vertically aligned with the Off button — all
  traced back to two related causes: a shared `.hint` text-style class also carrying page-paragraph
  margins that made no sense reused inside a table cell or a dialog, and simply not giving the
  dialog and its color-picker popover enough room by default.
- A slider (e.g. the new dimmer/white one above) now uses this app's own green accent color instead
  of the browser's default blue, matching every checkbox and radio button already.
- A State panel's bar(s) stayed a fixed, thin height regardless of how tall the panel itself was
  resized, leaving dead space between the bar and the panel's footer instead of using it — the
  bar(s) now stretch to fill whatever height the panel has, and the panel's own drag-resize floor
  shrank to match (previously computed from that fixed height, which no longer means anything now
  that it stretches).

## [0.13.2-alpha.1] - 2026-08-09

### Fixed
- **Loxone Virtual UDP Output commands stopped reaching MQTT entirely** since 0.13.0-alpha.1 —
  every UDP-transport Loxone → MQTT mapping (Shelly lights, dimmers, relays, RGBW/color, or any
  other UDP-configured command) silently failed to publish, while the command still showed as
  "queued" with nothing obviously wrong in the UI. Root cause: one function involved in parsing an
  incoming UDP command became asynchronous when the database layer was converted to the new async
  Knex facade (0.13.0-alpha.1's own db-backend work), but the one place that called it was missed —
  it kept calling the function without waiting for its result, which made every such command throw
  immediately and vanish into a background log line instead of being applied. HTTP-transport
  mappings and every other part of the app were unaffected. Found and fixed after a report of Shelly
  devices no longer responding to Loxone commands; verified with a real UDP command sent through the
  fixed code path end to end (including an independent MQTT subscriber confirming the correct topic
  and payload actually arrived) and with new automated regression tests
  (`test/loxoneUdpServer.test.js`) covering both the RGBW color transform and the plain on/off case.
- Two related hardening fixes found during the same investigation (neither caused a functional
  failure on their own, but both let a real error vanish as a generic "unhandled promise rejection"
  instead of a clear log line): recording an incoming MQTT message's value into monitor history now
  properly reports a failure instead of swallowing it silently, and every background service started
  at boot (dynamic-security bootstrap, MQTT log tailing, the MQTT client itself, the monitor/log
  collectors, live Loxone connections) now logs a clear message if its own startup fails instead of
  producing an unlabeled warning.

## [0.13.1-alpha.1] - 2026-08-08

### Fixed
- A State panel showing just a single monitor rendered its bar shrunk to a sliver instead of
  filling the row — the shared label/bar grid still expected a label column even though a
  single-monitor panel skips rendering one, so the bar auto-placed into that now-empty column and
  shrank to its own minimum width. Single-monitor panels now use a one-column layout instead.
- The State panel's own bar track was taller than its label text needed — trimmed down, which also
  lets a panel with just one or two monitors size itself to its actual content instead of staying
  taller than necessary.

## [0.13.0-alpha.1] - 2026-08-08

### Added
- **Optional external database support** — LoxSuite can now run against an external PostgreSQL or
  MySQL/MariaDB server instead of its built-in SQLite file. SQLite stays the zero-config default;
  nothing changes for existing installs unless you opt in. Set `DB_BACKEND=postgres` or
  `DB_BACKEND=mysql` and either `DATABASE_URL` or the discrete `DB_HOST`/`DB_PORT`/`DB_NAME`/
  `DB_USER`/`DB_PASSWORD` env vars — see the commented-out example in `docker-compose.yml`/
  `.env.example` and the README's own Data and persistence section. Administration → General
  shows which backend is active.
- **Transfer tool** for moving an existing SQLite install's data to Postgres or MySQL/MariaDB:
  `docker compose exec loxsuite node src/db/transfer.js --from-sqlite /data/gateway.db --to
  "$DATABASE_URL" [--backend mysql]`. Supports `--dry-run` (row-count report, orphaned-row scan,
  touches nothing), `--prune-orphans` (skip rows SQLite never enforced foreign keys on instead of
  aborting), and resets the target's sequences/AUTO_INCREMENT counters afterward so the next
  ordinary insert doesn't collide with a transferred row.
- **Backups and restore** now work the same way regardless of backend — a SQLite install still
  backs up via an online file copy, Postgres via `pg_dump`/`pg_restore`, MySQL/MariaDB via
  `mysqldump`/`mysql`. A backup made under one backend is rejected (with a clear message) if you
  try to restore it into an install running a different one — use the transfer tool instead.

## [0.12.2-alpha.1] - 2026-08-08

### Fixed
- On a phone-width screen, the off-canvas sidebar menu was cut off partway down with no way to
  reach whatever ran past the bottom edge (`height: 100vh` on a fixed mobile overlay includes the
  space still occupied by the browser's own address-bar chrome before it collapses, which is taller
  than what's actually visible on first load). Now `100dvh`, which tracks the real visible
  viewport.
- A dashboard panel's Edit drawer (and Monitor detail's own chart-settings drawer, same shared
  component) opened as a right-side panel up to 92vw wide on a phone — effectively the whole
  screen, hiding the very panel it was supposed to let you keep watching while you edit it. It's
  now a bottom sheet capped at roughly 60% of the screen height on narrow screens, and the panel
  being edited scrolls to the top of the remaining space instead of trying to squeeze in beside a
  drawer that no longer has room next to it. A very tall panel (e.g. a large chart) can still have
  its lower portion sit behind the sheet — a genuine small-screen limit, not something a layout
  change alone fixes.

### Changed
- The MQTT → Loxone and Loxone → MQTT mapping tables had a small filter box under every
  filterable column's own header — replaced with the one search box each table had before the
  Tabulator conversion (0.12.0-alpha.1), now matching Topic/Miniserver/Transport/Target/Transform
  (plus Token on Loxone → MQTT) all at once instead of one column at a time.

## [0.12.1-alpha.1] - 2026-08-07

### Fixed
- The Live Data (MQTT) table's Topic and Command Recognition columns had no width cap, so a long
  topic or recognition string could push the Command Recognition/Actions columns off the right
  edge with no visible hint there was more to scroll to (the table does scroll horizontally, but
  nothing signaled that it should). Both now respect the truncation caps already built for exactly
  this — `.truncate`'s sitewide 320px default for Topic, `code.recognition-string`'s own 220px
  default for Command Recognition — which an inline style on each was overriding. The full value
  is still one hover away via the title tooltip, and Copy still copies it untruncated.

## [0.12.0-alpha.1] - 2026-08-07

### Changed
- Miniservers (including the same status table embedded on the shared home Dashboard),
  Transformations, the two Loxone/MQTT translation-table lookup pages, the admin Backup page, and
  both Mappings pages (MQTT → Loxone / Loxone → MQTT) now run on a shared table engine
  (Tabulator.js) instead of the old hand-rolled one — the same column show/hide/resize/reorder
  controls every table already had, now consistent and more reliable across all of them: resizing
  one column no longer leaves a stray gap on the right once the others no longer add up to the
  table's own width, and turning a hidden column back on no longer pushes the last column out of
  view with no way to reach it. The Mappings pages' old combined Status/text filter bar is now
  Tabulator's own per-column header filters instead. Miniservers additionally gets
  drag-to-reorder rows built on the table engine's own row-move support, and a row's actions
  (Edit/Diagnostics/Test now/Delete) collapse into one menu instead of separate always-visible
  buttons competing for space.
- A Miniserver's **Diagnostics** (PLC state, CPU load, heap, task count, firmware date, update
  channel, and the Check for update / Update to latest release / Add to Dashboard / Add to Monitor
  actions) now opens in a dialog from the row's own actions menu, instead of expanding the row
  itself.
- Every popover/menu on these tables — the Columns menu, a row's actions menu, and the
  notification template's `{{`/`/` autocomplete (Notification Center) — is now positioned by
  Floating UI instead of hand-rolled placement math: it flips above when there's no room below,
  stays nudged inside the viewport instead of running off an edge, and now correctly tracks its
  anchor while the page itself scrolls (a menu could previously "freeze" in place on a whole-page
  scroll, a bug this surfaced and fixed along the way, not something a released version ever had).

## [0.11.0-alpha.1] - 2026-08-06

### Added
- Dashboard panels are now laid out with GridStack instead of the old custom grid, adding real
  free-form drag/resize and **panel groups**: a collapsible header that bundles a set of panels
  into their own zone, independently sortable from other groups (drag the group's own header bar
  to reorder groups) and reorderable amongst themselves without disturbing ungrouped panels. A
  panel can be dragged straight onto a group's header bar to join that group, not just into its
  body.
- A chart panel's legend can show **min / max / avg / current** for each series, toggled
  independently per series (and per stat) rather than all-or-nothing for the whole legend.
- Threshold, annotation, and value-mapping row lists (and now dashboard groups too) share one
  drag-to-reorder module instead of duplicated one-off logic — a picked-up row lifts with an
  accent ring and the same drop shadow a dragged panel gets, and a live drop-indicator shows where
  it'll land.
- The admin Notification Center gained per-trigger **message templates**: a customizable title and
  body per trigger type, with `{{placeholder}}` autocomplete, a live preview rendered against
  sample data, and a "Send test" button per template.
- The Dashboard panel Range field, Monitor detail's own range picker, the Home/My Dashboards time
  filter, and each Logs page's filter form now share one Range field component (preset dropdown,
  Custom, or an absolute From/To pair), instead of each page carrying its own variant.
- Live Data gained multi-select bulk actions (Monitor selected / Widget selected) and a way to hide
  specific control states from the table.
- A Miniserver's last Loxone Logbook fetch error is now persisted and surfaced with a friendlier
  message when it's a permissions problem (HTTP 401/403), instead of only appearing transiently in
  the server log.

## [0.10.1-alpha.1] - 2026-08-04

### Added
- The Monitor detail page's own chart settings gained a **Y-axis unit**, **Value scale**, and
  **Decimals** — the unit field already existed but silently did nothing (see Fixed below); scale
  and decimals didn't exist on this page at all before. All three are independent per monitor, the
  same way a dashboard chart panel's per-series settings are — Value scale reuses the exact same
  `×0.001`–`×1000` preset dropdown (plus Custom…) a dashboard chart panel's own per-series scale
  picker already offers.

### Fixed
- The Monitor detail page's own "Y-axis unit" field silently did nothing when changed — its
  supporting JS (converting the preset dropdown into an actual submittable value) only ever loaded
  on a dashboard's panel-editor page, never on this one. Moved into the shared footer script so
  both pages get it.
  - Once wired up, the unit was still shared across every monitor's chart (bundled with
    legend/fill/stepped-line, which genuinely are one shared style) rather than specific to the one
    monitor it was set on — moved alongside the new Value scale/Decimals so each monitor's own unit
    is independent, with a fallback so a monitor already using the old shared field doesn't lose it
    until its next save.
  - A per-monitor Decimals setting was accepted but never actually applied to the chart's own
    Y-axis tick labels, which always fell back to the global default regardless — only the
    tooltip honored it. The axis now uses whichever monitor's own Decimals is assigned to it,
    same tie-break logic already used for a shared axis's unit.
- Filling the area under a chart's line no longer reaches the very top/bottom edge of the chart,
  now that the axis leaves ~10% headroom above/below the data (see 0.9.1-alpha.1) — that headroom
  is now skipped whenever Fill area is on, since a filled area already reads as "full" flush against
  the edges without needing it (unlike a bare line, which is what the headroom was added for).
- The Hardware page's MAC column now strips the `:` separators and lowercases the result, so a MAC
  and Serial that are the same underlying identifier (common on Loxone Tree/Air devices) read
  identically instead of only an attentive reader noticing "0F:9B:6D:66" and "0f9b6d66" match.
- The Monitor detail page's raw-readings table header now reads "Raw value" instead of "Value" —
  it intentionally still shows the literal unscaled reading regardless of any unit/scale set above.

## [0.10.0-alpha.1] - 2026-08-04

### Changed
- **License changed from MIT to AGPL-3.0-or-later.** Every release up to and including
  0.9.2-alpha.1 stays available to anyone who already has it under MIT terms — this only applies
  going forward.
- The Hardware page's dedup (see 0.9.2-alpha.1) is now generalized beyond Audioservers/Stereo
  Extensions: any hardware row with a real Serial or MAC is deduplicated across Miniservers that
  both report it, not just audio devices — matches how a Loxone Gateway Client setup actually
  behaves (a Gateway's own `/data/status` already includes its Clients' hardware, on top of each
  Client separately reporting that same hardware from its own).
- Live Data's Miniserver dropdown now only lists Miniservers that are currently online (except
  whichever one is already selected) — an offline one has no live connection to switch to, so it's
  no longer offered as a choice that just won't work.
- The hints-toggle button (Monitor/Dashboard panel settings, and now also the Add/Edit Miniserver
  forms, MQTT Broker, and Settings pages) uses a lightbulb icon instead of a question mark.
- Any `[data-toggle-row]` button, sitewide, now fills in with the accent color while its target is
  open — previously just the Miniservers page's own diagnostics/Client-group buttons.
- The Hardware page's two introductory paragraphs were removed — they didn't add anything a
  first-time visitor needed.

### Added
- **Loxone Gateway Client support**: a Miniserver can now be explicitly flagged as a Gateway with
  its own inline-managed Client Miniservers — the Add Miniserver form, Edit Miniserver form, and
  the Setup Wizard's Miniserver step all share the same UI (name/host/port/HTTPS per Client, shared
  credentials, batch Test).
  - The Miniservers list, and the home dashboard's own Miniservers table, show each row's
    relationship: Standalone, "Gateway · N clients", or `Client – <Gateway name>` — Clients
    render as real sibling rows directly under their Gateway, toggled open/closed with a dedicated
    share-icon button (or the page's own "Expand/Collapse all clients" button), independent of that
    row's own diagnostics panel.
  - Updating a Gateway's firmware also updates every one of its Clients.
  - Drag-and-drop reordering keeps a Gateway's Clients grouped under it, and keeps each row's own
    diagnostics panel attached to it through a reorder.

### Fixed
- A stray `docker-compose.yml` edit had `MQTT_URL` pointing at `128.0.0.1` instead of `127.0.0.1`,
  which would have broken the bundled Mosquitto connection on a fresh install.

## [0.9.2-alpha.1] - 2026-08-04

### Added
- The Hardware page now shows each device's **Serial** and **MAC** address as their own columns
  (the data was already being collected, just never surfaced).

### Fixed
- A Loxone **Gateway Client** setup (one Miniserver sharing its Audioserver with another) no
  longer lists the same physical Audioserver and its Stereo Extension zones twice, once per
  Miniserver that can see them — deduplicated by MAC address, since it's the same hardware either
  way.
- The Hardware page's category filter had two identically-labeled "Plugin device" options with no
  way to tell them apart — the Plugin's own GenDev children (the individual devices it exposes,
  e.g. each Home Connect appliance) are now labeled "Plugin sub-device" to distinguish them from
  the plugin/bridge itself (e.g. an MCP Server plugin).
- Client Activity's device-name resolution only ever recognized Shelly's own "brandname-XXXXXX"
  client ID convention — a device whose client ID is "<product>_<name>" while its actual MQTT
  topic prefix is just "<name>" (e.g. a HeatMeister module: client ID "heatbooster_radiator-gang",
  topic prefix "radiator-gang") now also resolves to its friendly name, which in turn also makes
  "Suggest commands" appear for it (the family lookup uses that same resolved name).

## [0.9.1-alpha.1] - 2026-08-04

### Added
- A "?" button next to a chart/panel settings drawer's own star icon (Monitor detail page, Dashboard
  panels) toggles every help-text paragraph in that drawer on/off, sitewide — hidden by default
  (someone configuring their hundredth panel doesn't need to be told what Stepped line does), one
  click away for whoever wants it. Highlights in the app's accent color while active, and stays in
  sync across every panel's own drawer on a dashboard, not just the one it was clicked in.
- The threshold builder's own help text now explains what **Style** (Line/Band) actually does —
  previously only a hover tooltip, easy to miss entirely.
- The favorite-star button on My Dashboards now lives in the row's own Actions group, with an
  "Add to favorite"/"Remove from favorite" text label, matching the button already on a single
  dashboard's own page.
- The sidebar's version number is now a link to this project's GitHub releases, combined onto one
  line with the "update available" badge instead of two stacked lines. Administration > General's
  own version card shows Installed/Available on separate lines and adds a GitHub page button
  alongside Check for updates/View changelog.
- Logs now has its own expandable sidebar section (System, Notifications, Loxone Miniservers,
  Loxone Commands, MQTT Broker) instead of one flat link — the in-page tab strip repeated at the
  top of each of the five Logs pages was removed since the sidebar now covers that navigation.
- Live Data (Loxone) now has its own row in Access Roles instead of silently piggybacking on the
  Miniservers permission — existing roles keep whatever access to it they already had via
  Miniservers, this just makes the two independently grantable going forward.

### Fixed
- **Notifications**: clicking through to one unread notification's source (or dismissing it) no
  longer incorrectly marks every OTHER, never-looked-at notification as read too — confirmed as a
  real bug (2 unread events, clicking the newer one's link cleared the badge to 0 instead of 1). The
  unread count and the initial page-load badge now both check genuine per-item acknowledgement
  instead of a single shared watermark that any one item's id could jump ahead of the others on.
- A monitor/dashboard chart's y-axis now leaves ~10% headroom above/below the actual data range —
  a line no longer runs flush along the very top/bottom edge of the chart area.
- The "?" hints-toggle button's own color was backwards — green ("active") lit up the moment hints
  were HIDDEN, the default state, instead of when they're shown. Green now means "help text is
  currently on," matching the same convention the Hardware page's own Alert buttons already use.
- A threshold line's value label flips to below the line instead of above it when there isn't
  enough room to the chart's own top edge — previously it could get clipped clean off by the
  canvas's own edge for a threshold sitting near the top of a tight range.
- The Monitor detail page's own chart settings drawer no longer blurs the chart underneath it while
  open — the chart now lifts above the backdrop, gets the same accent-colored highlight border, and
  re-centers next to the drawer, exactly matching how a dashboard's own panel-being-edited already
  behaves (only the title/range tabs/history table stay blurred, same as everything NOT currently
  being edited on a dashboard). Its width now also always shrinks to actually fit next to the
  drawer instead of just centering within room that might not be there, with a guaranteed gap on
  both sides of the highlighted card rather than however much (or little) centering happened to
  leave over.
- The pagination bar's row count ("N rows") is no longer bunched up hard against the Next button
  with an inconsistent double gap — it's now pinned to the opposite side, clearly separated from
  the Prev/page-numbers/Next cluster.
- A dashboard panel's "Edit panel" drawer's own Close (×) button rendered narrower than the star/"?"
  buttons beside it — it was a plain `&times;` character instead of the same SVG icon the other two
  use, so its box shrank to fit a smaller glyph. All three are the same width now.
- A dashboard's My Dashboards list rendered its favorite star grey even when a dashboard genuinely
  was favorited (a generic table-button style rule was winning a same-specificity CSS tie against
  the favorited-state color) — now consistently amber/filled everywhere, list and detail page alike.
- The pagination row count still wasn't vertically centered with the Prev/page-number/Next buttons
  in every case (a leftover margin from the shared `.hint` class was itself winning a further
  same-specificity cascade fight) — and single-digit page buttons (1, 2, 3…) had their number
  sitting visibly left of center within the button's own minimum width.
- Dark theme: the small "Loxone (direct, polled): ..." subtitle line under a page's title had
  noticeably lower contrast against the accent-colored glow behind the header — brightened.
- The very same subtitle line had its own top ~6px clipped off on any page that renders an
  invisible overlay element before it in the markup — e.g. the Monitor detail page's own edit
  backdrop, present only when you can edit the chart — because the existing anti-clipping CSS only
  matched a hint that's the literal first child of `<main>`, not the first *visible* one.
- style.css/tables.js/monitor-chart.js are now served with a cache-busting version query tied to
  this run's own boot time, so a browser that cached an older copy always picks up the actual
  current files after a restart instead of needing a manual hard refresh.
- Radar/spiderweb charts: the web/spoke lines and axis value labels used Chart.js's fixed default
  styling, nearly invisible on dark theme; both are now theme-aware, and the little backdrop box
  behind each axis number is gone.

## [0.9.0-alpha.1] - 2026-08-04

### Added
- A new **Hardware** page (Loxone section) listing every piece of hardware a Miniserver's own
  `/data/status` endpoint reports: the Miniserver itself, Extensions, Audioserver zones, and the
  Air/Tree/1-Wire/Plugin devices attached to it — one flat, filterable (category dropdown +
  free-text search), sortable table. Polled every 5 minutes in the background; entirely skipped for
  a Miniserver currently offline or rebooting, so a reboot never floods the table (or an alert)
  with every attached device briefly reporting offline at once. Battery 127 (mains-powered, not a
  real percentage) shows as "External power" instead.
- Three new notification rule types, each with its own configurable severity: **Loxone device
  battery weak**, **Loxone device firmware changed**, and **Loxone device online/offline** — a
  single rule (optionally scoped to one Miniserver) covers every device of that kind automatically,
  current and any added later, no per-device setup. The Hardware page's own toolbar has one-click
  "Alert ..." buttons per type (green = enabled, gray = disabled/not yet set up) as a shortcut to
  the common "Any Miniserver, default severity" case.
- Every hardware battery/firmware/online-offline transition is now also written to the existing
  Logs → Loxone Miniservers log unconditionally, whether or not a notification rule exists for
  it — logging and alerting are independent.
- Miniservers can now be reordered by dragging a row's own handle — this is no longer just cosmetic:
  it's the one shared, authoritative order every other page that lists Miniservers (Logs, Mappings,
  Monitor, Notifications, Hardware, Live Data, the dashboard, ...) now queries by, instead of each
  picking its own (previously an inconsistent mix of alphabetical-by-name and by-id).

### Fixed
- A table's pagination no longer jumps back to page 1 on every periodic background refresh
  (Logs, Client Activity, Hardware, ...) — it only resets to page 1 on an actual filter/sort change,
  not merely because the page silently refreshed itself while you were reading page 3.
- `notification_rules.trigger_type`'s CHECK constraint never actually included
  `loxsuite_update_available`, despite it being offered as a creatable rule type since it was added —
  every attempt to create one was silently rejected by SQLite. Caught and fixed while widening this
  same constraint for the three new hardware trigger types above.
- The `monitor_history` retention cleanup (`DELETE ... WHERE recorded_at < ?`) had no usable index —
  its only index led with `monitor_id`, useless for a query with no `monitor_id` filter — forcing a
  full table scan that got slower as history grew. Added a dedicated index, the same fix
  `notification_events` already had.

## [0.8.0-alpha.1] - 2026-08-03

### Added
- A **"Create RGB + White mappings"** button on Suggest Commands, shown for device types that need
  the Shelly RGBW/White transform (Shelly RGBW2, Shelly Bulb) — creates both the RGB and White
  Loxone → MQTT mappings in one step, already pointed at the right shared topic with the correct
  transform and mode preselected, instead of having to add each one by hand and remember to pick
  `shelly_rgbw` (not `passthrough`) and the right mode on both.

## [0.7.3-alpha.1] - 2026-08-03

### Added
- A second Shelly RGBW/White mode, **"RGB (Loxone's Analog input RGB)"**, for Loxone's own
  "Analoge ingang RGB" virtual output — it packs all three channels into one number
  (`red% + green%×1000 + blue%×1000000`), a completely different convention from the H,S,V-based
  RGB mode already there. Both modes coexist; pick whichever matches the actual Loxone output
  you're wiring up. Verified end-to-end against a real RGBW2: three real Loxone-generated values
  (representing ~100% red / ~100% blue / ~100% green) all decoded to the correct dominant channel,
  confirmed via the device's own status topic.

## [0.7.2-alpha.1] - 2026-08-03

### Fixed
- The Shelly RGBW/White transform's on/off now reflects **both** the RGB and White mappings
  together, not just whichever one happened to publish last: off only once every channel
  (red/green/blue/white) is genuinely zero, on the moment any of them isn't — matching how a real
  Loxone RGBW output actually signals off (sending zero on every channel at once, not just one).
  Previously White alone controlled on/off and RGB never touched it at all, which meant a
  same-family light that used the RGB mapping to indicate on/off never actually turned on.
- A bare, unqualified `rgb 0` (no comma) is now treated as true zero — red:0,green:0,blue:0 — not
  hue 0° (which is mathematically pure red). This was silently breaking the "all channels zero"
  off detection: Loxone's own off sequence sends `rgb 0` specifically to mean nothing, and it was
  instead being turned into full red. An explicit comma-separated `H,S,V` still means exactly what
  it says even when H is 0 — only the bare shorthand gets this special case. Verified via the
  published JSON for all four transitions (both zero -> off, either one going nonzero -> on, back
  to both zero -> off again) — not re-confirmed against the physical device's own status topic
  this round the way earlier RGBW2 fixes were.

## [0.7.1-alpha.1] - 2026-08-03

### Fixed
- The Shelly RGBW/White transform's RGB mode forced the light **on** with every single color
  update — harmless on its own, but a real problem once a Loxone Lighting Controller resends the
  RGB output alongside any brightness/white change on the same light circuit: turning the light off
  through the White mapping got silently undone the instant the next color refresh arrived. RGB
  updates no longer touch on/off at all; only the White mapping does now. Verified against a real
  RGBW2 — sent off via White, then a new color via RGB, and it stayed off with the new color applied.
- Logs → Loxone commands' "from/to" value history was keyed by MQTT topic alone — for a device
  like an RGBW2 in color mode, its separate RGB and White mappings both legitimately publish to the
  *same* topic (Shelly merges the partial JSON bodies itself), so each one's own history was
  actually showing whichever OTHER mapping had fired most recently, not its own. Now keyed by the
  mapping itself.
- The Shelly RGBW2/Bulb Common Commands templates' "White channel" preset pointed at
  `/white/{channel}/command` — the topic for the device's *other*, mutually exclusive operating
  mode (four independent white channels), not the color-mode device these templates are actually
  for. Removed (there's no real "toggle just white" in color mode — that's the whole-light on/off
  below), and replaced with reference-only "Set color"/"Set white %" entries showing the real
  `/color/0/set` topic and value shape a Loxone RGB/White output actually needs (this page never
  publishes anything itself — it's suggestions to copy into a mapping's own Shelly RGBW/White
  transform). RGBW2 verified against a real device; Shelly Bulb updated the same way by inference
  (identical documented API), not separately tested.

## [0.7.0-alpha.1] - 2026-08-03

### Added
- **Pagination**: any table with more rows than your own "Rows per page" setting (Profile → Account,
  default 25) now paginates automatically, with Prev/Next and a windowed set of page-number buttons
  (first 3, last 3, current page and its neighbors, "…" for the gap). Works alongside every
  existing per-page search filter and column sort without conflicting with either.
- **Monitor**: a search bar (matching every other filterable table in the app), with a Dashboard
  column that's now clickable straight through to each dashboard, and a "None" badge instead of a
  bare "-" when no notification threshold is set.
- Settings → Broker connection shows the same live "Connected"/"Not connected" badge the home
  dashboard already has, next to the page title.
- Admin → General: a "Check for updates now" button (the existing daily check only ever re-read
  its own cached result — this actually triggers a fresh GitHub lookup) and, when a newer version is
  found, a changelog dialog pulled straight from that release's own CHANGELOG.md.
- Live Data and Monitor's search filters gained a clear ("×") button and Escape-to-clear — since
  rolled out to every other search bar in the app (Incoming Clients/Messages, both Mapping pages)
  for consistency.
- The topbar bell's own popover list is now clickable the same way Logs → Notifications already is
  — straight to a threshold breach's own Chart settings drawer (already expanded), or a status/
  firmware change's Miniserver diagnostics panel. Dismissing an item (or clicking through) now also
  marks it — and anything older — read, so the badge count actually reflects it.
- "Rows per page" lives on Settings → General now (still your own per-user value, not shared) —
  folded into that page's single existing Save button rather than a second one of its own.
- The Shelly RGBW/White transform (Loxone → MQTT mapping) now also accepts a value prefixed with
  its own mode name ("rgb 17", "white 20.0") — some real-world Loxone virtual output configs send
  it that way rather than the plain "H,S,V"/percentage this was originally written against. Also
  accepts a bare hue number (no comma) for RGB, at full saturation/brightness. Verified end-to-end
  against a real RGBW2: hue 0/120/240 produced exactly red/green/blue, confirmed via the device's
  own status topic.

### Fixed
- A bug in creating a dashboard from Live Data's "Suggest dashboard" flow could crash the whole
  gateway process — and since the container stops itself if either of its two processes dies, that
  took Mosquitto down with it too. The route now catches its own errors and returns a normal 500,
  and a process-level safety net was added so no future uncaught error in any route can do this
  again.
- The version-check card wrongly blamed "offline, or GitHub unreachable" even when the real reason
  was simply that no release had ever been tagged yet — now distinguishes the two.
- A stray z-index rule meant a search bar's own clear ("×") button was hidden behind the input the
  moment you actually clicked into the box — only visible while it *wasn't* focused, backwards from
  the point of the button.
- Dismissing a notification from the bell popover previously left it still counted in the unread
  badge — dismissing now advances the read watermark the same way clicking through already does.
- Tables.js's own pagination toggle (`hidden = true`) silently had no effect once a table had any
  filter narrowing it below one page's worth of rows — an unrelated `display` rule on the same
  element was overriding the browser's default `[hidden]` behavior.

## [0.6.1-alpha.1] - 2026-08-03

### Fixed (stability)
- A bug in creating a dashboard from Live Data's "Suggest dashboard" flow could crash the whole
  gateway process — and since the container stops itself if either of its two processes dies,
  that took Mosquitto down with it too. The route now catches its own errors and returns a normal
  500 instead, and a process-level safety net was added so no future uncaught error in any route
  can do this again.

### Added
- **Monitor**: a new **Notification** column — shows whether a monitor's own threshold ladder (its
  chart settings, edited from this page) has at least one rung flagged **Notify**, without having
  to open each monitor's own chart settings to check.
- Logs → Notifications: the **Source** column is now a link straight to whatever the event was
  actually about — a Monitor's own detail page for a threshold breach/notify rung, or the
  Miniservers page with that row's diagnostics panel already open for a status/firmware change
  (new `?open=<id>` support there). The other three trigger types (MQTT client status, backup
  failure, LoxSuite update available) have no single entity of their own to land on, so those stay
  plain text. The topbar bell's own popover list now links the same way — clicking through to an
  item's source there also marks that notification (and anything older) as read.
- Live Data's Control/state filter now has a clear ("&times;") button in the search box, and
  pressing **Escape** while it has focus clears the filter the same way.
- Settings → Broker connection now shows the same live "Connected"/"Not connected" status badge as
  the home dashboard, right next to the **MQTT Broker** title — previously you could only see this
  on the home page.

### Fixed
- The Notification Center bell's unread badge cleared the moment you opened the popover, even if
  you'd only glanced at it — now only clears via **Mark all read**, **View all**, or once there's
  genuinely nothing left unread.
- The bell popover's own list of events only ever reflected whatever was baked into the page at its
  last full load — the unread badge already polled live, but a notification that arrived while you
  stayed on one page without navigating didn't show up in the list itself until an actual page
  reload. Now polls alongside the badge (same 60s cadence, same "don't overwrite what's currently
  open" guard).
- Logs → Notifications: a **warning**-severity row showed a plain gray badge instead of the
  existing yellow "warning" style already used elsewhere in the app — a leftover placeholder class
  that was never updated to the real one.
- Live Data's **Control / state** filter left every room visible regardless of match, even an
  already-expanded one with nothing matching in it — only a room that's never been expanded at all
  (nothing loaded yet to check) still stays visible now, since hiding that one really would be a
  guess. That fix alone still meant a non-matching room only disappeared once you happened to click
  it open yourself, so typing a query now also auto-expands every not-yet-loaded room right away —
  it correctly drops out (or stays, if it matches) the moment its own content actually arrives.
- Live Data's filter also never actually cleared: emptying the search box out was supposed to
  restore every hidden room/category/row, but a leftover early-return above that reset code made it
  unreachable, and even then it never touched individual rows. Clearing the box (or now, Escape/the
  new clear button) properly restores everything again.

## [0.6.0-alpha.1] - 2026-08-03

### Added
- **Device templates**: every Common Commands/Data device (all 16 named Shelly Gen1 types,
  Shelly Gen2/Gen3, and the new SDR Innovation HeatMeister below) is now a plain `.json`/`.xml`
  file under `device-templates/`, read once at startup — drop your own file in that same folder to
  add or override a device, no code or UI editing required. An invalid file is skipped with a log
  line naming the file and the problem, not a broken catalog. A generic fallback device (like
  Shelly's own "other/unlisted model") can set an explicit `order` so more specific devices are
  still auto-detected first.
- **SDR Innovation HeatMeister** (radiator/fan-coil controller): fan boost/control mode, fan
  speed, ambient temperature control, and the external sensor-override topics as commands; control
  state, fan speed, all four temperatures, and WiFi/firmware/runtime as data — confirmed against
  its own protocol spec and a real installation. A separate "Home Assistant discovery" variant
  publishes MQTT Discovery configs for the same topics (LoxSuite's own addition — Home Assistant
  has no native integration with this device).
- **Notification Center**: a "LoxSuite update available" trigger type — the sidebar's existing
  daily GitHub tags check can now also log here and notify a channel, not just show its own badge.
  Each item gained a "×" to dismiss just that one from your own popover (not a delete — it still
  shows in Logs → Notifications and everyone else's popover), and a "Mark all read" button at the
  bottom.
- **Users (MQTT accounts)**: an off-by-default "Per-device MQTT roles" setting (Settings → MQTT
  Broker) — filling in a topic prefix when adding a device account creates a role scoped to just
  `<prefix>/#` and assigns it, instead of the shared `client` role with access to every topic.
- Mappings → MQTT to Loxone: the Virtual input name field now suggests names already used in
  other mappings, covering the common case of one Virtual Input receiving several commands.
- Logs → Loxone commands: a rejected row's **+ Mapping** button now also pre-selects Transport
  (HTTP/UDP) and Miniserver on the new mapping form, matching exactly what that command actually
  arrived as, instead of just pre-filling the topic.
- Dashboard: **Total messages since start** is now abbreviated past 1000 (`1.2K`, `3.4M`, full
  number on hover), same convention Live Messages' own per-topic count already used.

### Fixed
- A Loxone UDP Virtual Output command whose value contains spaces (e.g. a Shelly JSON payload like
  `{"turn": "off", "brightness": 30}`) got silently truncated to just its last few characters — the
  parser split on the *last* space in the whole message, which is the JSON's own last space, not
  the boundary between topic and value. Now matches against already-registered tokens/topics
  first, only falling back to the first space for a brand-new, not-yet-registered one.
- Dragging a table column wider or narrower didn't change how much of its own text showed — a
  truncated cell's ellipsis width was a fixed value, completely disconnected from the column's
  actual (possibly resized) width. Fixed together with a related issue where the very first resize
  on a table only took effect after the next page load, not during the drag itself.
- Miniservers diagnostics panel: the state row showed a redundant/opaque `PLC 5: Running` — now
  just `Running`, with the numeric code moved into the tooltip.
- **Upgrade safety**: an existing install upgrading to this version without also adding the new
  `device-templates` volume/path mapping (see Data and persistence in the README) ended up with an
  entirely EMPTY Common Commands catalog — every built-in device, not just custom ones, used to
  live only in that folder once the old hardcoded list was removed. The image now also carries its
  own always-available copy of the built-in devices, used as a fallback whenever the configurable
  folder is missing, empty, or not yet mounted, so a not-yet-updated `docker-compose.yml`/Unraid
  template degrades to "your own customizations aren't picked up yet," not "no devices at all."
- A missing `SESSION_SECRET` at boot (e.g. an Unraid container edit that blanked the field — see
  the Security section) silently fell back to an insecure hardcoded value with no indication
  anything was wrong, until every already-encrypted secret started failing to decrypt with errors
  that looked completely unrelated (MQTT "not authorised", a Miniserver HTTP 403, ...). The
  container log now prints an unmissable warning the moment this happens, naming the actual cause
  and what to do about it.
- Client Activity's **Suggest commands** shortcut only ever guessed "this looks like a Shelly" from
  the client id's own text — broke down for any device whose id isn't self-describing (a HeatMeister
  module is just whatever name you gave it in its own config, e.g. "radiator-gang", nothing in that
  string says "heatmeister"). Now uses the same family resolution Common Commands auto-detection
  already relies on, so it works for HeatMeister (and any future device template) too, not just
  Shelly. Also fixed HeatMeister's own two families (the real one and its Home Assistant discovery
  variant) sharing one topic pattern, which meant a real device could get auto-detected as the HA
  variant depending on file load order — the real one now always wins that tie.

### Changed
- Miniservers page: Firmware and Generation moved out of the main table into the diagnostics
  expand panel (labeled "Miniserver state" instead of "PLC state"), alongside the other
  per-Miniserver details; a bit more spacing between that panel and its action buttons.
- Monitor's "Loxone (direct)" source description corrected in the README — it already reads from a
  persistent, shared, pushed websocket connection (same one Live Data uses), not HTTP polling; the
  interval you set only controls how often a history *row* gets written from that live cache.

## [0.5.0-alpha.1] - 2026-08-02

### Added
- **Notification Center**: a bell icon next to Help, visible to every logged-in user, polling for
  new events every 60s — opening it marks them read and links to a full history under the new
  **Logs → Notifications** tab (its own permission area). Reuses the existing Apprise rule engine
  for delivery and adds two events that only ever show up here: **Firmware changed** (a
  Miniserver's reported version changed since the last check) and a per-rung **Notify** flag on any
  threshold ladder (Monitor or Dashboard chart), which logs directly without needing a separate
  rule/channel.
- **Dashboard chart panels**: five new snapshot chart types — **Bar (compare)**, **Doughnut**,
  **Pie**, **Polar Area**, **Radar** — comparing every selected monitor's *current* value side by
  side, alongside the existing time-series line chart.
- **Monitor detail page**: its chart is now as configurable as a Dashboard chart panel (appearance,
  thresholds with the new Notify flag, axis, annotations), via a resizable edit drawer with a live
  preview, plus save/reset-as-default across every Monitor's chart at once. The custom time-range
  field accepts absolute dates too (`1-8-2026`, `1-8-2026/-now`), Grafana-style.
- **Miniservers**: a **Generation** column (Miniserver Gen 1/Gen 2, Miniserver Go Gen 1/Gen 2,
  Compact) — `msInfo.miniserverType` from the structure file, fetched once per Miniserver (a
  physical device's generation never changes) and confirmed against Loxone's own official
  Structure File documentation before shipping, not guessed.
- **Loxone commands log**: a **+ Mapping** button on a "no matching mapping" rejected row (pre-fills
  the Loxone → MQTT add form with that exact topic) and a **+ Reject** button on an accepted row
  (disables its mapping on the spot).
- **Backups**: offsite copy (rclone) gained graphical setup forms for **S3-compatible** (AWS S3,
  MinIO, Wasabi, DigitalOcean Spaces, Cloudflare R2), **SFTP**, **WebDAV**, and **Backblaze B2** —
  each builds the underlying `rclone.conf` from plain fields (passwords obscured via rclone's own
  `rclone obscure`, never plain text) instead of requiring `rclone config` run elsewhere and pasted
  in. Pasting a hand-written config directly is still there for any of rclone's other 65+ backends.
- **Notifications**: a channel's **Service** picker gained graphical forms for **Email (SMTP)**,
  **Telegram**, **Slack**, **Microsoft Teams**, and **Discord** — paste the webhook URL/bot
  token/SMTP details the service itself gives you and the actual Apprise URL is built for you, with
  a live preview before saving. **Custom (Apprise URL)** still takes any raw Apprise URL directly.
- Per-table Columns menu: a column can now start hidden by default until explicitly shown (used for
  Miniservers' Generation/UDP port/External URL, all sparse for a typical row) — previously every
  column always started visible.
- Any single database query taking 200ms or longer is now logged to the System log — groundwork
  from investigating slow monitor-data loads on some self-hosting setups (e.g. Unraid), where a
  slow underlying disk is a real, visible-this-way possibility.

### Fixed
- The Miniservers table sorted alphabetically by name instead of by when a Miniserver was added,
  so a newly added one didn't reliably appear where expected.
- The Miniservers table needed horizontal scrolling to see the Actions column on common laptop
  widths, even before the new Generation column — tightened its padding and capped the Name column
  with a click-to-expand ellipsis instead of letting one long name stretch the whole table.
- A `required` form field inside a `hidden`-attribute ancestor (not the field itself) still blocked
  submission in Chromium, silently, with no visible error — confirmed empirically while building
  the new Notifications Service picker; toggling `required` itself, not just visibility, is what
  actually fixes it.
- The topbar notification bell wasn't visually centered in its circle (first a vertical offset, then
  a separate ~5px horizontal one from a `margin-right` rule meant for icon+label buttons bleeding
  onto icon-only ones) and was a slightly different, wrong shade of gray from the neighboring Help
  button (a copy/paste typo: `var(--text)` instead of `var(--text-muted)`).
- `loxoneStructure.js`'s `getStructure` (the in-memory, fetch-once-per-Miniserver structure cache)
  wasn't actually exported, only its higher-level derived helpers were — meant the new Generation
  lookup silently failed on its own require until this was found by exercising it against a real
  Miniserver rather than trusting a clean container boot alone.

## [0.4.1-alpha.1] - 2026-08-01

### Added
- **Monitor**: a new "Miniserver diagnostic" source — track CPU load, heap, or task count as a
  regular monitor with history/chart/CSV export. Fed from the Miniservers page's own existing
  background check, not polled a second time.
- **Miniservers**: **Add to Dashboard** / **Add to Monitor** buttons on the diagnostics panel pin
  CPU load, heap, and task count in one click — the former also adds each as a widget on the
  shared home Dashboard, the latter only starts recording history without pinning anything.
- A permanent "Demo (offline, for UI testing)" Miniserver, so empty/offline states have something
  to show without needing a real, reachable device.

### Fixed
- The Miniservers diagnostics panel's **Check for update**, **Update to latest release**, **Add to
  Dashboard**, and **Add to Monitor** buttons are now disabled (visible, not clickable) while that
  Miniserver is offline, instead of staying active against a device that can't answer.
- No button anywhere had visible `:disabled` styling — the explicit colors every button class sets
  override the browser's own default dimming, so a disabled button (Update to latest release
  before its first check, any button while offline, ...) looked exactly as clickable as an enabled
  one, and still lit up on hover. All five button classes now dim and ignore hover while disabled.
- Check for update / Update to latest release / Add to Dashboard / Add to Monitor now use the
  app's existing color convention (purple/yellow/green) instead of a plain bordered gray, matching
  every other action button in the app.
- Sorting a table while a row's expand-panel was open could send the wrong row to the top, or
  strand one behind — root-caused to the Miniservers row's own Actions-column overflow already
  generating its own "..." kebab expand-row, so a row could carry two stacked expand-rows, not
  one; the sort logic now re-pairs the whole chain instead of just the next sibling.
- A Miniserver's diagnostics panel could render at a visibly different collapsed height than its
  neighbor's — its card kept a fixed border and padding even while collapsed, which doesn't shrink
  to zero just because the row's height/overflow do.
- Duplicate `miniserver_id` form fields (a hidden one in the Loxone section, a visible one in the
  new diagnostics section) could both submit at once on the Monitor "Add" form, producing "Too
  many parameter values were provided" and a follow-on "monitor not found" for the partially
  created row. Fixed by disabling whichever section isn't active, plus a defensive fallback
  server-side.
- A rebuild landing mid-migration could leave a stale `monitors_new` table behind, crash-looping
  the gateway on every subsequent boot. The `miniserver_diag` migration now runs inside a
  transaction with a `DROP TABLE IF EXISTS` guard, so a retry after an interrupted run is safe.

## [0.4.0-alpha.1] - 2026-08-01

### Added
- **Miniservers**: an expandable diagnostics panel per row — PLC run state (Loxone's own
  documented 0-8 values), CPU load, heap usage, task count, firmware date, and update channel, via
  Miniserver HTTP commands not in Loxone's official API reference but individually verified
  against real firmware. **Check for update** reads the current release channel and unlocks
  **Update to latest release**, which sends a real update command (confirmation dialog spells out
  the consequences — this is a genuine firmware update and reboot, not a dry run). The background
  check interval is now configurable in Settings (default 60s, 10s minimum) instead of a fixed
  60s. "Test now" and the Add-Miniserver test both gained a **Loxone API** line, confirming the
  response actually looks like a Loxone Miniserver's own API rather than just "something answered
  HTTP" (what the existing Local/External checks prove).
- **Dashboard panels**: a star/reset pair on every panel's Edit form — star saves that panel's
  whole appearance as the default for every panel of that type *on that specific dashboard*; reset
  applies it back. Line/series colors remap by monitor *position* rather than id, so a saved
  default still makes sense applied to a panel wired to entirely different monitors.
- **Suggest dashboard** (Live Data): the preview is now editable before creating anything — **+
  Add** pins another state of a control already in a bucket (e.g. a climate control's target
  alongside its actual reading), and any item's panel type or bucket can be overridden per item.
- **MQTT Roles**: an existing ACL's type/topic/allow can be edited in place instead of removing
  and re-adding it.
- **Access Roles**: a **None** button clears every log-permission checkbox for a role in one click.
- Connected Clients (Live Traffic) splits into **Devices** and **LoxSuite itself** tabs — the
  gateway's own connections (persistent broker connection, dynamic-security bootstrap, ad-hoc Test
  button use) now connect under a stable `loxsuite-...` client ID instead of a random one each
  time, specifically so they can be told apart from real devices here.
- Live Messages (Live Traffic) shows a running total topic count, and abbreviates each topic's
  message count past 1000 (`1.2K`, `3.4M`) for a broker that's been running a long time.
- MQTT over WebSocket support (port `9001`) can now be added retroactively to an existing
  install — see the upgrade note under 0.3.1-alpha.1 below.

### Fixed
- **Suggest dashboard**'s Lighting bucket matched any generic `Switch`/`Pushbutton` control
  regardless of its actual category — a ventilation "turbo" button, a shading lock flag, or a
  media trigger could all get miscategorized as lighting purely by control type. Those two types
  now only match Lighting via Loxone's own `lights` category tag; `Dimmer`/`LightControllerV2`/
  `ColorPickerV2` (unambiguous regardless of category) still match by type alone.
- Firmware version on the Miniservers page was silently always blank on at least one real
  Miniserver — it read `msInfo.swVersion` from the structure export, which doesn't exist in that
  field on real hardware. Switched to a dedicated `/jdev/cfg/version` command.
- A disconnected MQTT client that was still marked "Connected" at the exact moment of a gateway
  restart stayed stuck showing Connected forever afterward (the broker restarts in lockstep with
  the gateway, so nothing from before a restart can still genuinely be connected, but the process
  dying doesn't get to log a clean disconnect line for whoever was live at that instant). The first
  log replay after each restart now sweeps any such leftover into Disconnected.
- A Viewer-role user on the Settings page saw the page's shell but no content (every field there
  is edit-only, so a view-only grant was a dead end) — Settings nav links now gate on edit access
  instead of view.
- The Administration nav link (sidebar and Help) pointed at the Users tab instead of General.
- Uneven spacing around Monitor/Client Activity toolbar buttons that have a `data-confirm`
  dropdown — the confirm bar's zero-width collapsed state was still consuming a full flex `gap` on
  both sides, doubling the visible space around those specific buttons.
- Saving or resetting a panel's default appearance closed its still-open Edit drawer, and (briefly)
  broke the drawer's own autosave content-patching for every panel on the page — an earlier
  version's cross-DOM `button[form=]` trick added extra elements the patch logic mistook for panel
  content. Replaced with a plain `fetch()` that adds no DOM nodes and patches just that panel's
  own rendered content in place.

## [0.3.1-alpha.1] - 2026-08-01

### Added
- The bundled Mosquitto broker now also listens for **MQTT over WebSocket** on port `9001`
  (`ws://<gateway-host>:9001`), alongside plain MQTT on `1883` — same accounts, roles, and ACLs
  either way. For browser-based MQTT clients/dashboards that can't open a raw TCP socket. Only
  written into a genuinely fresh `mosquitto.conf`, same as the rest of that file — add
  `listener 9001` / `protocol websockets` to an existing one yourself to pick it up on upgrade.

## [0.3.0-alpha.1] - 2026-08-01

### Fixed
- **Critical**: the dynamic-security bootstrap (creating the gateway's own MQTT broker account on
  first boot) read the MQTT password straight out of the database without decrypting it, so the
  broker account ended up with the *encrypted ciphertext* as its actual password — mismatched
  against the real password the gateway itself tries to authenticate with. This broke the MQTT
  connection on every fresh bootstrap since encryption at rest was introduced in 0.2.0-alpha.1
  (a brand new install, or an existing one whose `dynamic-security.json` was ever reset).
- Setup wizard buttons that sit next to a Test button (Continue/Save & continue/Add & continue)
  were a few pixels lower than their neighbor — a login-page-only CSS rule's `margin-top` was
  bleeding onto every `.primary` button in the wizard, not just the login form's own submit button.

### Added
- Setup wizard: a new **MQTT Broker** step (host/port/TLS/username/password, pre-filled with the
  already-working bundled-broker connection), with the same ad-hoc **Test** button the Miniserver
  step already had.
- **Administration -> General**: a new first tab holding "Run setup wizard again" (moved out of
  the general Settings page, where it didn't fit alongside per-account preferences).

### Changed
- Setup wizard step badges: redesigned as plain single-line text (no boxed/pill background),
  checkmark shown before the label. A step's checkmark now only appears once that step has
  actually been submitted (Skip or a real save) — previously a step could show complete just
  because its default state happened to already be "valid" (e.g. SSO disabled), even if nobody
  had looked at it yet.

## [0.2.2-alpha.1] - 2026-08-01

### Fixed
- Unraid template: `ADMIN_PASSWORD`, `SESSION_SECRET`, `MQTT_PASSWORD`, and `MQTT_ADMIN_PASSWORD`
  are no longer masked in Unraid's Edit Container screen. A masked field always renders blank
  there regardless of whether it's actually set, and clicking Apply while it looks empty silently
  saves that blank value over the real one — which is exactly what caused the SESSION_SECRET
  incident in 0.2.1-alpha.1. Showing the real value beats hiding it from a screen glance on a
  self-hosted single-admin box.

### Added
- More README screenshots: Live Data, and the Administration Backups/Notifications/Security pages.

## [0.2.1-alpha.1] - 2026-08-01

### Added
- **Emergency password reset** — drop a `reset-password.txt` file (containing a username) into the
  `Data` volume and restart; that account gets a fresh random password printed once to the
  container log, and every session is signed out. For anyone locked out of the web UI without
  container/database access.

### Changed
- Documented, more prominently, that `SESSION_SECRET` must stay the same across restarts once
  set — it's now also the key secrets are encrypted with (see 0.2.0-alpha.1), not just the session
  cookie signing key it always was. Changing it after secrets have already been encrypted makes
  them unreadable (not lost — they can be re-entered once `SESSION_SECRET` is stable again).

## [0.2.0-alpha.1] - 2026-08-01

### Added
- **Encryption at rest** for every secret LoxSuite has to actively use (not just check a login
  against): Miniserver passwords, the MQTT broker password, the SSO client secret, and any saved
  `rclone.conf`. AES-256-GCM, key derived from `SESSION_SECRET` — no new required environment
  variable. Existing plain-text values are encrypted automatically on first boot after upgrading.
- **Setup wizard**: three new steps (Single Sign-On, Backups, Notifications), all optional and
  skippable like the rest of the wizard. The Miniserver step gained the UDP port/External URL
  fields and Test button the regular Add Miniserver form already had. Step badges are clickable
  and show a checkmark once that step's own state is complete.
- **Administration -> Security**: the login page's rate limit (attempts and time window) is now
  configurable, instead of a fixed 10-per-15-minutes.

### Fixed
- The setup wizard's Miniserver step sent you straight to the last step instead of the next one
  when a Miniserver was already configured.
- A dashboard panel's Test/Add buttons in the wizard sat on their own row above Skip/Continue
  instead of alongside them.
- Two "Known scope limitations" entries in the README were stale — a Shelly RGBW/White/Tunable
  value transform and live-websocket-backed Loxone monitors were already built, just not
  documented as such.

## [0.1.0-alpha.1] - 2026-07-31

### Added
- **Dashboard charts**: fill-under-line, stepped lines, point markers, a linear or logarithmic
  Y-axis with an optional fixed min/max, scroll-to-zoom/drag-to-pan, threshold lines *or* filled
  bands, time-anchored annotations, and per-series overrides (rename, unit, scale, decimals,
  right-hand axis, color, line style/width).
- **Auto order**: resizes every dashboard panel to fit its own content, then repacks them with the
  fewest gaps, in one click. Every panel type's Edit form is now grouped into the same labeled
  sections (Appearance, Axis, Condition, ...) regardless of type.
- **Dashboard sharing**: share a personal dashboard with specific users (viewer or editor) or with
  an entire Access Role; **Favorite Dashboards** stars one into its own sidebar section.
- **Notifications**: admin-wide alert rules/channels via [Apprise](https://github.com/caronc/apprise)
  (Monitor threshold, Miniserver/MQTT client status, backup failures), plus fully independent
  per-user notifications on the Profile page — a personal Apprise channel, personal trigger rules
  needing no admin involvement, and the option to subscribe to admin-wide rules too.
- **Command catalog**: 18 named Shelly Gen1 device types, Shelly Gen2/Gen3 (both the full RPC form
  and the simpler "command/switch:N" form), a matching telemetry catalog ("Common data"), JSON/XML
  catalog import & export, and a native Shelly RGBW/White/Tunable-white value transform for
  Loxone → MQTT mappings.
- **Monitor**: history table grouped by day/hour instead of one unbounded list; hover tooltips with
  time + value on the chart.
- Miniserver firmware version, shown alongside the existing Online/Offline status.
- Offsite backup copy via rclone (70+ storage backends), on top of the existing local
  scheduled/manual backups.
- A first-boot setup wizard, a GitHub release version check in the sidebar, a shared toggle-switch
  UI component applied across every admin settings page, and a first automated test suite.
- A GitHub Actions workflow publishing a Docker image to GHCR on every push to `main` and on
  version tags, and an Unraid Community Applications template (`unraid/loxsuite.xml`).

### Fixed
- Dashboard panels not visually refreshing after being edited/saved, caused by a leaked
  `setInterval` that kept every previous edit's old chart polling in the background indefinitely.
- Drag-and-drop panel reordering flickering/jumping, and the resize cursor not showing while
  actively dragging a panel, drawer, or table column edge.
- A chart's plotted line silently connecting to the wrong value at "now" when its underlying data
  arrived newest-first, producing a spurious flat line across the whole chart.

### Changed
- Dashboard chart panels no longer set Decimals/Value scale at the panel level — every series sets
  its own now, matching how the Current Value panel type already worked.

## [0.0.1-alpha.1] - 2026-07-29

Initial alpha. First tagged snapshot after consolidating the stack into a single container.

### Added
- MQTT gateway with bidirectional Loxone &harr; MQTT mapping (HTTP and UDP transports).
- Monitor: value history over time with charts, tables, and CSV export.
- Custom dashboards (chart/table/current value/gauge/stat-with-change/threshold panels).
- Logs: live + persisted view of the Mosquitto broker log and each Miniserver's own log.
- Web UI with login, Users, Access Roles, and optional Pocket ID (OIDC) Single Sign-On.
- MQTT Users/Roles management backed by Mosquitto's dynamic-security plugin.
- Gateway database backup/restore, including scheduled backups and restore from existing storage.
- CSRF protection (synchronizer token) and login rate-limiting.
- `/healthz` endpoint and a Docker `HEALTHCHECK`.

### Changed
- Mosquitto now runs inside the same container as the gateway (previously three separate
  containers) — only one container (`loxsuite`) is visible externally.

### Known limitations
- No automated test suite yet.
- No autocomplete for Virtual Input names, no per-device MQTT topic ACLs, no device-specific
  value transforms beyond a plain translation table — see the README's "Known scope limitations".
- Miniserver/Audioserver backup (distinct from the gateway's own database backup) is not
  implemented — deliberately deferred, not an oversight.
