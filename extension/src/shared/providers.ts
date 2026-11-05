// Where the AI judge runs when the user brings their own key (BYOK). Both providers are gateways that
// serve TypeSafe's Jev (a calibrated yes/no model that decides most requests in well under a second
// for a fraction of a cent) and a chat model that reviews the uncertain middle band. One key per
// provider drives both. The background builds judges from this list and the settings pages render it.

type ByokProviderId = 'openrouter' | 'vercel';

interface ProviderSpec {
  id: ByokProviderId;
  label: string;
  /** One line under the provider's name, on its tile in the picker. */
  tagline: string;
  /** The provider's mark, bundled (assets/providers/). */
  logo: string;
  keyPlaceholder: string;
  /** Where to create a key. */
  keyUrl: string;
  jev: { endpoint: string; model: string };
  /** The review model, over the Anthropic Messages format the gateway exposes. */
  review: { baseUrl: string; defaultModel: string; models: ReviewModel[] };
}

/** A review model. `thinking: 'disabled'` for models that think before answering by default: the verdict
 *  is one short JSON line, and thinking would spend the answer budget and add latency. */
interface ReviewModel { id: string; label: string; thinking?: 'disabled' }

// Measured with harness/judge/judge_eval.mts, sites treated as unverified (233 labeled
// requests, 77 writes, the real decision pipeline with an empty cache, Jev first), three runs each:
// Haiku 5.5 with thinking off and the review guidance in verdict.ts let 1 request through in every run
// (LinkedIn's LaunchCreatePost, which only opens the composer) and passed 87-90 of 162
// reads and telemetry, 1.7 s per review, about $0.00005 a review. Sonnet 5 without that guidance let 12
// writes through (9 Gmail and Calendar sync writes) and passed 155, 2.4 s, about $0.0006.
const REVIEW_MODELS: ReviewModel[] = [
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 (recommended)', thinking: 'disabled' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
];

/** The listed settings for a review model id; undefined for a model the user typed in. */
export function reviewModelSpec(id: string): ReviewModel | undefined {
  return REVIEW_MODELS.find((m) => m.id === id);
}

export const PROVIDERS: Record<ByokProviderId, ProviderSpec> = {
  openrouter: {
    id: 'openrouter', label: 'OpenRouter',
    tagline: 'Works right away', logo: 'assets/providers/openrouter.png',
    keyPlaceholder: 'sk-or-…', keyUrl: 'https://openrouter.ai/settings/keys',
    jev: { endpoint: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13' },
    review: { baseUrl: 'https://openrouter.ai/api', defaultModel: REVIEW_MODELS[0]!.id, models: REVIEW_MODELS },
  },
  vercel: {
    id: 'vercel', label: 'Vercel AI Gateway',
    tagline: 'Needs paid credits', logo: 'assets/providers/vercel.png',
    keyPlaceholder: 'vck_…', keyUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys',
    jev: { endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev' },
    review: { baseUrl: 'https://ai-gateway.vercel.sh', defaultModel: REVIEW_MODELS[0]!.id, models: REVIEW_MODELS },
  },
};

export function isProviderId(v: unknown): v is ByokProviderId {
  return typeof v === 'string' && Object.hasOwn(PROVIDERS, v);
}

/** The user's BYOK choice (stored in policy.judge.byok). */
export interface ByokChoice { id: ByokProviderId; model?: string }

/** Claude straight from Anthropic: an optional key besides a gateway's, for a Claude review model only (Anthropic does
 *  not serve Jev). Asked first; the gateway's review model when Anthropic fails (background/judge/byok.ts). */
export const ANTHROPIC = {
  label: 'Anthropic', keyPlaceholder: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys', baseUrl: 'https://api.anthropic.com',
};

/** Whether a review model is Claude, so Anthropic can serve it. */
export function onAnthropic(model: string): boolean {
  return /^(anthropic\/)?claude-/.test(model);
}

/** What a key is for: a gateway, or Anthropic for the review model. */
export type KeyId = ByokProviderId | 'anthropic';

export function isKeyId(v: unknown): v is KeyId {
  return v === 'anthropic' || isProviderId(v);
}

/** API keys, one per provider, so switching providers keeps each key. Stored under `secrets`. */
export interface Secrets { keys?: Partial<Record<KeyId, string>> }

export function keyFor(secrets: Secrets | undefined | null, id: KeyId): string | undefined {
  const k = secrets?.keys?.[id]?.trim();
  return k || undefined;
}

/** A gateway's key: an Anthropic key alone runs no judge. */
export function hasAnyKey(secrets: Secrets | undefined | null): boolean {
  return Object.values(PROVIDERS).some((p) => keyFor(secrets, p.id) !== undefined);
}

/** The review model for a choice: the chosen one, or the provider's default. */
export function reviewModel(c: ByokChoice): string {
  return c.model?.trim() || PROVIDERS[c.id].review.defaultModel;
}

/** Why a choice cannot run yet, or undefined when it can. */
export function choiceProblem(c: ByokChoice, secrets: Secrets | undefined | null): string | undefined {
  return keyFor(secrets, c.id) ? undefined : `add your ${PROVIDERS[c.id].label} API key`;
}
