/**
 * tests/shared/validate.test.ts
 *
 * Unit tests for the parseBody() helper and Zod schemas in shared/validate.ts.
 *
 * Testing strategy:
 *   These tests have no DynamoDB dependency — they only test pure input parsing.
 *   Fast, isolated, no mocks needed.
 *
 * What we test:
 *   — Malformed JSON is rejected with a 400 before Zod runs
 *   — Valid input passes and returns typed data
 *   — Missing required fields produce a 400 with a descriptive message
 *   — Format violations (bad email, short password) produce a 400
 *   — Cross-field .refine() rules (at least one field) work correctly
 */

import { parseBody, registerSchema, loginSchema, createNoteSchema, updateNoteSchema } from '../../shared/validate';

// ── parseBody — JSON parsing ───────────────────────────────────────────────────

describe('parseBody — JSON parsing', () => {

  it('returns badRequest 400 for malformed JSON', () => {
    // Arrange — a string that is not valid JSON
    const result = parseBody('{bad json', registerSchema);

    // Assert — parsing failed and the error is a 400 response
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.statusCode).toBe(400);
      expect(JSON.parse(result.error.body).error).toMatch(/valid JSON/i);
    }
  });

  it('treats null body as empty object (no crash)', () => {
    // Arrange — null body simulates a request with no body at all
    // Zod will then fail validation (missing required fields), not JSON.parse
    const result = parseBody(null, loginSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      // Should be a Zod validation error, not a JSON parse error
      expect(result.error.statusCode).toBe(400);
    }
  });

});

// ── registerSchema ────────────────────────────────────────────────────────────

describe('registerSchema', () => {

  it('accepts valid registration data', () => {
    const result = parseBody(
      JSON.stringify({ email: 'user@example.com', password: 'secret123', name: 'Alice' }),
      registerSchema
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('user@example.com');
      expect(result.data.name).toBe('Alice');
    }
  });

  it('rejects invalid email format', () => {
    const result = parseBody(
      JSON.stringify({ email: 'notanemail', password: 'secret123', name: 'Alice' }),
      registerSchema
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.statusCode).toBe(400);
      expect(JSON.parse(result.error.body).error).toMatch(/email/i);
    }
  });

  it('rejects password shorter than 8 characters', () => {
    const result = parseBody(
      JSON.stringify({ email: 'user@example.com', password: 'short', name: 'Alice' }),
      registerSchema
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.parse(result.error.body).error).toMatch(/8 characters/i);
    }
  });

  it('rejects missing name', () => {
    const result = parseBody(
      JSON.stringify({ email: 'user@example.com', password: 'secret123' }),
      registerSchema
    );

    expect(result.success).toBe(false);
  });

  it('trims whitespace from name', () => {
    // Zod .trim() should strip surrounding spaces from the name
    const result = parseBody(
      JSON.stringify({ email: 'user@example.com', password: 'secret123', name: '  Alice  ' }),
      registerSchema
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Alice');
    }
  });

});

// ── loginSchema ───────────────────────────────────────────────────────────────

describe('loginSchema', () => {

  it('accepts valid login data', () => {
    const result = parseBody(
      JSON.stringify({ email: 'user@example.com', password: 'anypassword' }),
      loginSchema
    );

    expect(result.success).toBe(true);
  });

  it('rejects missing password', () => {
    const result = parseBody(
      JSON.stringify({ email: 'user@example.com' }),
      loginSchema
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.statusCode).toBe(400);
    }
  });

});

// ── createNoteSchema ──────────────────────────────────────────────────────────

describe('createNoteSchema', () => {

  it('accepts note with all fields', () => {
    const result = parseBody(
      JSON.stringify({ title: 'My Note', content: 'Some content', tags: ['aws', 'learning'] }),
      createNoteSchema
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(['aws', 'learning']);
    }
  });

  it('accepts note without tags (tags is optional)', () => {
    const result = parseBody(
      JSON.stringify({ title: 'My Note', content: 'Some content' }),
      createNoteSchema
    );

    expect(result.success).toBe(true);
  });

  it('rejects title longer than 100 characters', () => {
    const result = parseBody(
      JSON.stringify({ title: 'a'.repeat(101), content: 'Some content' }),
      createNoteSchema
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.parse(result.error.body).error).toMatch(/100/);
    }
  });

  it('rejects more than 10 tags', () => {
    const result = parseBody(
      JSON.stringify({ title: 'Title', content: 'Content', tags: Array(11).fill('tag') }),
      createNoteSchema
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.parse(result.error.body).error).toMatch(/10 tags/i);
    }
  });

});

// ── updateNoteSchema — cross-field refine ─────────────────────────────────────

describe('updateNoteSchema — .refine() rule', () => {

  it('rejects empty body (no fields provided)', () => {
    // The .refine() rule requires at least one field
    const result = parseBody(JSON.stringify({}), updateNoteSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.parse(result.error.body).error).toMatch(/at least/i);
    }
  });

  it('accepts update with only title', () => {
    const result = parseBody(JSON.stringify({ title: 'New title' }), updateNoteSchema);
    expect(result.success).toBe(true);
  });

  it('accepts update with only tags', () => {
    const result = parseBody(JSON.stringify({ tags: ['new-tag'] }), updateNoteSchema);
    expect(result.success).toBe(true);
  });

});
