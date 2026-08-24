export type CliDiagnosticCode =
  | "cli-input"
  | "configuration-error"
  | "analysis-error"
  | "resource-limit"
  | "cancelled"
  | "git-error"
  | "output-error";

type ErrorShape = {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
};

const SECRET_ASSIGNMENT =
  /(\b(?:access[-_ ]?key|access[-_ ]?token|api[-_ ]?key|authorization|bearer|client[-_ ]?secret|credential|password|passphrase|secret|token)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;)}]+)/giu;
const BEARER_VALUE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const CREDENTIAL_URL =
  /\b[a-z][a-z\d+.-]*:\/\/[^/\s:@]+:[^@\s/]+@[^\s"'<>]+/giu;
const JWT_VALUE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const STANDALONE_SENSITIVE_VALUE =
  /\b(?:TOP-SECRET|SECRET|TOKEN|CREDENTIAL|PASSWORD)[-_][A-Za-z0-9._-]+\b/giu;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'`<>;,)]*/gu;
const ABSOLUTE_PATH =
  /(?<![A-Za-z0-9:])\/(?:[^/\s"'`<>;,)]+\/)+[^/\s"'`<>;,)]*/gu;
const SOURCE_LINE =
  /\b(?:import|export|const|let|var|function|class)\s+[A-Za-z_$][\w$]*|=>|;\s*(?:\/\/.*)?$/u;

const shapeOf = (value: unknown): ErrorShape =>
  value !== null && typeof value === "object" ? value : {};

const stringifyUnknown = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  if (typeof value === "symbol") return value.toString();
  return "[unknown error]";
};

const sourceSafeLine = (line: string): string =>
  SOURCE_LINE.test(line) ? "[REDACTED:SOURCE]" : line;

/**
 * Redact untrusted CLI diagnostics before they reach a terminal or log.
 * Diagnostics remain short and actionable, but values supplied by a
 * repository, path, Git ref, or malformed source are never echoed verbatim.
 */
export const redactCliText = (value: unknown): string => {
  const raw = stringifyUnknown(value).replaceAll("\r", "");
  if (raw.trim().length === 0) return "";
  const lines = raw.split("\n");
  const firstLine = lines[0] ?? "";
  const redacted = firstLine
    .replace(CREDENTIAL_URL, "[REDACTED:URL]")
    .replace(BEARER_VALUE, "[REDACTED:CREDENTIAL]")
    .replace(JWT_VALUE, "[REDACTED:TOKEN]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED:SECRET]")
    .replace(STANDALONE_SENSITIVE_VALUE, "[REDACTED:SECRET]")
    .replace(WINDOWS_PATH, "[REDACTED:PATH]")
    .replace(ABSOLUTE_PATH, "[REDACTED:PATH]");
  const safe = sourceSafeLine(redacted).trim();
  const detail = safe.length > 0 ? safe : "command failed";
  return `${detail.slice(0, 2_048)}${detail.length > 2_048 ? "…" : ""}`;
};

const isShape = (value: unknown): value is ErrorShape =>
  value !== null && typeof value === "object";

export const classifyCliError = (value: unknown): CliDiagnosticCode => {
  const shape = shapeOf(value);
  const name = typeof shape.name === "string" ? shape.name : "";
  const code = typeof shape.code === "string" ? shape.code : "";

  if (
    name === "CommanderError" ||
    name === "InvalidArgumentError" ||
    code.startsWith("commander.")
  )
    return "cli-input";
  if (
    name === "ConfigValidationError" ||
    name === "TypeScriptConfigError" ||
    name === "PolicyConfigValidationError"
  )
    return "configuration-error";
  if (name === "ResourceLimitError") return "resource-limit";
  if (name === "CancellationError") return "cancelled";
  if (name === "GitCommandError") return "git-error";
  if (
    code === "EACCES" ||
    code === "EEXIST" ||
    code === "ENOENT" ||
    code === "EPERM" ||
    code === "EROFS"
  )
    return "output-error";
  return "analysis-error";
};

export const formatCliError = (value: unknown): string => {
  const shape = shapeOf(value);
  const message =
    isShape(value) && typeof shape.message === "string"
      ? shape.message
      : stringifyUnknown(value);
  return `cartograph [${classifyCliError(value)}]: ${redactCliText(message)}`;
};

export const formatCliWarning = (value: unknown): string =>
  `cartograph: warning: ${redactCliText(value)}`;

export const isCommanderControlError = (value: unknown): boolean => {
  const shape = shapeOf(value);
  return (
    shape.code === "commander.helpDisplayed" ||
    shape.code === "commander.version"
  );
};
