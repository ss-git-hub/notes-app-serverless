/**
 * shared/validate.ts
 *
 * Zod validation schemas for all Lambda request bodies,
 * plus the parseBody() helper that safely parses and validates
 * an API Gateway event body in one step.
 *
 * Why Zod instead of manual if (!field) checks?
 *   Before Zod, each Lambda had manual checks like:
 *     if (!email || !password) return badRequest('...')
 *   The problem: this only catches missing fields. It does NOT catch:
 *     — wrong types  (a number where a string is expected)
 *     — invalid formats (e.g. "notanemail" passed as email)
 *     — length violations (a 2-character password slipping through)
 *     — malformed JSON in the request body (causes an unhandled throw)
 *   Zod validates ALL of these and returns a structured list of exactly
 *   what failed and why — far cleaner than a chain of if statements.
 *
 * How Zod works:
 *   schema.safeParse(data) — tries to validate data against the schema.
 *   Unlike schema.parse() which throws on failure, safeParse() always
 *   returns a result object:
 *     { success: true,  data: ValidatedData }   ← validation passed
 *     { success: false, error: ZodError }        ← validation failed
 *   We use safeParse() in Lambdas because a throw inside a handler
 *   returns an unhelpful 500. safeParse() lets us return a proper 400.
 *
 * parseBody() helper:
 *   event.body in API Gateway is a raw JSON string — or null if no body.
 *   JSON.parse(null) throws. JSON.parse("bad json{") also throws.
 *   parseBody() wraps this safely and returns a 400 badRequest if
 *   the JSON is malformed — before Zod even runs.
 *   In Express, express.json() handles this automatically. Here we do
 *   it manually in one central place so every Lambda benefits.
 *
 * Usage in a Lambda:
 *   const parsed = parseBody(event.body, registerSchema);
 *   if (!parsed.success) return parsed.error; // ready-to-return 400
 *   const { email, password, name } = parsed.data; // fully typed ✓
 */

import { z } from 'zod';
import { APIGatewayProxyResult } from 'aws-lambda';
import { badRequest } from './response';

// ── Result type ───────────────────────────────────────────────────────────────

/**
 * ParseResult<T> — the return type of parseBody().
 *
 * This is a discriminated union — a TypeScript pattern where the
 * 'success' boolean tells TypeScript which shape the object has.
 *
 *   if (parsed.success) {
 *     parsed.data  // ← TypeScript knows this exists and has type T
 *   } else {
 *     parsed.error // ← TypeScript knows this is APIGatewayProxyResult
 *   }
 *
 * The generic T is inferred automatically from the schema you pass —
 * so TypeScript knows the exact shape of parsed.data for each endpoint.
 */
type ParseResult<T> =
  | { success: true;  data: T }
  | { success: false; error: APIGatewayProxyResult };

// ── parseBody helper ──────────────────────────────────────────────────────────

/**
 * parseBody — safely parses and validates a Lambda event body.
 *
 * Two things can go wrong before your business logic even runs:
 *   1. The body is null or malformed JSON → JSON.parse throws
 *   2. The JSON parses fine but fields are wrong type/missing → Zod fails
 *
 * This function handles both in one place and always returns either:
 *   { success: true,  data }  — validated, fully typed, safe to use
 *   { success: false, error } — a ready-to-return 400 badRequest response
 *
 * Express equivalent:
 *   express.json() handles case 1, a validation middleware handles case 2.
 *   Here we handle both in one function call.
 */
export function parseBody<T>(
  body: string | null,
  schema: z.ZodSchema<T>
): ParseResult<T> {

  // ── Step 1: Parse JSON ─────────────────────────────────────────
  // event.body is a raw string. If the client sends malformed JSON
  // (e.g. a missing bracket or unquoted key), JSON.parse throws.
  // We catch that here and return a 400 instead of letting it bubble
  // up to the Lambda's generic catch block and return a confusing 500.
  // Defaulting to '{}' handles the null body case (e.g. GET requests).
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? '{}');
  } catch {
    return {
      success: false,
      error: badRequest('Request body must be valid JSON')
    };
  }

  // ── Step 2: Validate with Zod ──────────────────────────────────
  // safeParse() never throws — it returns { success, data } or { success, error }.
  // error.issues is an array of every validation failure, each containing:
  //   path    — which field failed, e.g. ['email']
  //   message — why it failed,  e.g. 'Invalid email'
  // We join ALL failures into one string so the client sees every
  // problem at once rather than fixing them one at a time.
  const result = schema.safeParse(raw);

  if (!result.success) {
    // Example output: "email: Invalid email; password: String must contain at least 8 character(s)"
    const message = result.error.issues
      .map(i => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    return { success: false, error: badRequest(message) };
  }

  return { success: true, data: result.data };
}

// ── Schemas ───────────────────────────────────────────────────────────────────
// Each schema mirrors the validation rules in the frontend's Zod schemas
// (src/pages/LoginPage.tsx, CreateNotePage.tsx, etc.) so validation
// rules are consistent on both sides — client and server.

/**
 * registerSchema — validates POST /users/register body.
 *
 * email:    must be a valid email format — Zod checks the structure
 * password: minimum 8 characters — matches the frontend rule exactly
 * name:     at least 1 character — .trim() removes surrounding whitespace
 *           before validation so "  " does not pass as a name
 */
export const registerSchema = z.object({
  email:    z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name:     z.string().min(1, 'Name is required').trim()
});

/**
 * loginSchema — validates POST /users/login body.
 *
 * Deliberately no format/length restrictions on password here —
 * we just check it's present. bcrypt.compare() will handle
 * wrong passwords. We don't want to hint which specific rule failed.
 */
export const loginSchema = z.object({
  email:    z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required')
});

/**
 * updateProfileSchema — validates PUT /users/profile body.
 *
 * All fields are optional individually — but at least one must exist.
 * .refine() enforces cross-field rules that cannot be expressed with
 * per-field validators alone — "at least one of these" is exactly that.
 *
 * currentPassword + newPassword dependency is validated in the
 * handler itself (not here) because it also requires a DB lookup.
 */
export const updateProfileSchema = z.object({
  name:            z.string().min(1, 'Name cannot be empty').trim().optional(),
  currentPassword: z.string().min(1).optional(),
  newPassword:     z.string().min(8, 'New password must be at least 8 characters').optional()
}).refine(
  // At least one of name or newPassword must be provided
  data => data.name !== undefined || data.newPassword !== undefined,
  { message: 'Provide at least a name or newPassword to update' }
);

/**
 * createNoteSchema — validates POST /notes body.
 *
 * tags is optional — a note can be created without any tags.
 * Individual tag strings are capped at 50 chars to prevent abuse.
 * Max 10 tags per note — matches the frontend enforcement.
 *
 * The max lengths here mirror the frontend Zod schemas in
 * CreateNotePage.tsx so the same rules apply on both sides.
 */
export const createNoteSchema = z.object({
  title:   z.string().min(1, 'Title is required').max(100, 'Title must be under 100 characters').trim(),
  content: z.string().min(1, 'Content is required').max(10000, 'Content must be under 10,000 characters'),
  tags:    z.array(z.string().max(50)).max(10, 'Maximum 10 tags allowed').optional()
});

/**
 * updateNoteSchema — validates PUT /notes/{id} body.
 *
 * All fields are optional — a caller may update just the title,
 * just the content, just the tags, or any combination.
 * .refine() ensures the request is not completely empty (no-op).
 */
export const updateNoteSchema = z.object({
  title:   z.string().min(1).max(100).trim().optional(),
  content: z.string().min(1).max(10000).optional(),
  tags:    z.array(z.string().max(50)).max(10).optional()
}).refine(
  data => data.title !== undefined || data.content !== undefined || data.tags !== undefined,
  { message: 'Provide at least a title, content, or tags to update' }
);

/**
 * refreshTokenSchema — validates POST /users/refresh body.
 *
 * The refresh token is a random UUID stored in DynamoDB.
 * We just check it is a non-empty string here — the DynamoDB
 * lookup in the handler will confirm whether it is actually valid.
 */
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required')
});
