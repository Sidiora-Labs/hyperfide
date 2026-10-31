import { defineConfig } from 'vitest/config';
export default defineConfig({resolve: {conditions: ['source'], alias: {'@hyperfide/plugin-sdk/testing': new URL('../../sdk/plugins/src/testing/index.ts', import.meta.url).pathname}}, test: {server: {deps: {inline: ['@hyperfide/plugin-sdk']}}, include: ['*.test.ts'], testTimeout: 30000}});
