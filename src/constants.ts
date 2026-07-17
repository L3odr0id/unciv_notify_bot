// Polling interval and notify-period bounds, shared across the bot.

/** Smallest interval an admin may set, in seconds. */
export const MIN_INTERVAL_SECONDS = 10;

/** Default polling interval when POLL_INTERVAL_SECONDS is unset, in seconds. */
export const DEFAULT_INTERVAL_SECONDS = 600;

/** Smallest re-notify period an admin may set, in seconds. */
export const MIN_NOTIFY_PERIOD_SECONDS = 60;

/** Default re-notify period when NOTIFY_PERIOD_SECONDS is unset, in seconds (2h). */
export const DEFAULT_NOTIFY_PERIOD_SECONDS = 7200;
