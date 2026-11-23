// Environment configuration validated at process startup via Zod.

import { z } from 'zod';

const EnvConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PROTOCOL: z.enum(['binary', 'json']).default('binary')
});

export type ServerConfig = z.infer<typeof EnvConfigSchema>;

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = EnvConfigSchema.safeParse({
    PORT: env.PORT,
    PROTOCOL: env.PROTOCOL
  });

  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server environment configuration: ${details}`);
  }

  return parsed.data;
}
