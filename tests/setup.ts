/**
 * tests/setup.ts
 *
 * Global Jest setup — runs once before every test file.
 *
 * Suppresses console.error output during tests. Lambda handlers
 * intentionally call console.error in their catch blocks (for CloudWatch
 * logging in production), which produces noisy output when tests exercise
 * error paths. The handlers still behave correctly — this only silences
 * the terminal output during test runs.
 */

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});
