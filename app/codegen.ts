import type { CodegenConfig } from '@graphql-codegen/cli';

// Reads the SDL the server prints from its own Drizzle-derived schema, so the
// typed documents here cannot drift from what the API actually serves.
const config: CodegenConfig = {
  schema: '../server/__generated__/schema.graphql',
  importExtension: '.ts',
  documents: ['./src/**/*.ts', './src/**/*.tsx', './app/**/*.ts', './app/**/*.tsx'],
  ignoreNoDocuments: true,
  generates: {
    'src/__generated__/': {
      preset: 'client',
      presetConfig: {
        fragmentMasking: false,
      },
      config: {
        avoidOptionals: {
          // Use `null` for nullable fields instead of optionals
          field: true,
        },
        useTypeImports: true,
        defaultScalarType: 'unknown',
        skipTypeNameForRoot: true,
        scalars: {
          // Timestamps cross the wire as ISO strings; nothing here needs a Date
          // object, and parsing them into one would only invite timezone bugs.
          DateTime: 'string',
          UUID: 'string',
        },
      },
    },
  },
};

export default config;
