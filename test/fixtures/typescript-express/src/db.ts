export interface User {
  id: string;
  name: string;
}

export declare const db: {
  user: {
    findMany(): User[];
    create(input: { data: { name: string } }): User;
    update(input: { where: { id: string }; data: { name: string } }): User;
  };
};
