export function resolveUser() {
  return { id: "user-1" };
}

export function createUser() {
  return { id: "created" };
}

export const resolvers = {
  Query: {
    user: resolveUser,
    aliasUser: resolveUser,
  },
  Mutation: {
    createUser,
  },
};
