type StructuredScalar = string | number | boolean | null;

export type StructuredValue = StructuredScalar | StructuredObject | StructuredValue[];

export interface StructuredObject {
  [key: string]: StructuredValue;
}

function projectObject(value: Record<string, StructuredValue>, fields: string[]): StructuredObject {
  const projected: StructuredObject = {};

  for (const field of fields) {
    projected[field] = value[field] ?? null;
  }

  return projected;
}

export function renderStructuredJson(
  value: object | object[],
  requestedFields: string[],
  supportedFields: Iterable<string>
): { output?: string; error?: string } {
  const supportedFieldSet = new Set(supportedFields);
  const unsupportedFields = requestedFields.filter((field) => !supportedFieldSet.has(field));

  if (unsupportedFields.length > 0) {
    return {
      error: `Unsupported JSON field(s): ${unsupportedFields.join(", ")}`
    };
  }

  const projectedValue = Array.isArray(value)
    ? value.map((entry) => projectObject(entry as Record<string, StructuredValue>, requestedFields))
    : projectObject(value as Record<string, StructuredValue>, requestedFields);

  return {
    output: `${JSON.stringify(projectedValue, null, 2)}\n`
  };
}

function parseJqStep(step: string): { tokens?: string[]; error?: string } {
  if (!step.startsWith(".")) {
    return {
      error: `Unsupported jq expression: ${step}`
    };
  }

  let remainder = step.slice(1);
  const tokens: string[] = [];

  while (remainder.length > 0) {
    if (remainder.startsWith("[]")) {
      tokens.push("[]");
      remainder = remainder.slice(2);

      if (remainder.startsWith(".")) {
        remainder = remainder.slice(1);
      }

      continue;
    }

    const identifierMatch = remainder.match(/^[A-Za-z_][A-Za-z0-9_]*/);

    if (identifierMatch === null) {
      return {
        error: `Unsupported jq expression: .${remainder}`
      };
    }

    const identifier = identifierMatch[0];

    tokens.push(identifier);
    remainder = remainder.slice(identifier.length);

    if (remainder.startsWith(".")) {
      remainder = remainder.slice(1);
    } else if (remainder.length > 0) {
      return {
        error: `Unsupported jq expression: ${step}`
      };
    }
  }

  return { tokens };
}

function serializeJqValue(value: StructuredValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

export function renderStructuredJq(value: StructuredValue, expression: string): { output?: string; error?: string } {
  const normalizedExpression = expression.replace(/\s*\|\s*/g, "|").replace(/\.\[\]\./g, ".[]|.");
  const steps = normalizedExpression.split("|").map((step) => step.trim()).filter((step) => step.length > 0);

  if (steps.length === 0) {
    return {
      error: "Missing value for --jq"
    };
  }

  let sequence: StructuredValue[] = [value];

  for (const step of steps) {
    if (step === ".") {
      continue;
    }

    const parsedStep = parseJqStep(step);

    if (parsedStep.error !== undefined || parsedStep.tokens === undefined) {
      return parsedStep;
    }

    for (const token of parsedStep.tokens) {
      if (token === "[]") {
        const expanded: StructuredValue[] = [];

        for (const entry of sequence) {
          if (Array.isArray(entry)) {
            expanded.push(...entry);
          } else {
            return {
              error: `jq expression expects an array before []: ${expression}`
            };
          }
        }

        sequence = expanded;
        continue;
      }

      sequence = sequence.map((entry) => {
        if (entry === null || Array.isArray(entry) || typeof entry !== "object") {
          return null;
        }

        return entry[token] ?? null;
      });
    }
  }

  if (sequence.length === 0) {
    return {
      output: ""
    };
  }

  return {
    output: `${sequence.map((entry) => serializeJqValue(entry)).join("\n")}\n`
  };
}

function stringifyTemplateValue(value: StructuredValue): string {
  if (value === null) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function renderTemplateBlock(value: StructuredValue, template: string): { output?: string; error?: string } {
  let result = template.replace(/{{\s*"((?:[^"\\]|\\.)*)"\s*}}/g, (_match, literal: string) => JSON.parse(`"${literal}"`));

  result = result.replace(/{{\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*}}/g, (_match, fieldName: string) => {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      return "";
    }

    return stringifyTemplateValue(value[fieldName] ?? null);
  });

  if (/{{[^}]+}}/.test(result)) {
    return {
      error: `Unsupported template action: ${template}`
    };
  }

  return { output: result };
}

export function renderStructuredTemplate(value: StructuredValue, template: string): { output?: string; error?: string } {
  let rangeError: string | undefined;

  const withRangesExpanded = template.replace(/{{\s*range\s+\.\s*}}([\s\S]*?){{\s*end\s*}}/g, (_match, innerTemplate: string) => {
    if (!Array.isArray(value)) {
      rangeError = "Template range requires an array value.";
      return "";
    }

    return value.map((entry) => {
      const renderedEntry = renderTemplateBlock(entry, innerTemplate);

      if (renderedEntry.error !== undefined || renderedEntry.output === undefined) {
        rangeError = renderedEntry.error ?? "Failed to render template range.";
        return "";
      }

      return renderedEntry.output;
    }).join("");
  });

  if (rangeError !== undefined) {
    return {
      error: rangeError
    };
  }

  const renderedTemplate = renderTemplateBlock(value, withRangesExpanded);

  if (renderedTemplate.error !== undefined || renderedTemplate.output === undefined) {
    return renderedTemplate;
  }

  return {
    output: renderedTemplate.output.endsWith("\n") ? renderedTemplate.output : `${renderedTemplate.output}\n`
  };
}