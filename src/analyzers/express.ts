import { Node, type CallExpression, type Expression } from "ts-morph";

export interface ExpressAnalyzerContext {
  isExpressReceiver: (receiver: Expression) => boolean;
  isPotentialMiddlewareHandler?: (handler: Expression) => boolean;
}

export interface ExpressRouteResult {
  diagnostic?: {
    code: string;
    message: string;
    node: Node;
  };
  handlers: Expression[];
  method: string;
  path: string;
}

const ROUTE_METHODS = new Set([
  "all",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "use",
]);

const GLOBAL_MIDDLEWARE_PATH = "*";

const literalPath = (node: Node | undefined): string | undefined => {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return node.getLiteralValue();
  return undefined;
};

export const analyzeExpressRouteCall = (
  call: CallExpression,
  context: ExpressAnalyzerContext,
): ExpressRouteResult | undefined => {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return undefined;
  const methodName = expression.getName().toLowerCase();
  const method = methodName.toUpperCase();
  if (!ROUTE_METHODS.has(methodName)) return undefined;
  const isMiddleware = methodName === "use";

  const receiver = expression.getExpression();
  let routePathNode: Node | undefined;
  if (Node.isCallExpression(receiver)) {
    const routeFactory = receiver.getExpression();
    if (
      !Node.isPropertyAccessExpression(routeFactory) ||
      routeFactory.getName() !== "route" ||
      !context.isExpressReceiver(routeFactory.getExpression())
    ) {
      return undefined;
    }
    routePathNode = receiver.getArguments()[0];
  } else if (!context.isExpressReceiver(receiver)) {
    return undefined;
  }

  const argumentsList = call.getArguments();
  const expressionArguments = argumentsList.filter(
    (argument): argument is Expression => Node.isExpression(argument),
  );
  let pathNode: Node | undefined;
  let handlers: Expression[];
  if (isMiddleware && !routePathNode) {
    const firstArgument = argumentsList[0];
    const allArgumentsAreHandlers =
      argumentsList.length > 0 &&
      argumentsList.every(
        (argument) =>
          Node.isExpression(argument) &&
          (context.isPotentialMiddlewareHandler?.(argument) ?? false),
      );
    if (literalPath(firstArgument) !== undefined) {
      pathNode = firstArgument;
      handlers = expressionArguments.slice(1);
    } else if (allArgumentsAreHandlers || argumentsList.length === 1) {
      return {
        handlers: expressionArguments,
        method,
        path: GLOBAL_MIDDLEWARE_PATH,
      };
    } else {
      return {
        diagnostic: {
          code: "UNSUPPORTED_DYNAMIC_ROUTE",
          message:
            "Express middleware mount path must be a literal string when a path is provided.",
          node: firstArgument ?? call,
        },
        handlers: [],
        method,
        path: "",
      };
    }
  } else {
    pathNode = routePathNode ?? argumentsList[0];
    handlers = routePathNode
      ? expressionArguments
      : expressionArguments.slice(1);
  }
  const path = literalPath(pathNode);
  if (path === undefined) {
    return {
      diagnostic: {
        code: "UNSUPPORTED_DYNAMIC_ROUTE",
        message: "Express route path must be a literal string.",
        node: pathNode ?? call,
      },
      handlers: [],
      method,
      path: "",
    };
  }

  return {
    handlers,
    method,
    path,
  };
};

export const isPotentialExpressReceiver = (
  receiver: Expression,
  _rootDir?: string,
): boolean => {
  const text = receiver.getText();
  if (Node.isIdentifier(receiver)) {
    return (
      /(?:^|_)(?:app|router)(?:$|_|[A-Z])/iu.test(text) ||
      /(?:app|router)$/iu.test(text)
    );
  }

  if (Node.isCallExpression(receiver)) {
    const callText = receiver.getExpression().getText();
    return (
      callText === "express" ||
      callText === "Router" ||
      callText.endsWith(".Router")
    );
  }

  const typeText = receiver.getType().getText();
  if (/(?:express\.)?(?:Application|Router|IRouter|Express)/u.test(typeText))
    return true;

  const symbol = receiver.getSymbol();
  for (const declaration of symbol?.getDeclarations() ?? []) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const initializerText = initializer.getExpression().getText();
    if (
      initializerText === "express" ||
      initializerText === "Router" ||
      initializerText.endsWith(".Router")
    ) {
      return true;
    }
  }

  return false;
};
