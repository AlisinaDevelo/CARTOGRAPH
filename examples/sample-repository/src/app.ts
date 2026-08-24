import { greeting } from "./greeting.js";

export function greet(name: string): string {
  return `${greeting}, ${name}`;
}
