import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/schema-postgres.ts",
  out: "./drizzle-postgres",
  dialect: "postgresql",
  schemaFilter: ["platform"],
  dbCredentials: { url: process.env.HYPERFIDE_DATABASE_URL ?? "" },
});
