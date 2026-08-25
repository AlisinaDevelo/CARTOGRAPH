import express from "express";

const app = express();

export function listUsers() {
  return [{ id: "user-1" }];
}

export function getUser() {
  return { id: "user-1" };
}

const prefix = process.env.API_PREFIX ?? "/api";
app.get("/users", listUsers);
app.get("/users/:id", getUser);
app.get(`${prefix}/generated`, getUser);

export { app };
