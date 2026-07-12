/**
 * The right dock — **one** panel, and it *swaps* (SPEC §7.1): the message feed by default, the
 * node inspector while a task is selected. Never both stacked, because at this node count the
 * canvas deserves the width.
 *
 * So there is one shell, in one place. Two panels that are the same panel at different moments
 * must not be able to disagree about how wide they are or which edge they draw — a dock that
 * changed width on selection would jolt the canvas it is beside every time you clicked a node.
 */
export const DOCK_STYLE = {
  width: 360,
  flexShrink: 0,
  borderLeft: '1px solid #e4e4e7',
  display: 'flex',
  flexDirection: 'column' as const,
  minHeight: 0,
} as const;
