import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bounds,
  normalizeWords,
  candidatesFromIds,
  uniqueCandidates,
  srt,
  wordChunks,
  safeName,
} from '../server/domain.js';
import { publicAddress, remoteUrl, parseFeed, lookup } from '../server/network.js';
import { configuration, sign, verify } from '../server/index.js';
test('cut bounds reject nonfinite, reversed, negative, and out-of-source cuts', () => {
  for (const [a, b] of [
    [NaN, 1],
    [2, 1],
    [-1, 1],
    [0, 11],
    [0, 0.05],
  ])
    assert.throws(() => bounds(a, b, 10));
  assert.deepEqual(bounds(0.1, 9, 10), { start: 0.1, end: 9 });
});
test('word timing survives sorting and uses real IDs for suggestions', () => {
  const words = normalizeWords(
    {
      words: [
        { start: 6000, end: 7000, text: 'payoff', speaker: 'B' },
        { start: 0, end: 1000, text: 'setup', speaker: 'A' },
      ],
    },
    10,
  );
  assert.deepEqual(
    words.map((w) => w.id),
    [0, 1],
  );
  const picks = candidatesFromIds(
    [
      { firstWord: 0, lastWord: 1, title: 'a bit', short: null, full: null },
      { firstWord: 0, lastWord: 99, title: 'invented' },
    ],
    words,
    10,
  );
  assert.equal(picks.length, 1);
  assert.equal(picks[0].start, 0);
  assert.equal(picks[0].end, 7.25);
});
test('overlap removal preserves variety and excludes prior suggestions', () => {
  const a = { start: 0, end: 20, score: 9 },
    b = { start: 10, end: 22, score: 8 },
    c = { start: 40, end: 60, score: 7 };
  assert.deepEqual(uniqueCandidates([a, b, c]), [a, c]);
  assert.deepEqual(uniqueCandidates([a, b, c], [a]), [c]);
});
test('captions have clip-relative times, corrected wording, bounded edges, and speaker breaks', () => {
  const p = {
    words: [
      { id: 0, start: 4, end: 5, text: 'old', speaker: 'A' },
      { id: 1, start: 5, end: 6, text: 'answer', speaker: 'B' },
    ],
    corrections: { 0: 'new' },
  };
  const out = srt(p, { start: 4.5, end: 5.5 });
  assert.match(out, /00:00:00,000 --> 00:00:00,500\nnew/);
  assert.match(out, /00:00:00,500 --> 00:00:01,000\nanswer/);
});
test('chunk overlap covers every word and has bounded sizes', () => {
  const words = Array.from({ length: 4500 }, (_, id) => ({ id }));
  const chunks = wordChunks(words);
  assert.equal(new Set(chunks.flat().map((w) => w.id)).size, 4500);
  assert.ok(chunks.every((c) => c.length <= 1800));
  assert.ok(chunks[1][0].id < chunks[0].at(-1).id);
});
test('feed handles one item and rejects XML entities and unsafe audio destinations', () => {
  const feed = parseFeed(
    '<rss><channel><title>Yellow Five</title><item><title>A bit</title><guid>x</guid><enclosure url="https://example.com/a.mp3" /></item></channel></rss>',
    'https://example.com/rss',
  );
  assert.equal(feed.episodes.length, 1);
  assert.throws(() => parseFeed('<!DOCTYPE x [<!ENTITY b "oops">]><rss/>', 'x'));
  assert.equal(
    parseFeed(
      '<rss><channel><item><enclosure url="https://127.0.0.1/a"/></item></channel></rss>',
      'x',
    ).episodes.length,
    0,
  );
});
test('network import blocks private, mapped, metadata, credentialed, and non-HTTPS URLs', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '192.168.1.1',
    '0.0.0.0',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of [
    'file:///etc/passwd',
    'http://example.com/a',
    'https://localhost/a',
    'https://[::1]/a',
    'https://a:b@example.com/a',
    'https://example.com:8080/',
  ])
    assert.throws(() => remoteUrl(url));
});
test('tickets are scoped, signed, and expire', () => {
  const c = { secret: 'a'.repeat(32) },
    token = sign(c, 'media:one', 100);
  assert.ok(verify(c, token, 'media:one'));
  assert.equal(verify(c, token, 'workspace'), false);
  assert.equal(verify(c, token + 'x', 'media:one'), false);
  assert.equal(verify(c, sign(c, 'workspace', -1), 'workspace'), false);
});
test('configuration rejects unsafe limits and export names cannot traverse', () => {
  assert.throws(() => configuration({ MAX_FILE_MB: 'NaN' }));
  assert.ok(!safeName('../../hello/there').includes('/'));
});

import dns from 'node:dns';
test('connection-time lookup rejects mixed public/private answers and returns only checked addresses', async (t) => {
  t.mock.method(dns, 'lookup', (host, opts, cb) =>
    cb(null, [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
  );
  await assert.rejects(
    () =>
      new Promise((resolve, reject) =>
        lookup('example.com', {}, (err, address) => (err ? reject(err) : resolve(address))),
      ),
    /Private network/,
  );
  dns.lookup.mock.mockImplementation((host, opts, cb) =>
    cb(null, [{ address: '8.8.8.8', family: 4 }]),
  );
  assert.deepEqual(
    await new Promise((resolve, reject) =>
      lookup('example.com', { all: true }, (err, addresses) =>
        err ? reject(err) : resolve(addresses),
      ),
    ),
    [{ address: '8.8.8.8', family: 4 }],
  );
});
