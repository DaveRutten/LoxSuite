const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseThresholdLadder, serializeThresholdLadder, matchedRung, colorForThresholdLadder, sanitizeColor } = require('../src/thresholdLadder');

test('parseThresholdLadder: old 3-field lines still parse, notify defaults false', () => {
  const ladder = parseThresholdLadder('1=orange=line\n2=red=band');
  assert.deepEqual(ladder, [
    { value: 1, color: 'orange', style: 'line', notify: false },
    { value: 2, color: 'red', style: 'band', notify: false },
  ]);
});

test('parseThresholdLadder: 4th field "1" sets notify true, anything else/missing is false', () => {
  const ladder = parseThresholdLadder('1=orange=line=1\n2=red=band=0\n3=purple=line');
  assert.equal(ladder[0].notify, true);
  assert.equal(ladder[1].notify, false);
  assert.equal(ladder[2].notify, false);
});

test('parseThresholdLadder: still sorts ascending and drops invalid lines', () => {
  const ladder = parseThresholdLadder('3=purple=line=1\nnotanumber=red\n1=orange');
  assert.deepEqual(ladder.map((t) => t.value), [1, 3]);
});

test('serializeThresholdLadder: notify:true rungs get a trailing =1, others stay 3-field', () => {
  const text = serializeThresholdLadder([
    { value: 1, color: 'orange', style: 'line', notify: true },
    { value: 2, color: 'red', style: 'band', notify: false },
  ]);
  assert.equal(text, '1=orange=line=1\n2=red=band');
});

test('round-trip: parse -> serialize -> parse is stable, including notify', () => {
  const original = '1=orange=line=1\n2=red=band\n3=purple=line=1';
  const reparsed = parseThresholdLadder(serializeThresholdLadder(parseThresholdLadder(original)));
  assert.equal(serializeThresholdLadder(reparsed), original);
});

test('matchedRung: returns the whole rung object for the highest value met or exceeded', () => {
  const ladder = parseThresholdLadder('1=orange=line=1\n2=red=band\n3=purple=line=1');
  assert.deepEqual(matchedRung(0.5, ladder), null);
  assert.deepEqual(matchedRung(1.5, ladder), { value: 1, color: 'orange', style: 'line', notify: true });
  assert.deepEqual(matchedRung(2.5, ladder), { value: 2, color: 'red', style: 'band', notify: false });
  assert.deepEqual(matchedRung(4, ladder), { value: 3, color: 'purple', style: 'line', notify: true });
});

test('colorForThresholdLadder stays a thin wrapper over matchedRung', () => {
  const ladder = parseThresholdLadder('1=orange\n2=red');
  assert.equal(colorForThresholdLadder(1.5, ladder), 'orange');
  assert.equal(colorForThresholdLadder(0.5, ladder), null);
});

test('sanitizeColor accepts named/hex/rgb colors, rejects a CSS-injection attempt', () => {
  assert.equal(sanitizeColor('red'), 'red');
  assert.equal(sanitizeColor('#ff0000'), '#ff0000');
  assert.equal(sanitizeColor('rgb(255, 0, 0)'), 'rgb(255, 0, 0)');
  assert.equal(sanitizeColor('red; } body { display:none'), null);
});
