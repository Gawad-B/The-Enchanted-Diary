/** Where things are on the table (scene units: 1 = 10 cm). The table top is y = 0. */
export const CANDLE_HEIGHT = 1.0;
export const CANDLE_RADIUS = 0.14;
/** Height of the dish the candle stands in. */
export const DISH_HEIGHT = 0.09;
/** The widest part of the dish the candle stands in (its rim). */
export const DISH_RADIUS = 0.34;
/** The wick's top, in the candle's own frame: a little above the melted pool of wax. */
export const WICK_TOP_Y = DISH_HEIGHT + CANDLE_HEIGHT * 0.97 + 0.07;
/** Where the flame's visible body starts: on the wick tip (a hair below it, so it is seated and not floating). */
export const FLAME_BASE_Y = WICK_TOP_Y - 0.008;
/** The flame's quad: the visible flame is a teardrop inside it, about 1.1 x 3.6 cm. */
export const FLAME_SIZE = { width: 0.16, height: 0.46 } as const;
/** The flame's middle, in the candle's own frame: where the lights sit. */
export const FLAME_CENTER_Y = FLAME_BASE_Y + 0.14;

/** The warm candle colour of the lights (global brief). */
export const CANDLE_COLOR = '#ffb46b';

export const TABLE_SIZE = { width: 15, depth: 9.5, thickness: 0.5 } as const;

/** The inkwell's body is this tall, and the tip of its quill stands this far out (away from the candle) and this high. */
export const INKWELL_HEIGHT = 0.3;
export const QUILL_TIP = { out: 0.22, height: 0.78 } as const;
