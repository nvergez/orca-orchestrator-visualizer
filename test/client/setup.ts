import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach } from 'vitest';
import { installJsdomGaps } from './jsdom-gaps.ts';

installJsdomGaps();

/**
 * Every animation lands on its final frame, immediately.
 *
 * The panels arrive with an entrance (`src/client/motion.ts`), and an entrance starts at
 * `opacity: 0` — so a suite that asserted a heading was visible the instant it rendered would be
 * asserting against frame one of a fade, and would fail on a fade that is working perfectly.
 * `skipAnimations` is motion's own switch for this: the elements are still rendered, still carry
 * every class and attribute the suite reads, and are simply already *finished* moving.
 *
 * It is deliberately **not** a mock of motion. The components under test are the real ones, with
 * their real `motion.div`s — what the suite opts out of is the passage of time, which is not a
 * thing it was ever testing.
 */
MotionGlobalConfig.skipAnimations = true;

afterEach(cleanup);
