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
        // A table's type resolves from its row (db/src/models), not the full
        // object: drizzle-graphql resolves its relations, so a resolver
        // returning one, or reading one as its parent, has the row.
        mappers: {
          User: '@telos/db/schema#User',
          Agent: '@telos/db/schema#Agent',
          ProjectLabel: '@telos/db/schema#ProjectLabel',
          TodoEvent: '@telos/db/schema#TodoEvent',
          TodoDependency: '@telos/db/schema#TodoDependency',
          Run: '@telos/db/schema#Run',
          TodoLabel: '@telos/db/schema#TodoLabel',
          Lane: '@telos/db/schema#Lane',
          McpServer: '@telos/db/schema#McpServer',
          Project: '@telos/db/schema#Project',
          BoardTemplate: '@telos/db/schema#BoardTemplate',
          Todo: '@telos/db/schema#Todo',
          Artifact: '@telos/db/schema#Artifact',
          Label: '@telos/db/schema#Label',
          TodoNote: '@telos/db/schema#TodoNote',
        },
        mapperTypeSuffix: 'Row',
        // Resolvers see an enum's server value (`handedBack`), not its wire
        // name (`HANDED_BACK`): src/enums.ts translates between the two.
        enumValues: {
          WorkState: '../src/enums.ts#WorkState',
          HandBack: '../src/enums.ts#HandBack',
          McpProbeStatus: '../src/enums.ts#McpProbeStatus',
          McpSecretKind: '../src/enums.ts#McpSecretKind',
          ChangeEntity: '../src/enums.ts#ChangeEntity',
          RunOutcome: '../src/enums.ts#RunOutcome',
          RunEventKind: '../src/enums.ts#RunEventKind',
          SsoSource: '../src/enums.ts#SsoSource',
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
