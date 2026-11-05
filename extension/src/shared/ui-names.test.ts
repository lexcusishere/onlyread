import { describe, expect, it } from 'vitest';
import { fieldName, isSensitiveField } from './ui-names';

describe('fieldName', () => {
  const SECRET = 'SYNTHETIC_REVIEW_SECRET';
  it('never uses what was typed into a text field, text area or editable area', () => {
    expect(fieldName({ kind: 'input', type: 'text', value: SECRET, placeholder: 'Search' })).toBe('Search');
    expect(fieldName({ kind: 'input', type: 'text', value: SECRET, name: 'q' })).toBe('q');
    expect(fieldName({ kind: 'input', type: 'text', value: SECRET })).toBeUndefined();
    expect(fieldName({ kind: 'textarea', value: SECRET, label: 'Message' })).toBe('Message');
    expect(fieldName({ kind: 'editable', value: SECRET })).toBeUndefined();
  });
  it('never names a password or one-time-code field by its value, whatever else it has', () => {
    expect(fieldName({ kind: 'input', type: 'password', value: SECRET })).toBeUndefined();
    expect(fieldName({ kind: 'input', type: 'password', value: SECRET, label: 'Password' })).toBe('Password');
    expect(fieldName({ kind: 'input', type: 'text', autocomplete: 'one-time-code', value: SECRET, name: 'otp' })).toBe('otp');
  });
  it('keeps a submit input’s caption, which is its visible label', () => {
    expect(fieldName({ kind: 'input', type: 'submit', value: 'Send' })).toBe('Send');
    expect(fieldName({ kind: 'input', type: 'button', value: 'Save' })).toBe('Save');
  });
  it('prefers the label, trims and shortens', () => {
    expect(fieldName({ kind: 'input', type: 'email', label: '  Work   email ', placeholder: 'x' })).toBe('Work email');
    expect(fieldName({ kind: 'input', type: 'text', label: 'a'.repeat(200) })?.length).toBe(80);
  });
});

describe('isSensitiveField', () => {
  it('flags password, one-time-code and card fields', () => {
    expect(isSensitiveField('password', undefined)).toBe(true);
    expect(isSensitiveField('text', 'one-time-code')).toBe(true);
    expect(isSensitiveField('text', 'cc-number')).toBe(true);
    expect(isSensitiveField('text', 'current-password')).toBe(true);
    expect(isSensitiveField('text', 'username')).toBe(false);
    expect(isSensitiveField(undefined, undefined)).toBe(false);
  });
});
