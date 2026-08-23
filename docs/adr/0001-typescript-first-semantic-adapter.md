# ADR 0001: Start with a TypeScript 6 semantic adapter

- Status: accepted
- Date: 2026-08-23

## Context

CARTOGRAPH needs resolved imports, symbols, types, and framework bindings. Syntax-only parsing would make a visually broad but unreliable graph. TypeScript 7.0 also replaced the TypeScript compiler with a Go implementation and does not expose the TypeScript 6 compiler API.

## Decision

Use TypeScript 6 and ts-morph 28 for the first adapter. Isolate all compiler-specific behavior behind the analyzer-to-graph contract. Pin supported versions and maintain fixtures for the eventual TypeScript 7 API transition.

## Alternatives

- Tree-sitter alone: portable and fast, but insufficient for the initial semantic-precision goal.
- A multi-language code-property graph: broader, but adds deployment and semantic complexity before product value is proven.
- Wait for the TypeScript 7.1 API: delays the measurable TypeScript-first loop without removing transition risk.

## Consequences

The MVP has a bounded compatibility window and must not claim current TypeScript 7 compiler support. The adapter boundary becomes a release-critical contract.
