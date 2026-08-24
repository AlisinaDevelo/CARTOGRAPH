export async function loadLiteralModules(): Promise<void> {
  await import("./modules.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  void require("./db.js");
}

export async function loadDynamicModule(specifier: string): Promise<void> {
  await import(specifier);
}

export function requireDynamicModule(specifier: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(specifier);
}
