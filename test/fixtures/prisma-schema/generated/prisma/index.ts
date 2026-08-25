export class PrismaClient {
  post = {
    create(input: { data: { authorId: number } }): unknown {
      return input;
    },
  };
}
