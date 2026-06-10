import { defineConfig } from 'vitest/config';

// Unit tests for the trading-card realm's DOM-free core (cards-core.ts).
// Plain node environment: the core (and its state.ts/config.ts imports)
// never touches the DOM, and the one module-level localStorage read in
// options.ts is already guarded by a try/catch.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
