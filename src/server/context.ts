import type { Context } from 'hono';

export type Banker = { id: string; username: string };
export type AppEnv = { Variables: { banker: Banker } };
export type AppContext = Context<AppEnv>;
