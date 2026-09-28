/** A deliberately small JSON Schema validator: the subset the tool schemas use. */
export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number)[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
}

export function validate(schema: JsonSchema, value: unknown, path = 'input'): string[] {
  const errs: string[] = [];
  const t = schema.type;
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (t === 'integer' ? !Number.isInteger(value) : t && t !== actual) {
    return [`${path} must be ${t}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.includes(value as string)) errs.push(`${path} must be one of: ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path} must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path} must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path} must match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items!, v, `${path}[${i}]`)));
  if (t === 'object' && value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (obj[k] === undefined) errs.push(`${path}.${k} is required`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k} is not an allowed field`);
    }
  }
  return errs;
}
