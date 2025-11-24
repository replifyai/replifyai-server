import { encode as encodeToon } from "@toon-format/toon";

function formatLabel(label?: string): string {
  return label ? ` for ${label}` : "";
}

export function encodeMetadataToToon(metadata: unknown, label?: string): string {
  if (!metadata) {
    console.log(`[Toon] Skipping encoding${formatLabel(label)}: no metadata provided.`);
    return "";
  }

  try {
    const encoded = encodeToon(metadata);
    console.log(`[Toon] Metadata encoded${formatLabel(label)}.`);
    return encoded;
  } catch (error) {
    console.warn(
      `[Toon] Failed to encode metadata${formatLabel(label)}, falling back to JSON.`,
      error
    );
    return typeof metadata === "string" ? metadata : JSON.stringify(metadata, null, 2);
  }
}

