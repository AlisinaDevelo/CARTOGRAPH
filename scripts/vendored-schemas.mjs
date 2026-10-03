import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createAjv } from "./json-schema.mjs";

const vendorRoot = resolve(import.meta.dirname, "../schema/vendor");
const read = (path) => readFileSync(resolve(vendorRoot, path));

/** Fail if any vendored file differs from the digest recorded for it. */
export const verifyVendoredSchemas = () => {
  const provenance = JSON.parse(read("provenance.json").toString("utf8"));
  const mismatched = provenance.schemas.flatMap((schema) =>
    Object.entries(schema.files).filter(
      ([path, digest]) =>
        createHash("sha256").update(read(path)).digest("hex") !== digest,
    ),
  );
  if (mismatched.length > 0)
    throw new Error(
      `vendored schema files changed: ${mismatched.map(([path]) => path).join(", ")}`,
    );
  return provenance.schemas.map((schema) => schema.id);
};

/**
 * The upstream CycloneDX 1.6 validator. The schema uses two formats Ajv
 * does not ship; they are checked with their stricter ASCII counterparts.
 */
export const createCycloneDx16Validator = () => {
  verifyVendoredSchemas();
  const ajv = createAjv({ allErrors: true, strict: false });
  const formats = ajv.formats;
  ajv.addFormat("iri-reference", formats["uri-reference"]);
  ajv.addFormat("idn-email", formats.email);
  const json = (path) => JSON.parse(read(path).toString("utf8"));
  ajv.addSchema(json("cyclonedx-1.6/spdx.schema.json"));
  ajv.addSchema(json("cyclonedx-1.6/jsf-0.82.schema.json"));
  return ajv.compile(json("cyclonedx-1.6/bom-1.6.schema.json"));
};
