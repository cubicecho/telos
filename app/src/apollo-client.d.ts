// Keeps the rest of the Apollo Client surface available while opting the client
// into the codegen'd data-masking types.
import '@apollo/client';
import type { GraphQLCodegenDataMasking } from '@apollo/client/masking';

declare module '@apollo/client' {
  interface TypeOverrides extends GraphQLCodegenDataMasking.TypeOverrides {}
}
