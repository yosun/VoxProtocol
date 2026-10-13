export interface VideoOptions {
  descriptionField: "concept" | "prompt" | "generation_description";
  minDescriptionLength: number;
  maxDescriptionLength: number;
  durations: number[];
  resolutions: string[];
  supportsStyle: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only controls understood by checkout are supported; never invent provider inputs. */
export function videoOptions(schema: Record<string, unknown>, capabilityMax?: number): VideoOptions {
  const properties = object(schema.properties);
  const descriptionField = (["concept", "prompt", "generation_description"] as const).find((key) => object(properties[key]).type === "string");
  if (schema.type !== "object" || !descriptionField) throw new Error("This creator does not advertise a supported video description field.");
  const description = object(properties[descriptionField]);
  const duration = object(properties.duration_seconds);
  const minimum = typeof duration.minimum === "number" && Number.isFinite(duration.minimum) ? Math.max(1, Math.ceil(duration.minimum)) : 1;
  const maximum = Math.min(typeof duration.maximum === "number" && Number.isFinite(duration.maximum) ? Math.floor(duration.maximum) : 60, capabilityMax ?? 60, 60);
  const durationEnum = Array.isArray(duration.enum) ? duration.enum.filter((value): value is number => Number.isInteger(value) && typeof value === "number") : undefined;
  const durations = (durationEnum ?? Array.from({length: Math.max(0, maximum - minimum + 1)}, (_, index) => minimum + index)).filter((value) => value >= minimum && value <= maximum);
  if (!durations.length) throw new Error("This creator has no supported video durations.");
  const resolution = object(properties.resolution);
  const resolutions = Array.isArray(resolution.enum) ? resolution.enum.filter((value): value is string => typeof value === "string" && value.length <= 32) : [];
  const supported = new Set([descriptionField, "duration_seconds", "resolution", "style"]);
  if (Array.isArray(schema.required) && schema.required.some((key) => typeof key === "string" && !supported.has(key))) throw new Error("This creator requires generation controls that this checkout does not support yet.");
  return {
    descriptionField,
    minDescriptionLength: typeof description.minLength === "number" ? Math.max(1, description.minLength) : 1,
    maxDescriptionLength: typeof description.maxLength === "number" ? Math.min(2_000, description.maxLength) : 2_000,
    durations,
    resolutions,
    supportsStyle: object(properties.style).type === "string"
  };
}

export function generationDescription(parameters: Record<string, unknown>): string {
  return String(parameters.concept ?? parameters.prompt ?? parameters.generation_description ?? "");
}
