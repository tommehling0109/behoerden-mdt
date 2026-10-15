import { chatApp } from '../chat.js';

/** Chat im Partner-Portal: Privatnachrichten mit dem Team und freigegebene Kanäle. */
export default (container, ctx) => chatApp(container, ctx, { partner: true });
