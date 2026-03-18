/**
 * shared/response.ts
 *
 * HTTP response helpers for Lambda functions.
 *
 * In Express you send responses like this:
 *   res.status(200).json({ notes })
 *   res.status(404).json({ error: 'Not found' })
 *
 * In Lambda there is no res object. Instead you return a plain object
 * with a specific shape that API Gateway understands:
 *   return { statusCode: 200, headers: {...}, body: JSON.stringify({ notes }) }
 *
 * This file creates helper functions that replicate the Express res API
 * so your Lambda code stays clean and readable.
 *
 * Usage in a Lambda:
 *   return ok({ notes });
 *   return notFound('Note not found');
 *   return serverError('Something went wrong');
 */

import { APIGatewayProxyResult } from 'aws-lambda';

/**
 * CORS headers are required on every response so the browser
 * allows your React frontend (running on a different domain) to
 * receive the response.
 *
 * Without these headers the browser blocks the response even if
 * the Lambda executed successfully — this is a browser security rule
 * called the Same-Origin Policy.
 *
 * Access-Control-Allow-Origin: '*'
 *   Allows requests from any domain. Fine for learning.
 *   In production you would restrict this to your frontend domain:
 *   'https://your-app.com'
 *
 * Access-Control-Allow-Credentials: 'true'
 *   Allows the browser to include cookies and auth headers
 *   in cross-origin requests.
 */
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true'
};

/**
 * Base response builder.
 * All helper functions below call this internally.
 *
 * APIGatewayProxyResult is the TypeScript type that describes the
 * exact shape API Gateway expects as a return value from Lambda.
 */
export const response = (
  statusCode: number,
  body: Record<string, unknown>
): APIGatewayProxyResult => ({
  statusCode,
  headers,
  body: JSON.stringify(body) // API Gateway requires body to be a string
});

// ── Convenience helpers ───────────────────────────────────────────────────────
// These mirror the most common Express response patterns.
// Use these in your Lambda handlers instead of calling response() directly.

/** 200 — request succeeded, returning data */
export const ok = (body: Record<string, unknown>) =>
  response(200, body);

/** 201 — resource was successfully created */
export const created = (body: Record<string, unknown>) =>
  response(201, body);

/** 400 — client sent invalid data (missing fields, wrong format etc.) */
export const badRequest = (message: string) =>
  response(400, { error: message });

/** 401 — not authenticated (missing or invalid JWT token) */
export const unauthorized = (message: string) =>
  response(401, { error: message });

/** 404 — the requested resource does not exist */
export const notFound = (message: string) =>
  response(404, { error: message });

/** 409 — conflict (e.g. email already registered) */
export const conflict = (message: string) =>
  response(409, { error: message });

/** 500 — something unexpected went wrong on the server */
export const serverError = (message: string) =>
  response(500, { error: message });