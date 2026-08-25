import { Node, type CallExpression, type Expression } from "ts-morph";

const ROUTE_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "route",
]);

const literalString = (node: Node | undefined): string | undefined => {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return node.getLiteralValue();
  return undefined;
};

const propertyValue = (
  object: Node,
  names: readonly string[],
): { node: Node; value: Expression | undefined } | undefined => {
  if (!Node.isObjectLiteralExpression(object)) return undefined;
  for (const name of names) {
    const property = object.getProperty(name);
    if (!property) continue;
    if (Node.isPropertyAssignment(property)) {
      const initializer = property.getInitializer();
      return initializer && Node.isExpression(initializer)
        ? { node: initializer, value: initializer }
        : { node: property, value: undefined };
    }
    if (Node.isShorthandPropertyAssignment(property)) {
      const shorthand = property.getNameNode();
      return { node: shorthand, value: shorthand };
    }
    return { node: property, value: undefined };
  }
  return undefined;
};

export interface FastifyAnalyzerContext {
  isFastifyReceiver: (receiver: Expression) => boolean;
}

export interface FastifyRouteRegistration {
  readonly method: string;
  readonly path: string;
  readonly handlers: readonly Expression[];
}

export interface FastifyRouteDiagnostic {
  readonly code:
    "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE" | "UNRESOLVED_FASTIFY_HANDLER";
  readonly message: string;
  readonly node: Node;
}

export interface FastifyRouteResult {
  readonly registrations: readonly FastifyRouteRegistration[];
  readonly diagnostics: readonly FastifyRouteDiagnostic[];
}

export const isFastifyRouteMethod = (method: string): boolean =>
  ROUTE_METHODS.has(method.toLowerCase());

const unsupported = (node: Node): FastifyRouteDiagnostic => ({
  code: "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE",
  message:
    "Fastify route method and URL must be statically named literals in the supported adapter subset.",
  node,
});

const unresolvedHandler = (node: Node): FastifyRouteDiagnostic => ({
  code: "UNRESOLVED_FASTIFY_HANDLER",
  message:
    "Could not resolve a Fastify route handler in the supported adapter subset.",
  node,
});

const directRoute = (
  call: CallExpression,
  method: string,
): FastifyRouteResult => {
  const first = call.getArguments()[0];
  if (!first) return { registrations: [], diagnostics: [unsupported(call)] };

  if (Node.isObjectLiteralExpression(first)) {
    const pathProperty = propertyValue(first, ["url", "path"]);
    const path = literalString(pathProperty?.value);
    if (path === undefined) {
      return {
        registrations: [],
        diagnostics: [unsupported(pathProperty?.node ?? first)],
      };
    }
    const handlerProperty = propertyValue(first, ["handler"]);
    if (!handlerProperty?.value) {
      return {
        registrations: [],
        diagnostics: [unresolvedHandler(handlerProperty?.node ?? first)],
      };
    }
    return {
      registrations: [{ method, path, handlers: [handlerProperty.value] }],
      diagnostics: [],
    };
  }

  const path = literalString(first);
  if (path === undefined)
    return { registrations: [], diagnostics: [unsupported(first)] };
  const handlers = call
    .getArguments()
    .slice(1)
    .filter((argument): argument is Expression => Node.isExpression(argument));
  return {
    registrations: [{ method, path, handlers }],
    diagnostics: handlers.length === 0 ? [unresolvedHandler(call)] : [],
  };
};

const objectRoute = (call: CallExpression): FastifyRouteResult => {
  const first = call.getArguments()[0];
  if (!first || !Node.isObjectLiteralExpression(first))
    return { registrations: [], diagnostics: [unsupported(first ?? call)] };

  const pathProperty = propertyValue(first, ["url", "path"]);
  const path = literalString(pathProperty?.value);
  if (path === undefined)
    return {
      registrations: [],
      diagnostics: [unsupported(pathProperty?.node ?? first)],
    };

  const methodProperty = propertyValue(first, ["method"]);
  const methodValue = methodProperty?.value;
  const methods: string[] = [];
  if (methodValue && Node.isArrayLiteralExpression(methodValue)) {
    for (const element of methodValue.getElements()) {
      const value = literalString(element);
      if (value === undefined)
        return { registrations: [], diagnostics: [unsupported(element)] };
      methods.push(value.toUpperCase());
    }
  } else {
    const value = literalString(methodValue);
    if (value === undefined)
      return {
        registrations: [],
        diagnostics: [unsupported(methodProperty?.node ?? first)],
      };
    methods.push(value.toUpperCase());
  }
  if (methods.length === 0)
    return {
      registrations: [],
      diagnostics: [unsupported(methodProperty?.node ?? first)],
    };

  const handlerProperty = propertyValue(first, ["handler"]);
  if (!handlerProperty?.value)
    return {
      registrations: [],
      diagnostics: [unresolvedHandler(handlerProperty?.node ?? first)],
    };

  return {
    registrations: methods.map((method) => ({
      method,
      path,
      handlers: [handlerProperty.value as Expression],
    })),
    diagnostics: [],
  };
};

export const analyzeFastifyRouteCall = (
  call: CallExpression,
  context: FastifyAnalyzerContext,
): FastifyRouteResult | undefined => {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return undefined;
  const method = expression.getName().toLowerCase();
  if (!ROUTE_METHODS.has(method)) return undefined;
  if (!context.isFastifyReceiver(expression.getExpression())) return undefined;
  return method === "route"
    ? objectRoute(call)
    : directRoute(call, method.toUpperCase());
};
