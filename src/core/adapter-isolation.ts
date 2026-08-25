import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseAdapterInput,
  parseAdapterManifest,
  parseAdapterOutput,
  validateAdapterOutputIntegrity,
  type AdapterInput,
  type AdapterOutput,
  type CartographAdapter,
} from "./adapters.js";
import { stableStringify } from "./canonical.js";

/** The process boundary is owned by CARTOGRAPH, never by an adapter. */
const CHILD_PROTOCOL = String.raw`
const moduleUrl = process.env.CARTOGRAPH_ADAPTER_MODULE;
const exportName = process.env.CARTOGRAPH_ADAPTER_EXPORT || "default";
const chunks = [];

const fail = (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(message);
  process.exitCode = 1;
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("error", fail);
process.stdin.on("end", async () => {
  try {
    if (!moduleUrl) throw new Error("adapter module URL was not provided");
    const input = JSON.parse(chunks.join(""));
    const loaded = await import(moduleUrl);
    const adapter = loaded[exportName] ?? (exportName === "default" ? loaded.default : undefined);
    if (!adapter || typeof adapter.analyze !== "function") {
      throw new Error("adapter module does not export " + exportName + " with an analyze function");
    }
    const output = await adapter.analyze(input);
    process.stdout.write(JSON.stringify({ manifest: adapter.manifest, output }));
  } catch (error) {
    fail(error);
  }
});
`;

export type AdapterIsolationErrorCode =
  | "invalid-module"
  | "unsupported-runtime"
  | "input-limit"
  | "output-limit"
  | "wall-clock-limit"
  | "memory-limit"
  | "authority-denied"
  | "protocol"
  | "adapter-failed";

export class AdapterIsolationError extends Error {
  readonly code: AdapterIsolationErrorCode;
  readonly childPid: number | undefined;

  constructor(
    code: AdapterIsolationErrorCode,
    message: string,
    childPid?: number,
  ) {
    super(message);
    this.name = "AdapterIsolationError";
    this.code = code;
    this.childPid = childPid;
  }
}

export type AdapterIsolationRequest = {
  readonly adapterModule: string | URL;
  readonly exportName?: string;
  readonly input: unknown;
};

const permissionFlag = (): string =>
  process.allowedNodeEnvironmentFlags.has("--permission")
    ? "--permission"
    : "--experimental-permission";

/** Network denial is required; a filesystem-only permission model is not enough. */
export const supportsAdapterIsolation = (): boolean =>
  process.allowedNodeEnvironmentFlags.has("--allow-net") &&
  (process.allowedNodeEnvironmentFlags.has("--permission") ||
    process.allowedNodeEnvironmentFlags.has("--experimental-permission"));

const modulePathFromInput = (value: string | URL): string => {
  try {
    if (value instanceof URL) {
      if (value.protocol !== "file:")
        throw new AdapterIsolationError(
          "invalid-module",
          "isolated adapters must be loaded from a local file URL",
        );
      return fileURLToPath(value);
    }
    if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) {
      throw new AdapterIsolationError(
        "invalid-module",
        "isolated adapters must be loaded from a local file path",
      );
    }
    return isAbsolute(value) ? value : resolve(value);
  } catch (error) {
    if (error instanceof AdapterIsolationError) throw error;
    throw new AdapterIsolationError(
      "invalid-module",
      `invalid adapter module path: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const assertModulePath = (value: string | URL): string => {
  const modulePath = modulePathFromInput(value);
  const isFile = (() => {
    try {
      return existsSync(modulePath) && statSync(modulePath).isFile();
    } catch (error) {
      throw new AdapterIsolationError(
        "invalid-module",
        `adapter module cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  if (!isFile) {
    throw new AdapterIsolationError(
      "invalid-module",
      `adapter module does not exist or is not a file: ${modulePath}`,
    );
  }
  return modulePath;
};

const serializedBytes = (value: unknown): { text: string; bytes: number } => {
  try {
    const text = stableStringify(value);
    return { text, bytes: Buffer.byteLength(text, "utf8") };
  } catch (error) {
    throw new AdapterIsolationError(
      "protocol",
      `adapter input is not serializable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const kill = (child: ChildProcess): void => {
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
};

const classifyChildFailure = (
  stderr: string,
  childPid: number | undefined,
): AdapterIsolationError => {
  if (
    /ERR_ACCESS_DENIED|permission denied|operation not permitted/iu.test(stderr)
  ) {
    return new AdapterIsolationError(
      "authority-denied",
      `adapter authority request was denied: ${stderr.trim() || "permission boundary"}`,
      childPid,
    );
  }
  if (/heap out of memory|javascript heap out of memory/iu.test(stderr)) {
    return new AdapterIsolationError(
      "memory-limit",
      `adapter exceeded its ${childPid === undefined ? "configured" : "configured child-process"} memory ceiling`,
      childPid,
    );
  }
  return new AdapterIsolationError(
    "adapter-failed",
    `isolated adapter failed${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}`,
    childPid,
  );
};

const runChild = (
  modulePath: string,
  exportName: string,
  input: AdapterInput,
  inputText: string,
): Promise<{ manifest: unknown; output: unknown }> => {
  const sourceRoot = resolve(input.source.rootDir);
  const moduleRoot = dirname(modulePath);
  const memoryMegabytes = Math.max(
    16,
    Math.floor(input.resources.maxMemoryBytes / (1024 * 1024)),
  );
  const child = spawn(
    process.execPath,
    [
      permissionFlag(),
      `--allow-fs-read=${sourceRoot}`,
      `--allow-fs-read=${moduleRoot}`,
      `--max-old-space-size=${memoryMegabytes}`,
      "--input-type=module",
      "--eval",
      CHILD_PROTOCOL,
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        LANG: process.env.LANG ?? "",
        LC_ALL: process.env.LC_ALL ?? "",
        TZ: process.env.TZ ?? "",
        CARTOGRAPH_ADAPTER_MODULE: pathToFileURL(modulePath).href,
        CARTOGRAPH_ADAPTER_EXPORT: exportName,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  return new Promise((resolvePromise, rejectPromise) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let termination: AdapterIsolationError | undefined;
    let spawnFailure: Error | undefined;

    const requestTermination = (error: AdapterIsolationError): void => {
      if (termination === undefined) termination = error;
      kill(child);
    };

    const settle = (): void => {
      clearTimeout(timer);
      const childPid = child.pid ?? undefined;
      if (termination !== undefined) {
        rejectPromise(
          new AdapterIsolationError(
            termination.code,
            termination.message,
            childPid,
          ),
        );
        return;
      }
      if (spawnFailure !== undefined) {
        rejectPromise(
          new AdapterIsolationError(
            "adapter-failed",
            `could not start isolated adapter: ${spawnFailure.message}`,
            childPid,
          ),
        );
        return;
      }
      const outputText = Buffer.concat(stdout).toString("utf8");
      if (child.exitCode !== 0 || child.signalCode !== null) {
        rejectPromise(
          classifyChildFailure(
            Buffer.concat(stderr).toString("utf8"),
            childPid,
          ),
        );
        return;
      }
      try {
        const envelope = JSON.parse(outputText) as {
          manifest?: unknown;
          output?: unknown;
        };
        if (!("manifest" in envelope) || !("output" in envelope))
          throw new Error("isolated adapter response is missing its envelope");
        resolvePromise({
          manifest: envelope.manifest,
          output: envelope.output,
        });
      } catch (error) {
        rejectPromise(
          new AdapterIsolationError(
            "protocol",
            `invalid isolated adapter response: ${error instanceof Error ? error.message : String(error)}`,
            childPid,
          ),
        );
      }
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.byteLength;
      if (stdoutBytes > input.resources.maxOutputBytes) {
        requestTermination(
          new AdapterIsolationError(
            "output-limit",
            `isolated adapter response exceeded the ${input.resources.maxOutputBytes} byte output ceiling`,
            child.pid ?? undefined,
          ),
        );
        return;
      }
      stdout.push(buffer);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.byteLength;
      if (stderrBytes <= input.resources.maxOutputBytes) stderr.push(buffer);
      if (stderrBytes > input.resources.maxOutputBytes) {
        requestTermination(
          new AdapterIsolationError(
            "output-limit",
            `isolated adapter diagnostics exceeded the ${input.resources.maxOutputBytes} byte output ceiling`,
            child.pid ?? undefined,
          ),
        );
      }
    });
    child.once("error", (error) => {
      spawnFailure = error;
      kill(child);
    });
    child.once("close", settle);
    const timer = setTimeout(() => {
      requestTermination(
        new AdapterIsolationError(
          "wall-clock-limit",
          `isolated adapter exceeded the ${input.resources.maxWallClockMs} ms wall-clock ceiling`,
          child.pid ?? undefined,
        ),
      );
    }, input.resources.maxWallClockMs);

    child.stdin?.on("error", (error) => {
      if (!termination)
        requestTermination(
          new AdapterIsolationError(
            "protocol",
            `could not send isolated adapter input: ${error.message}`,
            child.pid ?? undefined,
          ),
        );
    });
    child.stdin?.end(inputText);
  });
};

/**
 * Run a module-exported adapter in a separate, permissioned Node process.
 *
 * The child receives only JSON over stdin. It has read access to the declared
 * source root and adapter module directory; network, child processes, writes,
 * and worker creation remain denied by the Node permission model. A wall-clock
 * or output breach kills the child and waits for its close event before
 * rejecting, so a hung or noisy adapter cannot survive the request.
 */
export const runAdapterIsolated = async (
  request: AdapterIsolationRequest,
): Promise<AdapterOutput> => {
  const modulePath = assertModulePath(request.adapterModule);
  const input = parseAdapterInput(request.input);
  const serialized = serializedBytes(input);
  if (serialized.bytes > input.resources.maxInputBytes) {
    throw new AdapterIsolationError(
      "input-limit",
      `isolated adapter input is ${serialized.bytes} bytes; the ${input.resources.maxInputBytes} byte input ceiling was exceeded`,
    );
  }

  if (!supportsAdapterIsolation()) {
    throw new AdapterIsolationError(
      "unsupported-runtime",
      "the current Node permission model cannot deny network access; refusing isolated adapter execution",
    );
  }

  const envelope = await runChild(
    modulePath,
    request.exportName ?? "default",
    input,
    serialized.text,
  );
  const manifest = parseAdapterManifest(envelope.manifest);
  const output = parseAdapterOutput(envelope.output);
  if (
    output.capability.id !== manifest.id ||
    output.capability.version !== manifest.version
  ) {
    throw new AdapterIsolationError(
      "protocol",
      `isolated adapter output capability ${output.capability.id}@${output.capability.version} does not match ${manifest.id}@${manifest.version}`,
    );
  }
  validateAdapterOutputIntegrity(output);
  return output;
};

/** A type-level adapter shape used by module authors and documentation. */
export type IsolatedCartographAdapter = Omit<CartographAdapter, "analyze"> & {
  analyze(input: AdapterInput): AdapterOutput | Promise<AdapterOutput>;
};
