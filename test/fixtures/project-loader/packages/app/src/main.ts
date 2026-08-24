// @ts-expect-error The repository root does not own the fixture's per-project alias.
import { coreValue } from "@core/index.js";

export const appValue = `${coreValue}-app`;
