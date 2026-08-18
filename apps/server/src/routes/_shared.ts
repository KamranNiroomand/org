import { z } from 'zod';

/** Civil days are stored as `YYYY-MM-DD` text — see the schema header. */
export const civilKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/**
 * Derives a PATCH schema from a POST schema.
 *
 * `.partial()` on its own is not enough, and the way it fails is silent. Zod
 * keeps a field's `.default()` when it makes the field optional, so a key the
 * client never sent still arrives *filled in with the default* — and a handler
 * that writes every defined key then overwrites stored data with it. Sending
 * `{ status: 'done' }` for a task would quietly reset its priority and drop its
 * tags; renaming a project would reset its status and colour.
 *
 * Stripping the defaults first makes an absent key stay absent, which is the
 * only thing a partial update should ever mean.
 */
export function patchOf<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  const undefaulted = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.unwrap() : field,
    ]),
  ) as T['shape'];

  return z.object(undefaulted).partial();
}
