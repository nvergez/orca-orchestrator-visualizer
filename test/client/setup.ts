import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { installJsdomGaps } from './jsdom-gaps.ts';

installJsdomGaps();

afterEach(cleanup);
