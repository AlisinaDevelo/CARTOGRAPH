import axios from "axios";
import { db } from "./db.js";

export function listOne(): ReturnType<typeof db.user.findMany> {
  return db.user.findMany();
}

export const createUser = () => db.user.create({ data: { name: "new" } });

export async function remoteUser() {
  return axios.get("https://api.example.test/users");
}

export class UserService {
  saveUser() {
    return db.user.update({ where: { id: "1" }, data: { name: "saved" } });
  }
}

export function invokeService(service: UserService) {
  return service.saveUser();
}
