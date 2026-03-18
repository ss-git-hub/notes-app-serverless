/**
 * jest.config.js
 *
 * Jest configuration for running unit tests with TypeScript.
 *
 * preset: 'ts-jest'
 *   ts-jest is a Jest transformer that compiles TypeScript on the fly
 *   so you can write tests in .ts files without a separate build step.
 *   It uses the project's tsconfig.json automatically.
 *
 * testEnvironment: 'node'
 *   Lambda functions run in Node.js — use the Node environment for tests,
 *   not jsdom (which is for browser-based code).
 *
 * roots: ['<rootDir>/tests']
 *   Only look for test files inside the tests/ directory.
 *   This prevents Jest from accidentally picking up Lambda handler files.
 *
 * testMatch: ['**\/*.test.ts']
 *   Any file ending in .test.ts inside the roots is a test file.
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Clear mocks automatically between each test — prevents state leaking
  // from one test into another. Equivalent to calling jest.clearAllMocks()
  // in a beforeEach without having to write it manually.
  clearMocks: true,
  // Global setup file — runs before every test file
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts']
};
