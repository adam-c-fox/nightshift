import { getEnv } from "./env.js";

const name = getEnv("NIGHTSHIFT_PROJECT");
if (name) console.log(name);
