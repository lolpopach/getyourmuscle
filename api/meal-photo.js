/* A meal photo → what is on the plate and how much (docs/dev/GETYOURMUSCLE_PLAN.md §4.10).
 *
 * Runs on a free vision model: Cloudflare Workers AI through the Worker's `AI` binding (no key,
 * inside the Workers Free plan's daily allowance), or Google's Gemini API when GEMINI_API_KEY is
 * set (a free key from Google AI Studio; usually the better reader of Korean food).
 *
 * The model is asked to RECOGNISE, not to count calories: dish names in Korean and servings
 * against a stated standard portion. The app looks the names up in its own food table
 * (frontend/src/lib/foods.js) and uses the model's own numbers only for a dish the table cannot
 * place — a small free model names a dish well and invents its calories badly.
 *
 * Shared by both servers (server.js, cloudflare/api.js); the fetch and the binding are injected,
 * so this file does no I/O of its own. */

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_WORKERS_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const TIMEOUT_MS = 45000;
// The app sends a ~1024 px JPEG of a few hundred kB; 3 MB keeps the base64 body under both
// servers' 5 MB request limit.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Which model this server reads photos with, from its environment, or null for none.
 * GEMINI_API_KEY wins over the Workers AI binding; GEMINI_MODEL / WORKERS_AI_MODEL pick another
 * model of the same provider.
 */
export function photoProvider(env = {}) {
  const key = String(env.GEMINI_API_KEY || '').trim();
  if (key) return { id: 'gemini', model: String(env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL, key };
  if (env.AI && typeof env.AI.run === 'function') return { id: 'workers-ai', model: String(env.WORKERS_AI_MODEL || '').trim() || DEFAULT_WORKERS_AI_MODEL, ai: env.AI };
  return null;
}

export const PHOTO_PROMPT = `You read photos of meals for a Korean high-school student's food log.
List every distinct food in the photo that the person is eating. Separate each part of a plate or a school lunch tray: rice, soup, each side dish, kimchi, fruit, drink.

For each item give:
- name: the usual Korean name of the dish as written on a Korean menu (흰쌀밥, 잡곡밥, 제육볶음, 소불고기, 된장찌개, 미역국, 배추김치, 깍두기, 시금치나물, 계란말이, 닭가슴살, 바나나). Korean only, no description.
- servings: how much is there, in standard single servings, in steps of 0.25. One serving is: rice 1 bowl (공기, 210 g); soup or stew 1 bowl (250 ml); a meat or fish main dish about 150 g; a vegetable side dish about 60 g; kimchi about 40 g; fruit about 100 g; a drink 200 ml. Judge the size against the bowl, tray, spoon or chopsticks.
- grams: your estimate of the weight.
- kcal, protein_g, carbs_g, fat_g: your estimate for that amount.

If a nutrition label or a product name is readable, use the label's numbers and the product's name.
If the user's note says how much was eaten (for example "밥 반만 먹음" or "국은 안 먹음"), apply it to the servings.
If the photo shows no food, answer is_food false with an empty list.
Answer with JSON only, in this shape:
{"is_food": true, "items": [{"name": "흰쌀밥", "servings": 1, "grams": 210, "kcal": 310, "protein_g": 6, "carbs_g": 68, "fat_g": 1}]}`;

export const PHOTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_food', 'items'],
  properties: {
    is_food: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'servings', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
        properties: {
          name: { type: 'string' },
          servings: { type: 'number' },
          grams: { type: 'number' },
          kcal: { type: 'number' },
          protein_g: { type: 'number' },
          carbs_g: { type: 'number' },
          fat_g: { type: 'number' }
        }
      }
    }
  }
};

/**
 * The app's request → { mediaType, data, note } or { error }. `image` is a data URL
 * (data:image/jpeg;base64,…), the shape a canvas hands out.
 */
export function parsePhotoBody(body) {
  const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof body?.image === 'string' ? body.image : '');
  if (!m) return { error: 'image must be a base64 data URL' };
  if (!MEDIA_TYPES.has(m[1])) return { error: 'image must be JPEG, PNG or WebP' };
  if (Math.floor(m[2].length * 3 / 4) > MAX_IMAGE_BYTES) return { error: 'image is too large' };
  const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return { mediaType: m[1], data: m[2], note };
}

const userText = note => note ? `User's note: ${note}` : 'No note from the user.';

/** The answer text → parsed JSON, tolerating a fence or prose around the object. */
export function parseAnswer(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0; };
const quarter = v => Math.round(v * 4) / 4;

/** What the model said → { isFood, items: [{ name, servings, grams, kcal, p, c, f }] }, bounded. */
export function normalizeRecognition(answer) {
  const list = Array.isArray(answer?.items) ? answer.items : [];
  const items = [];
  for (const it of list.slice(0, 15)) {
    const name = typeof it?.name === 'string' ? it.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    if (!name) continue;
    items.push({
      name,
      servings: Math.max(0.25, quarter(num(it.servings, 6) || 1)),
      grams: Math.round(num(it.grams, 3000)),
      kcal: Math.round(num(it.kcal, 4000)),
      p: Math.round(num(it.protein_g ?? it.protein ?? it.p, 400)),
      c: Math.round(num(it.carbs_g ?? it.carbs ?? it.c, 800)),
      f: Math.round(num(it.fat_g ?? it.fat ?? it.f, 400))
    });
  }
  return { isFood: answer?.is_food !== false && items.length > 0, items };
}

async function viaGemini(provider, { mediaType, data, note }, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(GEMINI_BASE + encodeURIComponent(provider.model) + ':generateContent', {
      method: 'POST',
      // The key as a header, never ?key= — a query string ends up in logs.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': provider.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PHOTO_PROMPT }] },
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mediaType, data } }, { text: userText(note) }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 }
      }),
      signal: ctl.signal
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { error: `Gemini answered ${res.status}${body?.error?.message ? ': ' + String(body.error.message).slice(0, 200) : ''}`, status: res.status };
    const cand = body?.candidates?.[0];
    if (!cand) return { error: 'Gemini gave no answer' + (body?.promptFeedback?.blockReason ? ` (${body.promptFeedback.blockReason})` : '') };
    const text = (cand.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    return { answer: parseAnswer(text) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'Gemini did not answer in time' : 'Gemini could not be reached' };
  } finally {
    clearTimeout(timer);
  }
}

async function viaWorkersAi(provider, { mediaType, data, note }) {
  const input = {
    messages: [
      { role: 'system', content: PHOTO_PROMPT },
      { role: 'user', content: [{ type: 'text', text: userText(note) }, { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } }] }
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'meal', schema: PHOTO_SCHEMA, strict: true } },
    max_tokens: 2048
  };
  // Gemma 4 and Qwen 3 think before answering unless told not to; for naming dishes that only
  // costs time and the daily allowance.
  if (/gemma-4|qwen3/.test(provider.model)) input.chat_template_kwargs = { enable_thinking: false };
  let timer;
  try {
    const out = await Promise.race([
      provider.ai.run(provider.model, input),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })), TIMEOUT_MS); })
    ]);
    const content = out?.choices?.[0]?.message?.content ?? out?.response;
    return { answer: parseAnswer(content) };
  } catch (e) {
    const msg = String(e?.message || e);
    // The Workers Free plan's daily allowance, spent: say so rather than "server error".
    if (/neuron|daily|quota|limit|429|capacity/i.test(msg)) return { error: 'the free AI allowance for today is used up — it resets at 00:00 UTC', status: 429 };
    return { error: e?.name === 'AbortError' ? 'the AI did not answer in time' : 'the AI could not read this photo: ' + msg.slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads one photo. → { items, provider, model } or { error, status }: 422 when the photo holds
 * no food, 429 when the provider's free allowance is spent, 502 for any other provider failure.
 */
export async function recognizeMeal(provider, input, { fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!provider) return { error: 'meal photos are not set up on this server', status: 503 };
  const r = provider.id === 'gemini' ? await viaGemini(provider, input, fetchImpl) : await viaWorkersAi(provider, input);
  if (r.error) return { error: r.error, status: r.status === 429 ? 429 : 502 };
  if (!r.answer) return { error: 'the AI answer could not be read — try again', status: 502 };
  const { isFood, items } = normalizeRecognition(r.answer);
  if (!isFood) return { error: 'no food found in this photo', status: 422 };
  return { items, provider: provider.id, model: provider.model };
}
