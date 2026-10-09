# Voorstel: energiebeheer in modules (Wallbox, Warmtepomp, Zonnepanelen, Aan/uit)

> Status: voorstel, met werkende voorbeelden (pure functies + tests, nog niet aangesloten):
> - `gateway/src/tankDraws.js`: tapbeurten herkennen uit de tanktemperatuur, tank plannen
> - `gateway/src/energyTypes.js` + `gateway/energy-types/`: apparaattypes (Mitsubishi Ecodan, SolarEdge, eigen merk)
> - `gateway/src/heatPumpTypes.js`: wat de warmtepomp doet, en het plan → setpoints
> - `gateway/src/solarLimit.js`: omvormer begrenzen als teruglevering geld kost
> - `gateway/src/energyDiscovery.js`: warmtepomp / omvormer vinden in de Loxone-structuur (zoals Home Connect)
> - `gateway/src/legionella.js`: tapwatergrenzen en de legionella-cyclus plannen
>
> De bestaande weergaven van de Energiemanager (Nu, Plan, Onbekende verbruikers) blijven; dit is het instellingendeel per module. In het menu staan Energiemanager en Slim laden bovenaan bij *Energie & laden*.

## Het idee in één zin

**LoxSuite beslist, Loxone voert uit en bewaakt de veiligheid.**

Nu staat veel van de slimme logica in Loxone Config, en daar is het lastig aan te passen. In LoxSuite is die logica te testen, te leren en per installatie in te stellen. Loxone houdt alleen de vangrails: legionella, vorst, minimumtemperaturen, en terugvallen op de eigen logica als LoxSuite stil valt.

## Drie soorten modules

Elk apparaat in het energiebeheer is een module. Elke module vertelt de verdeler per uur drie dingen:

1. **Wat hij nodig heeft:** de verwachte kWh, geleerd uit metingen en patronen.
2. **Hoe flexibel dat is:** wat moet vóór welk moment, wat mag later, en hoe lang hij maximaal kan wachten.
3. **Zijn prioriteit:** wie het eerst zonne-overschot of goedkope uren krijgt.

De verdeler (`planLoads` in `energyManager.js`, die er nu al is) verdeelt daarna het overschot en de goedkope uren. Elke module zet zijn deel van het plan om in signalen naar Loxone.

| Module | Bestaat al? | Wat hij stuurt | Wat hij leert |
|---|---|---|---|
| **Wallbox** | Ja, als *Slim laden* | laadvermogen / start-stop | vertrektijden, ritten, benodigde kWh |
| **Warmtepomp** | Deels, als twee losse soorten (`dhw` + `heatpump`) | **modus**: tapwater / verwarmen / vrij, plus setpoints | tapbeurten, stilstandverlies, hoe snel het huis afkoelt, wanneer het boost-element bijspringt |
| **Zonnepanelen** | Nee (de opbrengst wordt alleen gemeten) | begrenzing omvormer (%) | wanneer teruglevering geld kost |
| **Aan/uit-verbruiker** | Nee (de huidige `appliance` is voor Home Connect) | één uitgang aan/uit | draaiuren per dag, vaste momenten |

## Eerst zoeken in Loxone, de template is de reserve

Net als bij de Home Connect-apparaten leest LoxSuite de warmtepomp en de omvormer **uit de Loxone-structuur** (`energyDiscovery.js`). De uitgangen van één Modbus-apparaat staan daar als losse objecten met hetzelfde begin van de uuid. Hun namen zijn die van de Modbus-template, dus herkent LoxSuite op naam welke functie welk object is:

- **Lezen:** de status-uuid van het object.
- **Sturen:** per functie kies je zelf (`energyTypes.link`):
  - **direct** naar het Loxone-object (de `uuidAction`);
  - via een **virtuele ingang**, met een naam die je zelf kiest. Dan houdt jouw Loxone-logica het laatste woord;
  - of **uit**: alleen lezen.

  Zonder keuze stuurt LoxSuite direct als dat kan, en anders via `WP_…` of `PV_…`.
- **Lezen** kan ook uit een ander Loxone-object of een virtuele uitgang die je zelf kiest. Een functie die het type niet kent, kan je zo ook toevoegen.
- **Een sensor en de bijbehorende "Set …"-actuator** ("Tank Water Temp Target" en "Set Tank Water Temperature") horen bij één functie.
- **Het bekende type** dat het best op de namen past (bijvoorbeeld de ingebouwde Ecodan A1M) levert de betekenissen en grenzen. Ook laat het zien wat Loxone nog niet toont, zoals de 3-wegklep.

Voorwaarde: het object moet in Loxone zichtbaar zijn in de app.

**Reserve:** een Loxone-template importeren (zie hieronder). Voeg het apparaat daarna ook in Loxone toe, dan wordt het vanzelf gevonden.

## Tapwatergrenzen en legionella

**Grenzen** (`legionella.dhwLimits`). Je stelt vijf grenzen in:

- **comfortminimum:** nooit kouder bij de kraan;
- **doel:** de temperatuur in een gewoon uur;
- **buffer bij zon of goedkope stroom;**
- **wat de warmtepomp zelf haalt;**
- **absoluut maximum.**

Ze worden op volgorde gezet, met een melding. Een buffer boven wat de warmtepomp zelf haalt, kan alleen als je de bijverwarming op zon toestaat. Een comfortminimum onder 40 °C geeft een legionella-waarschuwing.

**Legionella** (`legionella.planLegionella`). Je stelt in:

- **elke X dagen;**
- **temperatuur** (60 °C);
- **vasthouden** (30 minuten);
- **alleen tussen** bepaalde uren.

LoxSuite kiest het goedkoopste blok vóór de cyclus moet, met zonne-overschot als eerste keus: dan zijn de kWh van de bijverwarming gratis. Is hij al te laat, dan neemt LoxSuite het eerste toegestane blok.

In dat blok gaat het setpoint naar 60 °C, met één puls op *Force DHW*. Elke keer dat de tank 30 minuten op temperatuur blijft, telt mee (`lastDone`). Dat geldt ook voor het eigen programma van de Ecodan, of voor een volle buffer op zon. Het programma van de Ecodan blijft als vangnet staan, op een langer interval.

## Apparaattypes: per merk weten wat er te sturen is

Bij de Warmtepomp en de Zonnepanelen kies je een **type**. Een type is een JSON-bestand: welke registers er zijn, wat ze betekenen (een *rol*, zoals `tankTemp` of `dhwSetpoint`), hoe ze schalen (°C × 100) en welke je kunt schrijven. Zo weet de module wat hij kan verwachten en wat hij kan sturen.

| Waar | Wat |
|---|---|
| `gateway/energy-types/<soort>/*.json` | ingebouwd: **Mitsubishi Ecodan (Procon)**, **SolarEdge** |
| `device-templates/user/energy/<soort>/*.json` | je eigen bestanden, zelfde vorm; dezelfde `key` vervangt een ingebouwde |
| **Eigen / ander merk** | altijd beschikbaar: alle rollen van de soort, zonder registers. Je koppelt per rol zelf een Loxone-object |

**LoxSuite praat zelf geen Modbus.** De Modbus-template (uit de Loxone Library of zelf gemaakt) zit in Loxone Config. LoxSuite leest de Loxone-statussen en zet virtuele ingangen (`WP_…`, `PV_…`) die in Loxone aan de Modbus-uitgangen hangen. De registers in een type zijn er om te weten wat een waarde betekent en welk Loxone-object je moet koppelen.

`energyTypes.check()` zegt per type wat de module mist: een type zonder `tankTemp` of zonder schrijfbaar `dhwSetpoint` kan de tapwaterplanning niet doen.

**Importeren uit een Loxone-template** (`loxoneTemplate.js`). Een `.LxAddon` uit de Loxone Library (een zip met de XML en `desc.json`), of de `.xml` uit Loxone Config, wordt een type:

- **Elke `ModbusCmd` wordt een register**, met de schaal van Loxone (SourceValHigh → DestValHigh) en de eenheid. Een sensor en een actuator op hetzelfde register worden samen één register dat je kunt lezen en schrijven.
- **De rol wordt voorgesteld op naam**, in het Engels, Nederlands of Duits. Wat niet herkend wordt, wijs je zelf toe.
- **SunSpec-waarden** (`X_RAW` + `X_SF`) krijgen hun schaalfactor: waarde = RAW × 10^SF.
- **`check()` zegt wat er mist.** Bij de Library-template van SolarEdge is dat de vermogensbegrenzing: die zit er niet in, en voeg je zelf toe in Loxone.

## Module Warmtepomp: één apparaat, twee taken

Nu zijn tapwater en verwarming in LoxSuite twee losse verbruikers. In werkelijkheid is het **één compressor**: een uur tapwater is een uur zonder ruimteverwarming. De module plant daarom één **modus per uur**:

| Modus | Betekenis | Signaal naar Loxone (bij de Ecodan) |
|---|---|---|
| `tapwater` | de tank opwarmen (eventueel tot een buffersetpoint) | `WP_Tapwater_Setpoint` boven tank + hysterese |
| `verwarmen` | ruimteverwarming, eventueel voorverwarmen | `WP_Blokkering = 0`, eventueel `WP_Aanvoer_Setpoint` hoger |
| `vrij` | LoxSuite heeft geen voorkeur: Loxone volgt zijn eigen logica | `WP_Tapwater_Setpoint` op "wachten", geen blokkering |

### Wat hij meet

- **Tanktemperatuur.** Elke minuut, niet alleen het uurgemiddelde dat nu in `load_temp_hourly` wordt bewaard. Een douchebeurt duurt maar 8 minuten.
- **Kamertemperatuur.** Bestaat al: daarmee wordt geleerd hoe snel het huis afkoelt (`temperature.js` → `holdHours`).
- **Huidige modus van de warmtepomp:** verwarmen of tapwater. Zo weet LoxSuite wanneer de tank wordt opgewarmd.
- **Vermogen van het boost-element, of alleen aan/uit.** Dit kan LoxSuite niet sturen, maar wel meten.

### Mitsubishi Ecodan (MelcoBEMS MINI A1M)

Het ingebouwde type (`energy-types/heatpump/mitsubishi-ecodan-a1m.json`) komt uit de Loxone Library-template **Mitshubishi Heat Pump**, aangevuld met de **Procon A1M-registertabel v1.0.7**. De namen zijn die van de objecten in Loxone, zodat koppelen vanzelf gaat.

Wat dat betekent voor de module (`heatPumpTypes.js`):

- **Nu tapwater maken (`Force DHW`, register 37).** Eén puls start een tapwatercyclus tot het setpoint. De Ecodan zet de puls zelf terug. LoxSuite stuurt hem dus één keer per gepland blok, niet elke minuut.
- **Tapwater-setpoint (31).** Dit is het doel, en buiten de geplande uren de vangrail. Het setpoint staat dan zo dat de Ecodan pas zelf start onder het comfortminimum. De hysterese leest LoxSuite uit de unit zelf (`DHW Temperature Drop`, 92).
- **Nooit boven `hpMaxC` (~55 °C).** Daarboven helpt de bijverwarming.
- **Het boost-element is te lezen:**
  - *Booster Heater 1/2* (145/146) en *Immersion Heater* (148): of ze aan staan;
  - *Heat Source* (364 in de template): 0 = warmtepomp, 1 = dompelaar, 2 = bijverwarming.
  
  Gaat het boost-element aan terwijl de tank volgens het plan warm genoeg was, dan was het plan te krap. Dat is een leermoment.
- **COP direct uit de unit:** *Consumed Power* (379) en *Produced Power* (380). Een uur verwarmen kost dan *prijs ÷ COP*.
- **Kamer-setpoint zone 1 (33).** Hiermee kan LoxSuite voorverwarmen in goedkope uren en rustiger aan doen in dure uren.
- **Niet te sturen via de template:**
  - *Holiday* (38) staat in de Library-template alleen als sensor. Op de A1M is het register wel schrijfbaar.
  - *DHW / Heating Prohibit* (39, 40, 42) zijn alleen-lezen vanaf firmware 3.0.28.
  
  Tapwater tegenhouden gaat dus via het setpoint.
- **Nog toevoegen in Loxone als Modbus-sensor**, om de tapbeurten goed te herkennen:
  - *3-Way Valve* (152), waaraan je ziet wanneer de tank wordt opgewarmd;
  - *Heat Pump Frequency* (73);
  - *Outdoor Ambient Temperature* (100);
  - *Room Temperature Zone 1* (94);
  - *Defrost* (input-register 26);
  - *Immersion Heater* (148).
- **Schrijven beperken:** alleen wat verandert, en maximaal 6 schrijfacties per uur.

### Tapwater herkennen zonder flowmeter (het voorbeeld)

Een tank koelt in rust langzaam af, ongeveer 0,3–1 °C per uur. Wordt er warm water getapt, dan zakt hij in een paar minuten een aantal graden. Wat "snel" is, leert LoxSuite per tank:

1. `dropRates`: de daling in °C per uur over een venster van 5 minuten. Alleen momenten waarop de warmtepomp de tank niet verwarmt tellen mee.
2. `learnThreshold`: de mediaan is het gewone stilstandverlies van deze tank. Een tapbeurt ligt ver daarboven: mediaan + 8 × de spreiding (MAD), en minstens 4 °C/u. Zolang er te weinig data is, geldt veilig 8 °C/u.
3. `detectDraws`: snelle minuten worden samengevoegd tot een tapbeurt, met begin, eind en het aantal graden dat de tank daalde.
4. `drawProfile`: hetzelfde patroonprofiel als `energyPatterns.js` al gebruikt, met °C in plaats van kWh. Daaruit komen patronen als *"elke dag ~07:00 douchen, −6 °C"* en *"zondag 10:00 bad"*.
5. `planTank`: voorspelt de tank uur voor uur (stilstandverlies plus de gebruikelijke tapbeurten). Zo vindt hij het eerste uur waarin de tank onder het comfortminimum zou zakken. Daarvóór kiest hij de **goedkoopste uren** om op te warmen, met zonne-overschot als goedkoopst.

Spelregels in `planTank`:

- **De tank is nu al te koud:** dan meteen opwarmen. Wachten betekent dat het boost-element bijspringt, en dat is direct elektrisch en dus duur.
- **Nooit langer tapwater achter elkaar dan het huis zonder warmte kan** (`holdH`, geleerd uit de afkoeling van de woonkamer).
- **Zonne-overschot:** dat gaat in de tank als buffer, zolang er ruimte is. Is de tank vol, dan blijft het over voor de auto of andere verbruikers.

### Het boost-element als leermeester

Het boost-element kun je niet sturen, maar je kunt wel zien **wanneer** het aangaat:

- **Boost aan terwijl de tank volgens het plan warm genoeg was:** de voorspelling was te optimistisch. LoxSuite verhoogt de marge, of neemt de tapbeurt van dat moment zwaarder mee.
- **Boost tijdens een lange verwarmingsrun op een koude dag:** de warmtepomp komt vermogen tekort. Een signaal om eerder voor te verwarmen.
- Op de pagina toon je per dag hoeveel kWh het boost-element gebruikte en wat dat kostte. Zo zie je of het plan het beter doet dan de Loxone-logica.

### Een dag als voorbeeld (winter, dynamisch tarief)

| Tijd | Prijs | Tank (voorspeld) | Modus | Waarom |
|---|---|---|---|---|
| 01–04 | € 0,12 | 49 → 55 °C | tapwater | goedkoopste uur vóór de douche van ~07:00 |
| 04–07 | € 0,18 | 55 → 53 °C | verwarmen (+1 °C) | goedkoop: voorverwarmen |
| 07:00 | € 0,31 | 53 → 47 °C | vrij | douche (geleerd), tank blijft boven 45 °C |
| 08–11 | € 0,34 | 47 → 45 °C | verwarmen (−0,5 °C) | duur: rustiger aan, huis houdt het 3 u vol |
| 12–14 | zon | 45 → 55 °C | tapwater | zonne-overschot: de tank als buffer |
| 19:30 | € 0,36 | 55 → 51 °C | vrij | afwas/bad (geleerd), geen actie nodig |

## Module Zonnepanelen

Vanaf 2027 stopt de salderingsregeling, en veel leveranciers rekenen nu al **terugleverkosten** per kWh. Dan kan teruglevering geld kosten: bij een negatieve marktprijs, of bij een positieve prijs die lager is dan de terugleverkosten.

**Volgorde:** eerst gebruiken, dan pas begrenzen. In zulke uren is zonnestroom het goedkoopst wat er is, dus de verdeler zet de tank, de auto en de aan/uit-verbruikers daar al op. Wat zij niet opnemen, maakt de omvormer niet.

Wat de module doet (`solarLimit.js`):

- **Waarde van teruglevering:** wat het oplevert (`solarValue.exportWorth`) min de **terugleverkosten** (een nieuwe instelling, € per kWh).
- **Levert het iets op:** geen begrenzing (100 %).
- **Kost het geld:** de begrenzing volgt het huisverbruik plus een kleine marge. Er wordt dan ook niets van het net gehaald. De stappen zijn 5 %, zodat er niet bij elke kleine verandering geschreven wordt.

**SolarEdge** (`energy-types/solar/solaredge.json`) heeft daarvoor twee uitgangen in Loxone, zoals je al dacht:

1. `PV_Regeling`: dynamische vermogensregeling aan/uit.
2. `PV_Limiet`: het actieve vermogen in % van de omvormer.

De volgorde van schrijven:

- **Begrenzen:** eerst de regeling aan, dan de limiet.
- **Loslaten:** eerst de limiet terug naar 100 %, dan de regeling uit.

De registernummers in het bestand moeten nog nagekeken worden tegen de template die jij in Loxone gebruikt.

**Een ander merk:** kies *Eigen / ander merk* en koppel de rollen (begrenzing in %, eventueel aan/uit) aan je eigen Loxone-objecten.

## Module Aan/uit-verbruiker

Voor alles met een relais: een boilertje, vijverpomp, infraroodpaneel, luchtontvochtiger. Instellingen:

- **Vermogen** (kW). Wordt geleerd als er een meter is.
- **Wat hij nodig heeft:** één van
  - *X uur per dag* (vijverpomp 6 u),
  - *klaar vóór* (een tijd),
  - *alleen bij overschot* (gratis of niets).
- **Minimaal aan / minimaal uit** (minuten), en het **maximaal aantal schakelingen per dag**. Dat beschermt het apparaat.
- **Venster:** van/tot (bijvoorbeeld niet 's nachts).

Signaal naar Loxone: `<naam>_Aan` (1/0). Planning: de goedkoopste uren binnen het venster, met de minimale looptijd als blokgrootte. Daarbovenop het live overschot, net als `currentSignals` nu al doet voor tapwater.

## Module Wallbox

Deze bestaat al als *Slim laden* en hoeft niet te veranderen. Hij staat al op een eigen plek in de prioriteitenvolgorde (`car_priority`). Wel moet het scherm van het energiebeheer hem tonen als een van de modules, zodat je in één lijst kunt slepen wie eerst gaat: *tapwater → auto → vijverpomp → buffer*.

## Wat er in Loxone overblijft

```
WP_Tapwater_Setpoint (VI °C) ──> Modbus Ecodan reg 30   (×100)
WP_Blokkering (VI 1/0) ────────> Modbus Ecodan reg 38
WP_Aanvoer_Setpoint (VI °C) ───> Modbus Ecodan reg 32   (alleen bij stoken op aanvoer)
PV_Regeling (VI 1/0) ──────────> SolarEdge dynamische vermogensregeling
PV_Limiet (VI %) ──────────────> SolarEdge actief vermogen limiet
LoxSuite_Heartbeat (VI) ── ouder dan 10 min → negeer de VI's, eigen waarden van Loxone
```

Vangrails die altijd in Loxone blijven:

- **Legionella:** wekelijks tot 60 °C, ongeacht het plan.
- **Minimum tanktemperatuur en vorstbeveiliging.**
- **Heartbeat:** stuurt LoxSuite langer dan 10 minuten niets, dan werkt Loxone weer zoals nu.

## Stappenplan

1. **Schaduw, meten.** Tanktemperatuur per minuut opslaan (een ringbuffer van een paar dagen), tapbeurten herkennen en tonen in de tijdlijn. Het boost-element apart meten. Nog niets sturen.
2. **Schaduw, plannen.** Het modusplan tonen naast wat Loxone werkelijk deed, met wat het gekost heeft en wat het had kunnen kosten. Dit is hetzelfde patroon als nu bij `dailyReport`.
3. **Live per signaal.** Eerst `WP_Tapwater_Setpoint`, het veiligste. Daarna `WP_Blokkering`, dan `WP_Aanvoer_Setpoint`, en `PV_Regeling`/`PV_Limiet` zodra de terugleverkosten zijn ingesteld. Met de heartbeat-terugval in Loxone.
4. **Samenvoegen.** De bestaande `dhw`- en `heatpump`-verbruikers worden één Warmtepomp-module. Hun metingen en patronen blijven bewaard, net als nu bij het aan- en uitzetten van modules.

## Nog uit te zoeken

- **De registernummers van de SolarEdge-vermogensregeling** (Enable Dynamic Power Control / Active Power Limit) naast jouw eigen Loxone-uitgangen leggen.
- **Batterij** (zit in de SolarEdge-template): later een eigen module?
- **Wordt het boost-element apart gemeten, of alleen het totaal van de warmtepomp?** Bij alleen een totaal is een vermogenssprong boven het compressormaximum het teken.
- **Waar zit de tanksensor?** Bovenin reageert hij snel op tappen. Onderin pas laat, maar wel goed om te zien wanneer de tank leeg raakt. Beide is het mooist.
- **Tapbeurten tijdens het opwarmen** worden nu niet gezien, omdat de temperatuur dan stijgt. Dat is meestal niet erg: de tank wordt toch al bijgewarmd.

## Stand van zaken (gebouwd)

Inmiddels gebouwd als echte pagina onder **Energiemanager → Modules**, te proberen met de lokale demo (`dev/docker-compose.demo.yml`, `LOXSUITE_DEMO=1`: een gesimuleerde Miniserver met Ecodan A1M, SolarEdge en eigen Loxone-logica). De bestaande weergaven van de Energiemanager blijven.

- **Zoeken in Loxone** zoals bij Home Connect; objecten van de eigen logica (vermogensrelais, NTC, buitenvoelers, leidingsensor, Kamstrup) ook buiten het Modbus-apparaat. Per functie: lezen uit een eigen object, sturen direct / via een virtuele ingang / uit. Template-import als reserve.
- **Geschiedenis uit Loxone**: de statistieken van de gekoppelde objecten (niet alle objecten hebben ze) vullen het leren meteen. Alles wat geleerd wordt staat in `em_samples` (per reeks per uur, 60 dagen) en overleeft een herstart.
- **Tapwater**: tapbeurten uit de tank, of exact uit een leidingsensor; plan op kosten per kWh **warmte** (prijs ÷ verwachte COP bij dat weer); nooit midden in het opwarmen van de kamer; grenzen en legionella instelbaar.
- **Weer**: lucht/water, water/water of bodem/water; ontdooien en COP geleerd per buitentemperatuur en luchtvochtigheid (de luchtvochtigheid komt ook uit de weersverwachting).
- **Kamer**: de Loxone-ruimteregeling (actueel, setpoint, vochtigheid); het comfortschema per weekdag geleerd uit het setpoint; de opwarmtijd per buitentemperatuur, voor tijdig voorverwarmen.
- **Bijsturen voor lange, rustige runs**: per weer de combinatie van aanvoertemperatuur (bij vaste aanvoer: het setpoint "Ta" van de eigen logica), vermogensstand en NTC met de langste runs, beste COP en minste ontdooiingen; adviseren of sturen. In aanvoer-modus gaat er nooit een kamertemperatuur naar "Set Zone 1 Thermostat" (dat is dan de aanvoer).
- **Zonnepanelen**: rekent met het contract (salderen / vaste vergoeding / marktprijs, minus terugleverkosten); SolarEdge AdvancedPwrControlEn = 4 en ReactivePwrConfig = 1 eenmalig, daarna alleen Active Power Limit. Netmeter-teken omkeerbaar.
- **Waarschuwing** als een uitgang die LoxSuite stuurt door de Loxone-logica wordt teruggezet.

Nog te doen: dezelfde koppelweergave bij Slim laden.
