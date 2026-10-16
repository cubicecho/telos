import { type JsonSchema, literalType, mergeObjects, typesOf } from './json-schema.ts';
import { type AuthOperation, OPEN_BODY_ARG } from './operations.ts';

// JSON Schema in, SDL out. Objects become types (or inputs), named from where
// they were found; what GraphQL cannot say — open records, unions of unlike
// things, untyped values — becomes the JSON scalar rather than a guess.

export interface SdlNames {
  /** Put in front of every type this makes, so `User` does not meet the host's own. */
  typePrefix: string;
  /** The scalar for `format: date-time`. */
  dateTime: string;
  /** The scalar for anything without a GraphQL shape. */
  json: string;
  /** The field an operation is served as. */
  fieldName: (operation: AuthOperation) => string;
}

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** The type references a schema maps to, before `!`. */
interface TypeRef {
  type: string;
  nullable: boolean;
}

export class SdlBuilder {
  /** Object and input types by name, in the order they were made. */
  private readonly types = new Map<string, string>();
  /** Models already being written, so a model that refers to itself terminates. */
  private readonly modelsMade = new Set<string>();

  private readonly names: SdlNames;
  private readonly models: Record<string, JsonSchema>;

  constructor(names: SdlNames, models: Record<string, JsonSchema>) {
    this.names = names;
    this.models = models;
  }

  /** The SDL for these operations: their types, then `extend type Query/Mutation`. */
  build(operations: AuthOperation[]): string {
    const roots: Record<'query' | 'mutation', string[]> = { query: [], mutation: [] };
    for (const operation of operations) roots[operation.kind].push(this.field(operation));

    const blocks = [...this.types.values()];
    if (roots.query.length) blocks.push(`extend type Query {\n${roots.query.join('\n')}\n}`);
    if (roots.mutation.length) blocks.push(`extend type Mutation {\n${roots.mutation.join('\n')}\n}`);
    return `${blocks.join('\n\n')}\n`;
  }

  private field(operation: AuthOperation): string {
    const base = pascal(operation.name);
    const args = Object.entries(operation.args)
      .filter(([name]) => NAME.test(name))
      .map(([name, arg]) => {
        const ref =
          operation.openBody && name === OPEN_BODY_ARG
            ? { type: this.names.json, nullable: true }
            : this.input(arg.schema, `${base}${pascal(name)}Input`);
        return `${describe(arg.schema.description, '    ')}    ${name}: ${ref.type}${arg.required ? '!' : ''}`;
      });
    const result = operation.result
      ? this.output(operation.result, `${base}Result`)
      : { type: this.names.json, nullable: true };
    const signature = args.length ? `(\n${args.join('\n')}\n  )` : '';
    const description = operation.description ?? `better-auth's \`${operation.path}\`.`;
    return `${describe(description, '  ')}  ${this.names.fieldName(operation)}${signature}: ${result.type}${result.nullable ? '' : '!'}`;
  }

  /** The output type for a schema, making object types as it goes. */
  private output(schema: JsonSchema, hint: string): TypeRef {
    if (schema.$ref) return { type: this.model(schema.$ref), nullable: schema.nullable === true };

    const union = schema.anyOf ?? schema.oneOf;
    if (schema.allOf || union) {
      const merged = mergeObjects(schema.allOf ?? union ?? [], !schema.allOf);
      if (merged) return { ...this.output(merged, hint), nullable: true };
      return this.sameScalar(union ?? [], hint) ?? { type: this.names.json, nullable: true };
    }

    const { types, nullable } = typesOf(schema);
    const kind = types.length === 1 ? types[0] : literalType(schema);
    if (kind === 'object' && schema.properties && Object.keys(schema.properties).length) {
      return { type: this.objectType(schema, hint, 'type'), nullable };
    }
    if (kind === 'array') {
      const item = schema.items ? this.output(schema.items, singular(hint)) : { type: this.names.json, nullable: true };
      return { type: `[${item.type}${item.nullable ? '' : '!'}]`, nullable };
    }
    return { type: this.scalar(kind, schema.format), nullable };
  }

  /** The input type for a schema, making input types as it goes. */
  private input(schema: JsonSchema, hint: string): TypeRef {
    const union = schema.anyOf ?? schema.oneOf;
    if (schema.allOf || union) {
      const merged = mergeObjects(schema.allOf ?? union ?? [], !schema.allOf);
      if (merged) return { ...this.input(merged, hint), nullable: true };
      return this.sameScalar(union ?? [], hint) ?? { type: this.names.json, nullable: true };
    }

    const { types, nullable } = typesOf(schema);
    const kind = types.length === 1 ? types[0] : literalType(schema);
    const open = schema.additionalProperties !== undefined && schema.additionalProperties !== false;
    if (kind === 'object' && schema.properties && Object.keys(schema.properties).length && !open) {
      return { type: this.objectType(schema, hint, 'input'), nullable };
    }
    if (kind === 'array') {
      const item = schema.items ? this.input(schema.items, singular(hint)) : { type: this.names.json, nullable: true };
      return { type: `[${item.type}${item.nullable ? '' : '!'}]`, nullable };
    }
    // Dates go in as strings: zod parses them, and a host's DateTime scalar
    // would hand it a Date it does not expect.
    return { type: this.scalar(kind, kind === 'string' ? undefined : schema.format), nullable };
  }

  /** A union of scalars that all map to one GraphQL scalar (`number | null`, two string enums). */
  private sameScalar(members: JsonSchema[], hint: string): TypeRef | undefined {
    const refs = members
      .filter(
        (member) =>
          !(member.type === 'null' || (Array.isArray(member.type) && member.type.every((type) => type === 'null'))),
      )
      .map((member) => this.output(member, hint));
    const kinds = new Set(refs.map((ref) => ref.type));
    if (kinds.size !== 1 || refs[0]?.type.startsWith('[')) return undefined;
    return { type: refs[0]?.type ?? this.names.json, nullable: true };
  }

  private objectType(schema: JsonSchema, hint: string, keyword: 'type' | 'input'): string {
    const name = this.names.typePrefix + hint;
    if (this.types.has(name)) return name;
    // Reserve the name first: a field below may refer back to this type.
    this.types.set(name, '');
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {})
      .filter(([key]) => NAME.test(key))
      .map(([key, property]) => {
        let ref: TypeRef;
        if (keyword === 'input') {
          ref = this.input(property, hint + pascal(key));
        } else {
          const model = this.inlineModel(key, property);
          ref = model
            ? { type: model, nullable: typesOf(property).nullable }
            : this.output(property, hint + pascal(key));
          if (key === 'id' && ref.type === 'String') ref = { ...ref, type: 'ID' };
        }
        // An input field is only required when it has no default; an output
        // field is non-null when the schema promises it.
        const nonNull = required.has(key) && !ref.nullable && (keyword === 'type' || property.default === undefined);
        return `${describe(property.description, '  ')}  ${key}: ${ref.type}${nonNull ? '!' : ''}`;
      });
    this.types.set(name, `${describe(schema.description, '')}${keyword} ${name} {\n${fields.join('\n')}\n}`);
    return name;
  }

  /**
   * Some endpoints document a model inline (`signUpEmail`'s `user`) rather than
   * by reference, and so without the fields the config adds to it. An inline
   * object under a model's name, with an `id` and only that model's fields, is
   * served as the model.
   */
  private inlineModel(key: string, schema: JsonSchema): string | undefined {
    if (schema.$ref || !schema.properties?.id) return undefined;
    const model = Object.keys(this.models).find((name) => name.toLowerCase() === key.toLowerCase());
    const known = model ? this.models[model]?.properties : undefined;
    if (!model || !known || !Object.keys(schema.properties).every((field) => field in known)) return undefined;
    return this.model(`#/components/schemas/${model}`);
  }

  /** The type for a `#/components/schemas/<Model>` reference. */
  private model(ref: string): string {
    const model = ref.split('/').pop() ?? '';
    const schema = this.models[model];
    if (!schema) return this.names.json;
    const name = this.names.typePrefix + model;
    if (!this.modelsMade.has(model)) {
      this.modelsMade.add(model);
      this.objectType(schema, model, 'type');
    }
    return name;
  }

  private scalar(kind: string | undefined, format: string | undefined): string {
    switch (kind) {
      case 'string':
        return format === 'date-time' ? this.names.dateTime : 'String';
      case 'integer':
        return 'Int';
      case 'number':
        return 'Float';
      case 'boolean':
        return 'Boolean';
      default:
        return this.names.json;
    }
  }
}

export function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `ApiKeys` -> `ApiKey`, for an array's items. Good enough for type names. */
function singular(name: string): string {
  return name.endsWith('s') && !name.endsWith('ss') ? name.slice(0, -1) : `${name}Item`;
}

/** A description line. JSON's string escapes are all valid GraphQL ones. */
function describe(text: string | undefined, indent: string): string {
  if (!text) return '';
  return `${indent}${JSON.stringify(text)}\n`;
}
