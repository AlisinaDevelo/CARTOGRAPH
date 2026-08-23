import { loadUsers } from "./modules.js";
import { createUser, listOne, remoteUser, UserService } from "./services.js";
import router from "./router.js";
import express from "express";

const app = express();
void router;
void UserService;

app.get("/users", loadUsers);
app.post("/users", createUser);
app.get("/users/:id", listOne);
app.route("/route-chain").get(listOne);
app.get("/remote", remoteUser);
app.get("/inline", (_request, response) => {
  response.json(remoteUser());
});

export default app;
