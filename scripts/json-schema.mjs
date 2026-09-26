import Ajv from "ajv";
import addFormats from "ajv-formats";

// Shared JSON Schema (draft-07) validator factory for scripts and tests.
// Formats use ajv-formats "fast" mode, matching the Ajv 6 defaults the
// checked-in contracts were written against.
export const createAjv = (options = {}) => {
  const ajv = new Ajv({ allErrors: true, ...options });
  addFormats(ajv, { mode: "fast" });
  return ajv;
};
