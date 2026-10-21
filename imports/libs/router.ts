/** Meteor 3.5 emits classic-script module wrappers. React Router 7's ESM entry
 * contains Vite-only import.meta.hot and cannot parse in that format. Meteor's
 * resolver supports direct package files; select the upstream CommonJS entry
 * without patching node_modules or changing router versions/security fixes.
 * Keep public typings, and qualify this adapter whenever React Router changes.
 */
import type * as RouterApi from 'react-router';
const router: typeof RouterApi = require('react-router/dist/development/index.js');
export const { BrowserRouter, Route, Routes, Link, MemoryRouter, useLocation, useNavigate, useParams } = router;
export type { Location, NavigateFunction } from 'react-router';
