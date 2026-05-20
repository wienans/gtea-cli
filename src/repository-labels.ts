import { type StructuredObject } from "./structured-output.js";

export interface GiteaRepositoryLabelPayload {
  color?: string | null;
  description?: string | null;
  id?: number;
  name?: string | null;
  url?: string | null;
}

export interface RepositoryLabelRecord extends StructuredObject {
  color: string | null;
  description: string | null;
  id: number | null;
  name: string | null;
  url: string | null;
}

export function mapRepositoryLabelRecord(
  payload: GiteaRepositoryLabelPayload | null | undefined
): RepositoryLabelRecord | null {
  if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  return {
    color: typeof payload.color === "string" && payload.color.length > 0 ? payload.color : null,
    description: typeof payload.description === "string" && payload.description.length > 0 ? payload.description : null,
    id: typeof payload.id === "number" ? payload.id : null,
    name: typeof payload.name === "string" && payload.name.length > 0 ? payload.name : null,
    url: typeof payload.url === "string" && payload.url.length > 0 ? payload.url : null
  };
}

export function buildRepositoryLabelIdLookup(
  labels: Array<GiteaRepositoryLabelPayload | null | undefined>
): Map<string, number> {
  return new Map(
    labels
      .filter(
        (label): label is GiteaRepositoryLabelPayload & { id: number; name: string } =>
          typeof label?.name === "string" && label.name.length > 0 && typeof label.id === "number"
      )
      .map((label) => [label.name, label.id])
  );
}