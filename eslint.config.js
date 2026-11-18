import tseslint from 'typescript-eslint';

const simImportBan = [{ name: 'three', message: 'src/sim must not import three.' }];
const simGlobals = [
  'window',
  'document',
  'navigator',
  'performance',
  'requestAnimationFrame',
  'setTimeout',
  'setInterval',
  'Date',
].map((name) => ({ name, message: `${name} is forbidden in src/sim (pure deterministic code).` }));

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'test-results', 'playwright-report', 'docs', '.claude'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: simImportBan,
          patterns: [
            { group: ['three/*'], message: 'src/sim must not import three.' },
            {
              group: [
                '**/render',
                '**/render/**',
                '**/input',
                '**/input/**',
                '**/ui',
                '**/ui/**',
                '**/app',
                '**/app/**',
                '**/dev',
                '**/dev/**',
              ],
              message: 'src/sim must not import render/input/ui/app/dev.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...simGlobals],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded RNG in state.' },
        { object: 'Date', property: 'now', message: 'No wall clock in src/sim.' },
      ],
    },
  },
);
