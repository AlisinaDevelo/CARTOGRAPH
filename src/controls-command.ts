import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  evaluateControlEvidence,
  parseControlMapping,
  type ControlEvidenceReport,
} from "./core/index.js";
import { loadControlBundleEvidence } from "./bundle-command.js";

const MAX_MAPPING_BYTES = 4 * 1024 * 1024;

export class ControlMappingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlMappingInputError";
  }
}

/** Evaluate a local control mapping against a verified assurance bundle. */
export async function evaluateControls(options: {
  mapping: string;
  bundle: string;
  asOf: string;
}): Promise<ControlEvidenceReport> {
  const metadata = await lstat(resolve(options.mapping));
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_MAPPING_BYTES
  )
    throw new ControlMappingInputError(
      `control mapping is not a regular file under ${MAX_MAPPING_BYTES} bytes: ${options.mapping}`,
    );
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(options.mapping), "utf8"));
  } catch {
    throw new ControlMappingInputError(
      `control mapping is not valid JSON: ${options.mapping}`,
    );
  }
  const mapping = parseControlMapping(value);
  const bundle = await loadControlBundleEvidence(options.bundle);
  return evaluateControlEvidence(mapping, bundle, options.asOf);
}
