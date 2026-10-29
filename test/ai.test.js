import test from 'node:test';
import assert from 'node:assert/strict';
import { AssemblyAI, parseCompletion } from '../server/ai.js';

test('provider adapter sends current transcript parameters and word-grounded structured requests', async () => {
  const requests = [];
  const ai = new AssemblyAI(
    { apiKey: 'test-only', speechModel: 'universal-3-5-pro', llmModel: 'gemini-2.5-flash' },
    async (url, options) => {
      requests.push({ url, ...options });
      return {
        ok: true,
        json: async () => ({
          id: 'transcript',
          choices: [{ message: { content: '{"moments":[],"chapters":[]}' } }],
        }),
      };
    },
  );
  await ai.submit('https://cdn.example/snapshot');
  let call = requests.at(-1),
    body = JSON.parse(call.body);
  assert.equal(call.headers.authorization, 'test-only');
  assert.equal(body.audio_url, 'https://cdn.example/snapshot');
  assert.equal(body.filter_profanity, false);
  assert.equal(body.disfluencies, true);
  assert.deepEqual(body.speech_models, ['universal-3-5-pro']);
  assert.equal(body.speaker_labels, true);
  await ai.moments(
    [{ id: 5, text: 'A real word.', speaker: 'A', start: 1, end: 2 }],
    [],
    'find a riff',
  );
  call = requests.at(-1);
  body = JSON.parse(call.body);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.model, 'gemini-2.5-flash');
  assert.match(body.messages[1].content, /5\.\.5/);
  assert.match(body.messages[0].content, /untrusted/);
  await ai.poll('one/two');
  assert.match(requests.at(-1).url, /one%2Ftwo$/);
});
test('provider errors, missing key, malformed and truncated outputs surface without invented suggestions', async () => {
  const ai = new AssemblyAI({ apiKey: 'x' }, async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: 'limit' }),
  }));
  await assert.rejects(() => ai.poll('id'), /429/);
  await assert.rejects(() => new AssemblyAI({}).poll('id'), /Configure ASSEMBLYAI_API_KEY/);
  assert.throws(
    () => parseCompletion({ choices: [{ message: { content: 'not json' } }] }),
    /unreadable/,
  );
  assert.throws(
    () => parseCompletion({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    /truncated/,
  );
});
