// The slice of JSON Schema that better-auth's endpoints describe themselves
// with: zod 4's `toJSONSchema()` for what they take, and the OpenAPI metadata
// each endpoint carries for what they return.

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  format?: string;
  description?: string;
  default?: unknown;
  nullable?: boolean;
}

/** The types a schema names, without `null`, and whether `null` was one of them. */
export function typesOf(schema: JsonSchema): { types: JsonSchemaType[]; nullable: boolean } {
  const all = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const types = all.filter((type) => type !== 'null');
  return { types, nullable: schema.nullable === true || types.length < all.length };
}

/** The type of a `const` or of every `enum` member, when they share one. */
export function literalType(schema: JsonSchema): JsonSchemaType | undefined {
  const values = schema.const !== undefined ? [schema.const] : schema.enum;
  if (!values?.length) return undefined;
  const kinds = new Set(values.map((value) => (value === null ? 'null' : typeof value)));
  kinds.delete('null');
  if (kinds.size !== 1) return undefined;
  const [kind] = kinds;
  return kind === 'string' || kind === 'number' || kind === 'boolean' ? kind : undefined;
}

/**
 * Folds `allOf` members, and the object members of an `anyOf`/`oneOf`, into one
 * object schema. An `allOf` keeps every member's required keys; a union keeps
 * none, since any one member may be what arrives.
 *
 * @returns The merged object, or undefined when the members are not all objects.
 */
export function mergeObjects(members: JsonSchema[], union: boolean): JsonSchema | undefined {
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  let open = false;
  for (const member of members) {
    const { types } = typesOf(member);
    if (member.allOf) {
      const inner = mergeObjects(member.allOf, false);
      if (!inner) return undefined;
      Object.assign(properties, inner.properties);
      for (const key of inner.required ?? []) required.add(key);
      open ||= inner.additionalProperties !== undefined && inner.additionalProperties !== false;
      continue;
    }
    if (types.length > 0 && !types.includes('object')) return undefined;
    for (const [key, value] of Object.entries(member.properties ?? {})) properties[key] ??= value;
    if (!union) for (const key of member.required ?? []) required.add(key);
    open ||= member.additionalProperties !== undefined && member.additionalProperties !== false;
  }
  return {
    type: 'object',
    properties,
    required: [...required],
    ...(open ? { additionalProperties: true } : {}),
  };
}
