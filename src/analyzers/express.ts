import { Node, type CallExpression, type Expression } from "ts-morph";

export interface ExpressAnalyzerContext {
  isExpressReceiver: (receiver: Expression) => boolean;
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
]);

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
  const method = expression.getName().toUpperCase();
  if (!ROUTE_METHODS.has(expression.getName().toLowerCase())) return undefined;

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

  const pathNode = routePathNode ?? call.getArguments()[0];
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
    handlers: (routePathNode
      ? call.getArguments()
      : call.getArguments().slice(1)
    ).filter((argument): argument is Expression => Node.isExpression(argument)),
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
