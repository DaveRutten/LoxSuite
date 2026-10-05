// ISO 3166-1 alpha-2 code -> English name, for the Geo-blocking country picker (Administration >
// Security) and for turning a GeoIP lookup's raw code into something a person can actually read.
// Deliberately a plain data file with zero dependencies — MaxMind's own GeoLite2-Country database
// (see geoBlock.js) returns exactly this same alpha-2 code, so this is the one place that code gets
// turned into a name and a flag, not duplicated per call site.
const COUNTRIES = [
  ['AD', 'Andorra'], ['AE', 'United Arab Emirates'], ['AF', 'Afghanistan'], ['AG', 'Antigua and Barbuda'],
  ['AI', 'Anguilla'], ['AL', 'Albania'], ['AM', 'Armenia'], ['AO', 'Angola'], ['AQ', 'Antarctica'],
  ['AR', 'Argentina'], ['AS', 'American Samoa'], ['AT', 'Austria'], ['AU', 'Australia'], ['AW', 'Aruba'],
  ['AX', 'Åland Islands'], ['AZ', 'Azerbaijan'], ['BA', 'Bosnia and Herzegovina'], ['BB', 'Barbados'],
  ['BD', 'Bangladesh'], ['BE', 'Belgium'], ['BF', 'Burkina Faso'], ['BG', 'Bulgaria'], ['BH', 'Bahrain'],
  ['BI', 'Burundi'], ['BJ', 'Benin'], ['BL', 'Saint Barthélemy'], ['BM', 'Bermuda'], ['BN', 'Brunei'],
  ['BO', 'Bolivia'], ['BQ', 'Bonaire, Sint Eustatius and Saba'], ['BR', 'Brazil'], ['BS', 'Bahamas'],
  ['BT', 'Bhutan'], ['BV', 'Bouvet Island'], ['BW', 'Botswana'], ['BY', 'Belarus'], ['BZ', 'Belize'],
  ['CA', 'Canada'], ['CC', 'Cocos (Keeling) Islands'], ['CD', 'DR Congo'], ['CF', 'Central African Republic'],
  ['CG', 'Congo'], ['CH', 'Switzerland'], ['CI', 'Côte d’Ivoire'], ['CK', 'Cook Islands'], ['CL', 'Chile'],
  ['CM', 'Cameroon'], ['CN', 'China'], ['CO', 'Colombia'], ['CR', 'Costa Rica'], ['CU', 'Cuba'],
  ['CV', 'Cabo Verde'], ['CW', 'Curaçao'], ['CX', 'Christmas Island'], ['CY', 'Cyprus'], ['CZ', 'Czechia'],
  ['DE', 'Germany'], ['DJ', 'Djibouti'], ['DK', 'Denmark'], ['DM', 'Dominica'], ['DO', 'Dominican Republic'],
  ['DZ', 'Algeria'], ['EC', 'Ecuador'], ['EE', 'Estonia'], ['EG', 'Egypt'], ['EH', 'Western Sahara'],
  ['ER', 'Eritrea'], ['ES', 'Spain'], ['ET', 'Ethiopia'], ['FI', 'Finland'], ['FJ', 'Fiji'],
  ['FK', 'Falkland Islands'], ['FM', 'Micronesia'], ['FO', 'Faroe Islands'], ['FR', 'France'],
  ['GA', 'Gabon'], ['GB', 'United Kingdom'], ['GD', 'Grenada'], ['GE', 'Georgia'], ['GF', 'French Guiana'],
  ['GG', 'Guernsey'], ['GH', 'Ghana'], ['GI', 'Gibraltar'], ['GL', 'Greenland'], ['GM', 'Gambia'],
  ['GN', 'Guinea'], ['GP', 'Guadeloupe'], ['GQ', 'Equatorial Guinea'], ['GR', 'Greece'], ['GT', 'Guatemala'],
  ['GU', 'Guam'], ['GW', 'Guinea-Bissau'], ['GY', 'Guyana'], ['HK', 'Hong Kong'], ['HM', 'Heard Island and McDonald Islands'],
  ['HN', 'Honduras'], ['HR', 'Croatia'], ['HT', 'Haiti'], ['HU', 'Hungary'], ['ID', 'Indonesia'],
  ['IE', 'Ireland'], ['IL', 'Israel'], ['IM', 'Isle of Man'], ['IN', 'India'], ['IO', 'British Indian Ocean Territory'],
  ['IQ', 'Iraq'], ['IR', 'Iran'], ['IS', 'Iceland'], ['IT', 'Italy'], ['JE', 'Jersey'], ['JM', 'Jamaica'],
  ['JO', 'Jordan'], ['JP', 'Japan'], ['KE', 'Kenya'], ['KG', 'Kyrgyzstan'], ['KH', 'Cambodia'],
  ['KI', 'Kiribati'], ['KM', 'Comoros'], ['KN', 'Saint Kitts and Nevis'], ['KP', 'North Korea'],
  ['KR', 'South Korea'], ['KW', 'Kuwait'], ['KY', 'Cayman Islands'], ['KZ', 'Kazakhstan'], ['LA', 'Laos'],
  ['LB', 'Lebanon'], ['LC', 'Saint Lucia'], ['LI', 'Liechtenstein'], ['LK', 'Sri Lanka'], ['LR', 'Liberia'],
  ['LS', 'Lesotho'], ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['LV', 'Latvia'], ['LY', 'Libya'],
  ['MA', 'Morocco'], ['MC', 'Monaco'], ['MD', 'Moldova'], ['ME', 'Montenegro'], ['MF', 'Saint Martin'],
  ['MG', 'Madagascar'], ['MH', 'Marshall Islands'], ['MK', 'North Macedonia'], ['ML', 'Mali'],
  ['MM', 'Myanmar'], ['MN', 'Mongolia'], ['MO', 'Macao'], ['MP', 'Northern Mariana Islands'],
  ['MQ', 'Martinique'], ['MR', 'Mauritania'], ['MS', 'Montserrat'], ['MT', 'Malta'], ['MU', 'Mauritius'],
  ['MV', 'Maldives'], ['MW', 'Malawi'], ['MX', 'Mexico'], ['MY', 'Malaysia'], ['MZ', 'Mozambique'],
  ['NA', 'Namibia'], ['NC', 'New Caledonia'], ['NE', 'Niger'], ['NF', 'Norfolk Island'], ['NG', 'Nigeria'],
  ['NI', 'Nicaragua'], ['NL', 'Netherlands'], ['NO', 'Norway'], ['NP', 'Nepal'], ['NR', 'Nauru'],
  ['NU', 'Niue'], ['NZ', 'New Zealand'], ['OM', 'Oman'], ['PA', 'Panama'], ['PE', 'Peru'],
  ['PF', 'French Polynesia'], ['PG', 'Papua New Guinea'], ['PH', 'Philippines'], ['PK', 'Pakistan'],
  ['PL', 'Poland'], ['PM', 'Saint Pierre and Miquelon'], ['PN', 'Pitcairn'], ['PR', 'Puerto Rico'],
  ['PS', 'Palestine'], ['PT', 'Portugal'], ['PW', 'Palau'], ['PY', 'Paraguay'], ['QA', 'Qatar'],
  ['RE', 'Réunion'], ['RO', 'Romania'], ['RS', 'Serbia'], ['RU', 'Russia'], ['RW', 'Rwanda'],
  ['SA', 'Saudi Arabia'], ['SB', 'Solomon Islands'], ['SC', 'Seychelles'], ['SD', 'Sudan'],
  ['SE', 'Sweden'], ['SG', 'Singapore'], ['SH', 'Saint Helena'], ['SI', 'Slovenia'],
  ['SJ', 'Svalbard and Jan Mayen'], ['SK', 'Slovakia'], ['SL', 'Sierra Leone'], ['SM', 'San Marino'],
  ['SN', 'Senegal'], ['SO', 'Somalia'], ['SR', 'Suriname'], ['SS', 'South Sudan'],
  ['ST', 'São Tomé and Príncipe'], ['SV', 'El Salvador'], ['SX', 'Sint Maarten'], ['SY', 'Syria'],
  ['SZ', 'Eswatini'], ['TC', 'Turks and Caicos Islands'], ['TD', 'Chad'], ['TF', 'French Southern Territories'],
  ['TG', 'Togo'], ['TH', 'Thailand'], ['TJ', 'Tajikistan'], ['TK', 'Tokelau'], ['TL', 'Timor-Leste'],
  ['TM', 'Turkmenistan'], ['TN', 'Tunisia'], ['TO', 'Tonga'], ['TR', 'Turkey'], ['TT', 'Trinidad and Tobago'],
  ['TV', 'Tuvalu'], ['TW', 'Taiwan'], ['TZ', 'Tanzania'], ['UA', 'Ukraine'], ['UG', 'Uganda'],
  ['UM', 'U.S. Outlying Islands'], ['US', 'United States'], ['UY', 'Uruguay'], ['UZ', 'Uzbekistan'],
  ['VA', 'Vatican City'], ['VC', 'Saint Vincent and the Grenadines'], ['VE', 'Venezuela'],
  ['VG', 'British Virgin Islands'], ['VI', 'U.S. Virgin Islands'], ['VN', 'Vietnam'], ['VU', 'Vanuatu'],
  ['WF', 'Wallis and Futuna'], ['WS', 'Samoa'], ['XK', 'Kosovo'], ['YE', 'Yemen'], ['YT', 'Mayotte'],
  ['ZA', 'South Africa'], ['ZM', 'Zambia'], ['ZW', 'Zimbabwe'],
];

const NAME_BY_CODE = new Map(COUNTRIES);

// Regional indicator symbols: two-letter code -> a pair of Unicode "regional indicator" code
// points, which every modern OS/browser renders as that country's flag automatically — no image
// assets to ship or keep in sync. XK (Kosovo, not a real ISO-assigned code but MaxMind returns it
// anyway) has no such flag; falls back to a plain globe rather than mangled/missing glyphs.
function flagEmoji(code) {
  if (!/^[A-Z]{2}$/.test(code)) return '🌐';
  if (code === 'XK') return '🇽🇰'; // has a real emoji flag despite not being ISO-3166-1
  const points = [...code].map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...points);
}

function countryName(code) {
  return NAME_BY_CODE.get(code) || code;
}

// Sorted by name for the picker UI — COUNTRIES itself stays code-ordered (easier to eyeball/diff).
// `locale` (e.g. 'nl-NL'): names in that language via Intl.DisplayNames, falling back to English.
function listCountries(locale = null) {
  let dn = null;
  try { if (locale && !/^en\b/.test(locale)) dn = new Intl.DisplayNames([locale], { type: 'region' }); } catch { dn = null; }
  const nameOf = (code, name) => { try { return (dn && dn.of(code)) || name; } catch { return name; } };
  return COUNTRIES.map(([code, name]) => ({ code, name: nameOf(code, name), flag: flagEmoji(code) })).sort((a, b) => a.name.localeCompare(b.name, locale || 'en'));
}

module.exports = { countryName, flagEmoji, listCountries };
