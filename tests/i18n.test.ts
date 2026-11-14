import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ukrainian} from '../lib/i18n/uk.ts';
import {translateRuntime} from '../lib/i18n/runtime.ts';

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;

function appKeys() {
  const keys = new Set<string>();
  for (const file of fs.readdirSync('app').filter(f => f.endsWith('.tsx'))) {
    const source = fs.readFileSync(`app/${file}`, 'utf8');
    for (const m of source.matchAll(/\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
      const raw = m[1];
      keys.add(raw[0] === "'" ? raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"') : JSON.parse(raw));
    }
  }
  return keys;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

test('every UI string used in app/ has a Ukrainian translation with the same placeholders', () => {
  const keys = appKeys();
  assert.ok(keys.size > 300, `expected many keys, found ${keys.size}`);
  const missing = [...keys].filter(k => !(k in ukrainian));
  assert.deepEqual(missing, []);
  for (const key of keys) {
    assert.equal(placeholders(ukrainian[key]), placeholders(key), `placeholder mismatch for: ${key}`);
    assert.ok(!CYRILLIC.test(key), `English key contains Cyrillic: ${key}`);
  }
});

test('app/ contains no Cyrillic outside the language picker', () => {
  for (const file of fs.readdirSync('app').filter(f => /\.(tsx|ts)$/.test(f))) {
    const lines = fs.readFileSync(`app/${file}`, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const stripped = line.replace('Українська', '');
      assert.ok(!CYRILLIC.test(stripped), `${file}:${i + 1} has Cyrillic text`);
    });
  }
});

test('runtime messages are translated to English at display time and untouched in Ukrainian', () => {
  const samples: [string, string][] = [
    ['Оберіть детектор D1–D6.', 'Choose a detector, D1–D6.'],
    ['Перевірено 3 із 12; придатних 2, відхилено 1', 'Checked 3 of 12: 2 usable, 1 rejected'],
    ['Сервіс пошуку спостережень IRSA тимчасово недоступний (HTTP 503). Це збій архівного сервісу; звуження дат його не усуне. Повторіть пошук пізніше. Збережені серії залишаються доступними.', 'The NASA archive (IRSA) search service is temporarily down (HTTP 503). This is an archive outage; changing the dates won\'t help. Try again in a few minutes. Saved series are still available.'],
    ['Не вдалося розпізнати «Barnard». Перевірте написання або введіть RA та Dec вручну.', 'Couldn\'t find "Barnard". Check the spelling or type RA and Dec yourself.'],
    ['Поле 167.2000°, +5.1500°', 'Field 167.2000°, +5.1500°'],
    ['Поле DR1 · різні епохи', 'DR1 field · different epochs'],
    ['M101 · поле ICRS', 'M101 · ICRS field'],
    ['TRANSIENT · Невідомі біти: 8', 'TRANSIENT · Unknown bits: 8'],
    ['Без установлених прапорців', 'No flags set'],
    ['Перевірка зображень для експорту: 3 / 10', 'Checking images for export: 3 / 10'],
    ['Архівна відповідь перевищила ліміт. Навіть за одну UTC-добу збігів забагато для повного запиту; звузьте поле або додайте наукові фільтри.', 'The archive response was too large. Even a single UTC day has too many matches for a full query; narrow the field or add science filters.'],
    ['Already English', 'Already English'],
  ];
  for (const [uk, en] of samples) {
    assert.equal(translateRuntime('en', uk), en);
    assert.equal(translateRuntime('uk', uk), uk);
  }
});

test('every Ukrainian string literal in lib/ and workers that can reach the UI is known to the runtime translator', () => {
  const sources = ['lib/field-query.ts', 'lib/science.ts', 'lib/sessions.ts', 'lib/frame-assets.ts', 'lib/processing-checkpoints.ts', 'lib/ephemeris.ts', 'lib/bundle-format.ts', 'lib/votable.ts', 'lib/most.ts', 'lib/session-model.ts', 'lib/hips.ts', 'lib/candidate-matches.ts', 'public/science/processing-state.mjs', 'public/science/lab-storage.mjs'];
  const untranslated: string[] = [];
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/(["'])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      const text = m[2];
      // Fragments concatenated with numbers at runtime are covered by the pattern samples above.
      if (!CYRILLIC.test(text) || text.includes('${') || text.endsWith(': ')) continue;
      if (CYRILLIC.test(translateRuntime('en', text))) untranslated.push(`${file}: ${text}`);
    }
  }
  assert.deepEqual(untranslated, []);
});
