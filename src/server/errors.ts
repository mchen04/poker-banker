import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 415 | 429, public code: string, message: string) {
    super(message);
  }
}
export function notFound(): never { throw new ApiError(404, 'not_found', 'Record not found'); }
export function conflict(code: string, message: string): never { throw new ApiError(409, code, message); }
export { ZodError };
