import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  SbomLinkError,
  linkSbomToGraph,
  parseBuildProvenance,
  parseSbom,
  type SbomLinkReport,
} from "./core/index.js";
import { loadSnapshot } from "./commands.js";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;

const readJsonInput = async (path: string, label: string): Promise<unknown> => {
  const metadata = await lstat(resolve(path));
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_INPUT_BYTES
  )
    throw new SbomLinkError(
      `${label} is not a regular file under ${MAX_INPUT_BYTES} bytes: ${path}`,
    );
  try {
    return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  } catch {
    throw new SbomLinkError(`${label} is not valid JSON: ${path}`);
  }
};

/** Link an SBOM, and optionally build provenance, to a graph snapshot. */
export async function linkSbomFiles(options: {
  snapshot: string;
  sbom: string;
  provenance?: string;
  aliases?: readonly { key: string; value: string }[];
}): Promise<SbomLinkReport> {
  const snapshot = await loadSnapshot(options.snapshot);
  const sbom = parseSbom(await readJsonInput(options.sbom, "SBOM"));
  const provenance =
    options.provenance === undefined
      ? undefined
      : parseBuildProvenance(
          await readJsonInput(options.provenance, "provenance"),
        );
  return linkSbomToGraph(snapshot, sbom, {
    ...(provenance === undefined ? {} : { provenance }),
    aliases: Object.fromEntries(
      (options.aliases ?? []).map((item) => [item.key, item.value]),
    ),
  });
}
