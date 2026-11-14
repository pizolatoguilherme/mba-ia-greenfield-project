/** The input could not be read as a video (TD-10: `failed` / `unreadable_media`, no retry). */
export class UnreadableMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableMediaError';
  }
}
