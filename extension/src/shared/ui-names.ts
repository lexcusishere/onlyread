// The name recorded for a UI action ("click on 'Send'"), which reaches the audit log and the AI judge.
// It comes from what the page labels an element, never from what the user typed into it (R5).

const NAME_MAX = 80;
const SENSITIVE_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-.*)$/;
/** Inputs whose value is their visible caption, not typed data. */
const CAPTION_TYPES = new Set(['submit', 'button', 'reset']);

interface FieldLike {
  kind: 'input' | 'textarea' | 'select' | 'editable';
  type?: string;
  autocomplete?: string;
  value?: string;
  placeholder?: string;
  name?: string;
  /** Text of the associated <label>. */
  label?: string;
}

const clean = (s: string | undefined): string | undefined => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, NAME_MAX) : undefined;
};

/** How long a value typed into a sensitive field is held, anywhere: in the page before reporting starts
 *  (content/actions.ts) and in the background (background/typed-secrets.ts). */
export const TYPED_SECRET_TTL_MS = 10 * 60_000;

/** A password, one-time-code or payment-card field: nothing about its content is ever recorded. */
export function isSensitiveField(type: string | undefined, autocomplete: string | undefined): boolean {
  if ((type ?? '').toLowerCase() === 'password') return true;
  return (autocomplete ?? '').toLowerCase().split(/\s+/).some((t) => SENSITIVE_AUTOCOMPLETE.test(t));
}

/** Label → placeholder → field name. A value only for button-like inputs, whose value is the caption. */
export function fieldName(f: FieldLike): string | undefined {
  const label = clean(f.label);
  if (label) return label;
  if (f.kind === 'input' && CAPTION_TYPES.has((f.type ?? '').toLowerCase()) && !isSensitiveField(f.type, f.autocomplete)) {
    const caption = clean(f.value);
    if (caption) return caption;
  }
  return clean(f.placeholder) ?? clean(f.name);
}
