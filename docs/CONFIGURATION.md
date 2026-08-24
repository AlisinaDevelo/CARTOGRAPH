# Configuration contract

CARTOGRAPH accepts an optional repository-relative JSON configuration with
schema version `1` (the public v0.1 contract is
[`schema/cartograph-config.v0.1.schema.json`](../schema/cartograph-config.v0.1.schema.json)).
Pass it to `scan` or `diff` with `--config <path>`.

```json
{
  "schemaVersion": 1,
  "include": ["src/**"],
  "exclude": ["src/generated/**"],
  "extractors": ["typescript", "express"],
  "resources": {
    "maxFiles": 20000,
    "maxFileBytes": 2097152,
    "maxSourceBytes": 67108864,
    "maxArchiveBytes": 67108864,
    "maxMemoryBytes": 1073741824,
    "maxWallClockMs": 30000,
    "maxReportItems": 10000
  },
  "policyRefs": [".cartograph/policy.json"],
  "unknownFields": "error"
}
```

Omitted fields use deterministic defaults: `include` is `["."]`, built-in
safe exclusions remain active, both current extractors are selected, and the
resource ceilings above apply. `tsconfigPath` is optional and remains
repository-relative.

Paths and glob patterns are normalized to POSIX separators and cannot be
absolute, contain a drive or URI prefix, contain NUL bytes, or include a `..`
segment. The config file itself must also be inside the analyzed repository.
The analyzer never follows source symlinks. Exceeding a selected-file, byte,
memory, or wall-clock ceiling fails closed with a stable diagnostic.

Unknown keys fail closed by default. A config may set `unknownFields` to
`"warn"`; unknown keys are ignored and each ignored key is reported on stderr
by the CLI (the library API returns the warnings). Known keys with invalid
values still fail in warn mode. This keeps forward-compatible automation
explicit instead of silently accepting misspelled limits or paths.

The `output` object describes the intended consumer format (`snapshot` or
`diff`, and `json`, `markdown`, or `html`); command-line output flags remain
authoritative for the current invocation. `policyRefs` records repository-local
policy inputs for callers and is validated for portability without executing
or loading those files.
