// eslint.config.js
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'reports/**',
      'mind/**',
      'models/**',
      'tests/sandbox/**',
      'tests/free_mode/**',
      'repomix-output.xml',
      'full-project-dump.xml',
      '*.log'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Плейсхолдеры (`_` или `_name`) допустимы: так помечают намеренно
      // неиспользуемые аргументы/binding'и (например, `catch (_)`).
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // Правила ниже разобраны после внедрения линтера (блок 5, follow-up).
      // В редких намеренных местах стоит точечный eslint-disable-next-line с
      // пояснением; глобальных понижений больше нет.
      'no-useless-assignment': 'error',
      'no-unsafe-finally': 'error',
      'no-useless-escape': 'error',
      'no-control-regex': 'error',
      'preserve-caught-error': 'error'
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser }
    }
  }
];
