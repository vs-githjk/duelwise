import { defineConfig } from 'drizzle-kit'

// `bunx drizzle-kit generate` only reads the schema; it never opens a database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
