import { loadConfig } from "./config.js";
import { migrate } from "./db/migrations.js";
import { createPool } from "./db/pool.js";

const pool = createPool(loadConfig().databaseUrl, 1);
const applied = await migrate(pool);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "schema up to date");
await pool.end();
