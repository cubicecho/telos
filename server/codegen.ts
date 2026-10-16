import type { CodegenConfig } from '@graphql-codegen/cli';

// The SDL this reads is written by src/write_schema.ts, which builds the schema
// from the Drizzle tables — so `npm run codegen` regenerates both halves and the
// resolver types can never drift from the schema the server actually serves.
const config: CodegenConfig = {
  schema: './__generated__/schema.graphql',
  importExtension: '.ts',
  generates: {
    './__generated__/resolvers.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
      config: {
        inputMaybeValue: 'T | null | undefined',
        contextType: '../src/context.ts#Context',
        useTypeImports: true,
        scalars: {
          UUID: 'string',
          DateTime: 'Date',
          JSON: 'unknown',
        },
        // Resolvers see an enum's server value (`handedBack`), not its wire
        // name (`HANDED_BACK`): src/enums.ts translates between the two.
        enumValues: {
          WorkState: '../src/enums.ts#WorkState',
          HandBack: '../src/enums.ts#HandBack',
          McpProbeStatus: '../src/enums.ts#McpProbeStatus',
          McpSecretKind: '../src/enums.ts#McpSecretKind',
          ChangeEntity: '../src/enums.ts#ChangeEntity',
          RunOutcome: '../src/enums.ts#RunOutcome',
        },
        avoidOptionals: {
          // Use `null` for nullable fields instead of optionals
          field: true,
          // Allow nullable input fields to remain unspecified
          inputValue: false,
        },
      },
    },
  },
};

export default config;
