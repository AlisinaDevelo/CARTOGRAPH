import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AjvDraft04 from "ajv-draft-04";
import addFormats from "ajv-formats";

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

/** Compile the untouched official SARIF 2.1.0 draft-04 schema offline. */
export const createSarif210Validator = () => {
  verifyVendoredSchemas();
  const ajv = new AjvDraft04({ allErrors: true, strict: false });
  addFormats(ajv, { mode: "full" });
  return ajv.compile(
    JSON.parse(read("sarif-2.1.0/sarif-schema-2.1.0.json").toString("utf8")),
  );
};

/**
 * CARTOGRAPH's required-field conformance check derived from pinned in-toto
 * Statement v1 prose, not an official upstream JSON Schema or a trust check.
 */
export const createInTotoStatementV1Validator = () => {
  verifyVendoredSchemas();
  const ajv = createAjv();
  addFormats(ajv, { mode: "full", formats: ["uri"] });
  const validateUri = ajv.compile({ type: "string", format: "uri" });
  ajv.addFormat("in-toto-type-uri", {
    type: "string",
    validate: (value) => {
      if (!validateUri(value)) return false;
      // TypeURI requires lowercase scheme and authority, not path or fragment.
      const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?/u.exec(
        value,
      );
      const authority = match?.[2];
      const hostPort = authority?.slice(authority.lastIndexOf("@") + 1);
      return (
        match !== null &&
        match[1] === match[1].toLowerCase() &&
        (authority === undefined || authority === authority.toLowerCase()) &&
        // Ajv's full URI format still permits nonnumeric authority ports.
        (hostPort === undefined ||
          /^(?:\[[^\]]+\]|[^:]*)(?::[0-9]*)?$/u.test(hostPort))
      );
    },
  });
  return ajv.compile({
    type: "object",
    required: ["_type", "subject", "predicateType"],
    properties: {
      _type: { const: "https://in-toto.io/Statement/v1" },
      subject: {
        type: "array",
        items: {
          type: "object",
          required: ["digest"],
          properties: {
            name: { type: "string" },
            digest: {
              type: "object",
              minProperties: 1,
              properties: {
                sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
              },
              additionalProperties: { type: "string", minLength: 1 },
            },
          },
        },
      },
      predicateType: { type: "string", format: "in-toto-type-uri" },
      predicate: { type: "object" },
    },
  });
};
