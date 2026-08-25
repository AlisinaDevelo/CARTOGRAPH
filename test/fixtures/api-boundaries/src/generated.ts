declare function buildSchema(source: string): unknown;

const generatedSource =
  process.env.GRAPHQL_SCHEMA ?? "type Query { generated: User }";
buildSchema(generatedSource);
buildSchema(`type Query { generatedStatic: User }`);
