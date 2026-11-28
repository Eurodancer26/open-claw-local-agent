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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Оставлено на уровне warn на момент внедрения линтера: существующий код
      // осознанно использует эти приёмы (escape-символы в regex, sanitize с
      // control-regex, throw в finally для проброса abort). Понижено до warn,
      // чтобы не менять поведение приложения молча. TODO: разобрать и включить.
      'no-useless-assignment': 'warn',
      'no-unsafe-finally': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
      'preserve-caught-error': 'warn'
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
