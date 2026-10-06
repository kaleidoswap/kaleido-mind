/**
 * Map engine ToolDefs to the tool shape `completion({ tools })` accepts.
 *
 * The SDK picks a mode from the FIRST tool: a full `Tool`
 * (`{ type: 'function', name, description, parameters: <flat JSON Schema> }`)
 * or a Zod `ToolInput`. A plain JSON-Schema def without `type: 'function'`
 * falls into the Zod branch, which reads `parameters.shape` and silently drops
 * every argument — the model then sees tool names with no parameters. So
 * JSON-Schema tools (wallet contract, MCP) are normalised to full `Tool`s here.
 * An all-Zod tool list is passed through for the SDK to convert, as before.
 */
import type { ToolDef } from '../types.js';

type PropType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'integer';
const PROP_TYPES = new Set<PropType>(['string', 'number', 'boolean', 'object', 'array', 'integer']);

export interface QvacToolProp {
  type: PropType;
  description?: string;
  enum?: Array<string | number | boolean | null>;
}

export interface QvacTool {
  type: 'function';
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, QvacToolProp>; required?: string[] };
}

type Obj = Record<string, any>;

function isZodLike(p: unknown): boolean {
  const o = p as Obj | null;
  return !!o && typeof o === 'object' && ('shape' in o || '_def' in o || 'def' in o) && !('properties' in o);
}

function pickType(s: Obj): PropType {
  const t = Array.isArray(s.type) ? s.type.find((x: unknown) => x !== 'null') : s.type;
  if (PROP_TYPES.has(t)) return t;
  for (const alt of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) {
    if (alt && typeof alt === 'object' && alt.type !== 'null') return pickType(alt);
  }
  if (Array.isArray(s.enum) && s.enum.length) {
    const first = typeof s.enum[0];
    if (first === 'number' || first === 'boolean') return first;
  }
  return 'string';
}

function jsonProp(s: Obj): QvacToolProp {
  const prop: QvacToolProp = { type: pickType(s ?? {}) };
  if (typeof s?.description === 'string') prop.description = s.description;
  if (Array.isArray(s?.enum)) {
    const values = s.enum.filter((v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
    if (values.length) prop.enum = values;
  }
  return prop;
}

function zodProp(field: Obj): { prop: QvacToolProp; optional: boolean } {
  const kind = field?.type ?? field?.def?.type ?? 'string';
  const optional = kind === 'optional';
  const inner = optional ? field.def?.innerType ?? {} : field;
  const innerKind = inner.type ?? inner.def?.type ?? 'string';
  const prop: QvacToolProp = { type: PROP_TYPES.has(innerKind) ? innerKind : 'string' };
  const description = field.description ?? inner.description;
  if (description) prop.description = description;
  const values = inner.def?.values ?? inner.def?.entries;
  if (Array.isArray(values)) prop.enum = values;
  else if (values && typeof values === 'object') prop.enum = Object.values(values);
  return { prop, optional };
}

function toQvacTool(t: Pick<ToolDef, 'name' | 'description' | 'parameters'>): QvacTool {
  const p = (t.parameters ?? {}) as Obj;
  const properties: Record<string, QvacToolProp> = {};
  const required: string[] = [];
  if (isZodLike(p)) {
    const shape = p.shape ?? p.def?.shape ?? {};
    for (const [key, field] of Object.entries(shape as Obj)) {
      const { prop, optional } = zodProp(field as Obj);
      properties[key] = prop;
      if (!optional) required.push(key);
    }
  } else {
    for (const [key, s] of Object.entries((p.properties ?? {}) as Obj)) properties[key] = jsonProp(s as Obj);
    for (const key of Array.isArray(p.required) ? p.required : []) if (key in properties) required.push(key);
  }
  return {
    type: 'function',
    name: t.name,
    description: t.description ?? '',
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
  };
}

/** Tools for `completion()`; undefined when there are none. */
export function toQvacTools(
  tools: ReadonlyArray<Pick<ToolDef, 'name' | 'description' | 'parameters'>>,
): QvacTool[] | Array<Pick<ToolDef, 'name' | 'description' | 'parameters'>> | undefined {
  if (!tools.length) return undefined;
  if (tools.every((t) => isZodLike(t.parameters))) {
    return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }
  return tools.map(toQvacTool);
}
